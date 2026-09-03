import type { CareTask, DutyAssignment, TodaySnapshot } from "./domain.js";

export interface MissedTaskEscalation {
  id: string;
  taskId: string;
  taskTitle: string;
  dueAt: string;
  createdAt: string;
  recipient: DutyAssignment;
}

export interface BlockedEscalation {
  taskId: string;
  taskTitle: string;
  dueAt: string;
  reason: "no_active_duty_assignment";
}

export type EscalationStatus = "blocked" | "queued" | "sending" | "sent" | "failed";

export interface EscalationRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  recipientMemberId: string | null;
  recipientMemberName: string | null;
  status: EscalationStatus;
  attemptCount: number;
  attemptId: string | null;
  leaseUntil: string | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
}

export type EscalationSummary = Pick<
  EscalationRecord,
  | "id"
  | "taskId"
  | "dueAt"
  | "updatedAt"
  | "recipientMemberName"
  | "status"
>;

export function toEscalationSummary(record: EscalationRecord): EscalationSummary {
  return {
    id: record.id,
    taskId: record.taskId,
    dueAt: record.dueAt,
    updatedAt: record.updatedAt,
    recipientMemberName: record.recipientMemberName,
    status: record.status,
  };
}

export interface EscalationStore {
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

export interface AlertPublisher {
  publish(record: EscalationRecord): Promise<{ messageId: string }>;
}

export interface EscalationPlan {
  events: MissedTaskEscalation[];
  blocked: BlockedEscalation[];
}

export function planMissedTaskEscalations(input: {
  snapshot: TodaySnapshot;
  now?: Date;
  graceMinutes?: number;
}): EscalationPlan {
  const now = input.now ?? new Date();
  const graceMinutes = input.graceMinutes ?? 30;
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 1_440) {
    throw new Error("graceMinutes must be an integer between 0 and 1440");
  }

  const missed = input.snapshot.tasks.filter((task) => isMissed(task, now, graceMinutes));
  const onDuty = activeDuty(input.snapshot.onDuty, now);
  if (!onDuty) {
    return {
      events: [],
      blocked: missed.map((task) => ({
        taskId: task.id,
        taskTitle: task.title,
        dueAt: task.dueAt,
        reason: "no_active_duty_assignment",
      })),
    };
  }

  return {
    blocked: [],
    events: missed.map((task) => ({
      id: `missed_${task.id}_${task.dueAt}`,
      taskId: task.id,
      taskTitle: task.title,
      dueAt: task.dueAt,
      createdAt: now.toISOString(),
      recipient: structuredClone(onDuty),
    })),
  };
}

export async function runEscalationSweep(input: {
  snapshot: TodaySnapshot;
  store: EscalationStore;
  publisher: AlertPublisher;
  now?: Date;
  graceMinutes?: number;
  attemptId: string;
}): Promise<{ records: EscalationRecord[] }> {
  const now = input.now ?? new Date();
  const plan = planMissedTaskEscalations({
    snapshot: input.snapshot,
    now,
    graceMinutes: input.graceMinutes,
  });
  const records: EscalationRecord[] = [];

  for (const blocked of plan.blocked) {
    const queued = await input.store.queueEscalation(blocked);
    records.push(queued.record);
  }

  for (const event of plan.events) {
    const queued = await input.store.queueEscalation(event);
    if (queued.record.status === "sent" || queued.record.status === "blocked") {
      records.push(queued.record);
      continue;
    }

    const claimed = await input.store.claimEscalation({
      event,
      attemptId: input.attemptId,
      now,
      leaseSeconds: 60,
    });
    if (!claimed) {
      records.push(queued.record);
      continue;
    }

    try {
      const published = await input.publisher.publish(claimed);
      records.push(await input.store.completeEscalation({
        record: claimed,
        attemptId: input.attemptId,
        providerMessageId: published.messageId,
        completedAt: now,
      }));
    } catch (error) {
      const errorCode = error instanceof Error && error.name ? error.name : "AlertPublishError";
      records.push(await input.store.failEscalation({
        record: claimed,
        attemptId: input.attemptId,
        errorCode,
        failedAt: now,
      }));
    }
  }

  return { records };
}

function isMissed(task: CareTask, now: Date, graceMinutes: number): boolean {
  if (task.state !== "scheduled") return false;
  const dueAt = new Date(task.dueAt).getTime();
  return Number.isFinite(dueAt) && now.getTime() >= dueAt + graceMinutes * 60_000;
}

function activeDuty(duty: DutyAssignment | null, now: Date): DutyAssignment | null {
  if (!duty) return null;
  const nowMs = now.getTime();
  if (new Date(duty.startsAt).getTime() > nowMs) return null;
  if (new Date(duty.endsAt).getTime() <= nowMs) return null;
  return duty;
}
