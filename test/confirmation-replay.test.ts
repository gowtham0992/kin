import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { createHttpApp } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import { confirmWithReceipt } from "../src/confirmation.js";
import { taskReview } from "../src/task-review.js";
import type { Membership } from "../src/membership.js";

const beforeMidnight = "2026-09-03T05:59:59.000Z";
const afterMidnight = "2026-09-03T06:00:00.000Z";
const task = { PK: "CIRCLE#family-1", SK: "TASK#2026-09-03T05:40:00.000Z#late-water", entityType: "CareTask",
  id: "late-water", title: "Water", dueAt: "2026-09-03T05:40:00.000Z", state: "scheduled",
  lastResponse: null, confirmedBy: null, confirmedAt: null };
const input = { taskId: task.id, response: "done" as const, actor: "Maya", requestId: "confirmation-replay-1" };
const receipt = { PK: task.PK, SK: `CONFIRMATION#${input.requestId}`, entityType: "Confirmation",
  id: `confirmation_${input.requestId}`, ...input, recordedAt: beforeMidnight };

class ReplayDynamo {
  rows = new Map<string, Record<string, unknown>>();
  commands: Array<GetCommand | QueryCommand | TransactWriteCommand> = [];
  raceReceipt: Record<string, unknown> | null = null;
  partial = false;
  constructor(rows: Record<string, unknown>[]) { for (const row of rows) this.put(row); }
  put(row: Record<string, unknown>) { this.rows.set(String(row.SK), structuredClone(row)); }
  async send(command: GetCommand | QueryCommand | TransactWriteCommand) {
    this.commands.push(command);
    if (command instanceof GetCommand) return { Item: this.rows.get(String(command.input.Key?.SK)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: [...this.rows.values()].filter(row => row.PK === values[":pk"] && String(row.SK) >= values[":start"] && String(row.SK) <= values[":end"]),
        ...(this.partial ? { LastEvaluatedKey: { PK: task.PK, SK: task.SK } } : {}) };
    }
    if (this.raceReceipt) {
      this.put(this.raceReceipt); this.raceReceipt = null;
      throw Object.assign(new Error("Another request won"), { name: "TransactionCanceledException" });
    }
    for (const item of command.input.TransactItems ?? []) if (item.Put?.Item) this.put(item.Put.Item);
    return {};
  }
}
function dynamo(client: ReplayDynamo, instant = afterMidnight) {
  return new DynamoCareRepository({ client, tableName: "synthetic", circleId: "family-1", timeZone: "America/Denver", now: () => new Date(instant) });
}

