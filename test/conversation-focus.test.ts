import { describe, expect, it } from "vitest";
import request from "supertest";
import { createConversationFocus } from "../src/conversation-focus.js";
import { createDemoStore } from "../src/domain.js";
import { taskReview } from "../src/task-review.js";
import { createHttpApp } from "../src/http.js";

describe("short-lived task context", () => {
  it("allows a follow-up proposal but never writes or treats yes as confirmation", async () => {
    const store = createDemoStore(() => new Date("2026-09-02T08:00:00Z"));
    const app = createHttpApp(store);
    const first = await request(app).post("/demo/conversation").send({ message: "done: Drink a glass of water" });
    const second = await request(app).post("/demo/conversation").send({ message: "actually not yet", contextToken: first.body.contextToken });
    expect(second.body).toMatchObject({ action: "confirm", response: "not_yet", taskId: "morning-water" });
    expect((await store.today()).summary.completed).toBe(0);
    const yes = await request(app).post("/demo/conversation").send({ message: "yes", contextToken: second.body.contextToken });
    expect(yes.body.action).toBe("clarify");
  });
  it("forgets expired context and rejects context after a family update", async () => {
    let now = 0;
    const focus = createConversationFocus(() => now);
    const store = createDemoStore(() => new Date("2026-09-02T08:00:00Z"));
    const snapshot = await store.today();
    const task = snapshot.tasks[0]!;
    const token = focus.remember(task.id, taskReview(task));
    expect(focus.resolve(token, snapshot)).toBe(task.id);
    now = 300_000;
    expect(focus.resolve(token, snapshot)).toBeUndefined();
    const fresh = focus.remember(task.id, taskReview(task));
    await store.confirm({ taskId: task.id, response: "not_yet", actor: "Maya", requestId: "context-change-1" });
    expect(focus.resolve(fresh, await store.today())).toBeUndefined();
  });
});
