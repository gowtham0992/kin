import { describe, expect, it, vi } from "vitest";
import type { ResponseEnvelope } from "ask-sdk-model";
import { createEchoHandler } from "../src/echo-lambda.js";
import { EchoCareError, type EchoCareClient } from "../src/echo-care-client.js";
import type { TodaySnapshot } from "../src/domain.js";

const skill = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const start = Date.parse("2026-09-14T18:00:00Z");
const tasks: TodaySnapshot["tasks"] = [1, 2].map(n => ({ id: `water-${n}`, title: "Water",
  dueAt: `2026-09-14T${n === 1 ? "19" : "22"}:00:00.000Z`, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null }));
const speech = (r: ResponseEnvelope) => (r.response.outputSpeech as { ssml: string }).ssml;
function setup(undo = true, reminderEnabled = false) {
  let time = start;
  const care = {
    today: vi.fn<EchoCareClient["today"]>(async () => ({ date: "2026-09-14", tasks: structuredClone(tasks), onDuty: null, escalations: [], summary: { total: 2, completed: 0, remaining: 2, skipped: 0 } })),
    confirm: vi.fn<EchoCareClient["confirm"]>(async (_token, input) => ({ task: { ...tasks.find(t => t.id === input.taskId)!,
      state: input.response === "done" ? "done" : input.response === "skipped" ? "skipped" : "scheduled",
      lastResponse: input.response, confirmedAt: new Date(time).toISOString(), confirmedBy: "Parent account" },
      confirmation: { id: "receipt", requestId: input.requestId, taskId: input.taskId, taskDueAt: input.expected.dueAt,
        response: input.response, actor: "Parent account", recordedAt: new Date(time).toISOString() }, refreshRequired: false })),
    undoCompletion: vi.fn<NonNullable<EchoCareClient["undoCompletion"]>>(),
  };
  const reminders = { createTest: vi.fn(), createCheckIn: vi.fn(async () => ({ alertToken: "reminder" })) };
  const claims = { claim: vi.fn(async () => true) };
  const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skill, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true",
    KIN_ECHO_REMINDER_TEST_ENABLED: String(reminderEnabled),
    KIN_ECHO_UNDO_ENABLED: String(undo), KIN_ECHO_TIME_ZONE: "America/Denver" }, { care, reminders, reminderClaims: claims, now: () => time });
  const event = (name?: string, attributes: object = {}) => ({ version: "1.0",
    session: { new: !name, sessionId: "session", application: { applicationId: skill }, attributes },
    context: { System: { application: { applicationId: skill }, apiEndpoint: "https://api.amazonalexa.com", apiAccessToken: "alexa-token", user: { userId: "user", accessToken: "linked-token" } } },
    request: { type: name ? "IntentRequest" : "LaunchRequest", requestId: `req-${name ?? "launch"}`, timestamp: new Date(time).toISOString(), locale: "en-US",
      ...(name ? { intent: { name } } : {}) } });
  return { care, reminders, claims, handle, event, advance: (ms: number) => { time += ms; } };
}

