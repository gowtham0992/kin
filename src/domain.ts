import type {
  BlockedEscalation,
  EscalationRecord,
  EscalationSummary,
  MissedTaskEscalation,
} from "./escalation.js";
import { activeDutyAt, dutyReviewFields, toEscalationSummary } from "./escalation.js";
import { calendarDate, calendarDayBounds, shiftCalendarDate, validateTimeZone } from "./calendar.js";
import { scheduledTask, sameScheduledTask, routineTasks, sameRoutine, type ScheduleRoutineInput, type ScheduleTaskInput } from "./care-plan.js";
import { editableRoutineTasks, changedRoutineTask, RoutineConflict, type RoutineChange } from "./care-plan.js";
import { assertTaskReview, type TaskReview } from "./task-review.js";
import { assertDutyReview, replayDutyChange, validateDutyChange, type DutyChangeInput, type DutyChangeReceipt, type DutyChangeResult } from "./duty-change.js";
import { acceptedDutyRotation, dutyRotationWindow, proposeDutyRotation, replayDutyRotation, validateDutyRotation,
  type DutyRotationInput, type DutyRotationProposal, type DutyRotationReceipt, type DutyRotationResult } from "./duty-rotation.js";
import { assertEditableTask, changedTask, rescheduledTask, replayTaskChange, taskChangeResult, TaskChangeConflict, type TaskChange, type TaskChangeReceipt, type TaskChangeResult } from "./task-change.js";
import type { CareWriteAuthorization } from "./care-write-authorization.js";
import { assertUndoableCompletion, replayCompletionUndo, restoredCompletion, type CompletionUndoInput, type CompletionUndoResult,
  type StoredCompletionUndo, type UndoableConfirmation } from "./response-undo.js";
import { taskReview } from "./task-review.js";
import { acceptPlanPause, assertTaskOutsidePause, makePauseWindow, planControlSchema, PlanPauseConflict, proposePlanPause, replayPlanPause,
  type PlanControl, type PlanPauseInput, type PlanPauseProposal, type PlanPauseResult, type StoredPlanPause } from "./plan-pause.js";

export const confirmationResponses = ["done", "not_yet", "skipped"] as const;

export type ConfirmationResponse = (typeof confirmationResponses)[number];
export type TaskState = "scheduled" | "done" | "skipped" | "cancelled";

