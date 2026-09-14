import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../src/http.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { AccessDeniedError } from "../src/auth.js";
import type { Membership } from "../src/membership.js";
import { PlanPauseConflict } from "../src/plan-pause.js";
import { taskReview } from "../src/task-review.js";

const start = Date.parse("2026-09-13T16:00:00.000Z");
const instant = (hours: number) => new Date(start + hours * 3_600_000).toISOString();
const tasks: CareTask[] = [1, 2, 192].map((hours, n) => ({ id: `task-${n}`, title: `Check-in ${n}`, dueAt: instant(hours), state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null }));
function fixture() {
  let time = start;
  const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };
  const store = new InMemoryCareStore(tasks, () => new Date(time));
  const apply = vi.spyOn(store, "acceptPlanPause");
  const app = createHttpApp(store, undefined, {
    accessAuthorizer: { async authorize(header) {
      if (header !== "Bearer synthetic") throw new AccessDeniedError(401, "invalid_token");
      return { subject: "subject", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
    } }, familyAccess: { circleId: "family", directory: { async find() { return member; } } },
  });
  const post = (path: string, body: object) => request(app).post(path).set("authorization", "Bearer synthetic").send(body);
  const get = (path: string) => request(app).get(path).set("authorization", "Bearer synthetic");
  return { store, member, app, apply, post, get, advance: (ms: number) => { time += ms; } };
}
async function prepare() {
  const f = fixture(), { body } = await f.get("/api/plan/pause").expect(200);
  return { ...f, proposal: body.proposal, input: { startsAt: body.proposal.startsAt, endsAt: body.proposal.endsAt,
    reviewToken: body.proposal.reviewToken, requestId: "pause-http-request", confirm: true } };
}
describe("reviewed one-week pause memory and HTTP boundary", () => {
  it.each(["care_recipient", "caregiver"] as const)("allows %s to review and atomically pause without plan-management authority", async role => {
    const f = await prepare(); f.member.role = role;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.proposal.tasks).toHaveLength(2);
    expect(f.proposal.nextTask.id).toBe("task-2");
    const session = await f.get("/api/session").expect(200); expect(session.body.permissions.pausePlan).toBe(true);
    const saved = await f.post("/api/plan/pause", f.input).expect(201);
    expect(saved.body.receipt).toMatchObject({ requestId: f.input.requestId, actor: "Parent", startsAt: instant(0), endsAt: instant(168) });
    expect(saved.body.control.pause.requestId).toBe(f.input.requestId);
    expect(f.apply.mock.calls[0]![0].requestId).toMatch(/^member_[a-f0-9]{64}$/);
    expect((await f.get("/api/plan/pause")).body.proposal).toBeNull();
    expect((await f.get("/api/plan")).body.tasks.map((t: CareTask) => t.state)).toEqual(["cancelled", "cancelled", "scheduled"]);
    f.advance(300_001);
    const replay = await f.post("/api/plan/pause", f.input).expect(200);
    expect(replay.body).toEqual({ ...saved.body, replayed: true });
    expect((await f.store.planControl()).version).toBe(1);
  });
  it.each(["viewer", "foreign", "revoked"])("denies %s for REST review and apply and MCP before repository dispatch", async mode => {
    const f = await prepare();
    if (mode === "viewer") f.member.role = "viewer";
    if (mode === "foreign") f.member.circleId = "elsewhere";
    if (mode === "revoked") Object.assign(f.member, { status: "revoked" });
    await f.get("/api/plan/pause").expect(403);
    await f.post("/api/plan/pause", f.input).expect(403);
    for (const name of ["review_plan_pause", "pause_care_plan"]) await f.post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: name === "pause_care_plan" ? f.input : {} } }).expect(403);
    expect(f.apply).not.toHaveBeenCalled();
    expect((await f.store.today()).tasks).toHaveLength(2);
  });
  it("requires authentication even in a local simulator", async () => {
    const f = await prepare();
    await request(f.app).get("/api/plan/pause").expect(401);
    await request(f.app).post("/api/plan/pause").send(f.input).expect(401);
    const local = createHttpApp(f.store);
    await request(local).get("/api/plan/pause").expect(401);
    await request(local).post("/api/plan/pause").send(f.input).expect(401);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it.each([{ confirm: false }, { actor: "Forged" }, { endsAt: instant(24) }, { reviewToken: "bad" }, { requestId: "bad" }])("rejects malformed/unreviewed consent %j", async patch => {
    const f = await prepare(); await f.post("/api/plan/pause", { ...f.input, ...patch }).expect(400);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("scopes permanent retries to the current member rather than the display name", async () => {
    const f = await prepare(); await f.post("/api/plan/pause", f.input).expect(201);
    f.member.name = "Renamed parent"; await f.post("/api/plan/pause", f.input).expect(200);
    f.member.memberId = "other-member"; await f.post("/api/plan/pause", f.input).expect(409);
    expect((await f.store.planControl()).version).toBe(1);
  });
  it.each(["expired", "new-task", "response", "rename"])("rejects a %s review without partial cancellation", async change => {
    const f = await prepare();
    if (change === "expired") f.advance(300_001);
    if (change === "new-task") await f.store.scheduleTask({ id: "new-task", title: "new", dueAt: instant(240) });
    if (change === "response") await f.store.confirm({ taskId: "task-0", response: "done", requestId: "changed-response", actor: "Parent" });
    if (change === "rename") await f.store.changeTask({ taskId: "task-2", action: "rename", title: "Changed next", requestId: "rename-task", expected: { title: tasks[2]!.title, dueAt: instant(192) }, actor: "Parent", confirm: true });
    await f.post("/api/plan/pause", f.input).expect(409, { error: "pause_conflict" });
    expect((await f.store.activityBetween({ startDate: "2026-09-13", endDate: "2026-10-13" })).tasks.some(task => task.state === "cancelled")).toBe(false);
  });
  it("keeps stored pause status and scheduling protection visible after disabling new pause requests", async () => {
    const f = await prepare(); await f.post("/api/plan/pause", f.input).expect(201);
    Object.defineProperty(f.store, "planPauseEnabled", { value: false });
    const plan = await f.get("/api/plan").expect(200);
    expect(plan.body.features.planPause).toBe(false); expect(plan.body.planPause.pause.endsAt).toBe(instant(168));
    await f.get("/api/plan/pause").expect(404); await f.post("/api/plan/pause", f.input).expect(404);
    await expect(f.store.scheduleTask({ id: "no", title: "No", dueAt: instant(4) })).rejects.toBeInstanceOf(PlanPauseConflict);
  });
  it("does not reopen a completion inside a pause or grant a fresh not-yet grace", async () => {
    const f = fixture();
    const saved = await f.store.confirm({ taskId: "task-0", response: "done", requestId: "done-receipt", actor: "Parent" });
    const proposal = (await f.store.proposePlanPause())!;
    await f.store.acceptPlanPause({ startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken,
      requestId: "pause-direct", actor: "Parent", confirm: true });
    await expect(f.store.undoCompletion({ taskId: "task-0", confirmationRequestId: "done-receipt", requestId: "undo-receipt", actor: "Parent", confirm: true,
      expected: taskReview(saved.task), restore: taskReview(tasks[0]!) })).rejects.toBeInstanceOf(PlanPauseConflict);
    await expect(f.store.confirm({ taskId: "task-0", response: "not_yet", requestId: "notyet-receipt", actor: "Parent" })).rejects.toBeInstanceOf(PlanPauseConflict);
  });
});
