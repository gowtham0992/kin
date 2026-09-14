import type { ResponseEnvelope } from "ask-sdk-model";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createEchoCareClient } from "../src/echo-care-client.js";
import { createEchoHandler } from "../src/echo-lambda.js";
import { createHttpApp } from "../src/http.js";
import type { Membership } from "../src/membership.js";
import { taskReview } from "../src/task-review.js";

const skillId = "amzn1.ask.skill.00000000-0000-0000-0000-000000000001";
const issuer = "https://synthetic-kin.example", endpoint = `${issuer}/mcp`;
const token = "synthetic-linked-echo-account-token";
const instant = Date.parse("2026-09-11T16:00:00.000Z");
const tasks: CareTask[] = [
  { id: "water", title: "Morning water", dueAt: "2026-09-11T17:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null },
  { id: "walk", title: "Afternoon walk", dueAt: "2026-09-11T20:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null },
];
type Frame = { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
const speech = (response: ResponseEnvelope) => (response.response.outputSpeech as { ssml: string }).ssml;

function fixture(role: Membership["role"] = "caregiver", undoEnabled = false, pauseEnabled = false) {
  let time = instant, sequence = 0, loseUndoResponse = false, losePauseResponse = false;
  const membership = { circleId: "synthetic-circle", memberId: "maya", name: "Maya", role, status: "active" };
  const store = new InMemoryCareStore(tasks, () => new Date(time));
  // These spies still run the real repository implementation, including review,
  // membership, member-scoped receipts and duplicate-delivery behavior.
  const confirms = vi.spyOn(store, "confirm");
  const undos = vi.spyOn(store, "undoCompletion");
  const pauses = vi.spyOn(store, "acceptPlanPause");
  const app = createHttpApp(store, undefined, {
    serveSimulator: false, mcpAuthMode: "standard", canonicalMcpUri: endpoint, authorizationServer: issuer,
    accessAuthorizer: { async authorize(header, scopes) {
      if (header !== `Bearer ${token}`) throw new AccessDeniedError(401, "invalid_token");
      if (scopes.some(scope => scope !== "mcp:tools")) throw new AccessDeniedError(403, "insufficient_scope");
      return { subject: "synthetic-family-account", claims: { iss: issuer, client_id: "synthetic-echo-client" }, scopes: new Set(["mcp:tools"]) };
    } },
    familyAccess: { circleId: membership.circleId, directory: { async find(principal) {
      expect(principal.subject).toBe("synthetic-family-account");
      return { ...membership };
    } } },
  });
  const frames: Frame[] = [];
  const fetch = async (url: string | URL | Request, init: RequestInit = {}) => {
    expect(String(url)).toBe(endpoint);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    const frame = JSON.parse(String(init.body)) as Frame;
    frames.push(structuredClone(frame));
    const outgoing = request(app).post("/mcp");
    headers.forEach((value, name) => outgoing.set(name, value));
    const incoming = await outgoing.send(frame);
    if (loseUndoResponse && frame.params?.name === "undo_care_completion") throw new Error("Synthetic lost undo response");
    if (losePauseResponse && frame.params?.name === "pause_care_plan") throw new Error("Synthetic lost pause response");
    return new Response(incoming.status === 202 ? null : incoming.text, { status: incoming.status, headers: incoming.headers as Record<string, string> });
  };
  const care = createEchoCareClient(endpoint, { fetch });
  const handle = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true",
    KIN_ECHO_UNDO_ENABLED: String(undoEnabled), KIN_ECHO_PLAN_PAUSE_ENABLED: String(pauseEnabled) }, { care, now: () => time });
  function event(name?: string, attributes: object = {}, number?: string) {
    return { version: "1.0", session: { new: !name, sessionId: "synthetic-echo-session", application: { applicationId: skillId }, attributes },
      context: { System: { application: { applicationId: skillId }, user: { userId: "synthetic-amazon-user", accessToken: token } } },
      request: { type: name ? "IntentRequest" : "LaunchRequest", requestId: `synthetic-utterance-${++sequence}`, timestamp: new Date(time).toISOString(), locale: "en-US",
        ...(name ? { intent: { name, ...(number ? { slots: { taskNumber: { name: "taskNumber", value: number } } } : {}) } } : {}) } };
  }
  async function review(name = "MarkTaskDoneIntent") {
    const listed = await handle(event());
    expect(speech(listed)).toContain("1. Morning water");
    expect(speech(listed)).toContain("2. Afternoon walk");
    const reviewed = await handle(event(name, listed.sessionAttributes, "2"));
    expect(speech(reviewed)).toContain("Afternoon walk");
    expect(speech(reviewed)).toContain("Say yes or no");
    expect(confirms).not.toHaveBeenCalled();
    expect((await store.today()).tasks).toEqual(tasks);
    return reviewed;
  }
  return { store, membership, handle, event, review, frames, confirms, undos, pauses,
    loseUndoResponse: () => { loseUndoResponse = true; }, losePauseResponse: () => { losePauseResponse = true; },
    advance: (milliseconds: number) => { time += milliseconds; } };
}

describe("real Echo one-week pause journey", () => {
  it("reviews count, end and next remaining occurrence before one atomic replay-safe pause", async () => {
    const f = fixture("care_recipient", false, true);
    await f.store.scheduleTask({ id: "next", title: "Later <check-in>", dueAt: "2026-09-20T17:00:00.000Z" });
    const reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    expect(speech(reviewed)).toContain("cancels 2 untouched future check-ins");
    expect(speech(reviewed)).toContain("September 18");
    expect(speech(reviewed)).toContain("Later &lt;check-in&gt;");
    expect(speech(reviewed)).toContain("won't be moved or caught up");
    expect(f.pauses).not.toHaveBeenCalled();
    const yes = f.event("AMAZON.YesIntent", reviewed.sessionAttributes);
    const saved = await f.handle(yes);
    expect(speech(saved)).toContain("Paused until"); expect(saved.sessionAttributes).toEqual({});
    expect((await f.store.today()).tasks).toHaveLength(0);
    expect((await f.store.planControl()).pause).toMatchObject({ actor: "Maya" });
    await f.handle(yes);
    expect((await f.pauses.mock.results[1]!.value).replayed).toBe(true);
    expect((await f.store.planControl()).version).toBe(2);
    expect(f.frames.filter(frame => frame.method === "tools/call").every(frame => ["review_plan_pause", "pause_care_plan"].includes(frame.params!.name!))).toBe(true);
    await f.handle(f.event("AMAZON.YesIntent", saved.sessionAttributes));
    expect(f.pauses).toHaveBeenCalledTimes(2);
  });
  it.each(["AMAZON.NoIntent", "AMAZON.CancelIntent", "AMAZON.StopIntent", "TodayPlanIntent", "AMAZON.FallbackIntent", "AMAZON.RepeatIntent"])("disarms a pause review on %s without extending old consent", async name => {
    const f = fixture("care_recipient", false, true), reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    const disarmed = await f.handle(f.event(name, reviewed.sessionAttributes));
    await f.handle(f.event("AMAZON.YesIntent", disarmed.sessionAttributes));
    expect(f.pauses).not.toHaveBeenCalled();
  });
  it.each(["session", "user", "token", "new", "expired"])("rejects a pause Yes after %s changes", async mode => {
    const f = fixture("care_recipient", false, true), reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    const yes = f.event("AMAZON.YesIntent", reviewed.sessionAttributes);
    if (mode === "session") yes.session.sessionId = "other";
    if (mode === "user") yes.context.System.user.userId = "other";
    if (mode === "token") yes.context.System.user.accessToken = "other";
    if (mode === "new") yes.session.new = true;
    if (mode === "expired") f.advance(90_001);
    await f.handle(yes); expect(f.pauses).not.toHaveBeenCalled();
  });
  it("does not offer or read a pause when the Echo gate is off", async () => {
    const f = fixture("care_recipient");
    const result = await f.handle(f.event("PausePlanWeekIntent"));
    expect(speech(result)).toContain("isn't available here yet"); expect(f.frames).toHaveLength(0);
  });
  it.each(["viewer", "revoked", "foreign"])("denies a %s account before pause data is read or written", async mode => {
    const f = fixture("care_recipient", false, true);
    if (mode === "viewer") f.membership.role = "viewer";
    if (mode === "revoked") f.membership.status = "revoked";
    if (mode === "foreign") f.membership.circleId = "elsewhere";
    const result = await f.handle(f.event("PausePlanWeekIntent"));
    expect(speech(result)).toContain("doesn't currently have permission");
    expect(f.pauses).not.toHaveBeenCalled();
  });
  it("rejects a changed review and does not apply a partial pause", async () => {
    const f = fixture("care_recipient", false, true), reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    await f.store.scheduleTask({ id: "another", title: "Another", dueAt: "2026-09-20T17:00:00.000Z" });
    const result = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(result)).toContain("pause review changed or expired");
    expect((await f.store.today()).tasks).toHaveLength(2); expect((await f.store.planControl()).pause).toBeUndefined();
  });
  it("reports an unknown outcome after a committed response is lost without retrying", async () => {
    const f = fixture("care_recipient", false, true), reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    f.losePauseResponse();
    const result = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(result)).toContain("couldn't verify whether the pause was saved");
    expect(speech(result)).not.toContain("haven't applied"); expect(f.pauses).toHaveBeenCalledTimes(1);
    expect((await f.store.planControl()).pause).toBeDefined(); expect(result.sessionAttributes).toEqual({});
  });
  it("speaks an existing pause honestly without generating another write", async () => {
    const f = fixture("care_recipient", false, true), reviewed = await f.handle(f.event("PausePlanWeekIntent"));
    await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    const status = await f.handle(f.event("PausePlanWeekIntent"));
    expect(speech(status)).toContain("already paused until"); expect(f.pauses).toHaveBeenCalledTimes(1);
    expect(status.sessionAttributes).toEqual({});
  });
});

