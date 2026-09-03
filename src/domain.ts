import type {
  BlockedEscalation,
  EscalationRecord,
  EscalationSummary,
  MissedTaskEscalation,
} from "./escalation.js";
import { toEscalationSummary } from "./escalation.js";
import { calendarDate, shiftCalendarDate, validateTimeZone } from "./calendar.js";

export const confirmationResponses = ["done", "not_yet", "skipped"] as const;

export type ConfirmationResponse = (typeof confirmationResponses)[number];
export type TaskState = "scheduled" | "done" | "skipped";

export interface CareTask {
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
  response: ConfirmationResponse;
  actor: string;
  recordedAt: string;
}

export interface DutyAssignment {
  memberId: string;
  memberName: string;
  startsAt: string;
  endsAt: string;
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
  today(): Promise<TodaySnapshot>;
  escalationSnapshot(asOf: Date): Promise<TodaySnapshot>;
  activityBetween(input: { startDate: string; endDate: string }): Promise<CareActivityWindow>;
  confirm(input: {
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }>;
  queueEscalation(input: MissedTaskEscalation | BlockedEscalation): Promise<{
    record: EscalationRecord;
    replayed: boolean;
  }>;
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

export class InMemoryCareStore implements CareRepository {
  readonly #tasks = new Map<string, CareTask>();
  readonly #confirmationsByRequest = new Map<string, Confirmation>();
  readonly #now: () => Date;
  readonly #onDuty: DutyAssignment | null;
  readonly #escalations = new Map<string, EscalationRecord>();
  readonly #timeZone: string;

  constructor(
    tasks: CareTask[],
    now: () => Date = () => new Date(),
    onDuty: DutyAssignment | null = null,
    timeZone = "UTC",
  ) {
    this.#now = now;
    this.#onDuty = onDuty ? structuredClone(onDuty) : null;
    this.#timeZone = validateTimeZone(timeZone);
    for (const task of tasks) this.#tasks.set(task.id, structuredClone(task));
  }

  async today(): Promise<TodaySnapshot> {
    const date = calendarDate(this.#now(), this.#timeZone);
    const tasks = [...this.#tasks.values()]
      .filter((task) => calendarDate(new Date(task.dueAt), this.#timeZone) === date)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .map((task) => structuredClone(task));

    const completed = tasks.filter((task) => task.state === "done").length;
    const skipped = tasks.filter((task) => task.state === "skipped").length;

    return {
      date,
      tasks,
      onDuty: this.#onDuty ? structuredClone(this.#onDuty) : null,
      escalations: [...this.#escalations.values()]
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
      this.#onDuty ? structuredClone(this.#onDuty) : null,
      escalations,
    );
  }

  async queueEscalation(input: MissedTaskEscalation | BlockedEscalation) {
    const id = `missed_${input.taskId}_${input.dueAt}`;
    const previous = this.#escalations.get(id);
    if (previous) return { record: structuredClone(previous), replayed: true };
    const routed = "recipient" in input;
    const createdAt = routed ? input.createdAt : this.#now().toISOString();
    const record: EscalationRecord = {
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
    const leaseExpired = record.leaseUntil !== null && record.leaseUntil <= input.now.toISOString();
    if (!["queued", "failed"].includes(record.status) && !(record.status === "sending" && leaseExpired)) {
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

  #finishEscalation(
    id: string,
    attemptId: string,
    update: Pick<EscalationRecord, "status" | "providerMessageId" | "lastErrorCode" | "updatedAt">,
  ): EscalationRecord {
    const record = this.#escalations.get(id);
    if (!record || record.status !== "sending" || record.attemptId !== attemptId) {
      throw new Error("Escalation lease was lost");
    }
    Object.assign(record, update, { attemptId: null, leaseUntil: null });
    return structuredClone(record);
  }

  async confirm(input: {
    taskId: string;
    response: ConfirmationResponse;
    actor: string;
    requestId: string;
  }): Promise<{ task: CareTask; confirmation: Confirmation; replayed: boolean }> {
    const previous = this.#confirmationsByRequest.get(input.requestId);
    if (previous) {
      const previousTask = this.#tasks.get(previous.taskId);
      if (!previousTask) throw new TaskNotFoundError(previous.taskId);
      return {
        task: structuredClone(previousTask),
        confirmation: structuredClone(previous),
        replayed: true,
      };
    }

    const task = this.#tasks.get(input.taskId);
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

    task.lastResponse = input.response;
    task.confirmedBy = input.actor;
    task.confirmedAt = recordedAt;
    if (input.response === "done") task.state = "done";
    if (input.response === "skipped") task.state = "skipped";
    if (input.response === "not_yet") task.state = "scheduled";

    this.#confirmationsByRequest.set(input.requestId, confirmation);
    return {
      task: structuredClone(task),
      confirmation: structuredClone(confirmation),
      replayed: false,
    };
  }
}

export function createDemoStore(
  now: () => Date = () => new Date(),
  timeZone = "UTC",
): InMemoryCareStore {
  const date = calendarDate(now(), validateTimeZone(timeZone));
  const dutyEndsAt = new Date(`${date}T02:00:00.000Z`);
  dutyEndsAt.setUTCDate(dutyEndsAt.getUTCDate() + 1);
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
  );
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
