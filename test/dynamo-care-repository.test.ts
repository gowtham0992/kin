import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { DutyConflict, type DutyChangeReceipt } from "../src/duty-change.js";
import { EscalationNotFoundError } from "../src/domain.js";
import type { EscalationRecord } from "../src/escalation.js";

const fixedNow = () => new Date("2026-09-02T16:00:00.000Z");
const storedTask = {
  PK: "CIRCLE#family-1",
  SK: "TASK#2026-09-02T15:00:00.000Z#morning-water",
  entityType: "CareTask",
  id: "morning-water",
  title: "Drink a glass of water",
  dueAt: "2026-09-02T15:00:00.000Z",
  state: "scheduled",
  lastResponse: null,
  confirmedBy: null,
  confirmedAt: null,
};

class FakeDynamoSender {
  readonly commands: Array<{ input: unknown }> = [];
  readonly #responses: unknown[];

  constructor(responses: unknown[]) {
    this.#responses = [...responses];
  }

  async send(command: { input: unknown }): Promise<unknown> {
    this.commands.push(command);
    const response = this.#responses.shift() ?? {};
    if (response instanceof Error) throw response;
    return response;
  }
}

const dutyMembers = [
  { PK: "CIRCLE#family-1", SK: "MEMBER#maya", entityType: "CircleMember", id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true },
  { PK: "CIRCLE#family-1", SK: "MEMBER#theo", entityType: "CircleMember", id: "theo", name: "Theo", relationship: "son", canReceiveAlerts: true },
];
const storedDuty = { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-02", entityType: "DutyAssignment",
  memberId: "theo", memberName: "Theo", startsAt: "2026-09-02T00:00:00.000Z", endsAt: "2026-09-03T00:00:00.000Z" };
const reviewedDuty = { date: "2026-09-02", memberId: "maya", expectedMemberId: "theo", requestId: "handoff-review-1", actor: "Gowtham" };