export interface CareTask {
  routineId?: string;
  changedAt?: string;
  changedBy?: string;
  rescheduledFrom?: { taskId: string; dueAt: string };
  rescheduledTo?: { taskId: string; dueAt: string };
  id: string;
  title: string;
  dueAt: string;
  state: TaskState;
  lastResponse: ConfirmationResponse | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface Confirmation {
  id: string;
  requestId: string;
  taskId: string;
  /** Exact task identity; absent only on receipts written before historical replay support. */
  taskDueAt?: string;
  response: ConfirmationResponse;
  actor: string;
  recordedAt: string;
}

export interface DutyAssignment {
  changedBy?: string;
  changedAt?: string;
  memberId: string;
  memberName: string;
  startsAt: string;
  endsAt: string;
}

export interface CircleMember {
  id: string;
  name: string;
  relationship: "parent" | "daughter" | "son" | "caregiver";
  canReceiveAlerts: boolean;
}

export interface CircleSnapshot {
  startDate: string;
  endDate: string;
  members: CircleMember[];
  assignments: Array<DutyAssignment & { date: string }>;
}

export interface TodaySnapshot {
  date: string;
  tasks: CareTask[];
  onDuty: DutyAssignment | null;
  escalations: EscalationSummary[];
  summary: {
    total: number;
    completed: number;
    remaining: number;
    skipped: number;
  };
}

export interface CareActivityWindow {
  startDate: string;
  endDate: string;
  tasks: CareTask[];
  escalations: EscalationSummary[];
}

export interface CareRepository {
  readonly planPauseEnabled?: boolean;
  planControl(): Promise<PlanControl>;
  proposePlanPause(): Promise<PlanPauseProposal | null>;
  acceptPlanPause(input: PlanPauseInput, authorization?: CareWriteAuthorization): Promise<PlanPauseResult>;
  readonly completionUndoEnabled?: boolean;
  undoCompletion(input: CompletionUndoInput, authorization?: CareWriteAuthorization): Promise<CompletionUndoResult>;
  acknowledgeEscalation(input: { id: string; memberId: string; name: string }, authorization?: CareWriteAuthorization): Promise<EscalationSummary>;
  scheduleTask(input: ScheduleTaskInput, authorization?: CareWriteAuthorization): Promise<CareTask>;
  scheduleRoutine(input: ScheduleRoutineInput, authorization?: CareWriteAuthorization): Promise<CareTask[]>;
  changeRoutine(input: RoutineChange, authorization?: CareWriteAuthorization): Promise<{ requestId: string; changed: number }>;
  changeTask(input: TaskChange, authorization?: CareWriteAuthorization): Promise<TaskChangeResult>;
  today(): Promise<TodaySnapshot>;
  escalationSnapshot(asOf: Date): Promise<TodaySnapshot>;
  /** All unresolved delivery states, independent of task date; fails closed above the read budget. */
  deliveryHealthSnapshot(): Promise<EscalationSummary[]>;
  activityBetween(input: { startDate: string; endDate: string }): Promise<CareActivityWindow>;
  circle(): Promise<CircleSnapshot>;
  assignDuty(input: DutyChangeInput, authorization?: CareWriteAuthorization): Promise<DutyChangeResult>;
  proposeDutyRotation(): Promise<DutyRotationProposal>;
  acceptDutyRotation(input: DutyRotationInput, authorization?: CareWriteAuthorization): Promise<DutyRotationResult>;
  confirm(input: {
    expected?: TaskReview;
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }, authorization?: CareWriteAuthorization): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }>;
  queueEscalation(input: MissedTaskEscalation | BlockedEscalation): Promise<{
    record: EscalationRecord;
    replayed: boolean;
  } | null>;
  claimEscalation(input: {
    event: MissedTaskEscalation;
    attemptId: string;
    now: Date;
    leaseSeconds: number;
  }): Promise<EscalationRecord | null>;
  completeEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord>;
  deferEscalationReceipt(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord>;
  failEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    errorCode: string;
    failedAt: Date;
  }): Promise<EscalationRecord>;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Care task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}
export class ConfirmationConflict extends Error {
  constructor() {
    super("This confirmation request was already used for a different task or response.");
    this.name = "ConfirmationConflict";
  }
}

export function assertConfirmationIntent(
  confirmation: Confirmation,
  input: Pick<Confirmation, "taskId" | "response">,
): void {
  // Display names and reviewed snapshots can change after a successful save.
  if (confirmation.taskId !== input.taskId || confirmation.response !== input.response) {
    throw new ConfirmationConflict();
  }
}
export class EscalationNotFoundError extends Error { constructor() { super("Escalation not found"); } }

export class InMemoryCareStore implements CareRepository {
  readonly planPauseEnabled = true;
  #planControl: PlanControl = { version: 0 };
  readonly #planPauses = new Map<string, StoredPlanPause>();
  readonly completionUndoEnabled = true;
  readonly #taskChanges = new Map<string, TaskChangeReceipt>();
  readonly #scheduledTasks = new Map<string, CareTask>();
  readonly #dutyChanges = new Map<string, DutyChangeReceipt>();
  readonly #dutyRotations = new Map<string, DutyRotationReceipt>();
  readonly #routineChanges = new Map<string, { input: RoutineChange; result: { requestId: string; changed: number } }>();
  readonly #routines = new Map<string, { input: ScheduleRoutineInput; tasks: CareTask[] }>();
  readonly #tasks = new Map<string, CareTask>();
  readonly #confirmationsByRequest = new Map<string, UndoableConfirmation>();
  readonly #responseVersions = new Map<string, string>();
  readonly #completionUndos = new Map<string, StoredCompletionUndo>();
  readonly #now: () => Date;
  readonly #dutyByDate = new Map<string, DutyAssignment>();
  readonly #members: CircleMember[];
  readonly #escalations = new Map<string, EscalationRecord>();
  readonly #timeZone: string;

