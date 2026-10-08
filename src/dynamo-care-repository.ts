import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { assertTaskReview, taskReview, TaskReviewConflict, type TaskReview } from "./task-review.js";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  assertConfirmationIntent,
  confirmationResponses,
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
import { activeDutyAt, dutyReviewFields, dutyRoutingDate, toEscalationSummary } from "./escalation.js";
import { calendarDate, calendarDayBounds, shiftCalendarDate, validateTimeZone } from "./calendar.js";
import { scheduledTask, sameScheduledTask, routineTasks, sameRoutine, type ScheduleRoutineInput, type ScheduleTaskInput } from "./care-plan.js";
import { editableRoutineTasks, RoutineConflict, type RoutineChange } from "./care-plan.js";
import { appliedDutySnapshot, assertDutyReview, DutyConflict, replayDutyChange, validateDutyChange, type DutyChangeInput, type DutyChangeReceipt, type DutyChangeResult } from "./duty-change.js";
import { acceptedDutyRotation, dutyRotationWindow, DutyRotationConflict, proposeDutyRotation, replayDutyRotation, validateDutyRotation,
  type DutyRotationInput, type DutyRotationProposal, type DutyRotationReceipt, type DutyRotationResult } from "./duty-rotation.js";
import { assertEditableTask, rescheduledTask, replayTaskChange, taskChangeResult, TaskChangeConflict, type TaskChange, type TaskChangeReceipt, type TaskChangeResult } from "./task-change.js";
import { assertCareWriteCancellation, careWriteCondition, type CareWriteAuthorization } from "./care-write-authorization.js";
import { assertUndoableCompletion, CompletionUndoConflict, replayCompletionUndo, restoredCompletion, type CompletionUndoInput,
  type CompletionUndoResult, type StoredCompletionUndo, type UndoableConfirmation } from "./response-undo.js";
import { acceptPlanPause, assertTaskOutsidePause, makePauseWindow, planControlSchema, PlanPauseConflict, proposePlanPause, replayPlanPause,
  type PlanControl, type PlanPauseInput, type PlanPauseProposal, type PlanPauseResult, type StoredPlanPause } from "./plan-pause.js";

interface DynamoSender {
  send(
    command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
  ): Promise<unknown>;
}

interface StoredTask extends CareTask {
  responseVersion?: string;
  PK: string;
  SK: string;
  entityType: "CareTask";
}

interface StoredConfirmation extends Confirmation {
  before?: TaskReview;
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

function isStoredInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function escalationSortKey(input: Pick<EscalationRecord, "taskId" | "dueAt">): string {
  return `ESCALATION#${input.dueAt}#${input.taskId}`;
}

function escalationIdentity(id: string): Pick<EscalationRecord, "taskId" | "dueAt"> | null {
  const match = /^missed_([A-Za-z0-9_-]{1,100})_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(id);
  if (!match) return null;
  const taskId = match[1]!, dueAt = match[2]!;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime()) || due.toISOString() !== dueAt) return null;
  return { taskId, dueAt };
}

function isConditionCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

function conditionalCancellation(error: unknown): Array<{ Code?: string }> | null {
  if (!isConditionalFailure(error)) return null;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.some(reason => reason.Code === "ConditionalCheckFailed")
    && reasons.every(reason => reason.Code === "None" || reason.Code === "ConditionalCheckFailed") ? reasons : null;
}

function assertCompleteWindow(result: unknown, label: string, limit = 500): void {
  const page = result as { Items?: unknown[]; LastEvaluatedKey?: unknown };
  if (page.LastEvaluatedKey || (page.Items?.length ?? 0) > limit) {
    throw new Error(`${label} window is too large to return completely`);
  }
}

export class FollowUpWindowIncompleteError extends Error {
  constructor() { super("Follow-up window is incomplete or too large to return completely"); }
}

