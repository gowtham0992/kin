import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { TaskChangeConflict, type TaskChange } from "../src/task-change.js";
import type { CareWriteAuthorization } from "../src/care-write-authorization.js";

const now = new Date("2026-09-08T15:00:00.000Z");
const task = { id: "single-water", title: "Drink water", dueAt: "2026-09-08T16:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const input: TaskChange = { taskId: task.id, action: "cancel", expected: { title: task.title, dueAt: task.dueAt }, actor: "Maya", requestId: "single-change-1", confirm: true };
const row = { ...task, PK: "CIRCLE#family-a", SK: `TASK#${task.dueAt}#${task.id}`, entityType: "CareTask" };

function fixture(mode: "normal" | "lost" | "race" | "conflict" = "normal", stored = row) {
  let receipt: Record<string, unknown> | undefined;
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.Key!.PK).toBe("CIRCLE#family-a");
      return { Item: command.input.Key!.SK === row.SK ? structuredClone(stored) : structuredClone(receipt) };
    }
    if (command instanceof TransactWriteCommand) {
      if (mode !== "conflict") receipt = structuredClone(command.input.TransactItems!.find(item => item.Put?.Item?.entityType === "TaskChange")!.Put!.Item!);
      if (mode === "lost") throw new Error("Synthetic committed but response lost");
      if (mode === "race" || mode === "conflict") throw Object.assign(new Error("Synthetic write conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] });
      return {};
    }
    throw new Error("Unexpected storage operation");
  });
  const store = new DynamoCareRepository({ client: { send }, tableName: "synthetic", circleId: "family-a", now: () => now });
  return { store, send };
}

