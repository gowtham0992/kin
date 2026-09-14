import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../src/http.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { AccessDeniedError } from "../src/auth.js";
import { taskReview } from "../src/task-review.js";
import type { Membership } from "../src/membership.js";

const task: CareTask = { id: "water", title: "Morning water", dueAt: "2026-09-13T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
function fixture() {
  const store = new InMemoryCareStore([task], () => new Date("2026-09-13T16:00:00.000Z"));
  const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: "care_recipient", status: "active" };
  const app = createHttpApp(store, undefined, {
    accessAuthorizer: { async authorize(header) {
      if (header !== "Bearer synthetic") throw new AccessDeniedError(401, "invalid_token");
      return { subject: "subject", claims: { iss: "https://synthetic.invalid" }, scopes: new Set(["mcp:tools"]) };
    } }, familyAccess: { circleId: "family", directory: { async find() { return member; } } },
  });
  const post = (path: string, body: object) => request(app).post(path).set("authorization", "Bearer synthetic").send(body);
  return { store, member, app, post };
}
async function prepare() {
  const f = fixture();
  const saved = await f.post(`/api/tasks/${task.id}/confirm`, { expected: taskReview(task), response: "done", actor: "ignored", requestId: "original-completion" }).expect(201);
  const body = { confirmationRequestId: saved.body.confirmation.requestId, requestId: "undo-completion", expected: taskReview(saved.body.task), restore: taskReview(task), confirm: true };
  return { ...f, saved, body };
}
describe("authenticated completion undo HTTP boundary", () => {
  it("advertises the bounded feature and records one reviewed undo with replay-safe response", async () => {
    const f = await prepare();
    const session = await request(f.app).get("/api/session").set("authorization", "Bearer synthetic").expect(200);
    expect(session.body.features).toEqual({ completionUndo: true, completionUndoWindowSeconds: 300 });
    const undone = await f.post("/api/tasks/water/undo", f.body).expect(201);
    expect(undone.body).toMatchObject({ task, replayed: false, undo: { confirmationRequestId: "original-completion", requestId: "undo-completion", actor: "Parent" } });
    const replay = await f.post("/api/tasks/water/undo", f.body).expect(200);
    expect(replay.body).toEqual({ ...undone.body, replayed: true });
    expect((await f.store.today()).tasks).toEqual([task]);
  });
  it.each(["viewer", "other-member", "other-circle"])("rejects undo by %s without changing the completion", async mode => {
    const f = await prepare();
    if (mode === "viewer") f.member.role = "viewer";
    if (mode === "other-member") f.member.memberId = "other-account";
    if (mode === "other-circle") f.member.circleId = "other-family";
    await f.post("/api/tasks/water/undo", f.body).expect(mode === "other-member" ? 409 : 403);
    expect((await f.store.today()).tasks[0]?.state).toBe("done");
  });
  it("rejects missing authentication and malformed or unconfirmed restoration", async () => {
    const f = await prepare();
    await request(f.app).post("/api/tasks/water/undo").send(f.body).expect(401);
    await f.post("/api/tasks/water/undo", { ...f.body, confirm: false }).expect(400);
    await f.post("/api/tasks/water/undo", { ...f.body, actor: "Someone else" }).expect(400);
    await f.post("/api/tasks/water/undo", { ...f.body, restore: { ...f.body.restore, title: "different" } }).expect(409);
    expect((await f.store.today()).tasks[0]?.state).toBe("done");
  });
  it("neither advertises nor accepts undo while the backend gate is off", async () => {
    const f = await prepare();
    Object.defineProperty(f.store, "completionUndoEnabled", { value: false });
    const session = await request(f.app).get("/api/session").set("authorization", "Bearer synthetic").expect(200);
    expect(session.body.features).toBeUndefined();
    await f.post("/api/tasks/water/undo", f.body).expect(404);
  });
  it("does not provide an unauthenticated simulator undo shortcut", async () => {
    const f = fixture();
    const app = createHttpApp(f.store);
    await request(app).post("/api/tasks/water/undo").send({}).expect(401);
  });
});
