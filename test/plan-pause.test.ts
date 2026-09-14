import { describe, expect, it } from "vitest";
import { makePauseWindow, proposePlanPause, acceptPlanPause, assertTaskOutsidePause, replayPlanPause,
  planPauseBody, PlanPauseConflict, type PlanPauseSnapshot } from "../src/plan-pause.js";
import type { CareTask } from "../src/domain.js";

const now = new Date("2026-09-13T16:00:00.000Z");
const task = (id: string, dueAt: string, extra: Partial<CareTask> = {}): CareTask => ({ id, title: id, dueAt,
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null, ...extra });
const window = makePauseWindow(now);
function snapshot(tasks: CareTask[] = [task("water", "2026-09-14T16:00:00.000Z")]): PlanPauseSnapshot {
  return { circleId: "test-circle", timeZone: "America/Denver", control: { version: 0 }, tasks };
}
function input(proposal = proposePlanPause(snapshot(), window)) {
  return { startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken,
    requestId: "pause-request-001", confirm: true as const, actor: "Test caregiver" };
}

describe("reviewed one-week pause", () => {
  it("reviews only future untouched occurrences and names the next unchanged check-in", () => {
    const state = snapshot([
      task("future", "2026-09-21T16:00:00.000Z"), task("old", "2026-09-13T15:00:00.000Z"),
      task("replied", "2026-09-15T16:00:00.000Z", { lastResponse: "not_yet", confirmedBy: "Test", confirmedAt: now.toISOString() }),
      task("complete", "2026-09-16T16:00:00.000Z", { state: "done", lastResponse: "done" }),
      task("water", "2026-09-14T16:00:00.000Z"), task("at-end", window.endsAt), task("at-start", window.startsAt),
    ]);
    const proposal = proposePlanPause(state, window);
    expect(proposal.tasks.map(row => row.id)).toEqual(["water"]);
    expect(proposal.nextTask?.id).toBe("at-end");
    expect(proposal.durationHours).toBe(168);
    expect(proposal.expiresAt).toBe("2026-09-13T16:05:00.000Z");
    expect(proposal.timeZone).toBe("America/Denver");
  });
  it("cancels atomically selected tasks without shifting or completing them and preserves history", () => {
    const state = snapshot(), original = structuredClone(state), proposal = proposePlanPause(state, window);
    const result = acceptPlanPause(state, input(proposal), new Date(now.getTime() + 60_000));
    expect(state).toEqual(original);
    expect(result.cancelledTasks[0]).toMatchObject({ id: "water", state: "cancelled", lastResponse: null,
      dueAt: state.tasks[0]!.dueAt, changedBy: "Test caregiver" });
    expect(result.control.version).toBe(1);
    expect(result.control.pause).toMatchObject({ startsAt: window.startsAt, endsAt: window.endsAt, requestId: "pause-request-001" });
    expect(result.receipt.cancelled).toEqual([{ id: "water", title: "water", dueAt: state.tasks[0]!.dueAt }]);
    expect(result.receipt.nextTask).toBeNull();
  });
  it("allows an empty finite plan to be paused, still fencing new scheduling", () => {
    const state = snapshot([]), proposal = proposePlanPause(state, window);
    expect(acceptPlanPause(state, input(proposal), now).cancelledTasks).toEqual([]);
  });
  it.each(["version", "title", "dueAt", "response", "new-task"])("rejects changed review basis: %s", change => {
    const state = snapshot(), request = input(proposePlanPause(state, window));
    if (change === "version") state.control.version++;
    if (change === "title") state.tasks[0]!.title = "changed";
    if (change === "dueAt") state.tasks[0]!.dueAt = "2026-09-15T16:00:00.000Z";
    if (change === "response") state.tasks[0]!.lastResponse = "not_yet";
    if (change === "new-task") state.tasks.push(task("new", "2026-09-15T16:00:00.000Z"));
    expect(() => acceptPlanPause(state, request, now)).toThrow(PlanPauseConflict);
  });
  it.each([-1, 300_001])( "rejects reviews accepted outside their lifetime (%s ms)", delta => {
    expect(() => acceptPlanPause(snapshot(), input(), new Date(now.getTime() + delta))).toThrow(PlanPauseConflict);
  });
  it("requires a fresh review if a selected task becomes due while reviewing", () => {
    const state = snapshot([task("soon", "2026-09-13T16:01:00.000Z")]);
    const request = input(proposePlanPause(state, window));
    expect(() => acceptPlanPause(state, request, new Date("2026-09-13T16:01:00.000Z"))).toThrow(PlanPauseConflict);
  });
  it("has a fixed elapsed duration across daylight-saving changes, displayed with the circle time zone", () => {
    for (const at of ["2026-03-06T16:00:00.000Z", "2026-10-30T16:00:00.000Z"]) {
      const period = makePauseWindow(new Date(at));
      expect(Date.parse(period.endsAt) - Date.parse(period.startsAt)).toBe(168 * 3_600_000);
      expect(proposePlanPause(snapshot([]), period).timeZone).toBe("America/Denver");
    }
  });
  it("fails closed above the cancellation/read bounds rather than partially pausing", () => {
    expect(() => proposePlanPause(snapshot(Array.from({ length: 26 }, (_, i) => task(`t${i}`, "2026-09-14T16:00:00.000Z"))), window)).toThrow(PlanPauseConflict);
    expect(() => proposePlanPause(snapshot(Array.from({ length: 501 }, (_, i) => task(`t${i}`, "2026-09-22T16:00:00.000Z"))), window)).toThrow(PlanPauseConflict);
  });
  it("rejects duplicate identities, invalid control versions, malformed times, and active overlapping pauses", () => {
    const bad = [snapshot([task("x", window.endsAt), task("x", window.endsAt)]), snapshot([task("bad", "invalid")])];
    bad.push({ ...snapshot(), control: { version: -1 } });
    const accepted = acceptPlanPause(snapshot(), input(), now);
    bad.push({ ...snapshot(), control: accepted.control });
    for (const value of bad) expect(() => proposePlanPause(value, window)).toThrow(PlanPauseConflict);
  });
  it("blocks scheduling and reopening within the half-open paused interval, including overdue reopenings", () => {
    const control = acceptPlanPause(snapshot(), input(), now).control;
    for (const at of [window.startsAt, "2026-09-14T16:00:00.000Z"]) {
      expect(() => assertTaskOutsidePause(control, at)).toThrow(PlanPauseConflict);
    }
    expect(() => assertTaskOutsidePause(control, window.endsAt)).not.toThrow();
    expect(() => assertTaskOutsidePause(control, "2026-09-13T15:59:59.999Z")).not.toThrow();
    expect(() => assertTaskOutsidePause({ version: 0 }, window.startsAt)).not.toThrow();
  });
  it("replays an exact saved receipt after expiry without changing the interval or cancelling again", () => {
    const request = input(), result = acceptPlanPause(snapshot(), request, now);
    const receipt = { input: request, result };
    const replay = replayPlanPause(receipt, { ...request, actor: "Renamed caregiver" });
    expect(replay).toEqual({ ...result, replayed: true });
    expect(replayPlanPause(receipt, request)).not.toBe(result);
    expect(() => replayPlanPause(receipt, { ...request, requestId: "another-request" })).toThrow(PlanPauseConflict);
    expect(() => replayPlanPause(receipt, { ...request, endsAt: "2026-09-21T16:00:00.000Z" })).toThrow(PlanPauseConflict);
    const broken = structuredClone(receipt); broken.result.cancelledTasks = [];
    expect(() => replayPlanPause(broken, request)).toThrow(PlanPauseConflict);
    const reordered = structuredClone(receipt);
    reordered.result.control.pause = Object.fromEntries(Object.entries(reordered.result.control.pause!).reverse()) as typeof reordered.result.control.pause;
    reordered.result.receipt.cancelled = reordered.result.receipt.cancelled.map(reference => ({ dueAt: reference.dueAt, title: reference.title, id: reference.id }));
    expect(replayPlanPause(reordered, request)).toMatchObject({ replayed: true });
  });
  it("fails closed rather than overflowing the plan version", () => {
    const state = snapshot(); state.control.version = Number.MAX_SAFE_INTEGER;
    expect(() => acceptPlanPause(state, input(proposePlanPause(state, window)), now)).toThrow(PlanPauseConflict);
  });
  it("validates explicit consent, exact fixed-duration timestamps, and unknown input fields", () => {
    const { actor: _, ...body } = input();
    expect(planPauseBody.safeParse(body).success).toBe(true);
    for (const value of [{ ...body, confirm: false }, { ...body, actor: "spoof" }, { ...body, endsAt: body.startsAt },
      { ...body, startsAt: "2026-09-13T16:00:00Z" }, { ...body, reviewToken: "anything" }]) {
      expect(planPauseBody.safeParse(value).success).toBe(false);
    }
  });
});