describe("real Echo completion undo journey", () => {
  async function savedCompletion() {
    const f = fixture("care_recipient", true);
    const reviewed = await f.review();
    const saved = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(saved)).toContain("Say undo last completion");
    expect(saved.sessionAttributes?.kinCare.pending).toBeUndefined();
    expect(saved.sessionAttributes?.kinCare.pendingUndo).toBeUndefined();
    return { ...f, saved };
  }
  it("freshly reviews and undoes the exact completion once, retaining its original audit receipt", async () => {
    const f = await savedCompletion();
    const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
    expect(speech(reviewed)).toContain("Undo done for Afternoon walk");
    expect(speech(reviewed)).toContain("restore not confirmed");
    expect(speech(reviewed)).toContain("Canceled reminders won't restart");
    expect(f.undos).not.toHaveBeenCalled();
    const repeated = await f.handle(f.event("AMAZON.RepeatIntent", reviewed.sessionAttributes));
    expect(repeated.sessionAttributes).toEqual(reviewed.sessionAttributes);
    const yes = f.event("AMAZON.YesIntent", repeated.sessionAttributes);
    const undone = await f.handle(yes);
    expect(speech(undone)).toContain("Undid the completion for Afternoon walk");
    expect(undone.sessionAttributes).toEqual({});
    expect((await f.store.today()).tasks).toEqual(tasks);
    await f.handle(yes);
    expect((await f.undos.mock.results[1]!.value).replayed).toBe(true);
    expect((await f.store.today()).tasks).toEqual(tasks);
    expect(f.confirms).toHaveBeenCalledTimes(1);
    expect(f.frames.filter(frame => frame.method === "tools/call").every(frame => ["show_today", "confirm_care_task", "undo_care_completion"].includes(frame.params!.name!))).toBe(true);
  });
  it("does not treat an extra yes after saving as consent to undo", async () => {
    const f = await savedCompletion();
    const result = await f.handle(f.event("AMAZON.YesIntent", f.saved.sessionAttributes));
    expect(result.sessionAttributes).toEqual({});
    expect(f.undos).not.toHaveBeenCalled();
    expect((await f.store.today()).tasks[1]?.state).toBe("done");
  });
  it.each(["AMAZON.NoIntent", "AMAZON.CancelIntent", "AMAZON.StopIntent", "TodayPlanIntent", "AMAZON.FallbackIntent"])("disarms an undo review on %s", async name => {
    const f = await savedCompletion();
    const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
    const disarmed = await f.handle(f.event(name, reviewed.sessionAttributes));
    await f.handle(f.event("AMAZON.YesIntent", disarmed.sessionAttributes));
    expect(f.undos).not.toHaveBeenCalled();
  });
  it.each(["session", "user", "token", "new", "expired review"])("does not undo after %s changes", async change => {
    const f = await savedCompletion();
    const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
    const yes = f.event("AMAZON.YesIntent", reviewed.sessionAttributes);
    if (change === "session") yes.session.sessionId = "different-session";
    if (change === "user") yes.context.System.user.userId = "another-alexa-user";
    if (change === "token") yes.context.System.user.accessToken = "other-token";
    if (change === "new") yes.session.new = true;
    if (change === "expired review") f.advance(90_001);
    await f.handle(yes);
    expect(f.undos).not.toHaveBeenCalled();
  });
  it("does not renew an undo review that expires during repeat's plan read", async () => {
    const f = await savedCompletion();
    const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
    f.advance(90_001);
    const repeated = await f.handle(f.event("AMAZON.RepeatIntent", reviewed.sessionAttributes));
    expect(repeated.sessionAttributes).toEqual({});
    expect(speech(repeated)).not.toContain("Afternoon walk");
    await f.handle(f.event("AMAZON.YesIntent", repeated.sessionAttributes));
    expect(f.undos).not.toHaveBeenCalled();
  });
  it("rejects a changed plan or lost membership at the undo write boundary", async () => {
    for (const change of ["plan", "membership"]) {
      const f = await savedCompletion();
      const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
      if (change === "membership") f.membership.status = "revoked";
      else await f.store.confirm({ taskId: "walk", response: "skipped", actor: "Other caregiver", requestId: "later-care-response",
        expected: taskReview((await f.store.today()).tasks[1]!) });
      const result = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
      expect(speech(result)).not.toContain("Undid");
      expect((await f.store.today()).tasks[1]?.state).toBe(change === "plan" ? "skipped" : "done");
      expect(result.sessionAttributes).toEqual({});
    }
  });
  it("does not claim or retry an undo after its committed response is lost", async () => {
    const f = await savedCompletion();
    const reviewed = await f.handle(f.event("UndoLastCompletionIntent", f.saved.sessionAttributes));
    f.loseUndoResponse();
    const result = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(result)).toContain("couldn't verify whether that completion was undone");
    expect(result.sessionAttributes).toEqual({});
    expect((await f.store.today()).tasks).toEqual(tasks);
    expect(f.undos).toHaveBeenCalledTimes(1);
    await f.handle(f.event("AMAZON.YesIntent", result.sessionAttributes));
    expect(f.undos).toHaveBeenCalledTimes(1);
  });
});