export class DynamoCareRepository implements CareRepository {
  readonly planPauseEnabled: boolean;
  readonly completionUndoEnabled: boolean;
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
    completionUndoEnabled?: boolean;
    planPauseEnabled?: boolean;
  }) {
    this.#client = input.client;
    this.#tableName = input.tableName;
    this.#circleId = input.circleId;
    this.#now = input.now ?? (() => new Date());
    this.#timeZone = validateTimeZone(input.timeZone ?? "UTC");
    this.completionUndoEnabled = input.completionUndoEnabled === true;
    this.planPauseEnabled = input.planPauseEnabled === true;
  }

  async #readPlanControl(): Promise<{ control: PlanControl; exists: boolean }> {
    const key = { PK: this.#partitionKey(), SK: "PLAN_CONTROL" };
    const item = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
      Item?: Record<string, unknown>;
    }).Item;
    if (!item) return { control: { version: 0 }, exists: false };
    const { PK, SK, entityType, ...control } = item;
    if (PK !== key.PK || SK !== key.SK || entityType !== "PlanControl") throw new PlanPauseConflict();
    const parsed = planControlSchema.safeParse(control);
    if (!parsed.success) throw new PlanPauseConflict();
    return { control: parsed.data, exists: true };
  }

  async planControl(): Promise<PlanControl> { return (await this.#readPlanControl()).control; }

  #planFence(previous: { control: PlanControl; exists: boolean }, next?: PlanControl) {
    if (previous.control.version === Number.MAX_SAFE_INTEGER) throw new PlanPauseConflict();
    const control = next ?? { ...previous.control, version: previous.control.version + 1 };
    return { Put: { TableName: this.#tableName,
      Item: { PK: this.#partitionKey(), SK: "PLAN_CONTROL", entityType: "PlanControl", ...control },
      ConditionExpression: previous.exists ? "entityType = :type AND #version = :version" : "attribute_not_exists(PK)",
      ...(previous.exists ? { ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":type": "PlanControl", ":version": previous.control.version } } : {}),
    } };
  }

  async #writerControl(dueAts: string[] = []) {
    const control = await this.#readPlanControl();
    if (control.control.version === Number.MAX_SAFE_INTEGER) throw new PlanPauseConflict();
    for (const dueAt of dueAts) assertTaskOutsidePause(control.control, dueAt);
    return control;
  }

  async #pauseSnapshot(startsAt: string) {
    const before = await this.#readPlanControl();
    // Read every finite future occurrence, not only today's view or one page.
    const result = await this.#client.send(new QueryCommand({ TableName: this.#tableName,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: { ":pk": this.#partitionKey(), ":start": `TASK#${startsAt}`, ":end": "TASK#\uffff" },
      ConsistentRead: true, Limit: 501,
    })) as { Items?: StoredTask[]; LastEvaluatedKey?: unknown };
    if (result.LastEvaluatedKey || (result.Items?.length ?? 0) > 500) throw new PlanPauseConflict();
    const tasks = (result.Items ?? []).map(item => {
      if (item.PK !== this.#partitionKey() || item.SK !== taskSortKey(item) || item.entityType !== "CareTask" || item.dueAt < startsAt) throw new PlanPauseConflict();
      return stripTaskStorage(item);
    });
    const after = await this.#readPlanControl();
    if (before.exists !== after.exists || JSON.stringify(before.control) !== JSON.stringify(after.control)) throw new PlanPauseConflict();
    return { previous: before, snapshot: { circleId: this.#circleId, timeZone: this.#timeZone, control: before.control, tasks } };
  }

  async proposePlanPause(): Promise<PlanPauseProposal | null> {
    if (!this.planPauseEnabled) throw new PlanPauseConflict();
    const window = makePauseWindow(this.#now()), { snapshot } = await this.#pauseSnapshot(window.startsAt);
    if (snapshot.control.pause && snapshot.control.pause.endsAt > window.startsAt) return null;
    return proposePlanPause(snapshot, window);
  }

  async acceptPlanPause(input: PlanPauseInput, authorization?: CareWriteAuthorization): Promise<PlanPauseResult> {
    if (authorization) await authorization.assertCurrent();
    if (!this.planPauseEnabled) throw new PlanPauseConflict();
    const key = { PK: this.#partitionKey(), SK: `PLAN_PAUSE#${input.requestId}` };
    const readReceipt = async () => {
      const item = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
        Item?: StoredPlanPause & { PK: string; SK: string; entityType: string };
      }).Item;
      if (!item) return null;
      if (item.PK !== key.PK || item.SK !== key.SK || item.entityType !== "PlanPause") throw new PlanPauseConflict();
      return replayPlanPause(item, input);
    };
    const prior = await readReceipt(); if (prior) return prior;
    let previous: { control: PlanControl; exists: boolean };
    let result: PlanPauseResult;
    try {
      const reviewed = await this.#pauseSnapshot(input.startsAt);
      previous = reviewed.previous;
      result = acceptPlanPause(reviewed.snapshot, input, this.#now());
    }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await readReceipt(); if (winner) return winner; throw error; }
    try {
      await this.#writeCare([
        ...result.cancelledTasks.map(task => ({ Update: { TableName: this.#tableName,
          Key: { PK: key.PK, SK: taskSortKey(task) },
          ConditionExpression: "entityType = :type AND id = :id AND title = :title AND dueAt = :due AND #state = :scheduled AND lastResponse = :null AND confirmedAt = :null AND confirmedBy = :null",
          UpdateExpression: "SET #state = :cancelled, changedAt = :at, changedBy = :by",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":type": "CareTask", ":id": task.id, ":title": task.title, ":due": task.dueAt,
            ":scheduled": "scheduled", ":null": null, ":cancelled": "cancelled", ":at": task.changedAt!, ":by": task.changedBy! },
        } })),
        this.#planFence(previous, result.control),
        { Put: { TableName: this.#tableName, Item: { ...key, entityType: "PlanPause", input, result }, ConditionExpression: "attribute_not_exists(PK)" } },
      ], authorization);
      return result;
    } catch (error) {
      if (isConditionalFailure(error)) { const winner = await readReceipt(); if (winner) return winner;
        if (conditionalCancellation(error)) throw new PlanPauseConflict(); }
      throw error;
    }
  }

  async #writeCare(items: NonNullable<TransactWriteCommandInput["TransactItems"]>, authorization?: CareWriteAuthorization) {
    const guarded = authorization ? [...items, { ConditionCheck: careWriteCondition(authorization, this.#tableName, this.#circleId) }] : items;
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: guarded }));
    } catch (error) {
      if (authorization) {
        assertCareWriteCancellation(error, items.length);
        // Do not disclose an old retry receipt when access was lost during another conflict.
        await authorization.assertCurrent();
      }
      throw error;
    }
  }

  async acknowledgeEscalation(input: { id: string; memberId: string; name: string }, authorization?: CareWriteAuthorization): Promise<EscalationSummary> {
    if (authorization) await authorization.assertCurrent();
    const identity = escalationIdentity(input.id);
    if (!identity) throw new EscalationNotFoundError();
    // An alert's stable identity outlives the daily view; the partition still comes only from this circle.
    const record = await this.#getEscalation(identity);
    if (!record || record.id !== input.id || record.taskId !== identity.taskId || record.dueAt !== identity.dueAt) {
      throw new EscalationNotFoundError();
    }
    try {
      if (authorization) {
        await this.#writeCare([{ Update: {
          TableName: this.#tableName, Key: { PK: this.#partitionKey(), SK: escalationSortKey(record) },
          ConditionExpression: "attribute_exists(PK) AND id = :id",
          UpdateExpression: "SET acknowledgment = if_not_exists(acknowledgment, :ack)",
          ExpressionAttributeValues: { ":id": input.id, ":ack": { memberId: input.memberId, name: input.name, at: this.#now().toISOString() } },
        } }], authorization);
        const acknowledged = await this.#getEscalation(identity);
        if (!acknowledged?.acknowledgment) throw new Error("Acknowledgment could not be read after saving");
        return toEscalationSummary(acknowledged);
      }
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

  async scheduleTask(input: ScheduleTaskInput, authorization?: CareWriteAuthorization): Promise<CareTask> {
    if (authorization) await authorization.assertCurrent();
    const key = { PK: this.#partitionKey(), SK: `PLAN_REQUEST#${input.id}` };
    const read = async () => (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as { Item?: { task?: CareTask } }).Item?.task;
    const existing = await read();
    if (existing) return sameScheduledTask(existing, input);
    const task = scheduledTask(input, this.#now());
    let control;
    try { control = await this.#writerControl([task.dueAt]); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await read(); if (winner) return sameScheduledTask(winner, input); throw error; }
    try {
      await this.#writeCare([
        { Put: { TableName: this.#tableName, Item: { ...task, PK: this.#partitionKey(), SK: taskSortKey(task), entityType: "CareTask" }, ConditionExpression: "attribute_not_exists(PK)" } },
        { Put: { TableName: this.#tableName, Item: { ...key, task, entityType: "PlanRequest" }, ConditionExpression: "attribute_not_exists(PK)" } },
        this.#planFence(control),
      ], authorization);
    } catch (error) {
      if (isConditionalFailure(error)) { const replay = await read(); if (replay) return sameScheduledTask(replay, input); if (conditionalCancellation(error)) throw new PlanPauseConflict(); }
      throw error;
    }
    return task;
  }

  async scheduleRoutine(input: ScheduleRoutineInput, authorization?: CareWriteAuthorization): Promise<CareTask[]> {
    if (authorization) await authorization.assertCurrent();
    const key = { PK: this.#partitionKey(), SK: `ROUTINE_REQUEST#${input.id}` };
    const read = async () => (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
      Item?: { input: ScheduleRoutineInput; tasks: CareTask[] };
    }).Item;
    const existing = await read();
    if (existing) return sameRoutine(existing, input);
    const tasks = routineTasks(input, this.#now());
    let control;
    try { control = await this.#writerControl(tasks.map(task => task.dueAt)); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await read(); if (winner) return sameRoutine(winner, input); throw error; }
    try {
      await this.#writeCare([
        ...tasks.map(task => ({ Put: { TableName: this.#tableName,
          Item: { ...task, PK: this.#partitionKey(), SK: taskSortKey(task), entityType: "CareTask" }, ConditionExpression: "attribute_not_exists(PK)" } })),
        { Put: { TableName: this.#tableName, Item: { ...key, input, tasks, entityType: "RoutineRequest" }, ConditionExpression: "attribute_not_exists(PK)" } },
        this.#planFence(control),
      ], authorization);
    } catch (error) {
      if (isConditionalFailure(error)) { const replay = await read(); if (replay) return sameRoutine(replay, input); if (conditionalCancellation(error)) throw new PlanPauseConflict(); }
      throw error;
    }
    return tasks;
  }

  async changeTask(input: TaskChange, authorization?: CareWriteAuthorization): Promise<TaskChangeResult> {
    if (authorization) await authorization.assertCurrent();
    const key = { PK: this.#partitionKey(), SK: `TASK_CHANGE#${input.requestId}` };
    const readReceipt = async () => {
      const receipt = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
        Item?: TaskChangeReceipt & { PK: string; SK: string; entityType: string };
      }).Item;
      if (receipt && (receipt.PK !== key.PK || receipt.SK !== key.SK || receipt.entityType !== "TaskChange")) throw new TaskChangeConflict();
      return receipt;
    };
    const receipt = await readReceipt();
    if (receipt) return replayTaskChange(receipt, input);
    const taskKey = { PK: key.PK, SK: taskSortKey({ id: input.taskId, dueAt: input.expected.dueAt }) };
    const task = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: taskKey, ConsistentRead: true })) as { Item?: StoredTask }).Item;
    const now = this.#now();
    try {
      if (!task || task.PK !== taskKey.PK || task.SK !== taskKey.SK || task.entityType !== "CareTask") throw new TaskChangeConflict();
      assertEditableTask(task, input, now);
    } catch (error) {
      // The same request may have committed between the receipt and task reads.
      const winner = await readReceipt();
      if (winner) return replayTaskChange(winner, input);
      throw error;
    }
    const replacement = rescheduledTask(task, input, now);
    let control;
    try { control = await this.#writerControl(replacement ? [replacement.dueAt] : []); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await readReceipt(); if (winner) return replayTaskChange(winner, input); throw error; }
    const result = taskChangeResult(input);
    try {
      await this.#writeCare([
        { Update: {
          TableName: this.#tableName, Key: taskKey,
          ConditionExpression: "id = :id AND #state = :scheduled AND lastResponse = :untouched AND confirmedAt = :untouched AND confirmedBy = :untouched AND title = :oldTitle AND dueAt = :dueAt"
            + (input.action === "close_unanswered" ? " AND dueAt < :now" : " AND dueAt > :now AND attribute_not_exists(routineId)"),
          UpdateExpression: input.action === "rename" ? "SET title = :value, changedAt = :now, changedBy = :actor"
            : `SET #state = :value, changedAt = :now, changedBy = :actor${replacement ? ", rescheduledTo = :replacement" : ""}`,
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":id": task.id, ":scheduled": "scheduled", ":untouched": null, ":oldTitle": task.title,
            ":dueAt": task.dueAt, ":now": now.toISOString(), ":value": input.action === "rename" ? input.title! : input.action === "close_unanswered" ? "closed_unanswered" : "cancelled", ":actor": input.actor,
            ...(replacement ? { ":replacement": result.replacement } : {}) },
        } },
        ...(replacement ? [{ Put: { TableName: this.#tableName,
          Item: { ...replacement, PK: key.PK, SK: taskSortKey(replacement), entityType: "CareTask" },
          ConditionExpression: "attribute_not_exists(PK)" } }] : []),
        { Put: { TableName: this.#tableName, Item: { ...key, input, result, entityType: "TaskChange" }, ConditionExpression: "attribute_not_exists(PK)" } },
        this.#planFence(control),
      ], authorization);
    } catch (error) {
      if (isConditionalFailure(error)) {
        const winner = await readReceipt();
        if (winner) return replayTaskChange(winner, input);
        const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
        if (reasons?.some(reason => reason.Code === "ConditionalCheckFailed") &&
            reasons.every(reason => reason.Code === "ConditionalCheckFailed" || reason.Code === "None")) throw new TaskChangeConflict();
      }
      throw error;
    }
    return result;
  }

  async changeRoutine(input: RoutineChange, authorization?: CareWriteAuthorization) {
    if (authorization) await authorization.assertCurrent();
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
    let control;
    try { control = await this.#writerControl(); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await read(); if (winner) return replay(winner); throw error; }
    const result = { requestId: input.requestId, changed: tasks.length };
    try {
      await this.#writeCare([
        ...tasks.map(task => ({ Update: { TableName: this.#tableName, Key: { PK: key.PK, SK: taskSortKey(task) },
          ConditionExpression: "#state = :scheduled AND lastResponse = :untouched AND title = :oldTitle AND dueAt > :now AND routineId = :routine",
          UpdateExpression: input.action === "cancel" ? "SET #state = :value, changedAt = :now, changedBy = :actor" : "SET title = :value, changedAt = :now, changedBy = :actor",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":scheduled": "scheduled", ":untouched": null, ":oldTitle": task.title, ":now": now.toISOString(), ":routine": input.routineId,
            ":value": input.action === "cancel" ? "cancelled" : input.title!, ":actor": input.actor },
        } })),
        { Put: { TableName: this.#tableName, Item: { ...key, input, result, entityType: "RoutineChange" }, ConditionExpression: "attribute_not_exists(PK)" } },
        this.#planFence(control),
      ], authorization);
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
        Limit: 501,
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
        Limit: 501,
      })),
      this.#todayFollowUps(date),
    ]);
    assertCompleteWindow(taskResult, "Care-plan");
    assertCompleteWindow(dutyResult, "Duty");
    assertCompleteWindow(escalationResult, "Follow-up");
    const result = taskResult as { Items?: StoredTask[] };
    const storedDuties = (dutyResult as { Items?: StoredDutyAssignment[] }).Items ?? [];
    const escalationPage = escalationResult as { Items?: StoredEscalation[]; LastEvaluatedKey?: unknown };
    const storedEscalations = escalationPage.Items ?? [];

    const tasks = (result.Items ?? [])
      .map(stripTaskStorage)
      .filter((task) => calendarDate(new Date(task.dueAt), this.#timeZone) === date)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
    const onDuty = activeDutyAt(storedDuties.map(stripDutyStorage), now);
    const escalations = storedEscalations
      .map(stripEscalationStorage)
      .filter((record) => {
        const dueDate = calendarDate(new Date(record.dueAt), this.#timeZone);
        return dueDate === date || !record.acknowledgment;
      })
      .map(toEscalationSummary);
    return snapshotFor(date, tasks, onDuty, escalations);
  }

  async #todayFollowUps(date: string): Promise<{ Items: StoredEscalation[] }> {
    const { startsAt, endsAt } = calendarDayBounds(date, this.#timeZone);
    const records: StoredEscalation[] = [];
    let cursor: Record<string, unknown> | undefined;
    // The filter is applied after Dynamo's evaluated-item limit. Empty filtered
    // pages are not the end of history. Bound both work and returned records.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        FilterExpression: "attribute_not_exists(acknowledgment) OR (dueAt >= :todayStart AND dueAt < :todayEnd)",
        ExpressionAttributeValues: { ":pk": this.#partitionKey(), ":start": "ESCALATION#", ":end": "ESCALATION#\uffff",
          ":todayStart": startsAt, ":todayEnd": endsAt },
        ConsistentRead: true, Limit: 501, ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      })) as { Items?: StoredEscalation[]; LastEvaluatedKey?: Record<string, unknown> };
      records.push(...(page.Items ?? []));
      if (records.length > 500) throw new FollowUpWindowIncompleteError();
      cursor = page.LastEvaluatedKey;
      if (!cursor || !Object.keys(cursor).length) return { Items: records };
    }
    throw new FollowUpWindowIncompleteError();
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
        Limit: 501,
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
        Limit: 501,
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
        Limit: 501,
        ScanIndexForward: false,
      })),
    ]);
    assertCompleteWindow(taskResult, "Care-plan");
    assertCompleteWindow(dutyResult, "Duty");
    assertCompleteWindow(escalationResult, "Follow-up");
    const tasks = ((taskResult as { Items?: StoredTask[] }).Items ?? [])
      .map(stripTaskStorage)
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

  async deliveryHealthSnapshot(): Promise<EscalationSummary[]> {
    const records: StoredEscalation[] = [];
    let cursor: Record<string, unknown> | undefined;
    // Limit counts evaluated rows before filtering: an empty page can still have
    // more history. Never turn a scan budget into a false healthy result.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :escalation)",
        FilterExpression: "#status IN (:blocked, :failed, :queued, :sending, :pending)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pk": this.#partitionKey(), ":escalation": "ESCALATION#",
          ":blocked": "blocked", ":failed": "failed", ":queued": "queued", ":sending": "sending", ":pending": "receipt_pending" },
        ConsistentRead: true,
        Limit: 100,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      })) as { Items?: StoredEscalation[]; LastEvaluatedKey?: Record<string, unknown> };
      records.push(...(page.Items ?? []));
      if (records.length > 500) throw new Error("Delivery health window is too large to return completely");
      cursor = page.LastEvaluatedKey;
      if (!cursor || Object.keys(cursor).length === 0) {
        return records.filter(record => record.status !== "sent")
          .sort((left, right) => left.id.localeCompare(right.id)).map(record => {
            const { taskTitle: _title, ...summary } = toEscalationSummary(record);
            return summary;
          });
      }
    }
    throw new Error("Delivery health window is incomplete after ten query pages");
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
        Limit: 501,
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
        Limit: 501,
      })),
    ]);
    assertCompleteWindow(taskResult, "Activity");
    assertCompleteWindow(escalationResult, "Activity");
    const tasks = ((taskResult as { Items?: StoredTask[] }).Items ?? [])
      .map(stripTaskStorage)
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
        Limit: 51,
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
    const memberPage = memberResult as { Items?: StoredCircleMember[]; LastEvaluatedKey?: unknown };
    const dutyPage = dutyResult as { Items?: StoredDutyAssignment[]; LastEvaluatedKey?: unknown };
    if (memberPage.LastEvaluatedKey || dutyPage.LastEvaluatedKey || (memberPage.Items?.length ?? 0) > 50) {
      throw new Error("Circle roster exceeds supported size");
    }
    const members = (memberPage.Items ?? [])
      .map(stripMemberStorage)
      .sort((left, right) => left.name.localeCompare(right.name));
    const assignments = (dutyPage.Items ?? [])
      .map((stored) => ({ date: stored.SK.slice("DUTY#".length), ...stripDutyStorage(stored) }))
      .sort((left, right) => left.date.localeCompare(right.date));
    return { timeZone: this.#timeZone, startDate, endDate, members, assignments };
  }

  async assignDuty(rawInput: DutyChangeInput, authorization?: CareWriteAuthorization): Promise<DutyChangeResult> {
    if (authorization) await authorization.assertCurrent();
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
    if (input.memberId !== null && !member?.canReceiveAlerts) throw new Error("Caregiver is not eligible for duty");
    const assignment: DutyAssignment | null = input.memberId === null ? null : {
      memberId: member!.id,
      memberName: member!.name,
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
        await this.#writeCare([
          ...(assignment ? [{ Put: {
            TableName: this.#tableName,
            Item: { ...assignment, PK: this.#partitionKey(), SK: `DUTY#${input.date}`, entityType: "DutyAssignment" },
            ConditionExpression: input.expectedMemberId === null ? "attribute_not_exists(PK)" : "memberId = :expectedMember",
            ...(input.expectedMemberId === null ? {} : { ExpressionAttributeValues: { ":expectedMember": input.expectedMemberId } }),
          } }] : [{ Delete: {
            TableName: this.#tableName, Key: { PK: this.#partitionKey(), SK: `DUTY#${input.date}` },
            ConditionExpression: "memberId = :expectedMember",
            ExpressionAttributeValues: { ":expectedMember": input.expectedMemberId },
          } }]),
          { Put: {
            TableName: this.#tableName,
            Item: { ...receiptKey, input, result, entityType: "DutyChange",
              ...(assignment === null ? { previousAssignment: current.assignments.find(day => day.date === input.date), changedAt: this.#now().toISOString() } : {}) },
            ConditionExpression: "attribute_not_exists(PK)",
          } },
        ], authorization);
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
    if (!assignment) throw new Error("Invalid duty removal");
    const put = {
      TableName: this.#tableName,
      Item: {
        ...assignment,
        PK: this.#partitionKey(),
        SK: `DUTY#${input.date}`,
        entityType: "DutyAssignment",
      } satisfies StoredDutyAssignment,
    };
    if (authorization) await this.#writeCare([{ Put: put }], authorization);
    else await this.#client.send(new PutCommand(put));
    return this.circle();
  }

  async #rotationSnapshot(now: Date) {
    const PK = this.#partitionKey(), window = dutyRotationWindow(now, this.#timeZone);
    // Read the roster fence before querying members: an addition between the two reads
    // must invalidate the eventual transaction, even when the new member is in this page.
    const meta = (await this.#client.send(new GetCommand({ TableName: this.#tableName,
      Key: { PK, SK: "ROSTER#META" }, ConsistentRead: true,
      ProjectionExpression: "PK, SK, entityType, circleId, #version", ExpressionAttributeNames: { "#version": "version" },
    })) as { Item?: Record<string, unknown> }).Item;
    if (meta && (meta.PK !== PK || meta.SK !== "ROSTER#META" || meta.entityType !== "RosterMetadata" || meta.circleId !== this.#circleId ||
      !Number.isSafeInteger(meta.version) || (meta.version as number) < 0)) throw new DutyRotationConflict();
    const [memberResult, dutyResult] = await Promise.all([
      this.#client.send(new QueryCommand({ TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :member)", ExpressionAttributeValues: { ":pk": PK, ":member": "MEMBER#" },
        ConsistentRead: true, Limit: 51, ProjectionExpression: "PK, SK, entityType, id, #name, relationship, canReceiveAlerts",
        ExpressionAttributeNames: { "#name": "name" },
      })),
      this.#client.send(new QueryCommand({ TableName: this.#tableName,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
        ExpressionAttributeValues: { ":pk": PK, ":start": `DUTY#${window.basisStartDate}`, ":end": `DUTY#${window.endDate}\uffff` },
        ConsistentRead: true, Limit: 22, ProjectionExpression: "PK, SK, entityType, memberId, memberName, startsAt, endsAt, changedAt, changedBy",
      })),
    ]);
    const memberPage = memberResult as { Items?: StoredCircleMember[]; LastEvaluatedKey?: unknown };
    const dutyPage = dutyResult as { Items?: StoredDutyAssignment[]; LastEvaluatedKey?: unknown };
    const members = memberPage.Items ?? [], duties = dutyPage.Items ?? [];
    if (memberPage.LastEvaluatedKey || dutyPage.LastEvaluatedKey || members.length > 50 || duties.length > 21 ||
      members.some(member => member.PK !== PK || member.SK !== `MEMBER#${member.id}` || member.entityType !== "CircleMember") ||
      duties.some(duty => duty.PK !== PK || duty.entityType !== "DutyAssignment" || !window.dates.includes(duty.SK.slice(5))) ||
      new Set(duties.map(duty => duty.SK)).size !== duties.length) throw new DutyRotationConflict();
    const proposal = proposeDutyRotation({ circleId: this.#circleId, today: window.today, timeZone: this.#timeZone,
      rosterVersion: meta ? meta.version as number : null, members: members.map(stripMemberStorage),
      days: window.dates.map(date => ({ date, assignment: duties.find(duty => duty.SK === `DUTY#${date}`)
        ? stripDutyStorage(duties.find(duty => duty.SK === `DUTY#${date}`)!) : null })) });
    return { proposal, meta, members, duties, dates: window.dates };
  }

  async proposeDutyRotation(): Promise<DutyRotationProposal> {
    return (await this.#rotationSnapshot(this.#now())).proposal;
  }

  async acceptDutyRotation(rawInput: DutyRotationInput, authorization?: CareWriteAuthorization): Promise<DutyRotationResult> {
    if (authorization) await authorization.assertCurrent();
    const input = validateDutyRotation(rawInput);
    const key = { PK: this.#partitionKey(), SK: `DUTY_ROTATION#${input.requestId}` };
    const readReceipt = async () => {
      const item = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
        Item?: DutyRotationReceipt & { PK: string; SK: string; entityType: string };
      }).Item;
      if (item && (item.PK !== key.PK || item.SK !== key.SK || item.entityType !== "DutyRotation")) throw new DutyRotationConflict();
      return item;
    };
    const existing = await readReceipt();
    if (existing) return replayDutyRotation(existing, input);
    const now = this.#now(), snapshot = await this.#rotationSnapshot(now);
    let result: DutyRotationResult;
    try { result = acceptedDutyRotation(snapshot.proposal, input, now); }
    catch (error) {
      // A successful duplicate can commit while this request is reading the snapshot.
      const winner = await readReceipt();
      if (winner) return replayDutyRotation(winner, input);
      throw error;
    }
    const check = (SK: string, record: Record<string, unknown> | undefined, fields: string[]) => ({
      TableName: this.#tableName, Key: { PK: key.PK, SK }, ...rotationSnapshotCondition(record, fields),
    });
    try {
      await this.#writeCare([
        { ConditionCheck: check("ROSTER#META", snapshot.meta, ["PK", "SK", "entityType", "circleId", "version"]) },
        ...snapshot.members.map(member => ({ ConditionCheck: check(member.SK, { ...member }, ["PK", "SK", "entityType", "id", "name", "relationship", "canReceiveAlerts"]) })),
        ...snapshot.dates.map(date => {
          const SK = `DUTY#${date}`, previous = snapshot.duties.find(duty => duty.SK === SK);
          const day = snapshot.proposal.days.find(day => day.date === date);
          if (day?.source === "proposed") {
            const { date: _date, ...assignment } = result.assignments.find(value => value.date === date)!;
            return { Put: { TableName: this.#tableName, Item: { PK: key.PK, SK, entityType: "DutyAssignment", ...assignment },
              ConditionExpression: "attribute_not_exists(PK)" } };
          }
          return { ConditionCheck: check(SK, previous ? { ...previous } : undefined,
            ["PK", "SK", "entityType", "memberId", "memberName", "startsAt", "endsAt", "changedAt", "changedBy"]) };
        }),
        { Put: { TableName: this.#tableName, Item: { ...key, entityType: "DutyRotation", input, result }, ConditionExpression: "attribute_not_exists(PK)" } },
      ], authorization);
    } catch (error) {
      if (isConditionalFailure(error)) {
        const winner = await readReceipt();
        if (winner) return replayDutyRotation(winner, input);
        const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
        if (reasons?.some(reason => reason.Code === "ConditionalCheckFailed") &&
          reasons.every(reason => reason.Code === "ConditionalCheckFailed" || reason.Code === "None")) throw new DutyRotationConflict();
      }
      throw error;
    }
    return result;
  }

  async confirm(input: {
    expected?: TaskReview;
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }, authorization?: CareWriteAuthorization): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    if (authorization) await authorization.assertCurrent();
    const existing = await this.#getConfirmation(input.requestId);
    if (existing) return this.#replayed(existing, input);

    const task = await this.#findTask(input.taskId);
    if (!task || task.state === "cancelled" || task.state === "closed_unanswered") throw new TaskNotFoundError(input.taskId);

    assertTaskReview(task, input.expected);

    const recordedAt = this.#now().toISOString();
    const confirmation: Confirmation = {
      id: `confirmation_${input.requestId}`,
      requestId: input.requestId,
      taskId: input.taskId,
      taskDueAt: task.dueAt,
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
    let control;
    try { control = await this.#writerControl(input.response === "not_yet" ? [task.dueAt] : []); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await this.#getConfirmation(input.requestId); if (winner) return this.#replayed(winner, input); throw error; }

    try {
      await this.#writeCare([
            {
              Put: {
                TableName: this.#tableName,
                Item: {
                  ...confirmation,
                  ...(this.completionUndoEnabled ? { before: taskReview(task) } : {}),
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
                  ...(this.completionUndoEnabled ? { responseVersion: confirmation.id } : {}),
                  PK: this.#partitionKey(),
                  SK: taskSortKey(updatedTask),
                  entityType: "CareTask",
                } satisfies StoredTask,
                ConditionExpression: "attribute_exists(PK) AND attribute_exists(SK) AND #state <> :cancelled AND #state <> :closedUnanswered AND title = :title"
                  + (input.expected ? " AND #state = :reviewState AND dueAt = :reviewDue AND lastResponse = :reviewResponse AND confirmedAt = :reviewAt AND confirmedBy = :reviewBy" : ""),
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: { ":cancelled": "cancelled", ":closedUnanswered": "closed_unanswered", ":title": task.title,
                  ...(input.expected ? { ":reviewState": input.expected.state, ":reviewDue": input.expected.dueAt,
                    ":reviewResponse": input.expected.lastResponse, ":reviewAt": input.expected.confirmedAt,
                    ":reviewBy": input.expected.confirmedBy } : {}) },
              },
            },
            this.#planFence(control),
          ], authorization);
      return { task: updatedTask, confirmation, replayed: false };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const racedConfirmation = await this.#getConfirmation(input.requestId);
      if (racedConfirmation) return this.#replayed(racedConfirmation, input);
      if (input.expected) throw new TaskReviewConflict();
      throw new TaskNotFoundError(input.taskId);
    }
  }

  async undoCompletion(input: CompletionUndoInput, authorization?: CareWriteAuthorization): Promise<CompletionUndoResult> {
    if (authorization) await authorization.assertCurrent();
    if (!this.completionUndoEnabled) throw new CompletionUndoConflict();
    const key = { PK: this.#partitionKey(), SK: `COMPLETION_UNDO#${input.requestId}` };
    const readReceipt = async () => {
      const item = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: key, ConsistentRead: true })) as {
        Item?: StoredCompletionUndo & { PK: string; SK: string; entityType: string };
      }).Item;
      if (!item) return null;
      if (item.PK !== key.PK || item.SK !== key.SK || item.entityType !== "CompletionUndo") throw new CompletionUndoConflict();
      return replayCompletionUndo(item, input);
    };
    const previous = await readReceipt();
    if (previous) return previous;
    const confirmationKey = { PK: this.#partitionKey(), SK: confirmationSortKey(input.confirmationRequestId) };
    const raw = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: confirmationKey, ConsistentRead: true })) as { Item?: StoredConfirmation }).Item;
    const confirmation: UndoableConfirmation | undefined = raw?.PK === confirmationKey.PK && raw.SK === confirmationKey.SK && raw.entityType === "Confirmation" ? raw : undefined;
    const taskKey = { PK: this.#partitionKey(), SK: taskSortKey({ id: input.taskId, dueAt: input.expected.dueAt }) };
    const stored = (await this.#client.send(new GetCommand({ TableName: this.#tableName, Key: taskKey, ConsistentRead: true })) as { Item?: StoredTask }).Item;
    const task = stored?.PK === taskKey.PK && stored.SK === taskKey.SK && stored.entityType === "CareTask" ? stripTaskStorage(stored) : undefined;
    const now = this.#now();
    try { assertUndoableCompletion(input, confirmation, task, stored?.responseVersion, now); }
    catch (error) { const winner = await readReceipt(); if (winner) return winner; throw error; }
    const result = restoredCompletion(input, confirmation.before, task!, now);
    const expected = input.expected, restored = result.undo.restored;
    let control;
    try { control = await this.#writerControl([restored.dueAt]); }
    catch (error) { if (authorization) await authorization.assertCurrent(); const winner = await readReceipt(); if (winner) return winner; throw error; }
    try {
      await this.#writeCare([
        { Update: { TableName: this.#tableName, Key: taskKey,
          ConditionExpression: "entityType = :type AND id = :id AND responseVersion = :version AND title = :title AND dueAt = :due AND #state = :state AND lastResponse = :response AND confirmedAt = :at AND confirmedBy = :by",
          UpdateExpression: "SET #state = :restoredState, lastResponse = :restoredResponse, confirmedAt = :restoredAt, confirmedBy = :restoredBy, responseVersion = :undoVersion",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":type": "CareTask", ":id": task!.id, ":version": confirmation.id,
            ":title": expected.title, ":due": expected.dueAt, ":state": expected.state,
            ":response": expected.lastResponse, ":at": expected.confirmedAt, ":by": expected.confirmedBy,
            ":restoredState": restored.state, ":restoredResponse": restored.lastResponse,
            ":restoredAt": restored.confirmedAt, ":restoredBy": restored.confirmedBy, ":undoVersion": result.undo.id },
        } },
        { Put: { TableName: this.#tableName, Item: { ...key, entityType: "CompletionUndo", input, result }, ConditionExpression: "attribute_not_exists(PK)" } },
        this.#planFence(control),
      ], authorization);
      return result;
    } catch (error) {
      if (isConditionalFailure(error)) {
        const winner = await readReceipt(); if (winner) return winner;
        if (conditionalCancellation(error)) throw new CompletionUndoConflict();
      }
      throw error;
    }
  }

  async queueEscalation(input: MissedTaskEscalation | BlockedEscalation) {
    const routed = "recipient" in input;
    const dutyChecks = routed ? this.#escalationDutyChecks(input) : [];
    if (dutyChecks === null) {
      // Expiry rejects only a first routing, not a previously frozen receipt.
      const previous = await this.#getEscalation(input);
      return previous && previous.status !== "blocked" ? { record: previous, replayed: true } : null;
    }
    const createdAt = routed ? input.createdAt : this.#now().toISOString();
    const record: EscalationRecord = {
      ...(input.responseState ? { responseState: input.responseState } : {}),
      ...(input.responseRecordedAt ? { responseRecordedAt: input.responseRecordedAt } : {}),
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
      await this.#client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: this.#escalationTaskCheck(input) },
        { Put: {
          TableName: this.#tableName,
          Item: { ...record, PK: this.#partitionKey(), SK: escalationSortKey(record), entityType: "Escalation" } satisfies StoredEscalation,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        } },
        ...dutyChecks,
      ] }));
      return { record, replayed: false };
    } catch (error) {
      const reasons = conditionalCancellation(error);
      if (!reasons) throw error;
      const stalePlan = reasons[0]?.Code === "ConditionalCheckFailed" || reasons.slice(2).some(reason => reason.Code === "ConditionalCheckFailed");
      const previous = await this.#getEscalation(record);
      if (!previous) {
        if (stalePlan) return null;
        throw error;
      }
      if (routed && previous.status === "blocked") {
        if (stalePlan) return null;
        const recoveryDutyChecks = this.#escalationDutyChecks(input);
        if (recoveryDutyChecks === null) return null;
        try {
          await this.#client.send(new TransactWriteCommand({ TransactItems: [
            { ConditionCheck: this.#escalationTaskCheck(input) },
            { Update: {
              TableName: this.#tableName,
              Key: { PK: this.#partitionKey(), SK: escalationSortKey(record) },
              ConditionExpression: "#status = :blocked AND attemptCount = :zero",
              UpdateExpression: "SET #status = :queued, recipientMemberId = :memberId, recipientMemberName = :memberName, updatedAt = :now, lastErrorCode = :clear" +
                (input.responseState ? ", responseState = :responseState, responseRecordedAt = :responseAt" : ""),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":blocked": "blocked", ":queued": "queued", ":zero": 0,
                ":memberId": input.recipient.memberId, ":memberName": input.recipient.memberName,
                ":now": input.createdAt, ":clear": null,
                ...(input.responseState ? { ":responseState": input.responseState, ":responseAt": input.responseRecordedAt ?? null } : {}),
              },
            } },
            ...recoveryDutyChecks,
          ] }));
          const recovered = await this.#getEscalation(record);
          if (!recovered) throw new Error("Recovered escalation was not returned");
          return { record: recovered, replayed: true };
        } catch (recoveryError) {
          const recoveryReasons = conditionalCancellation(recoveryError);
          if (!recoveryReasons) throw recoveryError;
          if (recoveryReasons[0]?.Code === "ConditionalCheckFailed" || recoveryReasons.slice(2).some(reason => reason.Code === "ConditionalCheckFailed")) return null;
          // Another worker has already frozen a recipient; never replace it.
          const winner = await this.#getEscalation(record);
          if (!winner) throw recoveryError;
          return { record: winner, replayed: true };
        }
      }
      return { record: previous, replayed: true };
    }
  }

  #escalationDutyChecks(input: MissedTaskEscalation) {
    const now = this.#now(), date = dutyRoutingDate(input.recipient, now, this.#timeZone);
    if (date === null) return null;
    const PK = this.#partitionKey(), today = calendarDate(now, this.#timeZone);
    return [
      { ConditionCheck: { TableName: this.#tableName, Key: { PK, SK: `DUTY#${date}` },
        ...rotationSnapshotCondition({ entityType: "DutyAssignment", ...input.recipient }, ["entityType", ...dutyReviewFields]) } },
      // The read selects the first active dated row. An overlapping prior-day
      // shift inserted concurrently would otherwise change that selection.
      ...(date === today ? [{ ConditionCheck: { TableName: this.#tableName, Key: { PK, SK: `DUTY#${shiftCalendarDate(today, -1)}` },
        ConditionExpression: "attribute_not_exists(PK) OR startsAt > :now OR endsAt <= :now",
        ExpressionAttributeValues: { ":now": now.toISOString() } } }] : []),
    ];
  }

  #escalationTaskCheck(input: MissedTaskEscalation | BlockedEscalation) {
    const response = input.responseState === "not_yet" ? "not_yet" : null;
    const responseAt = response === "not_yet" ? input.responseRecordedAt ?? null : null;
    return {
      TableName: this.#tableName,
      Key: { PK: this.#partitionKey(), SK: taskSortKey({ id: input.taskId, dueAt: input.dueAt }) },
      ConditionExpression: "entityType = :task AND #state = :scheduled AND title = :title AND "
        + (response === null ? "(attribute_not_exists(lastResponse) OR lastResponse = :response)" : "lastResponse = :response")
        + " AND " + (responseAt === null ? "(attribute_not_exists(confirmedAt) OR confirmedAt = :responseAt)" : "confirmedAt = :responseAt"),
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":task": "CareTask", ":scheduled": "scheduled", ":title": input.taskTitle,
        ":response": response, ":responseAt": responseAt },
    };
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
          "#status IN (:queued, :failed)",
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

  async deferEscalationReceipt(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord> {
    try {
      return await this.#finishEscalation({ record: input.record, attemptId: input.attemptId,
        status: "receipt_pending", providerMessageId: input.providerMessageId,
        lastErrorCode: "ReceiptPersistenceError", updatedAt: input.completedAt });
    } catch (error) {
      if (!isConditionCheckFailure(error)) throw error;
      // The original receipt write may have committed before its response was lost.
      const existing = await this.#getEscalation(input.record);
      if (existing && ["sent", "receipt_pending"].includes(existing.status)
        && existing.providerMessageId === input.providerMessageId) return existing;
      throw error;
    }
  }

  async #finishEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    status: "sent" | "failed" | "receipt_pending";
    providerMessageId: string | null;
    lastErrorCode: string | null;
    updatedAt: Date;
  }): Promise<EscalationRecord> {
    const result = (await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { PK: this.#partitionKey(), SK: escalationSortKey(input.record) },
      ConditionExpression: "#status = :sending AND attemptId = :attemptId",
      UpdateExpression:
        "SET #status = :status, providerMessageId = :providerMessageId, lastErrorCode = :lastErrorCode, updatedAt = :updatedAt, attemptId = :empty, leaseUntil = :empty" +
        (input.status !== "failed" ? ", sentAt = :updatedAt" : ""),
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
    const item = result.Item;
    if (item.PK !== this.#partitionKey() || item.SK !== confirmationSortKey(requestId)
      || item.entityType !== "Confirmation" || item.requestId !== requestId
      || item.id !== `confirmation_${requestId}` || typeof item.taskId !== "string" || !item.taskId
      || !confirmationResponses.includes(item.response) || typeof item.actor !== "string"
      || !isStoredInstant(item.recordedAt)
      || (item.taskDueAt !== undefined && !isStoredInstant(item.taskDueAt))) {
      throw new Error("Stored confirmation identity is invalid");
    }
    return { id: item.id, requestId: item.requestId, taskId: item.taskId,
      ...(item.taskDueAt === undefined ? {} : { taskDueAt: item.taskDueAt }),
      response: item.response, actor: item.actor, recordedAt: item.recordedAt };
  }

  async #findTask(taskId: string): Promise<CareTask | null> {
    const snapshot = await this.today();
    return snapshot.tasks.find((task) => task.id === taskId) ?? null;
  }

  async #replayed(confirmation: Confirmation, input: Pick<Confirmation, "taskId" | "response">) {
    assertConfirmationIntent(confirmation, input);
    const dueAt = confirmation.taskDueAt ?? await this.#legacyConfirmationDueAt(confirmation);
    const key = { PK: this.#partitionKey(), SK: taskSortKey({ id: confirmation.taskId, dueAt }) };
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName, Key: key, ConsistentRead: true,
    })) as { Item?: StoredTask };
    if (!result.Item) throw new TaskNotFoundError(confirmation.taskId);
    const item = result.Item;
    if (item.PK !== key.PK || item.SK !== key.SK || item.entityType !== "CareTask"
      || item.id !== confirmation.taskId || item.dueAt !== dueAt) {
      throw new Error("Stored confirmation task binding is invalid");
    }
    const task = stripTaskStorage(item);
    return { task, confirmation, replayed: true as const };
  }

  async #legacyConfirmationDueAt(confirmation: Confirmation): Promise<string> {
    // Old receipts did not store the task sort key. Search only the local save day
    // and its predecessor (a save may cross midnight), never today's mutable view.
    const date = calendarDate(new Date(confirmation.recordedAt), this.#timeZone);
    const { startsAt } = calendarDayBounds(shiftCalendarDate(date, -1), this.#timeZone);
    const { endsAt } = calendarDayBounds(date, this.#timeZone);
    const page = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      KeyConditionExpression: "PK = :pk AND SK BETWEEN :start AND :end",
      ExpressionAttributeValues: { ":pk": this.#partitionKey(), ":start": `TASK#${startsAt}`, ":end": `TASK#${endsAt}` },
      ConsistentRead: true,
      Limit: 501,
    })) as { Items?: StoredTask[]; LastEvaluatedKey?: unknown };
    if (page.LastEvaluatedKey || (page.Items?.length ?? 0) > 500) {
      throw new Error("Legacy confirmation task lookup is incomplete");
    }
    const matches = (page.Items ?? []).filter(item => item.id === confirmation.taskId);
    if (matches.length === 0) throw new TaskNotFoundError(confirmation.taskId);
    if (matches.length !== 1) throw new Error("Legacy confirmation task identity is ambiguous");
    const item = matches[0]!;
    if (!isStoredInstant(item.dueAt) || item.dueAt < startsAt || item.dueAt >= endsAt
      || item.PK !== this.#partitionKey() || item.SK !== taskSortKey(item) || item.entityType !== "CareTask") {
      throw new Error("Legacy confirmation task binding is invalid");
    }
    return item.dueAt;
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
  completionUndoEnabled?: boolean;
  planPauseEnabled?: boolean;
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
      remaining: tasks.filter(task => task.state === "scheduled").length,
    },
  };
}

