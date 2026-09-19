import { describe, expect, it, vi } from "vitest";
import { createEchoHandler } from "../src/echo-lambda.js";
import type { ResponseEnvelope } from "ask-sdk-model";
import type { TodaySnapshot } from "../src/domain.js";
import type { EchoCareClient } from "../src/echo-care-client.js";
import { EchoCareError } from "../src/echo-care-client.js";

const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const environment = { KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true" };
const now = Date.parse("2026-09-11T18:00:00Z");
const snapshot: TodaySnapshot = {
  date: "2026-09-11", onDuty: null, escalations: [], summary: { total: 2, completed: 0, remaining: 2, skipped: 0 },
  tasks: [1, 2].map(n => ({ id: `task-${n}`, title: n === 1 ? "Morning water" : "Evening water", dueAt: `2026-09-11T${n === 1 ? "16" : "23"}:00:00.000Z`, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null })),
};
function request(name?: string, attrs: object = {}, number?: string, token: string | undefined = "linked-token") {
  // This suite exercises the retained, explicit numbered-list conversation.
  // Default launch and short replies are covered by echo-short-replies.test.ts.
  name ??= "ListTasksIntent";
  return { version: "1.0", session: { new: !name, sessionId: "session-one", application: { applicationId: skillId }, attributes: attrs },
    context: { System: { application: { applicationId: skillId }, user: { userId: "alexa-user", accessToken: token }, apiAccessToken: "not-a-kin-token" } },
    request: { type: name ? "IntentRequest" : "LaunchRequest", requestId: `request-${name ?? "launch"}`, timestamp: new Date(now).toISOString(), locale: "en-US",
      ...(name ? { intent: { name, slots: number === undefined ? {} : { taskNumber: { name: "taskNumber", value: number } } } } : {}) } };
}
function setup() {
  let time = now;
  const care = { today: vi.fn(async () => structuredClone(snapshot)), confirm: vi.fn<EchoCareClient["confirm"]>(async (_token, input) => ({
    confirmation: { id: "receipt", requestId: input.requestId, taskId: input.taskId, taskDueAt: input.expected.dueAt, response: input.response, actor: "Current family member", recordedAt: new Date(now).toISOString() },
    task: { ...snapshot.tasks.find(t => t.id === input.taskId)!, state: input.response === "done" ? "done" : input.response === "skipped" ? "skipped" : "scheduled", lastResponse: input.response }, refreshRequired: false,
  })) };
  const handle = createEchoHandler(environment, { care, now: () => time });
  return { handle, care, advance: (ms: number) => { time += ms; } };
}
const speech = (result: ResponseEnvelope) => (result.response.outputSpeech as { ssml: string }).ssml;
async function prepare(context = setup(), name = "MarkTaskDoneIntent") {
  const listed = await context.handle(request());
  const review = await context.handle(request(name, listed.sessionAttributes, "2"));
  return { ...context, listed, review };
}

describe("linked Echo care conversation", () => {
  it("requests account linking instead of using Alexa's unrelated API token", async () => {
    const { handle, care } = setup();
    const event = request();
    delete (event.context.System.user as { accessToken?: string }).accessToken;
    const result = await handle(event);
    expect(result.response.card).toEqual({ type: "LinkAccount" });
    expect(result.response.shouldEndSession).toBe(true);
    expect(care.today).not.toHaveBeenCalled();
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("reads numbered tasks using only the linked token and excludes tokens and unrelated attributes from replies", async () => {
    const { handle, care } = setup();
    const event = request(undefined, { secret: "do-not-copy" });
    const result = await handle(event);
    expect(speech(result)).toContain("1. Morning water");
    expect(speech(result)).toContain("2. Evening water");
    expect(care.today).toHaveBeenCalledWith("linked-token");
    expect(JSON.stringify(result)).not.toMatch(/linked-token|not-a-kin-token|do-not-copy|alexa-user/);
  });
  it("keeps a routine plan reply brief and gives a supported next command", async () => {
    const { handle } = setup();
    const result = await handle(request());
    expect(speech(result)).toContain("mark check-in one done");
    expect(speech(result)).toContain("help");
    expect(speech(result).replace(/<\/?speak>/g, "").trim().split(/\s+/).length).toBeLessThanOrEqual(24);
  });
  it("explains the shared account without claiming to recognize the speaker", async () => {
    const { handle, care } = setup();
    const result = await handle(request("AMAZON.HelpIntent"));
    expect(speech(result)).toContain("Anyone using this Echo can use the linked Kin account");
    expect(speech(result)).toContain("I can't identify who's speaking");
    expect(speech(result)).toContain("I'll ask before skipping");
    expect(care.today).not.toHaveBeenCalled();
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["MarkTaskDoneIntent", "MarkTaskNotYetIntent", "SkipTaskIntent"])("reviews %s before writing and saves only after explicit yes", async name => {
    const { handle, care, review } = await prepare(setup(), name);
    expect(speech(review)).toContain("Evening water");
    expect(speech(review)).toContain("Say yes or no");
    expect(care.confirm).not.toHaveBeenCalled();
    const result = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(speech(result)).toContain("Saved");
    expect(care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({ taskId: "task-2", expected: expect.objectContaining({ title: "Evening water" }), response: name === "MarkTaskDoneIntent" ? "done" : name === "SkipTaskIntent" ? "skipped" : "not_yet" }));
    expect(result.sessionAttributes).toEqual({});
  });
  it.each(["AMAZON.NoIntent", "AMAZON.CancelIntent", "AMAZON.StopIntent"])("clears review without writing on %s", async name => {
    const { handle, care, review } = await prepare();
    const result = await handle(request(name, review.sessionAttributes));
    await handle(request("AMAZON.YesIntent", result.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("acknowledges a declined review briefly without a saved claim", async () => {
    const { handle, care, review } = await prepare();
    const result = await handle(request("AMAZON.NoIntent", review.sessionAttributes));
    expect(speech(result)).toBe("<speak>Okay. I haven't submitted a change.</speak>");
    expect(result.sessionAttributes).toEqual({});
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("attributes a saved response to the linked account without naming a human speaker", async () => {
    const { handle, care, review } = await prepare();
    const result = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(speech(result)).toBe("<speak>Saved done for Evening water through the linked Kin account.</speak>");
    expect(speech(result)).not.toContain("Current family member");
    expect(care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({ actor: "Linked Kin account" }));
    expect(result.sessionAttributes).toEqual({});
  });
  it("keeps the partial-refresh warning with a saved account-attributed response", async () => {
    const { handle, care, review } = await prepare();
    const confirm = care.confirm.getMockImplementation()!;
    care.confirm.mockImplementation(async (...args) => ({ ...await confirm(...args), refreshRequired: true }));
    const result = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(speech(result)).toContain("Saved done for Evening water through the linked Kin account");
    expect(speech(result)).toContain("I couldn't refresh the plan. Check Kin for its latest state");
    expect(care.confirm).toHaveBeenCalledTimes(1);
  });
  it("requires a numbered list before one-shot selection", async () => {
    const { handle, care } = setup();
    const result = await handle(request("MarkTaskDoneIntent", {}, "1"));
    expect(speech(result)).toContain("Morning water");
    await handle(request("AMAZON.YesIntent", result.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each([undefined, "0", "3", "1.5", "-1", "one", "1e0", "1<script>"])("never guesses an ambiguous task number %s", async number => {
    const { handle, care } = setup();
    const listed = await handle(request());
    const selection = await handle(request("MarkTaskDoneIntent", listed.sessionAttributes, number));
    await handle(request("AMAZON.YesIntent", selection.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["session", "token", "user", "new", "expired"])("rejects a review after %s changes", async change => {
    const { handle, care, review, advance } = await prepare();
    const event = request("AMAZON.YesIntent", review.sessionAttributes);
    if (change === "session") event.session.sessionId = "other-session";
    if (change === "token") event.context.System.user.accessToken = "other-token";
    if (change === "user") event.context.System.user.userId = "other-user";
    if (change === "new") event.session.new = true;
    if (change === "expired") advance(90_001);
    await handle(event);
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("keeps the same bounded operation ID for repeated delivery of the original yes", async () => {
    const { handle, care, review } = await prepare();
    const yes = request("AMAZON.YesIntent", review.sessionAttributes);
    await handle(yes);
    await handle(yes);
    expect(care.confirm.mock.calls[0]?.[1].requestId).toEqual(care.confirm.mock.calls[1]?.[1].requestId);
    expect(care.confirm.mock.calls[0]?.[1].requestId.length).toBeLessThanOrEqual(100);
  });
  it("escapes family text before rendering SSML", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: [{ ...snapshot.tasks[0]!, title: 'Water & <audio src="https://bad.invalid"/>' }] });
    const result = await handle(request());
    expect(speech(result)).not.toContain("<audio");
    expect(speech(result)).toContain("Water &amp; &lt;audio");
  });
  it("does not renumber a reviewed task when the family list changes", async () => {
    const { handle, care, listed } = await prepare();
    care.today.mockResolvedValue({ ...snapshot, tasks: [snapshot.tasks[1]!] });
    const review = await handle(request("MarkTaskDoneIntent", listed.sessionAttributes, "2"));
    await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(care.confirm.mock.calls[0]?.[1].taskId).toBe("task-2");
    expect(care.today).toHaveBeenCalledTimes(1);
  });
  it("does not silently overwrite an already completed task", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: [{ ...snapshot.tasks[0]!, state: "done", lastResponse: "done" }] });
    const list = await handle(request());
    const review = await handle(request("SkipTaskIntent", list.sessionAttributes, "1"));
    await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("handles unknown write outcome truthfully and never retries automatically", async () => {
    const { handle, care, review } = await prepare();
    care.confirm.mockRejectedValue(new Error("private upstream data"));
    const result = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(speech(result)).toContain("couldn't verify whether");
    expect(speech(result)).not.toMatch(/private upstream|nothing was saved|Saved/);
    expect(care.confirm).toHaveBeenCalledTimes(1);
    expect(result.sessionAttributes).toEqual({});
  });
  it("limits a voice page to five without hiding that other check-ins exist", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: Array.from({ length: 6 }, (_, n) => ({ ...snapshot.tasks[0]!, id: `task-${n}`, title: `Check-in ${n}` })) });
    const result = await handle(request());
    expect(speech(result)).toContain("5. Check-in 4");
    expect(speech(result)).not.toContain("6. Check-in 5");
    expect(speech(result)).toContain("next check-ins");
  });
  it("reads later pages and selects within the page that was actually spoken", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: Array.from({ length: 7 }, (_, n) => ({ ...snapshot.tasks[0]!, id: `task-${n}`, title: `Check-in ${n}` })) });
    const first = await handle(request());
    const next = await handle(request("NextTasksIntent", first.sessionAttributes));
    expect(speech(next)).toContain("1. Check-in 5");
    expect(speech(next)).not.toContain("Check-in 0");
    const review = await handle(request("MarkTaskDoneIntent", next.sessionAttributes, "2"));
    await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(care.confirm.mock.calls[0]?.[1].taskId).toBe("task-6");
  });
  it("does not silently wrap the last page back to the beginning", async () => {
    const { handle, care } = setup();
    const first = await handle(request());
    const next = await handle(request("NextTasksIntent", first.sessionAttributes));
    expect(speech(next)).toContain("last page");
    expect(care.today).toHaveBeenCalledTimes(1);
  });
  it.each(["last row removed", "whole page removed", "last row rescheduled"])("requires a fresh list when the page cursor changes: %s", async change => {
    const { handle, care } = setup();
    const tasks = Array.from({ length: 7 }, (_, n) => ({ ...snapshot.tasks[0]!, id: `task-${n}`, title: `Check-in ${n}` }));
    care.today.mockResolvedValue({ ...snapshot, tasks, summary: { total: tasks.length, completed: 0, remaining: tasks.length, skipped: 0 } });
    const first = await handle(request());
    const pending = await handle(request("MarkTaskDoneIntent", first.sessionAttributes, "2"));
    const remaining = change === "last row rescheduled"
      ? [...tasks.filter((_, index) => index !== 4), { ...tasks[4]!, dueAt: "2026-09-11T23:00:00.000Z" }]
      : tasks.filter((_, index) => change === "last row removed" ? index !== 4 : index > 4);
    care.today.mockResolvedValue({ ...snapshot, tasks: remaining, summary: { total: remaining.length, completed: 0, remaining: remaining.length, skipped: 0 } });

    const next = await handle(request("NextTasksIntent", pending.sessionAttributes));
    expect(speech(next)).toContain("The plan changed since I read that page");
    expect(speech(next)).toContain("Say today's plan to refresh");
    expect(speech(next)).not.toMatch(/Here are|1\. Check-in/);
    expect(next.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", next.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();

    const refreshed = await handle(request("TodayPlanIntent", next.sessionAttributes));
    expect(speech(refreshed)).toContain(remaining[0]!.title);
    const reviewed = await handle(request("MarkTaskDoneIntent", refreshed.sessionAttributes, "1"));
    await handle(request("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({ taskId: remaining[0]!.id }));
  });
  it("does not claim today's plan is empty when all unread check-ins are removed", async () => {
    const { handle, care } = setup();
    const tasks = Array.from({ length: 7 }, (_, n) => ({ ...snapshot.tasks[0]!, id: `task-${n}`, title: `Check-in ${n}` }));
    care.today.mockResolvedValue({ ...snapshot, tasks, summary: { total: 7, completed: 0, remaining: 7, skipped: 0 } });
    const first = await handle(request());
    care.today.mockResolvedValue({ ...snapshot, tasks: tasks.slice(0, 5), summary: { total: 5, completed: 0, remaining: 5, skipped: 0 } });

    const next = await handle(request("NextTasksIntent", first.sessionAttributes));
    expect(speech(next)).toContain("There are no more check-ins to read right now");
    expect(speech(next)).toContain("Say today's plan to refresh");
    expect(speech(next)).not.toContain("There are no check-ins to read for today");
    expect(next.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", next.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["AMAZON.HelpIntent", "AMAZON.FallbackIntent", "TodayPlanIntent", "NextTasksIntent"])("disarms a pending write after %s", async name => {
    const { handle, care, review } = await prepare();
    const result = await handle(request(name, review.sessionAttributes));
    await handle(request("AMAZON.YesIntent", result.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["unauthenticated", "forbidden", "conflict", "outcome_unknown"] as const)("handles %s at confirmation without a false saved claim", async code => {
    const { handle, care, review } = await prepare();
    care.confirm.mockRejectedValue(new EchoCareError(code));
    const result = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(speech(result)).not.toContain("Saved");
    expect(speech(result)).toContain(code === "unauthenticated" ? "link your Kin account" : code === "forbidden" ? "doesn't currently have permission" : code === "conflict" ? "changed or is no longer available" : "couldn't verify whether");
    expect(result.sessionAttributes).toEqual({});
  });
  it("reports empty plans without implying anyone is safe", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: [], summary: { total: 0, completed: 0, remaining: 0, skipped: 0 } });
    const result = await handle(request());
    expect(speech(result)).toContain("no check-ins");
    expect(speech(result)).toContain("doesn't tell us whether someone is safe");
    expect(result.sessionAttributes).toEqual({});
  });
  it("disambiguates duplicate titles using explicit UTC rather than an invented family timezone", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, title: "Water" })) });
    const result = await handle(request());
    expect(speech(result)).toContain("today at 4:00 PM UTC");
    expect(speech(result)).toContain("today at 11:00 PM UTC");
  });
  it("repeats the selected duplicate title's due time before asking to save", async () => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, title: "Water" })) });
    const listed = await handle(request());
    const review = await handle(request("MarkTaskDoneIntent", listed.sessionAttributes, "2"));
    expect(speech(review)).toContain("Record done for check-in 2, Water, scheduled for today at 11:00 PM UTC?");
    expect(speech(review)).not.toContain("4:00 PM");
    expect(speech(review)).toContain("Say yes or no");
    expect(care.confirm).not.toHaveBeenCalled();
    await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    expect(care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({
      taskId: "task-2", expected: expect.objectContaining({ title: "Water", dueAt: "2026-09-11T23:00:00.000Z" }),
    }));
  });
  it("clears a malformed or future-dated session instead of trusting it", async () => {
    const { handle, care, review } = await prepare();
    for (const patch of [{ listedAt: now + 1 }, { rows: [] }, { pending: { index: 400 } }, { extra: "untrusted" }]) {
      const attrs = structuredClone(review.sessionAttributes!);
      Object.assign(attrs.kinCare, patch);
      await handle(request("AMAZON.YesIntent", attrs));
    }
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["SessionEndedRequest", "unsupported-locale"])("clears private pending state on %s", async mode => {
    const { handle, care, review } = await prepare();
    const event = request("AMAZON.YesIntent", review.sessionAttributes);
    if (mode === "SessionEndedRequest") event.request.type = mode;
    else event.request.locale = "de-DE";
    const result = await handle(event);
    expect(result.sessionAttributes).toEqual({});
    expect(care.confirm).not.toHaveBeenCalled();
  });
});

describe("repeating a linked Echo conversation", () => {
  it.each(["first", "later"])("repeats the %s page after an authenticated read without renumbering or renewing it", async page => {
    const { handle, care, advance } = setup();
    const tasks = Array.from({ length: 7 }, (_, index) => ({ ...snapshot.tasks[0]!, id: `repeat-${index}`, title: `Check-in ${index}` }));
    care.today.mockResolvedValue({ ...snapshot, tasks, summary: { total: 7, completed: 0, remaining: 7, skipped: 0 } });
    const first = await handle(request());
    const listed = page === "later" ? await handle(request("NextTasksIntent", first.sessionAttributes)) : first;
    care.today.mockResolvedValue({ ...snapshot, tasks: [...tasks].reverse(), summary: { total: 7, completed: 0, remaining: 7, skipped: 0 } });
    advance(30_000);

    const repeated = await handle(request("AMAZON.RepeatIntent", listed.sessionAttributes));
    expect(speech(repeated)).toContain(`1. Check-in ${page === "later" ? 5 : 0}`);
    expect(speech(repeated)).toContain(page === "later" ? "2. Check-in 6" : "5. Check-in 4");
    expect(repeated.sessionAttributes).toEqual(listed.sessionAttributes);
    expect(care.today).toHaveBeenLastCalledWith("linked-token");
    expect(care.today).toHaveBeenCalledTimes(page === "later" ? 3 : 2);
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["MarkTaskDoneIntent", "MarkTaskNotYetIntent", "SkipTaskIntent"])("repeats a %s review without submitting or changing its confirmation identity", async name => {
    const { handle, care, review, advance } = await prepare(setup(), name);
    advance(30_000);
    const repeated = await handle(request("AMAZON.RepeatIntent", review.sessionAttributes));
    expect(speech(repeated)).toBe(speech(review));
    expect(repeated.sessionAttributes).toEqual(review.sessionAttributes);
    expect(care.today).toHaveBeenCalledTimes(2);
    expect(care.today).toHaveBeenLastCalledWith("linked-token");
    expect(care.confirm).not.toHaveBeenCalled();
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).toHaveBeenCalledExactlyOnceWith("linked-token", expect.objectContaining({
      taskId: "task-2", requestId: review.sessionAttributes!.kinCare.pending.requestId,
    }));
  });
  it.each(["missing", "session", "token", "user", "new", "expired list"])("does not repeat private text from %s conversation state", async change => {
    const { handle, care, review, advance } = await prepare();
    const event = request("AMAZON.RepeatIntent", change === "missing" ? {} : review.sessionAttributes);
    if (change === "session") event.session.sessionId = "another-session";
    if (change === "token") event.context.System.user.accessToken = "another-token";
    if (change === "user") event.context.System.user.userId = "another-user";
    if (change === "new") event.session.new = true;
    if (change === "expired list") advance(600_001);
    const repeated = await handle(event);
    expect(speech(repeated)).toContain("There isn't a current plan or review to repeat");
    expect(speech(repeated)).not.toMatch(/Morning water|Evening water/);
    expect(repeated.sessionAttributes).toEqual({});
    expect(care.today).toHaveBeenCalledTimes(1);
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("does not re-arm a confirmation that expired before repeat", async () => {
    const { handle, care, review, advance } = await prepare();
    advance(90_001);
    const repeated = await handle(request("AMAZON.RepeatIntent", review.sessionAttributes));
    expect(speech(repeated)).toContain("That confirmation expired");
    expect(speech(repeated)).not.toContain("Evening water");
    expect(repeated.sessionAttributes).toEqual({});
    expect(care.today).toHaveBeenCalledTimes(1);
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["review", "page"])("checks the %s lifetime again after the repeat read finishes", async mode => {
    const { handle, care, review, listed, advance } = await prepare();
    advance(mode === "review" ? 89_999 : 599_999);
    care.today.mockImplementation(async () => { advance(2); return structuredClone(snapshot); });
    const repeated = await handle(request("AMAZON.RepeatIntent", mode === "review" ? review.sessionAttributes : listed.sessionAttributes));
    expect(speech(repeated)).toContain(mode === "review" ? "That confirmation expired" : "There isn't a current plan or review to repeat");
    expect(speech(repeated)).not.toMatch(/Morning water|Evening water/);
    expect(care.today).toHaveBeenCalledTimes(2);
    expect(repeated.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["unauthenticated", "forbidden", "unavailable"] as const)("clears retained family text when the repeat read is %s", async code => {
    const { handle, care, review } = await prepare();
    care.today.mockRejectedValue(new EchoCareError(code));
    const repeated = await handle(request("AMAZON.RepeatIntent", review.sessionAttributes));
    expect(care.today).toHaveBeenCalledTimes(2);
    expect(speech(repeated)).toContain(code === "unauthenticated" ? "link your Kin account" : code === "forbidden" ? "doesn't currently have permission" : "couldn't load the family plan");
    expect(speech(repeated)).not.toMatch(/Morning water|Evening water/);
    expect(repeated.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it.each(["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy", "missing", "other row"])("requires a fresh review when a retained row's %s changes", async change => {
    const { handle, care, review } = await prepare();
    const changed = structuredClone(snapshot);
    const row = changed.tasks[change === "other row" ? 0 : 1]!;
    if (change === "title" || change === "other row") row.title = "Changed family check-in";
    if (change === "dueAt") row.dueAt = "2026-09-11T23:30:00.000Z";
    if (change === "state") row.state = "done";
    if (change === "lastResponse") row.lastResponse = "not_yet";
    if (change === "confirmedAt") row.confirmedAt = "2026-09-11T18:00:01.000Z";
    if (change === "confirmedBy") row.confirmedBy = "Another family member";
    if (change === "missing") changed.tasks.pop();
    care.today.mockResolvedValue(changed);
    const repeated = await handle(request("AMAZON.RepeatIntent", review.sessionAttributes));
    expect(speech(repeated)).toContain("The plan changed since I read that page");
    expect(speech(repeated)).not.toMatch(/Morning water|Evening water|Changed family/);
    expect(repeated.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).not.toHaveBeenCalled();
  });
  it("does not replay a saved result or submit again after save", async () => {
    const { handle, care, review } = await prepare();
    const saved = await handle(request("AMAZON.YesIntent", review.sessionAttributes));
    const repeated = await handle(request("AMAZON.RepeatIntent", saved.sessionAttributes));
    expect(speech(repeated)).toContain("There isn't a current plan or review to repeat");
    expect(speech(repeated)).not.toMatch(/Saved|Evening water/);
    expect(repeated.sessionAttributes).toEqual({});
    await handle(request("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(care.confirm).toHaveBeenCalledTimes(1);
    expect(care.today).toHaveBeenCalledTimes(1);
  });
  it.each(["page", "review"])("escapes hostile family text when repeating a %s", async mode => {
    const { handle, care } = setup();
    care.today.mockResolvedValue({ ...snapshot, tasks: snapshot.tasks.map(task => ({ ...task, title: 'Water & <audio src="https://bad.invalid"/>' })) });
    const listed = await handle(request());
    const previous = mode === "review" ? await handle(request("MarkTaskDoneIntent", listed.sessionAttributes, "2")) : listed;
    const repeated = await handle(request("AMAZON.RepeatIntent", previous.sessionAttributes));
    expect(speech(repeated)).toContain("Water &amp; &lt;audio");
    expect(speech(repeated)).not.toContain("<audio");
    if (mode === "review") expect(speech(repeated)).toContain("today at 11:00 PM UTC");
    expect(care.confirm).not.toHaveBeenCalled();
  });
});
