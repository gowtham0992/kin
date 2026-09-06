import { describe, expect, it, vi } from "vitest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { routineTasks } from "../src/care-plan.js";
const now = () => new Date("2026-09-06T08:00:00Z");
const routine = { id: "routine", title: "Call together", timeZone: "UTC", dueAts: ["2026-09-07T12:00:00.000Z", "2026-09-08T12:00:00.000Z"] };
const tasks = routineTasks(routine, now());
const change = { routineId: routine.id, action: "cancel" as const, requestId: "cancel-request", confirm: true as const, actor: "Maya",
  expected: tasks.map(({ id, title, dueAt }) => ({ id, title, dueAt })) };
describe("DynamoDB routine changes", () => {
  it("atomically guards each task against a response, title change or cancellation and stores a retry receipt", async () => {
    let receipt: unknown;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) {
        const sk = String(command.input.Key!.SK);
        if (sk.startsWith("ROUTINE_CHANGE#")) return { Item: receipt };
        if (sk.startsWith("ROUTINE_REQUEST#")) return { Item: { tasks } };
        return { Item: tasks.find(task => sk.endsWith(`#${task.id}`)) };
      }
      if (command instanceof TransactWriteCommand) {
        receipt = command.input.TransactItems!.at(-1)!.Put!.Item;
        throw Object.assign(new Error("concurrent winner"), { name: "TransactionCanceledException" });
      }
      throw new Error("Unexpected command");
    });
    const store = new DynamoCareRepository({ tableName: "test", circleId: "test", client: { send }, now });
    expect(await store.changeRoutine(change)).toEqual({ requestId: "cancel-request", changed: 2 });
    expect(await store.changeRoutine(change)).toEqual({ requestId: "cancel-request", changed: 2 });
    await expect(store.changeRoutine({ ...change, actor: "Someone else" })).rejects.toThrow("routine changed");
    const writes = send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand);
    expect(writes).toHaveLength(1);
    const items = (writes[0]![0] as TransactWriteCommand).input.TransactItems!;
    expect(items).toHaveLength(3);
    for (const item of items.slice(0, 2)) {
      expect(item.Update).toMatchObject({
        ConditionExpression: "#state = :scheduled AND lastResponse = :untouched AND title = :oldTitle AND dueAt > :now AND routineId = :routine",
        ExpressionAttributeValues: { ":scheduled": "scheduled", ":untouched": null, ":oldTitle": "Call together", ":value": "cancelled", ":actor": "Maya" },
      });
    }
    expect(items.at(-1)!.Put!.ConditionExpression).toBe("attribute_not_exists(PK)");
  });
  it("fails closed when one occurrence is missing", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand && String(command.input.Key!.SK).startsWith("ROUTINE_REQUEST#")) return { Item: { tasks } };
      return {};
    });
    const store = new DynamoCareRepository({ tableName: "test", circleId: "test", client: { send }, now });
    await expect(store.changeRoutine(change)).rejects.toThrow("routine changed");
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
});