describe("Dynamo one-off check-in changes", () => {
  it("atomically cancels the reviewed occurrence, puts a fresh linked replacement, and guards membership", async () => {
    const { store, send } = fixture("normal", { ...row, responseVersion: "private-old-response" } as typeof row);
    const move: TaskChange = { ...input, action: "reschedule", dueAt: "2026-09-09T18:00:00.000Z" };
    const authorization: CareWriteAuthorization = { member: { circleId: "family-a", memberId: "maya", name: "Maya", role: "caregiver", status: "active" },
      key: { PK: row.PK, SK: "MEMBER#maya" }, assertCurrent: vi.fn(async () => {}) };
    const result = await store.changeTask(move, authorization);
    const command = send.mock.calls.map(([command]) => command).find(command => command instanceof TransactWriteCommand) as TransactWriteCommand;
    const [old, replacement, receipt, control, membership] = command.input.TransactItems!;
    expect(command.input.TransactItems).toHaveLength(5);
    expect(control!.Put).toMatchObject({ Item: { SK: "PLAN_CONTROL", version: 1 }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(old!.Update).toMatchObject({ Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: "SET #state = :value, changedAt = :now, changedBy = :actor, rescheduledTo = :replacement",
      ExpressionAttributeValues: { ":value": "cancelled", ":replacement": result.replacement } });
    expect(old!.Update!.ConditionExpression).toContain("lastResponse = :untouched");
    expect(old!.Update!.ConditionExpression).toContain("attribute_not_exists(routineId)");
    expect(replacement!.Put).toEqual({ TableName: "synthetic", ConditionExpression: "attribute_not_exists(PK)", Item: {
      ...task, id: result.replacement!.taskId, dueAt: move.dueAt,
      rescheduledFrom: { taskId: task.id, dueAt: task.dueAt }, PK: row.PK,
      SK: `TASK#${move.dueAt}#${result.replacement!.taskId}`, entityType: "CareTask" } });
    expect(receipt!.Put!.Item).toMatchObject({ input: move, result, entityType: "TaskChange" });
    expect(receipt!.Put!.Item).not.toHaveProperty("expiresAt");
    expect(membership!.ConditionCheck!.Key).toEqual(authorization.key);
  });

  it.each(["lost", "race"] as const)("recovers reschedule after a %s response without another cancellation or replacement", async mode => {
    const { store, send } = fixture(mode);
    const move: TaskChange = { ...input, action: "reschedule", dueAt: "2026-09-09T18:00:00.000Z" };
    if (mode === "lost") await expect(store.changeTask(move)).rejects.toThrow("response lost");
    else await expect(store.changeTask(move)).resolves.toHaveProperty("replacement");
    expect(await store.changeTask(move)).toMatchObject({ replacement: { dueAt: move.dueAt } });
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
    await expect(store.changeTask({ ...move, dueAt: "2026-09-10T18:00:00.000Z" })).rejects.toBeInstanceOf(TaskChangeConflict);
  });

  it("rejects invalid replacement timing before issuing a transaction", async () => {
    const { store, send } = fixture();
    await expect(store.changeTask({ ...input, action: "reschedule", dueAt: task.dueAt })).rejects.toBeInstanceOf(RangeError);
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("renames the title without modifying the due time or recorded response", async () => {
    const { store, send } = fixture();
    const rename: TaskChange = { ...input, action: "rename", title: "Bring the blue glass" };
    expect(await store.changeTask(rename)).toMatchObject({ taskId: task.id, action: "rename", changed: 1 });
    const command = send.mock.calls.map(([command]) => command).find(command => command instanceof TransactWriteCommand) as TransactWriteCommand;
    expect(command.input.TransactItems![0]!.Update!.UpdateExpression).toBe("SET title = :value, changedAt = :now, changedBy = :actor");
    expect(command.input.TransactItems![0]!.Update!.ExpressionAttributeValues?.[":value"]).toBe("Bring the blue glass");
    expect(command.input.TransactItems![1]!.Put!.Item!.input).toEqual(rename);
  });

  it.each([undefined, "TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError", "ValidationError"])("preserves an uncertain storage failure %s instead of releasing the retry identity", async code => {
    const failure = Object.assign(new Error("Synthetic storage failure"), { name: "TransactionCanceledException",
      ...(code ? { CancellationReasons: [{ Code: code }, { Code: "None" }] } : {}) });
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: command.input.Key!.SK === row.SK ? row : undefined };
      throw failure;
    });
    const store = new DynamoCareRepository({ client: { send }, tableName: "synthetic", circleId: "family-a", now: () => now });
    await expect(store.changeTask(input)).rejects.toBe(failure);
  });

  it("recovers a matching winner that commits between the first receipt read and task read", async () => {
    let receiptReads = 0;
    const result = { requestId: input.requestId, taskId: task.id, action: input.action, changed: 1 };
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof GetCommand)) throw new Error("Must not write twice");
      if (command.input.Key!.SK === row.SK) return { Item: { ...row, state: "cancelled" } };
      return { Item: ++receiptReads === 1 ? undefined : { PK: row.PK, SK: `TASK_CHANGE#${input.requestId}`, entityType: "TaskChange", input, result } };
    });
    const store = new DynamoCareRepository({ client: { send }, tableName: "synthetic", circleId: "family-a", now: () => now });
    expect(await store.changeTask(input)).toEqual(result);
    expect(receiptReads).toBe(2);
    expect(send.mock.calls).toHaveLength(3);
  });

  it.each([{ PK: "CIRCLE#other" }, { SK: "TASK_CHANGE#other" }, { entityType: "Other" }, { result: { changed: 0 } }, { input: { ...input, taskId: "other-task" } }])("rejects corrupt receipt bindings %j without loading or updating a task", async patch => {
    const receipt = { PK: row.PK, SK: `TASK_CHANGE#${input.requestId}`, entityType: "TaskChange", input,
      result: { requestId: input.requestId, taskId: task.id, action: input.action, changed: 1 }, ...patch };
    const send = vi.fn(async () => ({ Item: receipt }));
    const store = new DynamoCareRepository({ client: { send }, tableName: "synthetic", circleId: "family-a", now: () => now });
    await expect(store.changeTask(input)).rejects.toBeInstanceOf(TaskChangeConflict);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("atomically guards the exact reviewed task and commits a permanent receipt without querying a daily view", async () => {
    const { store, send } = fixture();
    expect(await store.changeTask(input)).toEqual({ taskId: task.id, action: "cancel", changed: 1, requestId: input.requestId });
    const command = send.mock.calls.map(([command]) => command).find(command => command instanceof TransactWriteCommand) as TransactWriteCommand;
    const [update, receipt] = command.input.TransactItems!;
    expect(command.input.TransactItems).toHaveLength(3);
    expect(command.input.TransactItems![2]!.Put).toMatchObject({ Item: { SK: "PLAN_CONTROL", version: 1 }, ConditionExpression: "attribute_not_exists(PK)" });
    expect(update!.Update).toMatchObject({ Key: { PK: row.PK, SK: row.SK },
      ConditionExpression: "id = :id AND #state = :scheduled AND lastResponse = :untouched AND confirmedAt = :untouched AND confirmedBy = :untouched AND title = :oldTitle AND dueAt = :dueAt AND dueAt > :now AND attribute_not_exists(routineId)",
      ExpressionAttributeValues: { ":id": task.id, ":scheduled": "scheduled", ":untouched": null, ":oldTitle": task.title, ":dueAt": task.dueAt, ":now": now.toISOString(), ":value": "cancelled", ":actor": "Maya" },
    });
    expect(receipt!.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)", Item: { PK: row.PK, SK: `TASK_CHANGE#${input.requestId}`, input } });
    expect(receipt!.Put!.Item).not.toHaveProperty("expiresAt");
    expect(await store.changeTask({ ...input, actor: "Maya Chen" })).toEqual({ taskId: task.id, action: "cancel", changed: 1, requestId: input.requestId });
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
  });

  it.each(["lost", "race"] as const)("recovers the stored result after a %s response without a second mutation", async mode => {
    const { store, send } = fixture(mode);
    if (mode === "lost") await expect(store.changeTask(input)).rejects.toThrow("response lost");
    else await expect(store.changeTask(input)).resolves.toMatchObject({ changed: 1 });
    expect(await store.changeTask(input)).toMatchObject({ taskId: task.id, changed: 1 });
    expect(send.mock.calls.filter(([command]) => command instanceof TransactWriteCommand)).toHaveLength(1);
    await expect(store.changeTask({ ...input, action: "rename", title: "Different intent" })).rejects.toBeInstanceOf(TaskChangeConflict);
  });

  it("returns a conflict when the conditional write loses without a matching receipt", async () => {
    const { store } = fixture("conflict");
    await expect(store.changeTask(input)).rejects.toBeInstanceOf(TaskChangeConflict);
  });

  it.each([{ PK: "CIRCLE#other-family" }, { id: "another-task" }, { SK: "TASK#another-key" }, { entityType: "AnotherEntity" }, { title: "Changed after review" }, { state: "done" }])("refuses a mismatched stored task %j before a transaction", async patch => {
    const { store, send } = fixture("normal", { ...row, ...patch });
    await expect(store.changeTask(input)).rejects.toBeInstanceOf(TaskChangeConflict);
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
});