describe("DynamoDB reviewed duty handoffs", () => {
  it("atomically binds the reviewed assignment and permanent receipt", async () => {
    const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [storedDuty] }, {}]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const result = await repository.assignDuty(reviewedDuty);
    expect(result).toMatchObject({ requestId: reviewedDuty.requestId, assignments: [{
      date: reviewedDuty.date, memberId: "maya", memberName: "Maya", changedBy: "Gowtham", changedAt: fixedNow().toISOString(),
    }] });
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands.slice(0, 3).every(command => (command.input as { ConsistentRead?: boolean }).ConsistentRead)).toBe(true);
    expect(client.commands[3]).toBeInstanceOf(TransactWriteCommand);
    expect(client.commands[3]?.input).toMatchObject({ TransactItems: [
      { Put: { Item: { memberId: "maya", changedBy: "Gowtham", changedAt: fixedNow().toISOString() },
        ConditionExpression: "memberId = :expectedMember", ExpressionAttributeValues: { ":expectedMember": "theo" } } },
      { Put: { Item: { PK: "CIRCLE#family-1", SK: `DUTY_CHANGE#${reviewedDuty.requestId}`, input: reviewedDuty, result },
        ConditionExpression: "attribute_not_exists(PK)" } },
    ] });
    const receipt = (client.commands[3]?.input as { TransactItems: { Put?: { Item: DutyChangeReceipt } }[] }).TransactItems[1]!.Put!.Item;
    const replayClient = new FakeDynamoSender([{ Item: receipt }]);
    const replayRepository = new DynamoCareRepository({ client: replayClient, tableName: "kin-test", circleId: "family-1", now: () => new Date("2026-10-02T16:00:00.000Z") });
    expect(await replayRepository.assignDuty(reviewedDuty)).toEqual(result);
    expect(replayClient.commands).toHaveLength(1);
    const changedClient = new FakeDynamoSender([{ Item: receipt }]);
    const changedRepository = new DynamoCareRepository({ client: changedClient, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    await expect(changedRepository.assignDuty({ ...reviewedDuty, memberId: "theo" })).rejects.toThrow(DutyConflict);
    expect(changedClient.commands).toHaveLength(1);
  });

  it("requires a still-empty day when the review says there is no coverage", async () => {
    const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [] }, {}]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    await repository.assignDuty({ ...reviewedDuty, expectedMemberId: null });
    const put = (client.commands[3]?.input as { TransactItems: { Put: Record<string, unknown> }[] }).TransactItems[0]!.Put;
    expect(put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(put).not.toHaveProperty("ExpressionAttributeValues");
  });

  it("rejects an already-stale review without issuing a write", async () => {
    const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [{ ...storedDuty, memberId: "maya" }] }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    await expect(repository.assignDuty(reviewedDuty)).rejects.toThrow(DutyConflict);
    expect(client.commands.some(command => command instanceof TransactWriteCommand || command instanceof PutCommand)).toBe(false);
  });

  it("reports a conditional race as a conflict but leaves transient transaction failures retryable", async () => {
    for (const code of ["ConditionalCheckFailed", "TransactionConflict", "ThrottlingError"]) {
      const failure = Object.assign(new Error(code), { name: "TransactionCanceledException", CancellationReasons: [{ Code: code }] });
      const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [storedDuty] }, failure, {}]);
      const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
      if (code === "ConditionalCheckFailed") await expect(repository.assignDuty(reviewedDuty)).rejects.toThrow(DutyConflict);
      else await expect(repository.assignDuty(reviewedDuty)).rejects.toBe(failure);
      expect(client.commands[4]?.input).toMatchObject({ ConsistentRead: true, Key: { SK: `DUTY_CHANGE#${reviewedDuty.requestId}` } });
    }
  });

  it("recovers the winner's receipt after concurrent identical requests", async () => {
    const winningClient = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [storedDuty] }, {}]);
    const winningRepository = new DynamoCareRepository({ client: winningClient, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const result = await winningRepository.assignDuty(reviewedDuty);
    const receipt = (winningClient.commands[3]?.input as { TransactItems: { Put?: { Item: DutyChangeReceipt } }[] }).TransactItems[1]!.Put!.Item;
    const failed = Object.assign(new Error("Receipt exists"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
    const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [storedDuty] }, failed, { Item: receipt }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    expect(await repository.assignDuty(reviewedDuty)).toEqual(result);
    expect(client.commands.filter(command => command instanceof TransactWriteCommand)).toHaveLength(1);
  });

  it("recovers an identical request committed between the receipt read and roster read", async () => {
    const winner = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [storedDuty] }, {}]);
    const first = new DynamoCareRepository({ client: winner, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const result = await first.assignDuty(reviewedDuty);
    const receipt = (winner.commands[3]?.input as { TransactItems: { Put?: { Item: DutyChangeReceipt } }[] }).TransactItems[1]!.Put!.Item;
    const client = new FakeDynamoSender([{}, { Items: dutyMembers }, { Items: [{ ...storedDuty, memberId: "maya", memberName: "Maya" }] }, { Item: receipt }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    expect(await repository.assignDuty(reviewedDuty)).toEqual(result);
    expect(client.commands).toHaveLength(4);
    expect(client.commands.some(command => command instanceof TransactWriteCommand)).toBe(false);
  });
});

