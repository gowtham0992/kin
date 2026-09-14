import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { TaskChangeConflict, taskChangeBody, type TaskChange } from "../src/task-change.js";

const now = new Date("2026-09-13T15:00:00.000Z");
const original: CareTask = { id: "one-off", title: "A call together", dueAt: "2026-09-13T17:00:00.000Z",
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const move: TaskChange = { taskId: original.id, action: "reschedule", dueAt: "2026-09-13T19:00:00.000Z",
  expected: { title: original.title, dueAt: original.dueAt }, requestId: "member-scoped-move-1", actor: "Synthetic caregiver", confirm: true };
const window = { startDate: "2026-09-13", endDate: "2026-09-13" };

describe("reviewed one-off rescheduling", () => {
  it("atomically retains the canceled original and creates a fresh linked occurrence", async () => {
    const store = new InMemoryCareStore([original], () => now);
    const result = await store.changeTask(move);
    expect(result).toMatchObject({ taskId: original.id, action: "reschedule", changed: 1,
      replacement: { taskId: expect.not.stringMatching(/^one-off$/), dueAt: move.dueAt } });
    const history = (await store.activityBetween(window)).tasks;
    expect(history).toHaveLength(2);
    expect(history.find(task => task.id === original.id)).toMatchObject({ ...original, state: "cancelled",
      rescheduledTo: result.replacement, changedBy: move.actor, changedAt: now.toISOString() });
    expect((await store.today()).tasks).toEqual([{ id: result.replacement!.taskId, title: original.title,
      dueAt: move.dueAt, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null,
      rescheduledFrom: { taskId: original.id, dueAt: original.dueAt } }]);
  });

  it("replays after the replacement changes and the clock advances without recreating either occurrence", async () => {
    let clock = now;
    const store = new InMemoryCareStore([], () => clock);
    const created = await store.scheduleTask({ id: original.id, title: original.title, dueAt: original.dueAt });
    const result = await store.changeTask(move);
    await store.changeTask({ taskId: result.replacement!.taskId, action: "rename", title: "A changed call",
      expected: { title: original.title, dueAt: move.dueAt! }, requestId: "replacement-rename", actor: move.actor, confirm: true });
    clock = new Date("2026-09-15T15:00:00.000Z");
    expect(await store.changeTask({ ...move, actor: "Renamed caregiver" })).toEqual(result);
    expect(await store.scheduleTask({ id: original.id, title: original.title, dueAt: original.dueAt })).toEqual(created);
    const history = (await store.activityBetween(window)).tasks;
    expect(history).toHaveLength(2);
    expect(history.find(task => task.id === original.id)?.state).toBe("cancelled");
    expect(history.find(task => task.id === result.replacement!.taskId)?.title).toBe("A changed call");
    await expect(store.changeTask({ ...move, dueAt: "2026-09-13T20:00:00.000Z" })).rejects.toBeInstanceOf(TaskChangeConflict);
  });

  it.each([original.dueAt, now.toISOString(), "2026-10-14T15:00:00.000Z", "not-a-date"])("rejects the new time %s without canceling the original", async dueAt => {
    const store = new InMemoryCareStore([original], () => now);
    await expect(store.changeTask({ ...move, dueAt })).rejects.toThrow();
    expect((await store.activityBetween(window)).tasks).toEqual([original]);
  });

  it.each([{ routineId: "finite-routine" }, { lastResponse: "not_yet" as const }, { state: "done" as const },
    { dueAt: now.toISOString() }])("preserves an ineligible original %j", async patch => {
    const task = { ...original, ...patch }, store = new InMemoryCareStore([task], () => now);
    await expect(store.changeTask({ ...move, expected: { title: task.title, dueAt: task.dueAt } })).rejects.toBeInstanceOf(TaskChangeConflict);
    expect((await store.activityBetween(window)).tasks).toEqual([task]);
  });

  it("admits only the reschedule time and explicit review at the request boundary", () => {
    const { taskId: _task, actor: _actor, ...body } = move;
    expect(taskChangeBody.safeParse(body).success).toBe(true);
    for (const patch of [{ dueAt: undefined }, { title: "Also rename" }, { confirm: false }, { actor: "Forged" },
      { dueAt: "2026-09-13T19:00:00Z" }, { action: "cancel" }, { action: "rename", title: "New title" }]) {
      expect(taskChangeBody.safeParse({ ...body, ...patch }).success).toBe(false);
    }
  });
});
