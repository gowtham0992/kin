import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { InMemoryCareStore } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { scheduledTaskId } from "../src/care-plan.js";
import { createHttpApp } from "../src/http.js";
const now = () => new Date("2026-09-06T08:00:00Z");
const input = { id: "scheduled-test", title: "Call together", dueAt: "2026-09-06T12:00:00.000Z" };
describe("care plan scheduling", () => {
  it("refuses a truncated activity window instead of presenting a partial plan", async () => {
    const store = new DynamoCareRepository({ client: { send: async () => ({ Items: [], LastEvaluatedKey: { PK: "more" } }) }, tableName: "test-care", circleId: "test", now });
    await expect(store.activityBetween({ startDate: "2026-09-06", endDate: "2026-10-06" })).rejects.toThrow("completely");
  });
  it("creates one shared task across retries and rejects changed input under the same identity", async () => {
    const store = new InMemoryCareStore([], now);
    await store.scheduleTask(input); await store.scheduleTask(input);
    expect((await store.today()).tasks).toEqual([{ ...input, state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null }]);
    await expect(store.scheduleTask({ ...input, title: "Different" })).rejects.toThrow("different task");
    expect(scheduledTaskId("maya", "request-1")).not.toBe(scheduledTaskId("theo", "request-1"));
  });
  it.each(["2026-09-06T08:00:00Z", "2026-09-05T08:00:00Z", "2026-10-07T08:00:00Z", "invalid"])("rejects invalid scheduling time %s", async dueAt => {
    const store = new InMemoryCareStore([], now);
    await expect(store.scheduleTask({ ...input, dueAt })).rejects.toThrow("next 30 days");
    expect((await store.today()).tasks).toEqual([]);
  });
  it("requires caregiver permission and rejects arbitrary record fields at the HTTP boundary", async () => {
    const store = new InMemoryCareStore([], now);
    const find = vi.fn(async () => ({ circleId: "test", memberId: "maya", name: "Maya", role: "viewer", status: "active" }));
    const app = createHttpApp(store, undefined, { familyAccess: { circleId: "test", directory: { find } }, accessAuthorizer: { async authorize() { return { subject: "test", scopes: new Set(["mcp:tools"]), claims: { iss: "https://test.example" } }; } } });
    const body = { title: input.title, dueAt: input.dueAt, requestId: "schedule-request" };
    await request(app).post("/api/tasks").send(body).expect(403);
    find.mockResolvedValue({ circleId: "test", memberId: "maya", name: "Maya", role: "caregiver", status: "active" });
    await request(app).post("/api/tasks").send({ ...body, state: "done" }).expect(400);
    await request(app).post("/api/tasks").send(body).expect(200);
    await request(app).post("/api/tasks").send(body).expect(200);
    const plan = await request(app).get("/api/plan").expect(200);
    expect(plan.body.tasks).toHaveLength(1);
    expect(plan.body.tasks[0].title).toBe(input.title);
  });
  it("writes the task and scheduling receipt atomically and recovers a concurrent retry", async () => {
    let existing: unknown;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: existing };
      if (command instanceof TransactWriteCommand) {
        existing = command.input.TransactItems![1]!.Put!.Item;
        throw Object.assign(new Error("concurrent retry"), { name: "TransactionCanceledException" });
      }
      throw new Error("Unexpected operation");
    });
    const store = new DynamoCareRepository({ client: { send }, tableName: "test-care", circleId: "test", now });
    const task = await store.scheduleTask(input);
    expect(task.title).toBe(input.title);
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)![0] as TransactWriteCommand;
    expect(transaction.input.TransactItems!.map(item => item.Put?.ConditionExpression)).toEqual(["attribute_not_exists(PK)", "attribute_not_exists(PK)"]);
    expect(transaction.input.TransactItems![0]!.Put!.Item!.SK).toBe(`TASK#${input.dueAt}#${input.id}`);
    expect(transaction.input.TransactItems![1]!.Put!.Item!.SK).toBe(`PLAN_REQUEST#${input.id}`);
  });
});
