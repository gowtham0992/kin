import { describe, expect, it } from "vitest";
import { TaskNotFoundError, createDemoStore } from "../src/domain.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin care loop", () => {
  it("shows today's tasks in due-time order", async () => {
    const snapshot = await createDemoStore(fixedNow).today();
    expect(snapshot.tasks.map((task) => task.id)).toEqual([
      "morning-water",
      "afternoon-walk",
    ]);
    expect(snapshot.summary).toEqual({ total: 2, completed: 0, remaining: 2, skipped: 0 });
  });

  it("records a completed task and updates shared state", async () => {
    const store = createDemoStore(fixedNow);
    const result = await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Mom",
      requestId: "request-0001",
    });

    expect(result.replayed).toBe(false);
    expect(result.task.state).toBe("done");
    expect((await store.today()).summary).toEqual({ total: 2, completed: 1, remaining: 1, skipped: 0 });
  });

  it("makes confirmation retries idempotent", async () => {
    const store = createDemoStore(fixedNow);
    const input = {
      taskId: "morning-water",
      response: "done" as const,
      actor: "Mom",
      requestId: "request-0002",
    };

    const first = await store.confirm(input);
    const second = await store.confirm(input);
    expect(second.replayed).toBe(true);
    expect(second.confirmation.id).toBe(first.confirmation.id);
  });

  it("rejects an unknown task", async () => {
    const store = createDemoStore(fixedNow);
    await expect(
      store.confirm({
        taskId: "not-a-real-task",
        response: "done",
        actor: "Mom",
        requestId: "request-0003",
      }),
    ).rejects.toThrow(TaskNotFoundError);
  });
});