describe("DynamoDB stable escalation acknowledgment", () => {
  type AlertRow = EscalationRecord & { PK: string; SK: string; entityType: "Escalation" };
  function alertRow(dueAt = "2026-09-03T05:15:00.000Z"): AlertRow {
    return {
      PK: "CIRCLE#family-1", SK: `ESCALATION#${dueAt}#evening_water`, entityType: "Escalation",
      id: `missed_evening_water_${dueAt}`, taskId: "evening_water", taskTitle: "Water check-in", dueAt,
      createdAt: dueAt, updatedAt: dueAt, recipientMemberId: "maya", recipientMemberName: "Maya",
      status: "sent", attemptCount: 1, attemptId: null, leaseUntil: null,
      providerMessageId: "synthetic-provider-id", lastErrorCode: null,
    };
  }

  // Only the SDK boundary is simulated: keys, query bounds and the conditional first-write rule are enforced.
  class AcknowledgmentDynamoSender {
    readonly commands: Array<GetCommand | QueryCommand | UpdateCommand> = [];
    readonly rows: AlertRow[];
    beforeUpdate?: () => void;
    constructor(rows: AlertRow[]) { this.rows = structuredClone(rows); }
    async send(command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand): Promise<unknown> {
      if (!(command instanceof GetCommand || command instanceof QueryCommand || command instanceof UpdateCommand)) {
        throw new Error("Unexpected acknowledgment command");
      }
      this.commands.push(command);
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues!;
        return { Items: structuredClone(this.rows.filter(row => row.PK === values[":pk"] && row.SK >= values[":start"] && row.SK <= values[":end"])) };
      }
      if (command instanceof UpdateCommand) this.beforeUpdate?.();
      const row = this.rows.find(item => item.PK === command.input.Key?.PK && item.SK === command.input.Key?.SK);
      if (command instanceof GetCommand) return { Item: row && structuredClone(row) };
      const values = command.input.ExpressionAttributeValues!;
      if (!row || row.id !== values[":id"]) {
        throw Object.assign(new Error("Alert identity changed"), { name: "ConditionalCheckFailedException" });
      }
      expect(command.input.ConditionExpression).toBe("attribute_exists(PK) AND id = :id");
      expect(command.input.UpdateExpression).toBe("SET acknowledgment = if_not_exists(acknowledgment, :ack)");
      row.acknowledgment ??= structuredClone(values[":ack"]);
      return { Attributes: structuredClone(row) };
    }
  }

  it.each([
    ["America/Denver", "2026-09-03T05:15:00.000Z", "2026-09-03T05:59:59.999Z"],
    ["America/Denver", "2026-09-03T05:15:00.000Z", "2026-09-03T06:00:00.000Z"],
    ["America/Denver", "2026-09-03T05:15:00.000Z", "2026-09-03T06:00:00.001Z"],
    ["UTC", "2026-09-02T23:15:00.000Z", "2026-09-02T23:59:59.999Z"],
    ["UTC", "2026-09-02T23:15:00.000Z", "2026-09-03T00:00:00.000Z"],
  ])("acknowledges the same durable alert in %s at %s / %s without a daily query", async (timeZone, dueAt, instant) => {
    const original = alertRow(dueAt);
    const client = new AcknowledgmentDynamoSender([original]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone, now: () => new Date(instant) });

    const receipt = await repository.acknowledgeEscalation({ id: original.id, memberId: "maya", name: "Maya" });

    expect(receipt).toMatchObject({ id: original.id, status: "sent", acknowledgedBy: "Maya", acknowledgedAt: instant });
    expect(receipt).not.toHaveProperty("providerMessageId");
    expect(client.rows).toEqual([{ ...original, acknowledgment: { memberId: "maya", name: "Maya", at: instant } }]);
    expect(client.commands).toHaveLength(2);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands[0]?.input).toMatchObject({ Key: { PK: original.PK, SK: original.SK }, ConsistentRead: true });
    expect(client.commands[1]).toBeInstanceOf(UpdateCommand);
  });

  it("retains the first caregiver and timestamp on a retry after local midnight", async () => {
    const original = alertRow();
    let instant = "2026-09-03T05:59:59.999Z";
    const client = new AcknowledgmentDynamoSender([original]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone: "America/Denver", now: () => new Date(instant) });
    const first = await repository.acknowledgeEscalation({ id: original.id, memberId: "maya", name: "Maya" });
    instant = "2026-09-03T06:01:00.000Z";

    const retry = await repository.acknowledgeEscalation({ id: original.id, memberId: "theo", name: "Theo" });

    expect(retry).toEqual(first);
    expect(client.rows[0]?.acknowledgment).toEqual({ memberId: "maya", name: "Maya", at: "2026-09-03T05:59:59.999Z" });
    expect(client.commands).toHaveLength(4);
    expect(client.commands.some(command => command instanceof QueryCommand)).toBe(false);
  });

  it.each([
    "", "missed-water", "missed__2026-09-03T05:15:00.000Z", "missed_water_invalid",
    "missed_water_2026-02-30T05:15:00.000Z", "missed_water_2026-09-03T25:15:00.000Z",
    "missed_evening_water_2026-09-03T05:15:00.000Z\n",
    "missed_water_2026-09-03T05:15:00.000Z#CIRCLE#family-2", `missed_${"x".repeat(201)}_2026-09-03T05:15:00.000Z`,
  ])("rejects malformed alert ID %s before a database operation", async id => {
    const client = new AcknowledgmentDynamoSender([alertRow()]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });

    await expect(repository.acknowledgeEscalation({ id, memberId: "maya", name: "Maya" })).rejects.toBeInstanceOf(EscalationNotFoundError);

    expect(client.commands).toEqual([]);
    expect(client.rows[0]).not.toHaveProperty("acknowledgment");
  });

  it.each(["missing", "other-circle"])("does not acknowledge an alert that is %s in the authenticated circle", async scenario => {
    const other = { ...alertRow(), PK: "CIRCLE#family-2" };
    const client = new AcknowledgmentDynamoSender(scenario === "missing" ? [] : [other]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });

    await expect(repository.acknowledgeEscalation({ id: other.id, memberId: "maya", name: "Maya" })).rejects.toBeInstanceOf(EscalationNotFoundError);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.commands[0]?.input).toMatchObject({ Key: { PK: "CIRCLE#family-1", SK: other.SK }, ConsistentRead: true });
    expect(client.rows.every(row => !row.acknowledgment)).toBe(true);
  });

  it.each(["id", "taskId", "dueAt"] as const)("rejects a stored alert whose %s does not match its stable key", async field => {
    const original = alertRow();
    const client = new AcknowledgmentDynamoSender([{ ...original, [field]: "different" }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });

    await expect(repository.acknowledgeEscalation({ id: original.id, memberId: "maya", name: "Maya" })).rejects.toBeInstanceOf(EscalationNotFoundError);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(GetCommand);
    expect(client.rows[0]).not.toHaveProperty("acknowledgment");
  });

  it("does not create an acknowledgment if the alert identity changes after its read", async () => {
    const original = alertRow();
    const client = new AcknowledgmentDynamoSender([original]);
    client.beforeUpdate = () => { client.rows[0]!.id = "changed-after-read"; };
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone: "America/Denver", now: () => new Date("2026-09-03T05:59:59.999Z") });

    await expect(repository.acknowledgeEscalation({ id: original.id, memberId: "maya", name: "Maya" })).rejects.toBeInstanceOf(EscalationNotFoundError);

    expect(client.commands).toHaveLength(2);
    expect(client.commands[1]).toBeInstanceOf(UpdateCommand);
    expect(client.rows[0]).not.toHaveProperty("acknowledgment");
  });

  it.each([
    ["America/Denver", "2026-09-03T06:01:00.000Z", "2026-09-03T05:15:00.000Z", "2026-09-03T06:15:00.000Z", "2026-09-02T05:15:00.000Z"],
    ["Asia/Tokyo", "2026-09-02T15:01:00.000Z", "2026-09-01T15:15:00.000Z", "2026-09-02T15:15:00.000Z", "2026-09-01T14:15:00.000Z"],
  ])("keeps only unresolved previous-local-day follow-ups alongside today's alerts in %s", async (timeZone, instant, priorDueAt, todayDueAt, olderDueAt) => {
    const prior = alertRow(priorDueAt);
    const priorAcknowledged = { ...prior, id: `${prior.id}-acknowledged`, acknowledgment: { memberId: "maya", name: "Maya", at: instant } };
    const today = { ...alertRow(todayDueAt), acknowledgment: { memberId: "theo", name: "Theo", at: instant } };
    const older = alertRow(olderDueAt);
    const todayTask = { ...storedTask, dueAt: todayDueAt };
    const yesterdayTask = { ...storedTask, id: "yesterday-task", dueAt: priorDueAt };
    const client = new FakeDynamoSender([
      { Items: [todayTask, yesterdayTask] }, { Items: [] },
      { Items: [today, prior, priorAcknowledged, older] },
    ]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone, now: () => new Date(instant) });

    const snapshot = await repository.today();

    expect(snapshot.date).toBe("2026-09-03");
    expect(snapshot.escalations.map(record => record.id)).toEqual([today.id, prior.id]);
    expect(snapshot.escalations[0]).toMatchObject({ acknowledgedBy: "Theo" });
    expect(snapshot.tasks.map(task => task.id)).toEqual([todayTask.id]);
    expect(snapshot.summary.total).toBe(1);
    expect(client.commands).toHaveLength(3);
    expect(client.commands[2]?.input).toMatchObject({
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": "CIRCLE#family-1", ":start": "ESCALATION#2026-09-01", ":end": "ESCALATION#2026-09-04\uffff" },
    });
  });

  it("removes yesterday's alert from Today after acknowledgment while keeping stable retries available", async () => {
    const original = alertRow();
    const client = new AcknowledgmentDynamoSender([original]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone: "America/Denver", now: () => new Date("2026-09-03T06:01:00.000Z") });
    expect((await repository.today()).escalations.map(record => record.id)).toEqual([original.id]);

    const first = await repository.acknowledgeEscalation({ id: original.id, memberId: "maya", name: "Maya" });

    expect((await repository.today()).escalations).toEqual([]);
    expect(await repository.acknowledgeEscalation({ id: original.id, memberId: "theo", name: "Theo" })).toEqual(first);
  });

  it("refuses to show an incomplete follow-up window when DynamoDB returns another page", async () => {
    const client = new FakeDynamoSender([
      { Items: [] }, { Items: [] },
      { Items: [], LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: alertRow().SK } },
    ]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", timeZone: "America/Denver", now: () => new Date("2026-09-03T06:01:00.000Z") });

    await expect(repository.today()).rejects.toThrow("Follow-up window is too large to return completely");

    expect(client.commands).toHaveLength(3);
    expect(client.commands.every(command => command instanceof QueryCommand)).toBe(true);
  });
});

