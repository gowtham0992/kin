import { describe, expect, it, vi } from "vitest";
import { createEchoHandler } from "../src/echo-lambda.js";
import { createEchoReminderClient, reminderText } from "../src/echo-reminders.js";
import { createDynamoReminderClaims, type ReminderClaims } from "../src/echo-reminder-claims.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { TodaySnapshot } from "../src/domain.js";
import { EchoCareError } from "../src/echo-care-client.js";

const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const time = Date.parse("2026-09-12T18:00:00Z");
function event(name: string, attributes: object = {}) {
  return { version: "1.0", session: { new: false, sessionId: "session", application: { applicationId: skillId }, attributes },
    context: { System: { application: { applicationId: skillId }, apiEndpoint: "https://api.amazonalexa.com", apiAccessToken: "alexa-token", user: { userId: "user" } } },
    request: { type: "IntentRequest", requestId: name, timestamp: new Date(time).toISOString(), locale: "en-US", intent: { name } } };
}
const speech = (r: any) => r.response.outputSpeech?.ssml ?? "";
function memoryClaims(): ReminderClaims {
  const keys = new Set<string>();
  return { async claim(key) { if (keys.has(key)) return false; keys.add(key); return true; } };
}
function setup(enabled = true, reminderClaims = memoryClaims()) {
  const reminders = { createTest: vi.fn(async () => {}) };
  const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_REMINDER_TEST_ENABLED: String(enabled) }, { reminders, reminderClaims, now: () => time });
  return { handle, reminders };
}
describe("explicit device reminder test", () => {
  it("asks before creating, then sends only the Alexa service token", async () => {
    const { handle, reminders } = setup();
    const proposal = await handle(event("TestReminderIntent"));
    expect(speech(proposal)).toContain("two minutes");
    expect(reminders.createTest).not.toHaveBeenCalled();
    const result = await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(reminders.createTest).toHaveBeenCalledExactlyOnceWith("https://api.amazonalexa.com", "alexa-token", new Date(time).toISOString());
    expect(speech(result)).toContain("Alexa accepted");
    expect(result.sessionAttributes).toEqual({});
    expect(JSON.stringify(proposal)).not.toMatch(/alexa-token|userId/);
  });
  it.each(["AMAZON.NoIntent", "AMAZON.StopIntent", "AMAZON.CancelIntent", "AMAZON.HelpIntent"])("disarms consent on %s", async name => {
    const { handle, reminders } = setup();
    const proposal = await handle(event("TestReminderIntent"));
    const cancelled = await handle(event(name, proposal.sessionAttributes));
    await handle(event("AMAZON.YesIntent", cancelled.sessionAttributes));
    expect(reminders.createTest).not.toHaveBeenCalled();
  });
  it.each(["expired", "new session", "different user", "future", "missing token"])("rejects %s consent", async change => {
    const { handle, reminders } = setup();
    const proposal = await handle(event("TestReminderIntent"));
    const request = event("AMAZON.YesIntent", proposal.sessionAttributes);
    if (change === "expired") (request.session.attributes as any).kinReminder.preparedAt = time - 90_001;
    if (change === "future") (request.session.attributes as any).kinReminder.preparedAt = time + 1;
    if (change === "new session") request.session.new = true;
    if (change === "different user") request.context.System.user.userId = "another-user";
    if (change === "missing token") request.context.System.apiAccessToken = "";
    if (change === "missing token") await expect(handle(request)).rejects.toThrow();
    else await handle(request);
    expect(reminders.createTest).not.toHaveBeenCalled();
  });
  it("stays disabled unless explicitly enabled", async () => {
    const { handle, reminders } = setup(false);
    const proposal = await handle(event("TestReminderIntent"));
    await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(reminders.createTest).not.toHaveBeenCalled();
  });
  it("does not repeat a POST for concurrent replay on the same warm handler", async () => {
    const { handle, reminders } = setup();
    const proposal = await handle(event("TestReminderIntent"));
    await Promise.all([handle(event("AMAZON.YesIntent", proposal.sessionAttributes)), handle(event("AMAZON.YesIntent", proposal.sessionAttributes))]);
    expect(reminders.createTest).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain outcome or claim the reminder rang", async () => {
    const { handle, reminders } = setup();
    reminders.createTest.mockRejectedValue(new Error("private upstream token"));
    const proposal = await handle(event("TestReminderIntent"));
    const result = await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(speech(result)).toContain("couldn't verify");
    expect(speech(result)).not.toContain("private upstream");
    expect(reminders.createTest).toHaveBeenCalledTimes(1);
    await handle(event("AMAZON.YesIntent", result.sessionAttributes));
    expect(reminders.createTest).toHaveBeenCalledTimes(1);
  });
});
describe("Alexa reminder boundary", () => {
  it("creates a discreet relative reminder with phone push disabled", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ alertToken: "receipt", status: "ON" }), { status: 201 }));
    await createEchoReminderClient(fetcher).createTest("https://api.amazonalexa.com", "service-token", new Date(time).toISOString());
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.amazonalexa.com/v1/alerts/reminders");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(options.body as string)).toEqual({ requestTime: new Date(time).toISOString(), trigger: { type: "SCHEDULED_RELATIVE", offsetInSeconds: 120 }, alertInfo: { spokenInfo: { content: [{ locale: "en-US", text: reminderText }] } }, pushNotification: { status: "DISABLED" } });
  });
  it.each(["https://evil.example", "https://api.amazonalexa.com@evil.example", "http://api.amazonalexa.com", "https://api.amazonalexa.com/redirect"])("never sends the token to %s", async endpoint => {
    const fetcher = vi.fn();
    await expect(createEchoReminderClient(fetcher).createTest(endpoint, "token", new Date(time).toISOString())).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("offers the Alexa permission card when the service denies access", async () => {
    const reminders = createEchoReminderClient(vi.fn(async () => new Response("secret", { status: 403 })));
    const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_REMINDER_TEST_ENABLED: "true" }, { reminders, reminderClaims: memoryClaims(), now: () => time });
    const proposal = await handle(event("TestReminderIntent"));
    const result = await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(result.response.card).toEqual({ type: "AskForPermissionsConsent", permissions: ["alexa::alerts:reminders:skill:readwrite"] });
    expect(speech(result)).toContain("Alexa app");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("durable reminder claim boundary", () => {
  it("prevents replay across independently created handlers", async () => {
    const claims = memoryClaims();
    const first = setup(true, claims), second = setup(true, claims);
    const proposal = await first.handle(event("TestReminderIntent"));
    await Promise.all([first.handle(event("AMAZON.YesIntent", proposal.sessionAttributes)), second.handle(event("AMAZON.YesIntent", proposal.sessionAttributes))]);
    expect(first.reminders.createTest.mock.calls.length + second.reminders.createTest.mock.calls.length).toBe(1);
  });
  it("fails closed when the database claim outcome is uncertain", async () => {
    const { handle, reminders } = setup(true, { async claim() { throw new Error("private database details"); } });
    const proposal = await handle(event("TestReminderIntent"));
    const result = await handle(event("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(reminders.createTest).not.toHaveBeenCalled();
    expect(speech(result)).toContain("couldn't verify");
    expect(JSON.stringify(result)).not.toContain("private database");
  });
  it("refuses enabled configuration without durable storage", () => {
    expect(() => createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_REMINDER_TEST_ENABLED: "true" })).toThrow("dedicated Kin reminder claim table");
  });
  it("uses an immutable conditional claim with one-day cleanup and no identity data", async () => {
    const send = vi.fn(async (_command: PutCommand, _options: { abortSignal: AbortSignal }) => ({}));
    const store = createDynamoReminderClaims("kin-echo-reminder-claims", { send });
    expect(await store.claim("a".repeat(64), time)).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({ TableName: "kin-echo-reminder-claims", Item: { PK: "a".repeat(64), preparedAt: time, expiresAt: time / 1000 + 86400 }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(send.mock.calls[0]![1].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("treats only conditional failure as a duplicate", async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error(), { name: "ConditionalCheckFailedException" })).mockRejectedValueOnce(new Error("secret"));
    const store = createDynamoReminderClaims("kin-echo-reminder-claims", { send });
    expect(await store.claim("a".repeat(64), time)).toBe(false);
    await expect(store.claim("b".repeat(64), time)).rejects.toThrow("Reminder claim unavailable");
  });
});

describe("parent-approved plan reminder", () => {
  it("allows a three-second plan offer but bounds the confirmation recheck to two seconds", async () => {
    vi.useFakeTimers();
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const { snapshot } = planSetup();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const frame = JSON.parse(String(init?.body));
      if (frame.method === "initialize") await new Promise(resolve => setTimeout(resolve, 3000));
      if (frame.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: frame.id, result: frame.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "kin", version: "1" } }
        : { content: [], structuredContent: snapshot } });
    });
    const reminders = { createTest: vi.fn(), createCheckIn: vi.fn() };
    const claims = { claim: vi.fn() };
    try {
      const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true",
        KIN_ECHO_REMINDER_TEST_ENABLED: "true", KIN_ECHO_MCP_ENDPOINT: "https://kin.example/mcp" },
      { reminders, reminderClaims: claims, now: () => time });
      const request = event("NextCheckInReminderIntent");
      Object.assign(request.context.System.user, { accessToken: "private-kin-token" });
      const offering = handle(request);
      await vi.advanceTimersByTimeAsync(3100);
      const proposal = await offering;
      expect(speech(proposal)).toContain("Set one reminder");
      expect(claims.claim).not.toHaveBeenCalled();
      const yes = event("AMAZON.YesIntent", proposal.sessionAttributes);
      Object.assign(yes.context.System.user, { accessToken: "private-kin-token" });
      const confirming = handle(yes);
      await vi.advanceTimersByTimeAsync(2100);
      const declined = await confirming;
      expect(speech(declined)).toContain("Kin is having trouble loading");
      expect(declined.sessionAttributes).toEqual({});
      expect(claims.claim).not.toHaveBeenCalled();
      expect(reminders.createCheckIn).not.toHaveBeenCalled();
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers(); logs.mockRestore(); fetcher.mockRestore();
    }
  });
  it("records a redacted diagnostic when the real plan client cannot initialize", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    try {
      const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true",
        KIN_ECHO_REMINDER_TEST_ENABLED: "true", KIN_ECHO_MCP_ENDPOINT: "https://kin.example/mcp" },
      { reminderClaims: memoryClaims(), now: () => time });
      const request = event("NextCheckInReminderIntent");
      Object.assign(request.context.System.user, { accessToken: "private-kin-token" });
      const result = await handle(request);
      expect(speech(result)).toContain("Kin is having trouble loading");
      expect(logs).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ event: "kin_echo_reminder_plan_result", operation: "read", phase: "initialize", reason: "http", httpStatus: 503 });
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-kin-token|alexa-token|kin.example|userId/);
    } finally {
      logs.mockRestore(); fetcher.mockRestore();
    }
  });
  it.each(["offer", "confirmation"])("does not blame account access for an unavailable plan during %s", async phase => {
    const { handle, care, request, reminders, claims } = planSetup();
    const proposal = phase === "confirmation" ? await handle(request("NextCheckInReminderIntent")) : undefined;
    care.today.mockRejectedValueOnce(new EchoCareError("unavailable"));
    const result = await handle(request(phase === "offer" ? "NextCheckInReminderIntent" : "AMAZON.YesIntent", proposal?.sessionAttributes));
    expect(speech(result)).toContain("Kin is having trouble loading your family plan");
    expect(speech(result)).not.toMatch(/check your Kin access|recheck your plan or access/);
    expect(result.response.card).toBeUndefined();
    expect(result.sessionAttributes).toEqual({});
    expect(claims.claim).not.toHaveBeenCalled();
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
  });
  it.each(["unauthenticated", "forbidden"] as const)("gives the correct recovery for %s without requesting a reminder", async code => {
    const { handle, care, request, reminders } = planSetup();
    care.today.mockRejectedValueOnce(new EchoCareError(code));
    const result = await handle(request("NextCheckInReminderIntent"));
    expect(speech(result)).toContain(code === "unauthenticated" ? "reconnect your Kin account" : "organizer to check your membership");
    expect(result.response.card?.type).toBe(code === "unauthenticated" ? "LinkAccount" : undefined);
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
  });
  function planSetup(timeZone?: string) {
    let current = time;
    const snapshot: TodaySnapshot = { date: "2026-09-12", onDuty: null, escalations: [], summary: { total: 1, completed: 0, remaining: 1, skipped: 0 },
      tasks: [{ id: "walk", title: "Private family task", dueAt: "2026-09-12T18:30:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null }] };
    const care = { today: vi.fn(async () => structuredClone(snapshot)), confirm: vi.fn() };
    const reminders = { createTest: vi.fn(async () => {}), createCheckIn: vi.fn(async () => ({ alertToken: "synthetic-id" })) };
    const claims = { claim: vi.fn(async () => true), recordAccepted: vi.fn(async () => {}) };
    const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true", KIN_ECHO_REMINDER_TEST_ENABLED: "true", KIN_ECHO_TIME_ZONE: timeZone },
      { care, reminders, reminderClaims: claims, now: () => current });
    function request(name: string, attributes: object = {}) {
      const request = event(name, attributes);
      Object.assign(request.context.System.user, { accessToken: "kin-account-token" });
      return request;
    }
    return { handle, care, reminders, claims, snapshot, request, advance: (ms: number) => { current += ms; } };
  }
  it("uses the configured circle clock for the offer and repeat without changing the scheduled instant", async () => {
    const { handle, request, reminders } = planSetup("America/Denver");
    const proposal = await handle(request("NextCheckInReminderIntent"));
    expect(speech(proposal)).toContain("today at 12:30 PM MDT");
    const repeated = await handle(request("AMAZON.RepeatIntent", proposal.sessionAttributes));
    expect(speech(repeated)).toContain("today at 12:30 PM MDT");
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
  });
  it("reads the plan, reviews, rechecks, then uses Alexa's token for the agreed absolute time", async () => {
    const { handle, care, reminders, request } = planSetup();
    const proposal = await handle(request("NextCheckInReminderIntent"));
    expect(speech(proposal)).toContain("today at 6:30 PM UTC");
    expect(speech(proposal)).toContain("Later plan edits won't cancel");
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
    const saved = await handle(request("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(care.today).toHaveBeenCalledTimes(2);
    expect(care.today).toHaveBeenLastCalledWith("kin-account-token");
    expect(reminders.createCheckIn).toHaveBeenCalledExactlyOnceWith("https://api.amazonalexa.com", "alexa-token", new Date(time).toISOString(), "2026-09-12T18:30:00.000Z");
    expect(speech(saved)).toContain("does not mark the check-in done");
    expect(care.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(proposal)).not.toMatch(/Private family task|kin-account-token|alexa-token/);
  });
  it.each(["title", "dueAt", "completed", "cancelled", "removed", "access revoked"])("does not create a reminder after %s changes", async change => {
    const { handle, care, reminders, claims, snapshot, request } = planSetup();
    const proposal = await handle(request("NextCheckInReminderIntent"));
    if (change === "title") snapshot.tasks[0]!.title = "Changed";
    if (change === "dueAt") snapshot.tasks[0]!.dueAt = "2026-09-12T18:40:00.000Z";
    if (change === "completed") snapshot.tasks[0]!.state = "done";
    if (change === "cancelled") snapshot.tasks[0]!.state = "cancelled";
    if (change === "removed") snapshot.tasks = [];
    if (change === "access revoked") care.today.mockRejectedValue(new Error("private access error"));
    const result = await handle(request("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
    expect(claims.claim).not.toHaveBeenCalled();
    expect(speech(result)).not.toMatch(/Alexa accepted|private access/);
  });
  it("requires a linked account and does not substitute the Alexa API token", async () => {
    const { handle, care } = planSetup();
    const result = await handle(event("NextCheckInReminderIntent"));
    expect(result.response.card).toEqual({ type: "LinkAccount" });
    expect(care.today).not.toHaveBeenCalled();
  });
  it("handles an empty plan without claiming any reminder exists", async () => {
    const { handle, snapshot, request, claims } = planSetup();
    snapshot.tasks = [];
    const result = await handle(request("NextCheckInReminderIntent"));
    expect(speech(result)).toContain("no upcoming check-ins");
    expect(claims.claim).not.toHaveBeenCalled();
    expect(result.sessionAttributes).toEqual({});
  });
  it("does not let the second plan read extend expired consent", async () => {
    const { handle, care, request, advance, reminders, snapshot } = planSetup();
    const proposal = await handle(request("NextCheckInReminderIntent"));
    care.today.mockImplementation(async () => { advance(90_001); return structuredClone(snapshot); });
    await handle(request("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(reminders.createCheckIn).not.toHaveBeenCalled();
  });
  it("persists the accepted ID after yes without storing either access token", async () => {
    const { handle, request, claims } = planSetup();
    const proposal = await handle(request("NextCheckInReminderIntent"));
    await handle(request("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(claims.recordAccepted).toHaveBeenCalledOnce();
    const saved = JSON.stringify(claims.recordAccepted.mock.calls);
    expect(saved).toContain("synthetic-id");
    expect(saved).not.toContain("alexa-token");
    expect(saved).not.toContain("accessToken");
  });
  it("reports accepted-but-untracked without retrying the reminder when saving fails", async () => {
    const { handle, request, claims, reminders } = planSetup();
    claims.recordAccepted.mockRejectedValue(new Error("private storage detail"));
    const proposal = await handle(request("NextCheckInReminderIntent"));
    const result = await handle(request("AMAZON.YesIntent", proposal.sessionAttributes));
    expect(speech(result)).toContain("couldn't save its reference");
    expect(speech(result)).not.toContain("private storage detail");
    expect(reminders.createCheckIn).toHaveBeenCalledOnce();
    expect(result.sessionAttributes).toEqual({});
  });
  it("sends fixed private-safe text, not a care-task title, to Alexa", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ alertToken: "synthetic-receipt" }), { status: 201 }));
    await createEchoReminderClient(fetcher).createCheckIn!("https://api.amazonalexa.com", "token", new Date(time).toISOString(), "2026-09-12T18:30:00.000Z");
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.trigger).toEqual({ type: "SCHEDULED_ABSOLUTE", scheduledTime: "2026-09-12T18:30:00.000", timeZoneId: "Etc/UTC" });
    expect(body.alertInfo.spokenInfo.content[0].text).toBe("It is time for your Kin check-in. Whenever you are ready, say Alexa, open kin family.");
    expect(body.pushNotification.status).toBe("DISABLED");
  });
});
