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
        ":taskDate": "TASK#2026-09-02",
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
            ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
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
});