describe("confirmation identity and historical replay", () => {
  it.each([{ taskId: "afternoon-walk" }, { response: "not_yet" as const }])("rejects changed intent for an existing memory request: %j", async change => {
    const store = createDemoStore(() => new Date("2026-09-02T16:00:00.000Z"));
    const original = { ...input, taskId: "morning-water" };
    await store.confirm(original);
    await expect(store.confirm({ ...original, ...change })).rejects.toMatchObject({ name: "ConfirmationConflict" });
    expect((await store.today()).tasks).toMatchObject([{ state: "done" }, { state: "scheduled" }]);
  });

  it("replays an exact reviewed memory request without undoing a later family response", async () => {
    const store = createDemoStore(() => new Date("2026-09-02T16:00:00.000Z"));
    const reviewed = (await store.today()).tasks[0]!;
    const originalInput = { ...input, taskId: reviewed.id, expected: taskReview(reviewed) };
    const original = await store.confirm(originalInput);
    await store.confirm({ ...originalInput, expected: undefined, response: "not_yet", actor: "Theo", requestId: "later-confirmation" });

    const replay = await store.confirm({ ...originalInput, actor: "Renamed Maya" });

    expect(replay).toMatchObject({ replayed: true, confirmation: original.confirmation,
      task: { state: "scheduled", lastResponse: "not_yet", confirmedBy: "Theo" } });
    expect(replay.confirmation.taskDueAt).toBe(reviewed.dueAt);
  });

  it("persists the exact task identity and replays its current row after midnight without querying today", async () => {
    const client = new ReplayDynamo([task]);
    const original = await dynamo(client, beforeMidnight).confirm(input);
    expect(client.rows.get(receipt.SK)).toMatchObject({ taskDueAt: task.dueAt });
    client.put({ ...task, state: "skipped", lastResponse: "skipped", confirmedBy: "Theo", confirmedAt: afterMidnight });
    client.commands.length = 0;

    const result = await dynamo(client).confirm(input);

    expect(result.confirmation).toEqual(original.confirmation);
    expect(result).toMatchObject({ replayed: true, task: { id: task.id, dueAt: task.dueAt, state: "skipped", confirmedBy: "Theo" } });
    expect(result.task).not.toHaveProperty("PK");
    expect(client.commands).toHaveLength(2);
    expect(client.commands.every(command => command instanceof GetCommand && command.input.ConsistentRead === true)).toBe(true);
    expect(client.commands[1]!.input).toMatchObject({ Key: { PK: task.PK, SK: task.SK } });
  });

  it.each([beforeMidnight, afterMidnight])("recovers a legacy receipt independently of the current local day at %s", async instant => {
    const client = new ReplayDynamo([receipt, { ...task, state: "done", lastResponse: "done", confirmedBy: input.actor, confirmedAt: receipt.recordedAt }]);
    const result = await dynamo(client, instant).confirm(input);
    expect(result).toMatchObject({ replayed: true, confirmation: { requestId: input.requestId, recordedAt: beforeMidnight }, task: { id: task.id, dueAt: task.dueAt } });
    expect(client.commands.some(command => command instanceof TransactWriteCommand)).toBe(false);
    expect(client.commands.at(-1)?.input).toMatchObject({ Key: { PK: task.PK, SK: task.SK }, ConsistentRead: true });
    expect(client.commands[1]?.input).toMatchObject({ ConsistentRead: true, Limit: 501,
      ExpressionAttributeValues: { ":pk": task.PK, ":start": "TASK#2026-09-01T06:00:00.000Z", ":end": "TASK#2026-09-03T06:00:00.000Z" } });
  });

  it("uses the latest exact row after resolving a legacy save that crossed local midnight", async () => {
    const client = new ReplayDynamo([{ ...receipt, recordedAt: afterMidnight }, task]);
    const send = client.send.bind(client);
    client.send = async command => {
      const result = await send(command);
      if (command instanceof QueryCommand) client.put({ ...task, state: "skipped", lastResponse: "skipped", confirmedBy: "Theo", confirmedAt: afterMidnight });
      return result;
    };
    const result = await dynamo(client, "2026-09-20T16:00:00.000Z").confirm(input);
    expect(result).toMatchObject({ replayed: true, confirmation: { recordedAt: afterMidnight },
      task: { state: "skipped", lastResponse: "skipped", confirmedBy: "Theo" } });
    expect(result.confirmation).not.toHaveProperty("taskDueAt");
  });

  it("does not manufacture a current task when a committed receipt's exact row is missing", async () => {
    const client = new ReplayDynamo([{ ...receipt, taskDueAt: task.dueAt }]);
    await expect(dynamo(client).confirm(input)).rejects.toMatchObject({ name: "TaskNotFoundError" });
    expect(client.commands).toHaveLength(2);
    expect(client.commands[1]).toBeInstanceOf(GetCommand);
    expect(client.commands.some(command => command instanceof TransactWriteCommand)).toBe(false);
  });

  it.each([{ taskId: "other-task" }, { response: "not_yet" as const }])("rejects changed intent from a Dynamo receipt before loading its task: %j", async change => {
    const client = new ReplayDynamo([{ ...receipt, taskDueAt: task.dueAt }, task]);
    await expect(dynamo(client).confirm({ ...input, ...change })).rejects.toMatchObject({ name: "ConfirmationConflict" });
    expect(client.commands).toHaveLength(1);
  });

  it.each([{ taskId: "other-task" }, { response: "not_yet" as const }])("checks the winning receipt after a transaction race: %j", async change => {
    const otherTask = { ...task, id: "other-task", SK: `TASK#${task.dueAt}#other-task` };
    const client = new ReplayDynamo([task, otherTask]);
    client.raceReceipt = { ...receipt, taskDueAt: task.dueAt };
    await expect(dynamo(client, beforeMidnight).confirm({ ...input, ...change })).rejects.toMatchObject({ name: "ConfirmationConflict" });
    expect(client.commands.filter(command => command instanceof TransactWriteCommand)).toHaveLength(1);
    expect(client.rows.get(task.SK)?.state).toBe("scheduled");
  });

  it("recovers a matching race winner without replacing its original actor or timestamp", async () => {
    const client = new ReplayDynamo([task]);
    client.raceReceipt = { ...receipt, taskDueAt: task.dueAt };
    const result = await dynamo(client, beforeMidnight).confirm({ ...input, actor: "Renamed Maya" });
    expect(result).toMatchObject({ replayed: true, confirmation: { actor: "Maya", recordedAt: beforeMidnight } });
    expect(client.commands.at(-1)?.input).toMatchObject({ Key: { PK: task.PK, SK: task.SK }, ConsistentRead: true });
  });

  it.each([
    { receiptChange: { PK: "CIRCLE#foreign" }, taskChange: {} },
    { receiptChange: { requestId: "foreign-request" }, taskChange: {} },
    { receiptChange: { taskDueAt: "invalid-date" }, taskChange: {} },
    { receiptChange: { recordedAt: "invalid-date" }, taskChange: {} },
    { receiptChange: { entityType: "CareTask" }, taskChange: {} },
    { receiptChange: {}, taskChange: { id: "foreign-task" } },
    { receiptChange: {}, taskChange: { PK: "CIRCLE#foreign" } },
    { receiptChange: {}, taskChange: { entityType: "Confirmation" } },
    { receiptChange: {}, taskChange: { dueAt: "2026-09-03T06:40:00.000Z" } },
  ])("fails closed on corrupt receipt or task binding: %j", async ({ receiptChange, taskChange }) => {
    const client = new ReplayDynamo([{ ...receipt, taskDueAt: task.dueAt, ...receiptChange }, { ...task, ...taskChange }]);
    await expect(dynamo(client, beforeMidnight).confirm(input)).rejects.toThrow();
    expect(client.commands.some(command => command instanceof TransactWriteCommand)).toBe(false);
  });

  it.each(["ambiguous", "partial"])("does not guess a legacy task identity from an %s lookup", async kind => {
    const client = new ReplayDynamo([receipt, task]);
    if (kind === "ambiguous") client.put({ ...task, dueAt: "2026-09-02T05:40:00.000Z", SK: "TASK#2026-09-02T05:40:00.000Z#late-water" });
    else client.partial = true;
    await expect(dynamo(client).confirm(input)).rejects.toThrow();
    expect(client.commands.some(command => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("keeps the original signed-in receipt through renaming while returning only today's current snapshot", async () => {
    const client = new ReplayDynamo([task]);
    const member: Membership = { circleId: "family-1", memberId: "maya", name: "Maya", role: "caregiver", status: "active" };
    const reviewed = { ...input, expected: { title: task.title, dueAt: task.dueAt, state: "scheduled" as const, lastResponse: null, confirmedAt: null, confirmedBy: null } };
    const original = await confirmWithReceipt(dynamo(client, beforeMidnight), reviewed, member);
    const replay = await confirmWithReceipt(dynamo(client), reviewed, { ...member, name: "Renamed Maya" });
    expect(replay.confirmation).toEqual(original.confirmation);
    expect(replay).toMatchObject({ replayed: true, snapshot: { date: "2026-09-03", tasks: [], summary: { total: 0 } } });
  });

  it("returns stable REST conflicts for changed intent but keeps renamed-member exact retries valid", async () => {
    const store = createDemoStore(() => new Date("2026-09-02T16:00:00.000Z"));
    let member: Membership = { circleId: "family-1", memberId: "maya", name: "Maya", role: "caregiver", status: "active" };
    const app = createHttpApp(store, undefined, { accessAuthorizer: { async authorize() { return { subject: "maya", scopes: new Set(["mcp:tools"]), claims: { iss: "https://example.invalid" } }; } },
      familyAccess: { circleId: "family-1", directory: { async find() { return member; } } } });
    const reviews = new Map((await store.today()).tasks.map(task => [task.id, taskReview(task)]));
    const send = (taskId: string, response = "done") => request(app).post(`/api/tasks/${taskId}/confirm`).set("authorization", "Bearer synthetic").send({ response, actor: "Forged", requestId: input.requestId, expected: reviews.get(taskId) });
    const first = await send("morning-water").expect(201);
    expect((await send("afternoon-walk").expect(409)).body).toEqual({ error: "confirmation_conflict" });
    expect((await send("morning-water", "not_yet").expect(409)).body).toEqual({ error: "confirmation_conflict" });
    member = { ...member, name: "Renamed Maya" };
    expect((await send("morning-water").expect(200)).body.confirmation).toEqual(first.body.confirmation);
  });

  it("returns a fixed MCP error code instead of success for changed confirmation intent", async () => {
    const store = createDemoStore(() => new Date("2026-09-02T16:00:00.000Z"));
    const server = createMcpServer(store);
    const client = new Client({ name: "replay-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const args = { ...input, taskId: "morning-water", expected: taskReview((await store.today()).tasks[0]!) };
      await client.callTool({ name: "confirm_care_task", arguments: args });
      for (const change of [{ taskId: "afternoon-walk" }, { response: "not_yet" }]) {
        const result = await client.callTool({ name: "confirm_care_task", arguments: { ...args, ...change } });
        expect(result).toMatchObject({ isError: true, structuredContent: { code: "confirmation_conflict" } });
      }
    } finally { await client.close(); await server.close(); }
  });
});
