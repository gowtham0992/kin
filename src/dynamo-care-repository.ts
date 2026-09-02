import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
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

interface DynamoSender {
  send(command: GetCommand | QueryCommand | TransactWriteCommand): Promise<unknown>;
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

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionCanceledException";
}

function taskSortKey(task: Pick<CareTask, "id" | "dueAt">): string {
  return `TASK#${task.dueAt}#${task.id}`;
}

function confirmationSortKey(requestId: string): string {
  return `CONFIRMATION#${requestId}`;
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
    const [taskResult, dutyResult] = await Promise.all([
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
    ]);
    const result = taskResult as { Items?: StoredTask[] };
    const storedDuty = (dutyResult as { Item?: StoredDutyAssignment }).Item;

    const tasks = (result.Items ?? [])
      .map(({ PK: _pk, SK: _sk, entityType: _entityType, ...task }) => task)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const onDuty = storedDuty
      ? (({ PK: _pk, SK: _sk, entityType: _entityType, ...assignment }) => assignment)(storedDuty)
      : null;
    return snapshotFor(date, tasks, onDuty);
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
): TodaySnapshot {
  const completed = tasks.filter((task) => task.state === "done").length;
  const skipped = tasks.filter((task) => task.state === "skipped").length;
  return {
    date,
    tasks,
    onDuty,
    summary: {
      total: tasks.length,
      completed,
      skipped,
      remaining: tasks.length - completed - skipped,
    },
  };
}