function stripEscalationStorage(stored: StoredEscalation): EscalationRecord {
  const { PK: _pk, SK: _sk, entityType: _entityType, ...record } = stored;
  return record;
}

function stripTaskStorage(stored: StoredTask): CareTask {
  const { PK: _pk, SK: _sk, entityType: _entityType, responseVersion: _responseVersion, ...task } = stored;
  return task;
}

function stripDutyStorage(stored: StoredDutyAssignment): DutyAssignment {
  const { PK: _pk, SK: _sk, entityType: _entityType, ...assignment } = stored;
  return assignment;
}

// Compare every projected value, including absent optional values. No new row is
// written unless all 21 reviewed days and the complete bounded roster still match.
function rotationSnapshotCondition(record: Record<string, unknown> | undefined, fields: string[]) {
  if (!record) return { ConditionExpression: "attribute_not_exists(PK)" };
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const expressions = fields.map((field, index) => {
    const name = `#r${index}`; names[name] = field;
    if (record[field] === undefined) return `attribute_not_exists(${name})`;
    const value = `:r${index}`; values[value] = record[field];
    return `${name} = ${value}`;
  });
  return { ConditionExpression: expressions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
}

function stripMemberStorage(stored: StoredCircleMember): CircleMember {
  return { id: stored.id, name: stored.name, relationship: stored.relationship, canReceiveAlerts: stored.canReceiveAlerts };
}
