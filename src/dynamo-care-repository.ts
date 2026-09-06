import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { assertTaskReview, TaskReviewConflict, type TaskReview } from "./task-review.js";
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
  EscalationNotFoundError,
  type CareActivityWindow,
  type CircleMember,
  type CircleSnapshot,
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
import { calendarDate, calendarDayBounds, shiftCalendarDate, validateTimeZone } from "./calendar.js";
import { scheduledTask, sameScheduledTask, routineTasks, sameRoutine, type ScheduleRoutineInput, type ScheduleTaskInput } from "./care-plan.js";
import { editableRoutineTasks, RoutineConflict, type RoutineChange } from "./care-plan.js";
import { appliedDutySnapshot, assertDutyReview, DutyConflict, replayDutyChange, validateDutyChange, type DutyChangeInput, type DutyChangeReceipt, type DutyChangeResult } from "./duty-change.js";

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

interface StoredCircleMember extends CircleMember {
  PK: string;
  SK: string;
  entityType: "CircleMember";
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
  readonly #timeZone: string;

  constructor(input: {
    client: DynamoSender;
    tableName: string;
    circleId: string;
    now?: () => Date;
    timeZone?: string;
  }) {
    this.#client = input.client;
    this.#tableName = input.tableName;
    this.#circleId = input.circleId;
    this.#now = input.now ?? (() => new Date());
    this.#timeZone = validateTimeZone(input.timeZone ?? "UTC");
  }

  async acknowledgeEscalation(input: { id: string; memberId: string; name: string }): Promise<EscalationSummary> {
    const record = (await this.today()).escalations.find(event => event.id === input.id);
    if (!record) throw new EscalationNotFoundError();
    try {
      const result = await this.#client.send(new UpdateCommand({ TableName: this.#tableName,
        Key: { PK: this.#partitionKey(), SK: escalationSortKey(record) },
        ConditionExpression: "attribute_exists(PK) AND id = :id",
        UpdateExpression: "SET acknowledgment = if_not_exists(acknowledgment, :ack)",
        ExpressionAttributeValues: { ":id": input.id, ":ack": { memberId: input.memberId, name: input.name, at: this.#now().toISOString() } },
        ReturnValues: "ALL_NEW",
      })) as { Attributes?: StoredEscalation };
      if (!result.Attributes) throw new Error("Acknowledgment returned no record");
      return toEscalationSummary(result.Attributes);
    } catch (error) { if (isConditionCheckFailure(error)) throw new EscalationNotFoundError(); throw error; }
  }