describe("DynamoCareRepository", () => {
  it("records the first acknowledgment without changing task or delivery state", async () => {
    const record = { id: `missed_${storedTask.id}_${storedTask.dueAt}`, taskId: storedTask.id, dueAt: storedTask.dueAt,
      status: "queued", recipientMemberId: "maya", recipientMemberName: "Maya",
      acknowledgment: { memberId: "theo", name: "Theo", at: "2026-09-02T15:30:00.000Z" } };
    const client = new FakeDynamoSender([{ Item: record }, { Attributes: record }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const receipt = await repository.acknowledgeEscalation({ id: record.id, memberId: "maya", name: "Maya" });
    expect(receipt).toMatchObject({ status: "queued", acknowledgedBy: "Theo", acknowledgedAt: record.acknowledgment.at });
    expect(client.commands[1]).toBeInstanceOf(UpdateCommand);
    expect(client.commands[1]?.input).toMatchObject({
      Key: { PK: "CIRCLE#family-1", SK: `ESCALATION#${storedTask.dueAt}#${storedTask.id}` },
      ConditionExpression: "attribute_exists(PK) AND id = :id",
      UpdateExpression: "SET acknowledgment = if_not_exists(acknowledgment, :ack)",
      ReturnValues: "ALL_NEW",
    });
  });
  it("keeps invitation and account metadata out of the public roster", async () => {
    const member = { id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true };
    const client = new FakeDynamoSender([{ Items: [{ ...member,
      PK: "CIRCLE#family-1", SK: "MEMBER#maya", entityType: "CircleMember",
      accountKey: "ACCESS#private", pendingInvitation: "INVITE#private",
    }] }, { Items: [] }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    expect((await repository.circle()).members).toEqual([member]);
  });

  it("reads a complete 50-person roster with a bounded strongly consistent query", async () => {
    const members = Array.from({ length: 50 }, (_, index) => ({
      ...dutyMembers[0]!, id: `person-${index}`, name: `Person ${String(index).padStart(2, "0")}`,
      SK: `MEMBER#person-${index}`, relationship: "caregiver", canReceiveAlerts: false,
    }));
    const client = new FakeDynamoSender([{ Items: members }, { Items: [storedDuty] }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });

    const snapshot = await repository.circle();

    expect(snapshot.members).toHaveLength(50);
    expect(snapshot.members[0]).toEqual({ id: "person-0", name: "Person 00", relationship: "caregiver", canReceiveAlerts: false });
    expect(snapshot.assignments).toEqual([{ date: "2026-09-02", memberId: "theo", memberName: "Theo",
      startsAt: storedDuty.startsAt, endsAt: storedDuty.endsAt }]);
    expect(client.commands[0]?.input).toMatchObject({ Limit: 51, ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :member)",
      ExpressionAttributeValues: { ":pk": "CIRCLE#family-1", ":member": "MEMBER#" },
    });
  });

  it.each([
    ["more than 50 roster people", { Items: Array.from({ length: 51 }, () => dutyMembers[0]) }, { Items: [] }],
    ["a partial roster page", { Items: dutyMembers, LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: "MEMBER#theo" } }, { Items: [] }],
    ["a partial duty page", { Items: dutyMembers }, { Items: [storedDuty], LastEvaluatedKey: { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-02" } }],
  ])("refuses an incomplete circle snapshot when there is %s", async (_condition, members, duties) => {
    const client = new FakeDynamoSender([members, duties]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });

    await expect(repository.circle()).rejects.toThrow("Circle roster exceeds supported size");
    expect(client.commands.every(command => command instanceof QueryCommand)).toBe(true);
  });

  it("conditionally binds a previously blocked alert to its first available caregiver", async () => {
    const blocked = {
      PK: "CIRCLE#family-1", SK: "ESCALATION#2026-09-02T15:00:00.000Z#morning-water",
      entityType: "Escalation", id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water", taskTitle: "Drink a glass of water", dueAt: storedTask.dueAt,
      createdAt: fixedNow().toISOString(), updatedAt: fixedNow().toISOString(),
      recipientMemberId: null, recipientMemberName: null, status: "blocked", attemptCount: 0,
      attemptId: null, leaseUntil: null, providerMessageId: null, lastErrorCode: "no_active_duty_assignment",
    };
    const conditionFailure = Object.assign(new Error("Already exists"), { name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] });
    const recovered = { ...blocked, status: "queued", recipientMemberId: "maya", recipientMemberName: "Maya", lastErrorCode: null };
    const client = new FakeDynamoSender([conditionFailure, { Item: blocked }, {}, { Item: recovered }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const result = await repository.queueEscalation({
      id: blocked.id, taskId: blocked.taskId, taskTitle: blocked.taskTitle, dueAt: blocked.dueAt,
      createdAt: fixedNow().toISOString(), recipient: {
        memberId: "maya", memberName: "Maya", startsAt: "2026-09-02T00:00:00Z", endsAt: "2026-09-03T00:00:00Z",
      },
    });
    expect(result!.record).toMatchObject({ status: "queued", recipientMemberId: "maya", attemptCount: 0 });
    expect(client.commands[2]).toBeInstanceOf(TransactWriteCommand);
    expect(client.commands[2]?.input).toMatchObject({ TransactItems: [
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: storedTask.SK }, ExpressionAttributeValues: { ":scheduled": "scheduled", ":response": null, ":responseAt": null } } },
      { Update: {
      ConditionExpression: "#status = :blocked AND attemptCount = :zero",
      ExpressionAttributeValues: { ":memberId": "maya", ":blocked": "blocked", ":zero": 0 },
      } },
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-02" } } },
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-01" } } },
    ] });
  });

  it("queries a strongly consistent daily care-plan partition", async () => {
    const client = new FakeDynamoSender([{ Items: [storedTask] }]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
    });

    const snapshot = await repository.today();

    expect(snapshot.tasks).toEqual([
      expect.objectContaining({ id: "morning-water", state: "scheduled" }),
    ]);
    expect(client.commands[0]).toBeInstanceOf(QueryCommand);
    expect(client.commands[0]?.input).toMatchObject({
      TableName: "kin-test",
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": "CIRCLE#family-1",
        ":start": "TASK#2026-09-01",
        ":end": "TASK#2026-09-03\uffff",
      },
    });
  });

  it("atomically writes the task transition and idempotency record", async () => {
    const client = new FakeDynamoSender([
      {},
      { Items: [storedTask] },
      {},
      {},
      {},
    ]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
    });

    const result = await repository.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "voice-turn-0001",
    });

    expect(result).toMatchObject({ replayed: false, task: { state: "done" } });
    const transaction = client.commands.find(command => command instanceof TransactWriteCommand);
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction?.input).toMatchObject({
      TransactItems: [
        {
          Put: {
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        {
          Put: {
            ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #state <> :cancelled AND title = :title",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":cancelled": "cancelled" },
          },
        },
        { Put: { Item: { SK: "PLAN_CONTROL", version: 1 }, ConditionExpression: "attribute_not_exists(PK)" } },
      ],
    });
  });

  it("places all reviewed fields in the atomic task write condition", async () => {
    const client = new FakeDynamoSender([{}, { Items: [storedTask] }, {}, {}, {}]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    await repository.confirm({ taskId: "morning-water", response: "done", actor: "Evelyn", requestId: "reviewed-turn-1",
      expected: { title: storedTask.title, dueAt: storedTask.dueAt, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null } });
    expect(client.commands.find(command => command instanceof TransactWriteCommand)?.input).toMatchObject({ TransactItems: [expect.anything(), { Put: {
      ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #state <> :cancelled AND title = :title AND #state = :reviewState AND dueAt = :reviewDue AND lastResponse = :reviewResponse AND confirmedAt = :reviewAt AND confirmedBy = :reviewBy",
      ExpressionAttributeValues: { ":title": storedTask.title, ":reviewState": "scheduled", ":reviewDue": storedTask.dueAt, ":reviewResponse": null, ":reviewAt": null, ":reviewBy": null },
    } }, { Put: { Item: { SK: "PLAN_CONTROL", version: 1 }, ConditionExpression: "attribute_not_exists(PK)" } }] });
  });

  it("replays an existing confirmation without writing again", async () => {
    const confirmation = {
      PK: "CIRCLE#family-1",
      SK: "CONFIRMATION#voice-turn-0001",
      entityType: "Confirmation",
      id: "confirmation_voice-turn-0001",
      requestId: "voice-turn-0001",
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      recordedAt: "2026-09-02T16:00:00.000Z",
    };
    const client = new FakeDynamoSender([
      { Item: confirmation },
      { Items: [{ ...storedTask, state: "done" }] },
      { Item: { ...storedTask, state: "done" } },
    ]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
    });

    const result = await repository.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "voice-turn-0001",
    });

    expect(result.replayed).toBe(true);
    expect(client.commands).toHaveLength(3);
    expect(client.commands[2]).toBeInstanceOf(GetCommand);
    expect(client.commands[2]?.input).toMatchObject({ Key: { PK: storedTask.PK, SK: storedTask.SK }, ConsistentRead: true });
    expect(client.commands.some((command) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("conditionally queues and leases one escalation delivery", async () => {
    const sendingRecord = {
      PK: "CIRCLE#family-1",
      SK: "ESCALATION#2026-09-02T15:00:00.000Z#morning-water",
      entityType: "Escalation",
      id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water",
      taskTitle: "Drink a glass of water",
      dueAt: "2026-09-02T15:00:00.000Z",
      createdAt: "2026-09-02T16:00:00.000Z",
      updatedAt: "2026-09-02T16:00:00.000Z",
      recipientMemberId: "theo",
      recipientMemberName: "Theo",
      status: "sending",
      attemptCount: 1,
      attemptId: "worker-1",
      leaseUntil: "2026-09-02T16:01:00.000Z",
      providerMessageId: null,
      lastErrorCode: null,
    };
    const client = new FakeDynamoSender([{}, { Attributes: sendingRecord }]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
    });
    const event = {
      id: sendingRecord.id,
      taskId: sendingRecord.taskId,
      taskTitle: sendingRecord.taskTitle,
      dueAt: sendingRecord.dueAt,
      createdAt: sendingRecord.createdAt,
      recipient: {
        memberId: "theo",
        memberName: "Theo",
        startsAt: "2026-09-02T08:00:00.000Z",
        endsAt: "2026-09-03T02:00:00.000Z",
      },
    };

    await repository.queueEscalation(event);
    const claimed = await repository.claimEscalation({
      event,
      attemptId: "worker-1",
      now: fixedNow(),
      leaseSeconds: 60,
    });

    expect(claimed).toMatchObject({ status: "sending", attemptId: "worker-1" });
    expect(client.commands[0]).toBeInstanceOf(TransactWriteCommand);
    expect(client.commands[0]?.input).toMatchObject({ TransactItems: [
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: storedTask.SK } } },
      { Put: { ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)" } },
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-02" } } },
      { ConditionCheck: { Key: { PK: "CIRCLE#family-1", SK: "DUTY#2026-09-01" } } },
    ] });
    expect(client.commands[1]).toBeInstanceOf(UpdateCommand);
    expect(client.commands[1]?.input).toMatchObject({
      ConditionExpression:
        "#status IN (:queued, :failed)",
      ReturnValues: "ALL_NEW",
    });
  });

  it("reads a bounded activity window for grounded briefs", async () => {
    const client = new FakeDynamoSender([
      { Items: [storedTask] },
      { Items: [] },
    ]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
    });

    const activity = await repository.activityBetween({
      startDate: "2026-08-27",
      endDate: "2026-09-02",
    });

    expect(activity.tasks).toHaveLength(1);
    expect(client.commands).toHaveLength(2);
    expect(client.commands[0]?.input).toMatchObject({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":start": "TASK#2026-08-26",
        ":end": "TASK#2026-09-03\uffff",
      },
    });
    expect(client.commands[1]?.input).toMatchObject({
      ExpressionAttributeValues: {
        ":start": "ESCALATION#2026-08-26",
        ":end": "ESCALATION#2026-09-03\uffff",
      },
    });
  });

  it("keeps a late-evening local task in today despite tomorrow's UTC prefix", async () => {
    const lateTask = {
      ...storedTask,
      SK: "TASK#2026-09-03T04:00:00.000Z#evening-call",
      id: "evening-call",
      title: "Call Maya",
      dueAt: "2026-09-03T04:00:00.000Z",
    };
    const client = new FakeDynamoSender([{ Items: [lateTask] }, {}, {}]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: () => new Date("2026-09-03T04:30:00.000Z"),
      timeZone: "America/Denver",
    });

    const snapshot = await repository.today();

    expect(snapshot.date).toBe("2026-09-02");
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["evening-call"]);
  });

  it("loads the previous local day's overdue tasks for an after-midnight sweep", async () => {
    const priorTask = {
      ...storedTask,
      SK: "TASK#2026-09-03T05:30:00.000Z#late-check-in",
      id: "late-check-in",
      title: "Late check-in",
      dueAt: "2026-09-03T05:30:00.000Z",
    };
    const priorDuty = {
      PK: "CIRCLE#family-1",
      SK: "DUTY#2026-09-02",
      entityType: "DutyAssignment",
      memberId: "theo",
      memberName: "Theo",
      startsAt: "2026-09-02T14:00:00.000Z",
      endsAt: "2026-09-03T08:00:00.000Z",
    };
    const client = new FakeDynamoSender([
      { Items: [priorTask] },
      { Items: [priorDuty] },
      { Items: [] },
    ]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      timeZone: "America/Denver",
    });

    const snapshot = await repository.escalationSnapshot(
      new Date("2026-09-03T06:30:00.000Z"),
    );

    expect(snapshot.date).toBe("2026-09-03");
    expect(snapshot.tasks.map((task) => task.id)).toEqual(["late-check-in"]);
    expect(snapshot.onDuty?.memberId).toBe("theo");
    expect(client.commands[0]?.input).toMatchObject({
      ExpressionAttributeValues: {
        ":start": "TASK#2026-09-01",
        ":end": "TASK#2026-09-04\uffff",
      },
    });
  });

  it("writes a timezone-correct duty handoff for an eligible circle member", async () => {
    const maya = {
      PK: "CIRCLE#family-1",
      SK: "MEMBER#maya",
      entityType: "CircleMember",
      id: "maya",
      name: "Maya",
      relationship: "daughter",
      canReceiveAlerts: true,
    };
    const client = new FakeDynamoSender([
      { Items: [maya] }, { Items: [] }, {},
      { Items: [maya] }, { Items: [{
        PK: "CIRCLE#family-1",
        SK: "DUTY#2026-09-03",
        entityType: "DutyAssignment",
        memberId: "maya",
        memberName: "Maya",
        startsAt: "2026-09-03T06:00:00.000Z",
        endsAt: "2026-09-04T06:00:00.000Z",
      }] },
    ]);
    const repository = new DynamoCareRepository({
      client,
      tableName: "kin-test",
      circleId: "family-1",
      now: fixedNow,
      timeZone: "America/Denver",
    });

    const result = await repository.assignDuty({ date: "2026-09-03", memberId: "maya" });

    expect(client.commands[2]).toBeInstanceOf(PutCommand);
    expect(client.commands[2]?.input).toMatchObject({
      Item: {
        SK: "DUTY#2026-09-03",
        memberId: "maya",
        startsAt: "2026-09-03T06:00:00.000Z",
        endsAt: "2026-09-04T06:00:00.000Z",
      },
    });
    expect(result.assignments[0]).toMatchObject({ date: "2026-09-03", memberName: "Maya" });
  });
});