  constructor(
    tasks: CareTask[],
    now: () => Date = () => new Date(),
    onDuty: DutyAssignment | null = null,
    timeZone = "UTC",
    initialDuties: Array<DutyAssignment & { date: string }> = [],
    members: CircleMember[] = [
      { id: "evelyn", name: "Evelyn", relationship: "parent", canReceiveAlerts: false },
      { id: "maya", name: "Maya", relationship: "daughter", canReceiveAlerts: true },
      { id: "theo", name: "Theo", relationship: "son", canReceiveAlerts: true },
    ],
  ) {
    this.#now = now;
    this.#timeZone = validateTimeZone(timeZone);
    // Synthetic roster management and duty planning deliberately share this array.
    this.#members = members;
    for (const { date, ...assignment } of initialDuties) {
      this.#dutyByDate.set(date, structuredClone(assignment));
    }
    if (onDuty) {
      this.#dutyByDate.set(calendarDate(new Date(onDuty.startsAt), this.#timeZone), structuredClone(onDuty));
    }
    for (const task of tasks) this.#tasks.set(task.id, structuredClone(task));
  }

  async acknowledgeEscalation(input: { id: string; memberId: string; name: string }, authorization?: CareWriteAuthorization): Promise<EscalationSummary> {
    if (authorization) await authorization.assertCurrent();
    const record = this.#escalations.get(input.id);
    if (!record) throw new EscalationNotFoundError();
    record.acknowledgment ??= { memberId: input.memberId, name: input.name, at: this.#now().toISOString() };
    return toEscalationSummary(record);
  }

  async scheduleTask(input: ScheduleTaskInput, authorization?: CareWriteAuthorization): Promise<CareTask> {
    if (authorization) await authorization.assertCurrent();
    const existing = this.#scheduledTasks.get(input.id) ?? this.#tasks.get(input.id);
    if (existing) return structuredClone(sameScheduledTask(existing, input));
    const task = scheduledTask(input, this.#now());
    assertTaskOutsidePause(this.#planControl, task.dueAt);
    this.#advancePlan();
    this.#tasks.set(task.id, task);
    this.#scheduledTasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async changeTask(input: TaskChange, authorization?: CareWriteAuthorization): Promise<TaskChangeResult> {
    if (authorization) await authorization.assertCurrent();
    const receipt = this.#taskChanges.get(input.requestId);
    if (receipt) return replayTaskChange(receipt, input);
    const task = this.#tasks.get(input.taskId), now = this.#now();
    assertEditableTask(task, input, now);
    const replacement = rescheduledTask(task, input, now);
    if (replacement && this.#tasks.has(replacement.id)) throw new TaskChangeConflict();
    if (replacement) assertTaskOutsidePause(this.#planControl, replacement.dueAt);
    this.#advancePlan();
    const result = taskChangeResult(input);
    this.#tasks.set(task.id, changedTask(task, input, now.toISOString()));
    if (replacement) this.#tasks.set(replacement.id, replacement);
    this.#taskChanges.set(input.requestId, structuredClone({ input, result }));
    return structuredClone(result);
  }

  async scheduleRoutine(input: ScheduleRoutineInput, authorization?: CareWriteAuthorization): Promise<CareTask[]> {
    if (authorization) await authorization.assertCurrent();
    const receipt = this.#routines.get(input.id);
    if (receipt) return sameRoutine(receipt, input);
    const tasks = routineTasks(input, this.#now());
    if (tasks.some(task => this.#tasks.has(task.id))) throw new Error("Routine task identity conflict");
    for (const task of tasks) assertTaskOutsidePause(this.#planControl, task.dueAt);
    this.#advancePlan();
    for (const task of tasks) this.#tasks.set(task.id, structuredClone(task));
    this.#routines.set(input.id, structuredClone({ input, tasks }));
    return structuredClone(tasks);
  }

  async changeRoutine(input: RoutineChange, authorization?: CareWriteAuthorization) {
    if (authorization) await authorization.assertCurrent();
    const receipt = this.#routineChanges.get(input.requestId);
    if (receipt) { if (JSON.stringify(receipt.input) !== JSON.stringify(input)) throw new RoutineConflict(); return structuredClone(receipt.result); }
    const now = this.#now();
    const tasks = editableRoutineTasks([...this.#tasks.values()], input, now);
    this.#advancePlan();
    for (const task of tasks) this.#tasks.set(task.id, changedRoutineTask(task, input, now.toISOString()));
    const result = { requestId: input.requestId, changed: tasks.length };
    this.#routineChanges.set(input.requestId, structuredClone({ input, result }));
    return result;
  }

  #advancePlan() {
    if (!planControlSchema.safeParse(this.#planControl).success || this.#planControl.version === Number.MAX_SAFE_INTEGER) throw new PlanPauseConflict();
    this.#planControl = { ...this.#planControl, version: this.#planControl.version + 1 };
  }

  async planControl(): Promise<PlanControl> { return structuredClone(this.#planControl); }

  #pauseSnapshot(startsAt: string) {
    return { circleId: "memory", timeZone: this.#timeZone, control: this.#planControl,
      tasks: [...this.#tasks.values()].filter(task => task.dueAt >= startsAt) };
  }

  async proposePlanPause(): Promise<PlanPauseProposal | null> {
    const window = makePauseWindow(this.#now());
    if (this.#planControl.pause && this.#planControl.pause.endsAt > window.startsAt) return null;
    return proposePlanPause(this.#pauseSnapshot(window.startsAt), window);
  }

  async acceptPlanPause(input: PlanPauseInput, authorization?: CareWriteAuthorization): Promise<PlanPauseResult> {
    if (authorization) await authorization.assertCurrent();
    const prior = this.#planPauses.get(input.requestId);
    if (prior) return replayPlanPause(prior, input);
    const result = acceptPlanPause(this.#pauseSnapshot(input.startsAt), input, this.#now());
    // No await separates the complete review, all cancellations, fence, and receipt.
    for (const task of result.cancelledTasks) this.#tasks.set(task.id, structuredClone(task));
    this.#planControl = structuredClone(result.control);
    this.#planPauses.set(input.requestId, structuredClone({ input, result }));
    return structuredClone(result);
  }

  async today(): Promise<TodaySnapshot> {
    const now = this.#now();
    const date = calendarDate(now, this.#timeZone);
    const previousDate = shiftCalendarDate(date, -1);
    const tasks = [...this.#tasks.values()]
      .filter((task) => task.state !== "cancelled" && calendarDate(new Date(task.dueAt), this.#timeZone) === date)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((task) => structuredClone(task));

    const completed = tasks.filter((task) => task.state === "done").length;
    const skipped = tasks.filter((task) => task.state === "skipped").length;

    return {
      date,
      tasks,
      onDuty: this.#activeDuty(now),
      escalations: [...this.#escalations.values()]
        .filter(record => {
          const dueDate = calendarDate(new Date(record.dueAt), this.#timeZone);
          return dueDate === date || (dueDate === previousDate && !record.acknowledgment);
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(toEscalationSummary),
      summary: {
        total: tasks.length,
        completed,
        skipped,
        remaining: tasks.length - completed - skipped,
      },
    };
  }

  async activityBetween(input: {
    startDate: string;
    endDate: string;
  }): Promise<CareActivityWindow> {
    const tasks = [...this.#tasks.values()]
      .filter((task) => {
        const date = calendarDate(new Date(task.dueAt), this.#timeZone);
        return date >= input.startDate && date <= input.endDate;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((task) => structuredClone(task));
    const escalations = [...this.#escalations.values()]
      .filter((record) => {
        const date = calendarDate(new Date(record.dueAt), this.#timeZone);
        return date >= input.startDate && date <= input.endDate;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map(toEscalationSummary);

    return { ...input, tasks, escalations };
  }

  async circle(): Promise<CircleSnapshot> {
    return this.#circleSnapshot();
  }

  #circleSnapshot(): CircleSnapshot {
    const startDate = calendarDate(this.#now(), this.#timeZone);
    const endDate = shiftCalendarDate(startDate, 6);
    return {
      startDate,
      endDate,
      members: this.#members.map(({ id, name, relationship, canReceiveAlerts }) => ({ id, name, relationship, canReceiveAlerts })),
      assignments: [...this.#dutyByDate.entries()]
        .filter(([date]) => date >= startDate && date <= endDate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, assignment]) => ({ date, ...structuredClone(assignment) })),
    };
  }

  #activeDuty(now: Date): DutyAssignment | null {
    const date = calendarDate(now, this.#timeZone), previous = shiftCalendarDate(date, -1);
    const assignments = [...this.#dutyByDate.entries()].filter(([day]) => day >= previous && day <= date)
      .sort(([left], [right]) => left.localeCompare(right)).map(([, assignment]) => assignment);
    const active = activeDutyAt(assignments, now);
    return active ? structuredClone(active) : null;
  }

  async assignDuty(rawInput: DutyChangeInput, authorization?: CareWriteAuthorization): Promise<DutyChangeResult> {
    if (authorization) await authorization.assertCurrent();
    const input = validateDutyChange(rawInput);
    const receipt = input.requestId ? this.#dutyChanges.get(input.requestId) : undefined;
    if (receipt) return replayDutyChange(receipt, input);
    const current = this.#circleSnapshot();
    if (input.date < current.startDate || input.date > current.endDate) throw new Error("Duty date must be within the visible roster week");
    const member = this.#members.find((candidate) => candidate.id === input.memberId);
    if (!member?.canReceiveAlerts) throw new Error("Caregiver is not eligible for duty");
    const bounds = calendarDayBounds(input.date, this.#timeZone);
    assertDutyReview(this.#dutyByDate.get(input.date), input);
    const assignment: DutyAssignment = {
      memberId: member.id,
      memberName: member.name,
      ...bounds,
      ...(input.requestId ? { changedAt: this.#now().toISOString(), ...(input.actor ? { changedBy: input.actor } : {}) } : {}),
    };
    this.#dutyByDate.set(input.date, assignment);
    const result = { ...this.#circleSnapshot(), ...(input.requestId ? { requestId: input.requestId } : {}) };
    if (input.requestId) this.#dutyChanges.set(input.requestId, structuredClone({ input, result }));
    return result;
  }

  #rotationProposal(now: Date): DutyRotationProposal {
    const window = dutyRotationWindow(now, this.#timeZone);
    return proposeDutyRotation({ circleId: "memory", today: window.today, timeZone: this.#timeZone, rosterVersion: null,
      members: this.#members.map(({ id, name, relationship, canReceiveAlerts }) => ({ id, name, relationship, canReceiveAlerts })),
      days: window.dates.map(date => ({ date, assignment: this.#dutyByDate.get(date) ?? null })) });
  }

  async proposeDutyRotation(): Promise<DutyRotationProposal> { return this.#rotationProposal(this.#now()); }

  async acceptDutyRotation(rawInput: DutyRotationInput, authorization?: CareWriteAuthorization): Promise<DutyRotationResult> {
    if (authorization) await authorization.assertCurrent();
    const input = validateDutyRotation(rawInput);
    const receipt = this.#dutyRotations.get(input.requestId);
    if (receipt) return replayDutyRotation(receipt, input);
    const now = this.#now(), proposal = this.#rotationProposal(now);
    const result = acceptedDutyRotation(proposal, input, now);
    // No await separates review, application, and receipt: concurrent callers cannot partially apply a week.
    for (const day of proposal.days.filter(day => day.source === "proposed")) {
      const { date, ...assignment } = result.assignments.find(value => value.date === day.date)!;
      this.#dutyByDate.set(date, structuredClone(assignment));
    }
    this.#dutyRotations.set(input.requestId, structuredClone({ input, result }));
    return structuredClone(result);
  }

  async escalationSnapshot(asOf: Date): Promise<TodaySnapshot> {
    const date = calendarDate(asOf, this.#timeZone);
    const previousDate = shiftCalendarDate(date, -1);
    const tasks = [...this.#tasks.values()]
      .filter((task) => {
        const taskDate = calendarDate(new Date(task.dueAt), this.#timeZone);
        return taskDate >= previousDate && taskDate <= date;
      })
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((task) => structuredClone(task));
    const escalations = [...this.#escalations.values()]
      .filter((record) => {
        const dueDate = calendarDate(new Date(record.dueAt), this.#timeZone);
        return dueDate >= previousDate && dueDate <= date;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(toEscalationSummary);
    return snapshotFor(
      date,
      tasks,
      this.#activeDuty(asOf),
      escalations,
    );
  }

  async deliveryHealthSnapshot(): Promise<EscalationSummary[]> {
    const records = [...this.#escalations.values()].filter(record => record.status !== "sent");
    if (records.length > 500) throw new Error("Delivery health window is too large to return completely");
    return records.sort((left, right) => left.id.localeCompare(right.id)).map(toEscalationSummary);
  }

  async queueEscalation(input: MissedTaskEscalation | BlockedEscalation) {
    const id = `missed_${input.taskId}_${input.dueAt}`;
    const previous = this.#escalations.get(id);
    // No await separates this check from insertion/recovery: the in-memory store
    // shares the same atomic boundary as Dynamo's task + outbox transaction.
    if (!previous || (previous.status === "blocked" && "recipient" in input)) {
      const task = this.#tasks.get(input.taskId);
      const expectedResponse = input.responseState === "not_yet" ? "not_yet" : null;
      const expectedAt = expectedResponse === "not_yet" ? input.responseRecordedAt ?? null : null;
      if (!task || task.dueAt !== input.dueAt || task.title !== input.taskTitle || task.state !== "scheduled"
        || task.lastResponse !== expectedResponse || task.confirmedAt !== expectedAt) return null;
      if ("recipient" in input) {
        const active = this.#activeDuty(this.#now());
        if (!active || dutyReviewFields.some(field => active[field] !== input.recipient[field])) return null;
      }
    }
    if (previous?.status === "blocked" && "recipient" in input) {
      previous.status = "queued";
      previous.recipientMemberId = input.recipient.memberId;
      previous.recipientMemberName = input.recipient.memberName;
      previous.updatedAt = input.createdAt;
      previous.lastErrorCode = null;
      previous.responseState = input.responseState;
      previous.responseRecordedAt = input.responseRecordedAt;
    }
    if (previous) return { record: structuredClone(previous), replayed: true };
    const routed = "recipient" in input;
    const createdAt = routed ? input.createdAt : this.#now().toISOString();
    const record: EscalationRecord = {
      ...(input.responseState ? { responseState: input.responseState } : {}),
      ...(input.responseRecordedAt ? { responseRecordedAt: input.responseRecordedAt } : {}),
      id,
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
    this.#escalations.set(id, record);
    return { record: structuredClone(record), replayed: false };
  }

  async claimEscalation(input: {
    event: MissedTaskEscalation;
    attemptId: string;
    now: Date;
    leaseSeconds: number;
  }): Promise<EscalationRecord | null> {
    const record = this.#escalations.get(input.event.id);
    if (!record) return null;
    // A crashed worker may have sent its message. Expiry signals reconciliation,
    // not permission to publish again without evidence of non-acceptance.
    if (!["queued", "failed"].includes(record.status)) {
      return null;
    }
    record.status = "sending";
    record.attemptId = input.attemptId;
    record.attemptCount += 1;
    record.updatedAt = input.now.toISOString();
    record.leaseUntil = new Date(input.now.getTime() + input.leaseSeconds * 1_000).toISOString();
    return structuredClone(record);
  }

  async completeEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord> {
    return this.#finishEscalation(input.record.id, input.attemptId, {
      status: "sent",
      providerMessageId: input.providerMessageId,
      lastErrorCode: null,
      updatedAt: input.completedAt.toISOString(),
      sentAt: input.completedAt.toISOString(),
    });
  }

  async failEscalation(input: {
    record: EscalationRecord;
    attemptId: string;
    errorCode: string;
    failedAt: Date;
  }): Promise<EscalationRecord> {
    return this.#finishEscalation(input.record.id, input.attemptId, {
      status: "failed",
      providerMessageId: null,
      lastErrorCode: input.errorCode,
      updatedAt: input.failedAt.toISOString(),
    });
  }

  async deferEscalationReceipt(input: {
    record: EscalationRecord;
    attemptId: string;
    providerMessageId: string;
    completedAt: Date;
  }): Promise<EscalationRecord> {
    const existing = this.#escalations.get(input.record.id);
    if (existing && ["sent", "receipt_pending"].includes(existing.status)
      && existing.providerMessageId === input.providerMessageId) return structuredClone(existing);
    return this.#finishEscalation(input.record.id, input.attemptId, {
      status: "receipt_pending", providerMessageId: input.providerMessageId,
      lastErrorCode: "ReceiptPersistenceError", updatedAt: input.completedAt.toISOString(),
      sentAt: input.completedAt.toISOString(),
    });
  }

  #finishEscalation(
    id: string,
    attemptId: string,
    update: Pick<EscalationRecord, "status" | "providerMessageId" | "lastErrorCode" | "updatedAt" | "sentAt">,
  ): EscalationRecord {
    const record = this.#escalations.get(id);
    if (!record || record.status !== "sending" || record.attemptId !== attemptId) {
      throw new Error("Escalation lease was lost");
    }
    Object.assign(record, update, { attemptId: null, leaseUntil: null });
    return structuredClone(record);
  }

  async confirm(input: {
    expected?: TaskReview;
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }, authorization?: CareWriteAuthorization): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    if (authorization) await authorization.assertCurrent();
    const previous = this.#confirmationsByRequest.get(input.requestId);
    if (previous) {
      assertConfirmationIntent(previous, input);
      const previousTask = this.#tasks.get(previous.taskId);
      if (!previousTask) throw new TaskNotFoundError(previous.taskId);
      const { before: _before, ...publicConfirmation } = previous;
      return {
        task: structuredClone(previousTask),
        confirmation: structuredClone(publicConfirmation),
        replayed: true,
      };
    }

    const task = this.#tasks.get(input.taskId);
    if (!task || task.state === "cancelled") throw new TaskNotFoundError(input.taskId);

    assertTaskReview(task, input.expected);

    const recordedAt = this.#now().toISOString();
    const before = taskReview(task);
    const confirmation: Confirmation = {
      id: `confirmation_${input.requestId}`,
      requestId: input.requestId,
      taskId: input.taskId,
      taskDueAt: task.dueAt,
      response: input.response,
      actor: input.actor,
      recordedAt,
    };

    if (input.response === "not_yet") assertTaskOutsidePause(this.#planControl, task.dueAt);
    this.#advancePlan();
    task.lastResponse = input.response;
    task.confirmedBy = input.actor;
    task.confirmedAt = recordedAt;
    if (input.response === "done") task.state = "done";
    if (input.response === "skipped") task.state = "skipped";
    if (input.response === "not_yet") task.state = "scheduled";

    this.#confirmationsByRequest.set(input.requestId, { ...confirmation, before });
    this.#responseVersions.set(task.id, confirmation.id);
    return {
      task: structuredClone(task),
      confirmation: structuredClone(confirmation),
      replayed: false,
    };
  }

  async undoCompletion(input: CompletionUndoInput, authorization?: CareWriteAuthorization): Promise<CompletionUndoResult> {
    if (authorization) await authorization.assertCurrent();
    const existing = this.#completionUndos.get(input.requestId);
    if (existing) return replayCompletionUndo(existing, input);
    const confirmation = this.#confirmationsByRequest.get(input.confirmationRequestId);
    const task = this.#tasks.get(input.taskId);
    const now = this.#now();
    assertUndoableCompletion(input, confirmation, task, this.#responseVersions.get(input.taskId), now);
    const result = restoredCompletion(input, confirmation.before, task!, now);
    assertTaskOutsidePause(this.#planControl, result.task.dueAt);
    this.#advancePlan();
    this.#tasks.set(input.taskId, structuredClone(result.task));
    this.#responseVersions.set(input.taskId, result.undo.id);
    this.#completionUndos.set(input.requestId, structuredClone({ input, result }));
    return structuredClone(result);
  }
}

export function createDemoStore(
  now: () => Date = () => new Date(),
  timeZone = "UTC",
  members?: CircleMember[],
): InMemoryCareStore {
  const date = calendarDate(now(), validateTimeZone(timeZone));
  const dutyEndsAt = new Date(`${date}T02:00:00.000Z`);
  dutyEndsAt.setUTCDate(dutyEndsAt.getUTCDate() + 1);
  const initialDuties = Array.from({ length: 7 }, (_, index) => {
    const dutyDate = shiftCalendarDate(date, index);
    const isTheo = index % 2 === 0;
    return {
      date: dutyDate,
      memberId: isTheo ? "theo" : "maya",
      memberName: isTheo ? "Theo" : "Maya",
      ...calendarDayBounds(dutyDate, timeZone),
    };
  });
  return new InMemoryCareStore(
    [
      {
        id: "morning-water",
        title: "Drink a glass of water",
        dueAt: `${date}T15:00:00.000Z`,
        state: "scheduled",
        lastResponse: null,
        confirmedBy: null,
        confirmedAt: null,
      },
      {
        id: "afternoon-walk",
        title: "Take the afternoon walk",
        dueAt: `${date}T21:00:00.000Z`,
        state: "scheduled",
        lastResponse: null,
        confirmedBy: null,
        confirmedAt: null,
      },
    ],
    now,
    {
      memberId: "theo",
      memberName: "Theo",
      startsAt: `${date}T08:00:00.000Z`,
      endsAt: dutyEndsAt.toISOString(),
    },
    timeZone,
    initialDuties,
    members,
  );
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