  async scheduleTask(input: ScheduleTaskInput): Promise<CareTask> {
    const key = { PK: this.#partitionKey(), SK: `PLAN_REQUEST#${input.id}` };
    const read = async () => (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as { Item?: { task?: CareTask } }).Item?.task;
    const existing = await read();
    if (existing) return sameScheduledTask(existing, input);
    const task = scheduledTask(input, this.#now());
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.#tableName, Item: { ...task, PK: this.#partitionKey(), SK: taskSortKey(task), entityType: "CareTask" }, ConditionExpression: "attribute_not_exists(PK)" } },
        { Put: { TableName: this.#tableName, Item: { ...key, task, entityType: "PlanRequest" }, ConditionExpression: "attribute_not_exists(PK)" } },
      ] }));
    } catch (error) {
      if (isConditionalFailure(error)) { const replay = await read(); if (replay) return sameScheduledTask(replay, input); }
      throw error;
    }
    return task;
  }

  async scheduleRoutine(input: ScheduleRoutineInput): Promise<CareTask[]> {
    const key = { PK: this.#partitionKey(), SK: `ROUTINE_REQUEST#${input.id}` };
    const read = async () => (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
      Item?: { input: ScheduleRoutineInput; tasks: CareTask[] };
    }).Item;
    const existing = await read();
    if (existing) return sameRoutine(existing, input);
    const tasks = routineTasks(input, this.#now());
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [
        ...tasks.map(task => ({ Put: { TableName: this.#tableName,
          Item: { ...task, PK: this.#partitionKey(), SK: taskSortKey(task), entityType: "CareTask" }, ConditionExpression: "attribute_not_exists(PK)" } })),
        { Put: { TableName: this.#tableName, Item: { ...key, input, tasks, entityType: "RoutineRequest" }, ConditionExpression: "attribute_not_exists(PK)" } },
      ] }));
    } catch (error) {
      if (isConditionalFailure(error)) { const replay = await read(); if (replay) return sameRoutine(replay, input); }
      throw error;
    }
    return tasks;
  }

  async changeRoutine(input: RoutineChange) {
    const key = { PK: this.#partitionKey(), SK: `ROUTINE_CHANGE#${input.requestId}` };
    const read = async () => (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
      Item?: { input: RoutineChange; result: { requestId: string; changed: number } };
    }).Item;
    const replay = (receipt: NonNullable<Awaited<ReturnType<typeof read>>>) => {
      if (JSON.stringify(receipt.input) !== JSON.stringify(input)) throw new RoutineConflict();
      return receipt.result;
    };
    const existing = await read(); if (existing) return replay(existing);
    const original = (await this.#client.send(new GetCommand({ TableName: this.#tableName,
      Key: { PK: key.PK, SK: `ROUTINE_REQUEST#${input.routineId}` }, ConsistentRead: true })) as { Item?: { tasks: CareTask[] } }).Item;
    if (!original || original.tasks.length > 14) throw new RoutineConflict();
    const current = await Promise.all(original.tasks.map(async task => (await this.#client.send(new GetCommand({ TableName: this.#tableName,
      Key: { PK: key.PK, SK: taskSortKey(task) }, ConsistentRead: true })) as { Item?: CareTask }).Item));
    if (current.some(task => !task)) throw new RoutineConflict();
    const now = this.#now(), tasks = editableRoutineTasks(current as CareTask[], input, now);
    const result = { requestId: input.requestId, changed: tasks.length };
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [
        ...tasks.map(task => ({ Update: { TableName: this.#tableName, Key: { PK: key.PK, SK: taskSortKey(task) },
          ConditionExpression: "#state = :scheduled AND lastResponse = :untouched AND title = :oldTitle AND dueAt > :now AND routineId = :routine",
          UpdateExpression: input.action === "cancel" ? "SET #state = :value, changedAt = :now, changedBy = :actor" : "SET title = :value, changedAt = :now, changedBy = :actor",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":scheduled": "scheduled", ":untouched": null, ":oldTitle": task.title, ":now": now.toISOString(), ":routine": input.routineId,
            ":value": input.action === "cancel" ? "cancelled" : input.title!, ":actor": input.actor },
        } })),
        { Put: { TableName: this.#tableName, Item: { ...key, input, result, entityType: "RoutineChange" }, ConditionExpression: "attribute_not_exists(PK)" } },
      ] }));
    } catch (error) {
      if (isConditionalFailure(error)) { const receipt = await read(); if (receipt) return replay(receipt); throw new RoutineConflict(); }
      throw error;
    }
    return result;
  }

  async today(): Promise<TodaySnapshot> {
    const now = this.#now();
    const date = calendarDate(now, this.#timeZone);
    const previousDate = shiftCalendarDate(date, -1);
    const nextDate = shiftCalendarDate(date, 1);
    const [taskResult, dutyResult, escalationResult] = await Promise.all([
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `TASK#${previousDate}`,
          ":end": `TASK#${nextDate}\uffff`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `DUTY#${previousDate}`,
          ":end": `DUTY#${date}\uffff`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `ESCALATION#${previousDate}`,
          ":end": `ESCALATION#${nextDate}\uffff`,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
      })),
    ]);
    const result = taskResult as { Items?: StoredTask[] };
    const storedDuties = (dutyResult as { Items?: StoredDutyAssignment[] }).Items ?? [];
    const storedEscalations = (escalationResult as { Items?: StoredEscalation[] }).Items ?? [];

    const tasks = (result.Items ?? [])
      .map(({ PK: _pk, SK: _sk, entityType: _entityType, ...task }) => task)
      .filter((task) => calendarDate(new Date(task.dueAt), this.#timeZone) === date)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const onDuty = activeDutyAt(storedDuties.map(stripDutyStorage), now);
    const escalations = storedEscalations
      .map(stripEscalationStorage)
      .filter((record) => calendarDate(new Date(record.dueAt), this.#timeZone) === date)
      .map(toEscalationSummary);
    return snapshotFor(date, tasks, onDuty, escalations);
  }

  async escalationSnapshot(asOf: Date): Promise<TodaySnapshot> {
    const date = calendarDate(asOf, this.#timeZone);
    const previousDate = shiftCalendarDate(date, -1);
    const queryStartDate = shiftCalendarDate(previousDate, -1);
    const queryEndDate = shiftCalendarDate(date, 1);
    const [taskResult, dutyResult, escalationResult] = await Promise.all([
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `TASK#${queryStartDate}`,
          ":end": `TASK#${queryEndDate}\uffff`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `DUTY#${previousDate}`,
          ":end": `DUTY#${date}\uffff`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `ESCALATION#${queryStartDate}`,
          ":end": `ESCALATION#${queryEndDate}\uffff`,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
      })),
    ]);
    const tasks = ((taskResult as { Items?: StoredTask[] }).Items ?? [])
      .map(({ PK: _pk, SK: _sk, entityType: _entityType, ...task }) => task)
      .filter((task) => {
        const localDate = calendarDate(new Date(task.dueAt), this.#timeZone);
        return localDate >= previousDate && localDate <= date;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const assignments = ((dutyResult as { Items?: StoredDutyAssignment[] }).Items ?? [])
      .map(stripDutyStorage);
    const escalations = ((escalationResult as { Items?: StoredEscalation[] }).Items ?? [])
      .map(stripEscalationStorage)
      .filter((record) => {
        const localDate = calendarDate(new Date(record.dueAt), this.#timeZone);
        return localDate >= previousDate && localDate <= date;
      })
      .map(toEscalationSummary);
    return snapshotFor(date, tasks, activeDutyAt(assignments, asOf), escalations);
  }

  async activityBetween(input: {
    startDate: string;
    endDate: string;
  }): Promise<CareActivityWindow> {
    const [taskResult, escalationResult] = await Promise.all([
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `TASK#${shiftCalendarDate(input.startDate, -1)}`,
          ":end": `TASK#${shiftCalendarDate(input.endDate, 1)}\uffff`,
        },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `ESCALATION#${shiftCalendarDate(input.startDate, -1)}`,
          ":end": `ESCALATION#${shiftCalendarDate(input.endDate, 1)}\uffff`,
        },
        ConsistentRead: true,
      })),
    ]);
if ((taskResult as { LastEvaluatedKey?: unknown }).LastEvaluatedKey || (escalationResult as { LastEvaluatedKey?: unknown }).LastEvaluatedKey) {
      throw new Error("Activity window is too large to return completely");
    }
    const tasks = ((taskResult as { Items?: StoredTask[] }).Items ?? [])
      .map(({ PK: _pk, SK: _sk, entityType: _entityType, ...task }) => task)
      .filter((task) => {
        const localDate = calendarDate(new Date(task.dueAt), this.#timeZone);
        return localDate >= input.startDate && localDate <= input.endDate;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const escalations = ((escalationResult as { Items?: StoredEscalation[] }).Items ?? [])
      .map(stripEscalationStorage)
      .filter((record) => {
        const localDate = calendarDate(new Date(record.dueAt), this.#timeZone);
        return localDate >= input.startDate && localDate <= input.endDate;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map(toEscalationSummary);

    return { ...input, tasks, escalations };
  }

  async circle(): Promise<CircleSnapshot> {
    const startDate = calendarDate(this.#now(), this.#timeZone);
    const endDate = shiftCalendarDate(startDate, 6);
    const [memberResult, dutyResult] = await Promise.all([
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :member)",
        ExpressionAttributeValues: { ":pk": this.#partitionKey(), ":member": "MEMBER#" },
        ConsistentRead: true,
      })),
      this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": this.#partitionKey(),
          ":start": `DUTY#${startDate}`,
          ":end": `DUTY#${endDate}\uffff`,
        },
        ConsistentRead: true,
      })),
    ]);
    const members = ((memberResult as { Items?: StoredCircleMember[] }).Items ?? [])
      .map(stripMemberStorage)
      .sort((left, right) => left.name.localeCompare(right.name));
    const assignments = ((dutyResult as { Items?: StoredDutyAssignment[] }).Items ?? [])
      .map((stored) => ({ date: stored.SK.slice("DUTY#".length), ...stripDutyStorage(stored) }))
      .sort((left, right) => left.date.localeCompare(right.date));
    return { startDate, endDate, members, assignments };
  }

  async assignDuty(rawInput: DutyChangeInput): Promise<DutyChangeResult> {
    const input = validateDutyChange(rawInput);
    const receiptKey = { PK: this.#partitionKey(), SK: `DUTY_CHANGE#${input.requestId}` };
    const readReceipt = async () => (await this.#client.send(new GetCommand({
      TableName: this.#tableName, Key: receiptKey, ConsistentRead: true,
    })) as { Item?: DutyChangeReceipt }).Item;
    if (input.requestId) {
      const receipt = await readReceipt();
      if (receipt) return replayDutyChange(receipt, input);
    }
    const current = await this.circle();
    if (input.date < current.startDate || input.date > current.endDate) {
      throw new Error("Duty date must be within the visible roster week");
    }
    const member = current.members.find((candidate) => candidate.id === input.memberId);
    if (!member?.canReceiveAlerts) throw new Error("Caregiver is not eligible for duty");
    const assignment: DutyAssignment = {
      memberId: member.id,
      memberName: member.name,
      ...calendarDayBounds(input.date, this.#timeZone),
      ...(input.requestId ? { changedAt: this.#now().toISOString(), ...(input.actor ? { changedBy: input.actor } : {}) } : {}),
    };
    if (input.requestId) {
      try { assertDutyReview(current.assignments.find(day => day.date === input.date), input); }
      catch (error) {
        const receipt = await readReceipt();
        if (receipt) return replayDutyChange(receipt, input);
        throw error;
      }
      const result = appliedDutySnapshot(current, input, assignment);
      try {
        await this.#client.send(new TransactWriteCommand({ TransactItems: [
          { Put: {
            TableName: this.#tableName,
            Item: { ...assignment, PK: this.#partitionKey(), SK: `DUTY#${input.date}`, entityType: "DutyAssignment" },
            ConditionExpression: input.expectedMemberId === null ? "attribute_not_exists(PK)" : "memberId = :expectedMember",
            ...(input.expectedMemberId === null ? {} : { ExpressionAttributeValues: { ":expectedMember": input.expectedMemberId } }),
          } },
          { Put: {
            TableName: this.#tableName,
            Item: { ...receiptKey, input, result, entityType: "DutyChange" },
            ConditionExpression: "attribute_not_exists(PK)",
          } },
        ] }));
      } catch (error) {
        if (isConditionalFailure(error)) {
          const receipt = await readReceipt();
          if (receipt) return replayDutyChange(receipt, input);
          const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
          if (reasons?.some(reason => reason.Code === "ConditionalCheckFailed")) throw new DutyConflict();
        }
        throw error;
      }
      return result;
    }
    await this.#client.send(new PutCommand({
      TableName: this.#tableName,
      Item: {
        ...assignment,
        PK: this.#partitionKey(),
        SK: `DUTY#${input.date}`,
        entityType: "DutyAssignment",
      } satisfies StoredDutyAssignment,
    }));
    return this.circle();
  }

  async confirm(input: {
    expected?: TaskReview;
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    const existing = await this.#getConfirmation(input.requestId);
    if (existing) return this.#replayed(existing);

    const task = await this.#findTask(input.taskId);
    if (!task || task.state === "cancelled") throw new TaskNotFoundError(input.taskId);

    assertTaskReview(task, input.expected);

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
                ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #state <> :cancelled AND title = :title"
                  + (input.expected ? " AND #state = :reviewState AND dueAt = :reviewDue AND lastResponse = :reviewResponse AND confirmedAt = :reviewAt AND confirmedBy = :reviewBy" : ""),
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: { ":cancelled": "cancelled", ":title": task.title,
                  ...(input.expected ? { ":reviewState": input.expected.state, ":reviewDue": input.expected.dueAt,
                    ":reviewResponse": input.expected.lastResponse, ":reviewAt": input.expected.confirmedAt,
                    ":reviewBy": input.expected.confirmedBy } : {}) },
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
      if (input.expected) throw new TaskReviewConflict();
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
      if (routed && previous.status === "blocked") {
        try {
          const recovered = await this.#client.send(new UpdateCommand({
            TableName: this.#tableName,
            Key: { PK: this.#partitionKey(), SK: escalationSortKey(record) },
            ConditionExpression: "#status = :blocked AND attemptCount = :zero",
            UpdateExpression: "SET #status = :queued, recipientMemberId = :memberId, recipientMemberName = :memberName, updatedAt = :now, lastErrorCode = :clear",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":blocked": "blocked", ":queued": "queued", ":zero": 0,
              ":memberId": input.recipient.memberId, ":memberName": input.recipient.memberName,
              ":now": input.createdAt, ":clear": null,
            },
            ReturnValues: "ALL_NEW",
          })) as { Attributes?: StoredEscalation };
          if (!recovered.Attributes) throw new Error("Recovered escalation was not returned");
          return { record: stripEscalationStorage(recovered.Attributes), replayed: true };
        } catch (recoveryError) {
          if (!isConditionCheckFailure(recoveryError)) throw recoveryError;
          // Another worker has already frozen a recipient; never replace it.
          const winner = await this.#getEscalation(record);
          if (!winner) throw recoveryError;
          return { record: winner, replayed: true };
        }
      }
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
  timeZone?: string;
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
  tasks = tasks.filter(task => task.state !== "cancelled");
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

function stripDutyStorage(stored: StoredDutyAssignment): DutyAssignment {
  const { PK: _pk, SK: _sk, entityType: _entityType, ...assignment } = stored;
  return assignment;
}

function stripMemberStorage(stored: StoredCircleMember): CircleMember {
  return { id: stored.id, name: stored.name, relationship: stored.relationship, canReceiveAlerts: stored.canReceiveAlerts };
}

function activeDutyAt(assignments: DutyAssignment[], asOf: Date): DutyAssignment | null {
  const now = asOf.getTime();
  return assignments.find((assignment) => {
    const startsAt = new Date(assignment.startsAt).getTime();
    const endsAt = new Date(assignment.endsAt).getTime();
    return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= now && endsAt > now;
  }) ?? null;
}
