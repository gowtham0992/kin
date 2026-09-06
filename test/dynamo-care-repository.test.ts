import {
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";

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

describe("DynamoCareRepository", () => {
  it("records the first acknowledgment without changing task or delivery state", async () => {
    const record = { id: "missed-water", taskId: storedTask.id, dueAt: storedTask.dueAt,
      status: "queued", recipientMemberId: "maya", recipientMemberName: "Maya",
      acknowledgment: { memberId: "theo", name: "Theo", at: "2026-09-02T15:30:00.000Z" } };
    const client = new FakeDynamoSender([{ Items: [storedTask] }, { Items: [] }, { Items: [record] }, { Attributes: record }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const receipt = await repository.acknowledgeEscalation({ id: record.id, memberId: "maya", name: "Maya" });
    expect(receipt).toMatchObject({ status: "queued", acknowledgedBy: "Theo", acknowledgedAt: record.acknowledgment.at });
    expect(client.commands[3]).toBeInstanceOf(UpdateCommand);
    expect(client.commands[3]?.input).toMatchObject({
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

  it("conditionally binds a previously blocked alert to its first available caregiver", async () => {
    const blocked = {
      PK: "CIRCLE#family-1", SK: "ESCALATION#2026-09-02T15:00:00.000Z#morning-water",
      entityType: "Escalation", id: "missed_morning-water_2026-09-02T15:00:00.000Z",
      taskId: "morning-water", taskTitle: "Drink a glass of water", dueAt: storedTask.dueAt,
      createdAt: fixedNow().toISOString(), updatedAt: fixedNow().toISOString(),
      recipientMemberId: null, recipientMemberName: null, status: "blocked", attemptCount: 0,
      attemptId: null, leaseUntil: null, providerMessageId: null, lastErrorCode: "no_active_duty_assignment",
    };
    const conditionFailure = Object.assign(new Error("Already exists"), { name: "ConditionalCheckFailedException" });
    const recovered = { ...blocked, status: "queued", recipientMemberId: "maya", recipientMemberName: "Maya", lastErrorCode: null };
    const client = new FakeDynamoSender([conditionFailure, { Item: blocked }, { Attributes: recovered }]);
    const repository = new DynamoCareRepository({ client, tableName: "kin-test", circleId: "family-1", now: fixedNow });
    const result = await repository.queueEscalation({
      id: blocked.id, taskId: blocked.taskId, taskTitle: blocked.taskTitle, dueAt: blocked.dueAt,
      createdAt: fixedNow().toISOString(), recipient: {
        memberId: "maya", memberName: "Maya", startsAt: "2026-09-02T00:00:00Z", endsAt: "2026-09-03T00:00:00Z",
      },
    });
    expect(result.record).toMatchObject({ status: "queued", recipientMemberId: "maya", attemptCount: 0 });
    expect(client.commands[2]?.input).toMatchObject({
      ConditionExpression: "#status = :blocked AND attemptCount = :zero",
      ExpressionAttributeValues: { ":memberId": "maya", ":blocked": "blocked", ":zero": 0 },
    });
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
    const transaction = client.commands[4];
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
      ],
    });
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

    expect(result.replayed).toBe(true);
    expect(client.commands).toHaveLength(4);
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
    expect(client.commands[0]).toBeInstanceOf(PutCommand);
    expect(client.commands[0]?.input).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    });
    expect(client.commands[1]).toBeInstanceOf(UpdateCommand);
    expect(client.commands[1]?.input).toMatchObject({
      ConditionExpression:
        "#status IN (:queued, :failed) OR (#status = :sending AND leaseUntil <= :now)",
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