describe("real Echo to MCP care journey", () => {
  it("reads the plan, reviews a numbered task, commits as the current member, and replays the same Yes only once", async () => {
    const f = fixture();
    const reviewed = await f.review();
    // A display-name change between review and Yes must use current server-owned
    // membership, not anything retained in the Echo session or the tool actor.
    f.membership.name = "Maya Updated";
    const yes = f.event("AMAZON.YesIntent", reviewed.sessionAttributes);
    const saved = await f.handle(yes);
    expect(speech(saved)).toContain("Saved done for Afternoon walk");
    expect(saved.sessionAttributes).toEqual({});
    expect(f.confirms).toHaveBeenCalledTimes(1);
    const first = await f.confirms.mock.results[0]!.value;
    expect(first).toMatchObject({ replayed: false, confirmation: { taskId: "walk", actor: "Maya Updated", response: "done", recordedAt: new Date(instant).toISOString() } });
    expect(first.confirmation.requestId).toMatch(/^member_[a-f0-9]{64}$/);
    const committed = await f.store.today();
    expect(committed.summary).toEqual({ total: 2, completed: 1, remaining: 1, skipped: 0 });
    expect(committed.tasks[1]).toMatchObject({ id: "walk", state: "done", lastResponse: "done", confirmedBy: "Maya Updated" });
    expect(committed.tasks[0]).toEqual(tasks[0]);

    f.advance(1000);
    const replayed = await f.handle(structuredClone(yes));
    expect(speech(replayed)).toContain("Saved done for Afternoon walk");
    expect(f.confirms).toHaveBeenCalledTimes(2);
    const second = await f.confirms.mock.results[1]!.value;
    expect(second.replayed).toBe(true);
    expect(second.confirmation).toEqual(first.confirmation);
    expect(await f.store.today()).toEqual(committed);
    const writes = f.frames.filter(frame => frame.params?.name === "confirm_care_task");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.params!.arguments).toEqual(writes[1]!.params!.arguments);
    expect(writes[0]!.params!.arguments).toMatchObject({ actor: "Linked Kin account", requestId: expect.stringMatching(/^echo_[a-f0-9]{64}$/) });
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it("clears a declined review and never dispatches a care write on No or a later Yes", async () => {
    const f = fixture(); const reviewed = await f.review();
    const declined = await f.handle(f.event("AMAZON.NoIntent", reviewed.sessionAttributes));
    expect(speech(declined)).toContain("haven't submitted a change");
    expect(declined.sessionAttributes).toEqual({});
    const unarmed = await f.handle(f.event("AMAZON.YesIntent", declined.sessionAttributes));
    expect(speech(unarmed)).toContain("There isn't a current check-in");
    expect(f.confirms).not.toHaveBeenCalled();
    expect(f.frames.some(frame => frame.params?.name === "confirm_care_task")).toBe(false);
    expect((await f.store.today()).tasks).toEqual(tasks);
  });

  it("rechecks membership after review and refuses a revoked member before any repository write", async () => {
    const f = fixture(); const reviewed = await f.review();
    f.membership.status = "revoked";
    const refused = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(refused)).toContain("doesn't currently have permission");
    expect(refused.sessionAttributes).toEqual({});
    expect(f.confirms).not.toHaveBeenCalled();
    expect((await f.store.today()).tasks).toEqual(tasks);
  });

  it("allows a viewer to hear the actual plan but refuses their reviewed confirmation", async () => {
    const f = fixture("viewer"); const reviewed = await f.review();
    const refused = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(refused)).toContain("doesn't currently have permission");
    expect(f.frames.some(frame => frame.params?.name === "show_today")).toBe(true);
    expect(f.frames.some(frame => frame.params?.name === "confirm_care_task")).toBe(true);
    expect(f.confirms).not.toHaveBeenCalled();
    expect((await f.store.today()).tasks).toEqual(tasks);
  });

  it.each(["rename", "family_response"])("does not overwrite a %s change made after the spoken review", async change => {
    const f = fixture(); const reviewed = await f.review();
    f.advance(1000);
    if (change === "rename") {
      await f.store.changeTask({ taskId: "walk", action: "rename", title: "Short afternoon walk", actor: "Theo",
        expected: { title: tasks[1]!.title, dueAt: tasks[1]!.dueAt }, requestId: "synthetic-family-rename", confirm: true });
    } else {
      await f.store.confirm({ taskId: "walk", response: "not_yet", actor: "Theo", requestId: "synthetic-family-response", expected: taskReview(tasks[1]!) });
    }
    const familyUpdate = await f.store.today();
    const result = await f.handle(f.event("AMAZON.YesIntent", reviewed.sessionAttributes));
    expect(speech(result)).toContain("That check-in changed");
    expect(speech(result)).toContain("haven't saved this response");
    expect(result.sessionAttributes).toEqual({});
    expect(await f.store.today()).toEqual(familyUpdate);
    expect(familyUpdate.tasks[1]).toMatchObject(change === "rename"
      ? { title: "Short afternoon walk", state: "scheduled", lastResponse: null }
      : { state: "scheduled", lastResponse: "not_yet", confirmedBy: "Theo" });
  });
});
