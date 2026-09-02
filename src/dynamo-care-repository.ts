import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  TaskNotFoundError,
  type CareRepository,
  type CareTask,
  type Confirmation,
  type ConfirmationResponse,
  type DutyAssignment,
  type TodaySnapshot,
} from "./domain.js";
import type {
  BlockedEscalation,
  EscalationRecord,
  EscalationSummary,
  MissedTaskEscalation,
} from "./escalation.js";
import { toEscalationSummary } from "./escalation.js";

interface DynamoSender {
  send(
    command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
  ): Promise<unknown>;
}

interface StoredTask extends CareTask {
  PK: string;
  SK: string;
  entityType: "CareTask";
}

interface StoredConfirmation extends Confirmation {
  PK: string;
  SK: string;
  entityType: "Confirmation";
}

interface StoredDutyAssignment extends DutyAssignment {
  PK: string;
  SK: string;
  entityType: "DutyAssignment";
}

interface StoredEscalation extends EscalationRecord {
  PK: string;
  SK: string;
  entityType: "Escalation";
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionCanceledException";
}

function taskSortKey(task: Pick<CareTask, "id" | "dueAt">): string {
  return `TASK#${task.dueAt}#${task.id}`;
}

function confirmationSortKey(requestId: string): string {
  return `CONFIRMATION#${requestId}`;
}

function escalationSortKey(input: Pick<EscalationRecord, "taskId" | "dueAt">): string {
  return `ESCALATION#${input.dueAt}#${input.taskId}`;
}

function isConditionCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export class DynamoCareRepository implements CareRepository {
  readonly #client: DynamoSender;
  readonly #tableName: string;
  readonly #circleId: string;
  readonly #now: () => Date;

  constructor(input: {
    client: DynamoSender;
    tableName: string;
    circleId: string;
    now?: () => Date;
  }) {
    this.#client = input.client;
    this.#tableName = input.tableName;
    this.#circleId = input.circleId;
    this.#now = input.now ?? (() => new Date());
  }

  async today(): Promise<TodaySnapshot> {
    const date = this.#now().toISOString().slice(0, 10);
    const [taskResult, dutyResult, escalationResult] = await Promise.all([
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :taskDate)",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":taskDate": `TASK#${date}`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new GetCommand({
        TableName: this.#tableName,
        Key: { PK: this.#partitionKey(), SK: `DUTY#${date}` },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :escalationDate)",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":escalationDate": `ESCALATION#${date}`,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
      })),
    ]);
    const result = taskResult as { Items?: StoredTask[] };
    const storedDuty = (dutyResult as { Item?: StoredDutyAssignment }).Item;
    const storedEscalations = (escalationResult as { Items?: StoredEscalation[] }).Items ?? [];

    const tasks = (result.Items ?? [])
      .map(({ PK: _pk, SK: _sk, entityType: _entityType, ...task }) => task)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const onDuty = storedDuty
      ? (({ PK: _pk, SK: _sk, entityType: _entityType, ...assignment }) => assignment)(storedDuty)
      : null;
    const escalations = storedEscalations.map(stripEscalationStorage).map(toEscalationSummary);
    return snapshotFor(date, tasks, onDuty, escalations);
  }

  async confirm(input: {
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    const existing = await this.#getConfirmation(input.requestId);
    if (existing) return this.#replayed(existing);

    const task = await this.#findTask(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);

    const recordedAt = this.#now().toISOString();
    const confirmation: Confirmation = {
      id: `confirmation_${input.requestId}`,
      requestId: input.requestId,
      taskId: input.taskId,
      response: input.response,
      actor: input.actor,
      recordedAt,
    };
    const updatedTask: CareTask = {
      ...task,
      state:
        input.response === "done"
          ? "done"
          : input.response === "skipped"
            ? "skipped"
            : "scheduled",
      lastResponse: input.response,
      confirmedBy: input.actor,
      confirmedAt: recordedAt,
    };

    try {
      await this.#client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: {
                  ...confirmation,
                  PK: this.#partitionKey(),
                  SK: confirmationSortKey(input.requestId),
                  entityType: "Confirmation",
                } satisfies StoredConfirmation,
                ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
            {
              Put: {
                TableName: this.#tableName,
                Item: {
                  ...updatedTask,
                  PK: this.#partitionKey(),
                  SK: taskSortKey(updatedTask),
                  entityType: "CareTask",
                } satisfies StoredTask,
                ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK)",
              },
            },
          ],
        }),
      );
      return { task: updatedTask, confirmation, replayed: false };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const racedConfirmation = await this.#getConfirmation(input.requestId);
      if (racedConfirmation) return this.#replayed(racedConfirmation);
      throw new TaskNotFoundError(input.taskId);
    }
  }

  async queueEscalation(input: MissedTaskEscalation | BlockedEscalation) {
    const routed = "recipient" in input;
    const createdAt = routed ? input.createdAt : this.#now().toISOString();
    const record: EscalationRecord = {
      id: `missed_${input.taskId}_${input.dueAt}`,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      dueAt: input.dueAt,
      createdAt,
      updatedAt: createdAt,
      recipientMemberId: routed ? input.recipient.memberId : null,
      recipientMemberName: routed ? input.recipient.memberName : null,
      status: routed ? "queued" : "blocked",
      attemptCount: 0,
      attemptId: null,
      leaseUntil: null,
      providerMessageId: null,
      lastErrorCode: routed ? null : input.reason,
    };
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          ...record,
          PK: this.#partitionKey(),
          SK: escalationSortKey(record),
          entityType: "Escalation",
        } satisfies StoredEscalation,
        ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      }));
      return { record, replayed: false };
    } catch (error) {
      if (!isConditionCheckFailure(error)) throw error;
      const previous = await this.#getEscalation(record);
      if (!previous) throw error;
      return { record: previous, replayed: true };
    }
  }

  async claimEscalation(input: {
    event: MissedTaskEscalation;
    attemptId: string;
    now: Date;
    leaseSeconds: number;
  }): Promise<EscalationRecord | null> {
    const now = input.now.toISOString();
    try {
      const result = (await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { PK: this.#partitionKey(), SK: escalationSortKey(input.event) },
        ConditionExpression:
          "#status IN (:queued, :failed) OR (#status = :sending AND leaseUntil <= :now)",
        UpdateExpression:
          "SET #status = :sending, attemptId = :attemptId, leaseUntil = :leaseUntil, updatedAt = :now ADD attemptCount :one",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":queued": "queued",
          ":failed": "failed",
          ":sending": "sending",
          ":attemptId": input.attemptId,
          ":leaseUntil": new Date(
            input.now.getTime() + input.leaseSeconds * 1_000,
          ).toISOString(),
          ":now": now,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }))) as { Attributes?: StoredEscalation };
      return result.Attributes ? stripEscalationStorage(result.Attributes) : null;
    } catch (error) {
      if (isConditionCheckFailure(error)) return null;
      throw error;
    }
  }

  async completeEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord> {
    return this.#finishEscalation({
      record: input.record,
      attemptId: input.attemptId,
      status: "sent",
      providerMessageId: input.providerMessageId,
      lastErrorCode: null,
      updatedAt: input.completedAt,
    });
  }

  async failEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    errorCode: string;
    failedAt: Date;
  }): Promise<EscalationRecord> {
    return this.#finishEscalation({
      record: input.record,
      attemptId: input.attemptId,
      status: "failed",
      providerMessageId: null,
      lastErrorCode: input.errorCode,
      updatedAt: input.failedAt,
    });
  }

  async #finishEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    status: "sent" | "failed";
    providerMessageId: string | null;
    lastErrorCode: string | null;
    updatedAt: Date;
  }): Promise<EscalationRecord> {
    const result = (await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { PK: this.#partitionKey(), SK: escalationSortKey(input.record) },
      ConditionExpression: "#status = :sending AND attemptId = :attemptId",
      UpdateExpression:
        "SET #status = :status, providerMessageId = :providerMessageId, lastErrorCode = :lastErrorCode, updatedAt = :updatedAt, attemptId = :empty, leaseUntil = :empty",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":sending": "sending",
        ":attemptId": input.attemptId,
        ":status": input.status,
        ":providerMessageId": input.providerMessageId,
        ":lastErrorCode": input.lastErrorCode,
        ":updatedAt": input.updatedAt.toISOString(),
        ":empty": null,
      },
      ReturnValues: "ALL_NEW",
    }))) as { Attributes?: StoredEscalation };
    if (!result.Attributes) throw new Error("Escalation update returned no record");
    return stripEscalationStorage(result.Attributes);
  }

  async #getEscalation(input: Pick<EscalationRecord, "taskId" | "dueAt">) {
    const result = (await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { PK: this.#partitionKey(), SK: escalationSortKey(input) },
      ConsistentRead: true,
    }))) as { Item?: StoredEscalation };
    return result.Item ? stripEscalationStorage(result.Item) : null;
  }

  async #getConfirmation(requestId: string): Promise<Confirmation | null> {
    const result = (await this.#client.send(
      new GetCommand({
        TableName: this.#tableName,
        Key: { PK: this.#partitionKey(), SK: confirmationSortKey(requestId) },
        ConsistentRead: true,
      }),
    )) as { Item?: StoredConfirmation };
    if (!result.Item) return null;
    const { PK: _pk, SK: _sk, entityType: _entityType, ...confirmation } = result.Item;
    return confirmation;
  }

  async #findTask(taskId: string): Promise<CareTask | null> {
    const snapshot = await this.today();
    return snapshot.tasks.find((task) => task.id === taskId) ?? null;
  }

  async #replayed(confirmation: Confirmation) {
    const task = await this.#findTask(confirmation.taskId);
    if (!task) throw new TaskNotFoundError(confirmation.taskId);
    return { task, confirmation, replayed: true as const };
  }

  #partitionKey(): string {
    return `CIRCLE#${this.#circleId}`;
  }
}

export function createDynamoCareRepository(input: {
  tableName: string;
  circleId: string;
  region?: string;
  now?: () => Date;
}): DynamoCareRepository {
  const baseClient = new DynamoDBClient({ region: input.region });
  const client = DynamoDBDocumentClient.from(baseClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return new DynamoCareRepository({ client, ...input });
}

function snapshotFor(
  date: string,
  tasks: CareTask[],
  onDuty: DutyAssignment | null,
  escalations: EscalationSummary[],
): TodaySnapshot {
  const completed = tasks.filter((task) => task.state === "done").length;
  const skipped = tasks.filter((task) => task.state === "skipped").length;
  return {
    date,
    tasks,
    onDuty,
    escalations,
    summary: {
      total: tasks.length,
      completed,
      skipped,
      remaining: tasks.length - completed - skipped,
    },
  };
}

function stripEscalationStorage(stored: StoredEscalation): EscalationRecord {
  const { PK: _pk, SK: _sk, entityType: _entityType, ...record } = stored;
  return record;
}