describe("one check-in conversation", () => {
  it.each([undefined, "TodayPlanIntent", "ListTasksIntent"])("gives empty-plan next steps in initial speech for %s, not only the silence reprompt", async intent => {
    const f = setup();
    f.care.today.mockResolvedValue({ date: "2026-09-14", tasks: [], onDuty: null, escalations: [],
      summary: { total: 0, completed: 0, remaining: 0, skipped: 0 } });
    const result = await f.handle(f.event(intent));
    expect(speech(result)).toBe("<speak>There are no check-ins to read for today. This doesn't tell us whether someone is safe. Say today's plan, or stop.</speak>");
    expect(result.response.reprompt?.outputSpeech).toEqual({ type: "SSML", ssml: "<speak>Say today's plan, or stop.</speak>" });
    expect(result.response.shouldEndSession).toBe(false);
    expect(f.care.confirm).not.toHaveBeenCalled();
    expect(f.reminders.createCheckIn).not.toHaveBeenCalled();
  });
  it("gives next steps immediately when the plan has no unanswered check-ins", async () => {
    const f = setup();
    f.care.today.mockResolvedValue({ date: "2026-09-14", tasks: tasks.map(task => ({ ...task, state: "done", lastResponse: "done" })),
      onDuty: null, escalations: [], summary: { total: 2, completed: 2, remaining: 0, skipped: 0 } });
    const result = await f.handle(f.event());
    expect(speech(result)).toBe("<speak>There are no unanswered check-ins in today's plan. This doesn't tell us whether someone is safe. Say today's plan, or stop.</speak>");
    expect(f.care.confirm).not.toHaveBeenCalled();
    expect(f.reminders.createCheckIn).not.toHaveBeenCalled();
  });
  it.each(["yes", "no", "changed"])("offers a consented reminder after not yet and handles %s", async answer => {
    const f = setup(true, true);
    const first = await f.handle(f.event());
    const saved = await f.handle(f.event("CurrentTaskNotYetIntent", first.sessionAttributes));
    expect(speech(saved)).toContain("Saved not yet");
    expect(speech(saved)).toContain("May I set one discreet reminder");
    expect(speech(saved)).toContain("Later plan edits won't cancel this reminder");
    expect(f.reminders.createCheckIn).not.toHaveBeenCalled();
    const receipt = await f.care.confirm.mock.results[0]!.value;
    const snapshot = await f.care.today("linked-token");
    f.care.today.mockResolvedValue({ ...snapshot, tasks: [{ ...receipt.task, ...(answer === "changed" ? { title: "Changed task" } : {}) }, tasks[1]!] });
    await f.handle(f.event(answer === "no" ? "AMAZON.NoIntent" : "AMAZON.YesIntent", saved.sessionAttributes));
    expect(f.reminders.createCheckIn).toHaveBeenCalledTimes(answer === "yes" ? 1 : 0);
    expect(f.care.confirm).toHaveBeenCalledTimes(1);
  });
  it("launches with one check-in in the circle's time zone and next reads the following one", async () => {
    const f = setup();
    const first = await f.handle(f.event());
    expect(speech(first)).toContain("today at 1:00 PM MDT");
    expect(speech(first)).not.toContain("4:00 PM");
    expect(speech(first)).toContain("done, not yet, or skip");
    const next = await f.handle(f.event("NextTasksIntent", first.sessionAttributes));
    expect(speech(next)).toContain("today at 4:00 PM MDT");
    const end = await f.handle(f.event("NextTasksIntent", next.sessionAttributes));
    expect(speech(end)).toContain("last check-in");
    expect(f.care.confirm).not.toHaveBeenCalled();
  });
  it.each([["CurrentTaskDoneIntent", "done"], ["CurrentTaskNotYetIntent", "not_yet"]])("saves %s against exactly the spoken review without another yes", async (intent, response) => {
    const f = setup();
    const first = await f.handle(f.event());
    const saved = await f.handle(f.event(intent, first.sessionAttributes));
    expect(speech(saved)).toContain("Saved");
    expect(f.care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({ taskId: "water-1", response,
      expected: expect.objectContaining({ title: "Water", dueAt: tasks[0]!.dueAt }) }));
    if (response === "done") expect(speech(saved)).toContain("undo last completion");
    await f.handle(f.event("AMAZON.YesIntent", saved.sessionAttributes));
    expect(f.care.confirm).toHaveBeenCalledTimes(1);
  });
  it("still confirms a skip and does not save on no", async () => {
    const f = setup();
    const first = await f.handle(f.event());
    const review = await f.handle(f.event("CurrentTaskSkipIntent", first.sessionAttributes));
    expect(speech(review)).toContain("Say yes or no");
    expect(f.care.confirm).not.toHaveBeenCalled();
    await f.handle(f.event("AMAZON.NoIntent", review.sessionAttributes));
    expect(f.care.confirm).not.toHaveBeenCalled();
  });
  it("keeps done confirmation when undo has not been enabled", async () => {
    const f = setup(false);
    const first = await f.handle(f.event());
    const review = await f.handle(f.event("CurrentTaskDoneIntent", first.sessionAttributes));
    expect(speech(review)).toContain("Say yes or no");
    expect(f.care.confirm).not.toHaveBeenCalled();
  });
  it.each(["expired", "token", "new session", "missing", "numbered list"])("never guesses a short reply with %s context", async change => {
    const f = setup();
    const first = await f.handle(f.event(change === "numbered list" ? "ListTasksIntent" : undefined));
    if (change === "expired") f.advance(90_001);
    const event = f.event("CurrentTaskNotYetIntent", change === "missing" ? {} : first.sessionAttributes);
    if (change === "token") event.context.System.user.accessToken = "other";
    if (change === "new session") event.session.new = true;
    await f.handle(event);
    expect(f.care.confirm).not.toHaveBeenCalled();
  });
  it("does not silently retry a conflicting or uncertain short reply", async () => {
    const f = setup();
    const first = await f.handle(f.event());
    f.care.confirm.mockRejectedValue(new EchoCareError("conflict"));
    const conflict = await f.handle(f.event("CurrentTaskDoneIntent", first.sessionAttributes));
    expect(speech(conflict)).toContain("changed");
    expect(conflict.sessionAttributes).toEqual({});
    f.care.confirm.mockRejectedValue(new Error("network"));
    const unknown = await f.handle(f.event("CurrentTaskDoneIntent", first.sessionAttributes));
    expect(speech(unknown)).toContain("couldn't verify whether your response was saved");
    expect(f.care.confirm).toHaveBeenCalledTimes(2);
  });
});
