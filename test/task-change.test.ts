import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { taskChangeBody, TaskChangeConflict, type TaskChange } from "../src/task-change.js";
import { planMissedTaskEscalations } from "../src/escalation.js";

const now = new Date("2026-09-08T15:00:00.000Z");
const future: CareTask = { id: "single-water", title: "Drink water", dueAt: "2026-09-08T16:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null };
const change = (task = future): TaskChange => ({ taskId: task.id, action: "rename", title: "Bring a glass of water", expected: { title: task.title, dueAt: task.dueAt }, requestId: "one-off-change-1", actor: "Maya", confirm: true });

describe("reviewed one-off check-in changes", () => {
  it("replays the original creation after a later rename without restoring the old task", async () => {
    const store = new InMemoryCareStore([], () => now);
    const scheduled = { id: future.id, title: future.title, dueAt: future.dueAt };
    const original = await store.scheduleTask(scheduled);
    await store.changeTask(change());
    expect(await store.scheduleTask(scheduled)).toEqual(original);
    expect((await store.today()).tasks[0]!.title).toBe("Bring a glass of water");
  });

  it("renames only the reviewed check-in and replays after the task changes again or the clock advances", async () => {
    let clock = now;
    const store = new InMemoryCareStore([future], () => clock);
    const first = await store.changeTask(change());
    expect(first).toEqual({ requestId: "one-off-change-1", taskId: future.id, action: "rename", changed: 1 });
    const renamed = (await store.today()).tasks[0]!;
    expect(renamed).toMatchObject({ title: "Bring a glass of water", dueAt: future.dueAt, changedBy: "Maya", changedAt: now.toISOString() });
    await store.changeTask({ ...change(renamed), title: "Fill the blue glass", requestId: "one-off-change-2" });
    clock = new Date("2026-09-10T15:00:00.000Z");
    expect(await store.changeTask({ ...change(), actor: "Maya Chen" })).toEqual(first);
    expect((await store.activityBetween({ startDate: "2026-09-08", endDate: "2026-09-08" })).tasks[0]!.title).toBe("Fill the blue glass");
  });

  it("retains a cancelled check-in in history but excludes it from Today and future escalation", async () => {
    const store = new InMemoryCareStore([future], () => now);
    const { title: _title, ...input } = change();
    await store.changeTask({ ...input, action: "cancel" });
    expect((await store.today()).tasks).toEqual([]);
    const history = await store.activityBetween({ startDate: "2026-09-08", endDate: "2026-09-08" });
    expect(history.tasks).toMatchObject([{ id: future.id, state: "cancelled", title: future.title, changedBy: "Maya" }]);
    expect(planMissedTaskEscalations({ snapshot: { ...await store.today(), tasks: history.tasks }, now: new Date("2026-09-09T15:00:00Z") })).toEqual({ events: [], blocked: [] });
    await expect(store.confirm({ taskId: future.id, response: "done", actor: "Evelyn", requestId: "cannot-resurrect" })).rejects.toThrow("Care task not found");
  });

  it.each([
    { state: "done", lastResponse: "done" }, { state: "skipped", lastResponse: "skipped" }, { state: "cancelled" },
    { lastResponse: "not_yet" }, { confirmedBy: "Evelyn" }, { confirmedAt: now.toISOString() },
    { dueAt: now.toISOString() }, { dueAt: "2026-09-08T14:59:59.999Z" }, { routineId: "care-routine" },
  ])("rejects an ineligible current task %j without changing it", async fields => {
    const task = { ...future, ...fields } as CareTask;
    const store = new InMemoryCareStore([task], () => now);
    await expect(store.changeTask(change(task))).rejects.toBeInstanceOf(TaskChangeConflict);
    expect((await store.activityBetween({ startDate: "2026-09-08", endDate: "2026-09-08" })).tasks[0]).toEqual(task);
  });

  it("rejects stale review and changed intent under a used request identity", async () => {
    const store = new InMemoryCareStore([future], () => now);
    await expect(store.changeTask({ ...change(), expected: { ...change().expected, title: "Stale wording" } })).rejects.toBeInstanceOf(TaskChangeConflict);
    await store.changeTask(change());
    await expect(store.changeTask({ ...change(), title: "Different intent" })).rejects.toBeInstanceOf(TaskChangeConflict);
    await expect(store.changeTask({ ...change(), taskId: "another-task" })).rejects.toBeInstanceOf(TaskChangeConflict);
    const { title: _title, ...cancel } = change();
    await expect(store.changeTask({ ...cancel, action: "cancel" })).rejects.toBeInstanceOf(TaskChangeConflict);
  });

  it.each([
    { action: "cancel", title: "Unexpected" }, { action: "rename", title: " " }, { confirm: false },
    { dueAt: "2026-10-01T00:00:00.000Z" }, { actor: "Forged" }, { role: "caregiver" }, { requestId: "short" },
  ])("rejects unsupported body fields or values %j", async patch => {
    const { taskId: _id, actor: _actor, ...body } = change();
    expect(taskChangeBody.safeParse({ ...body, ...patch }).success).toBe(false);
  });

  it("requires caregiver membership and explicit confirmation, scopes receipts, and attributes to the signed-in caregiver", async () => {
    const store = new InMemoryCareStore([future], () => now);
    let role = "viewer";
    const find = vi.fn(async () => ({ circleId: "family-a", memberId: "maya", name: "Maya", role, status: "active" }));
    const app = createHttpApp(store, undefined, { accessAuthorizer: { async authorize() { return { subject: "account-maya", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } }; } },
      familyAccess: { circleId: "family-a", directory: { find } } });
    const { taskId, actor: _actor, ...body } = change();
    const send = (input: Record<string, unknown>) => request(app).post(`/api/tasks/${taskId}/change`).set("authorization", "Bearer synthetic").send(input);
    await send(body).expect(403); role = "care_recipient"; await send(body).expect(403); role = "caregiver";
    await send({ ...body, confirm: false }).expect(400); await send({ ...body, actor: "Forged" }).expect(400);
    const response = await send(body).expect(200);
    expect(response.body).toEqual({ requestId: body.requestId, taskId, action: "rename", changed: 1 });
    expect((await store.today()).tasks[0]!.changedBy).toBe("Maya");
    expect((await send(body).expect(200)).body).toEqual(response.body);
    await send({ ...body, title: "Another request" }).expect(409);
    role = "viewer"; await send(body).expect(403);
  });
});
