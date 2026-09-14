import type { CareTask, DutyAssignment, TodaySnapshot } from "./domain.js";
import { calendarDate, shiftCalendarDate } from "./calendar.js";

export const dutyReviewFields = ["memberId", "memberName", "startsAt", "endsAt", "changedAt", "changedBy"] as const;

// Assignments arrive in dated-key order; a prior-day shift can cover early today.
export function activeDutyAt(assignments: DutyAssignment[], now: Date): DutyAssignment | null {
  const instant = now.getTime();
  return assignments.find(duty => {
    const startsAt = Date.parse(duty.startsAt), endsAt = Date.parse(duty.endsAt);
    return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= instant && endsAt > instant;
  }) ?? null;
}

export function dutyRoutingDate(duty: DutyAssignment, now: Date, timeZone: string): string | null {
  if (!activeDutyAt([duty], now)) return null;
  const date = calendarDate(new Date(duty.startsAt), timeZone), today = calendarDate(now, timeZone);
  return date === today || date === shiftCalendarDate(today, -1) ? date : null;
}

export interface FollowUpContext {
  responseState?: "not_yet" | "no_response";
  responseRecordedAt?: string | null;
}

export interface MissedTaskEscalation extends FollowUpContext {
  id: string;
  taskId: string;
  taskTitle: string;
  dueAt: string;
  createdAt: string;
  recipient: DutyAssignment;
}

export interface BlockedEscalation extends FollowUpContext {
  taskId: string;
  taskTitle: string;
  dueAt: string;
  reason: "no_active_duty_assignment";
}

export type EscalationStatus = "blocked" | "queued" | "sending" | "sent" | "failed" | "receipt_pending";

export interface EscalationRecord extends FollowUpContext {
  /** Provider acceptance, not handset delivery; never inferred for legacy records. */
  sentAt?: string;
  acknowledgment?: { memberId: string; name: string; at: string };
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
> & FollowUpContext & { acknowledgedBy?: string; acknowledgedAt?: string; recipientMemberId?: string | null; sentAt?: string };

export function toEscalationSummary(record: EscalationRecord): EscalationSummary {
  return {
    ...followUpContext(record),
    ...(record.sentAt ? { sentAt: record.sentAt } : {}),
    recipientMemberId: record.recipientMemberId,
    ...(record.acknowledgment ? { acknowledgedBy: record.acknowledgment.name, acknowledgedAt: record.acknowledgment.at } : {}),
    id: record.id,
    taskId: record.taskId,
    dueAt: record.dueAt,
    updatedAt: record.updatedAt,
    recipientMemberName: record.recipientMemberName,
    status: record.status,
  };
}

export function followUpContext(input: FollowUpContext): FollowUpContext {
  return input.responseState ? { responseState: input.responseState,
    ...(input.responseState === "not_yet" && input.responseRecordedAt ? { responseRecordedAt: input.responseRecordedAt } : {}) } : {};
}

function responseContext(task: CareTask): FollowUpContext {
  return task.lastResponse === "not_yet"
    ? { responseState: "not_yet", ...(task.confirmedAt ? { responseRecordedAt: task.confirmedAt } : {}) }
    : { responseState: "no_response" };
}

export interface EscalationStore {
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
  /** The provider accepted; preserve its receipt without making this a retryable send. */
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
  const onDuty = activeDutyAt(input.snapshot.onDuty ? [input.snapshot.onDuty] : [], now);
  if (!onDuty) {
    return {
      events: [],
      blocked: missed.map((task) => ({
        ...responseContext(task),
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
      ...responseContext(task),
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
  completionClock?: () => Date;
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
    if (queued) records.push(queued.record);
  }

  for (const event of plan.events) {
    const queued = await input.store.queueEscalation(event);
    if (!queued) continue;
    if (["sent", "blocked", "receipt_pending"].includes(queued.record.status)) {
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

    let published: { messageId: string };
    try {
      published = await input.publisher.publish(claimed);
    } catch (error) {
      const errorCode = error instanceof Error && error.name ? error.name : "AlertPublishError";
      records.push(await input.store.failEscalation({
        record: claimed,
        attemptId: input.attemptId,
        errorCode,
        failedAt: input.completionClock?.() ?? now,
      }));
      continue;
    }

    const receipt = { record: claimed, attemptId: input.attemptId,
      providerMessageId: published.messageId, completedAt: input.completionClock?.() ?? now };
    try {
      records.push(await input.store.completeEscalation(receipt));
    } catch {
      // Never turn a known accepted publish into a retryable failure. If even this
      // write fails, propagate: the durable sending state also cannot be reclaimed.
      records.push(await input.store.deferEscalationReceipt(receipt));
    }
  }

  return { records };
}

function isMissed(task: CareTask, now: Date, graceMinutes: number): boolean {
  if (task.state !== "scheduled") return false;
  const dueAt = new Date(task.dueAt).getTime();
  if (!Number.isFinite(dueAt)) return false;
  const repliedAt = task.lastResponse === "not_yet" && task.confirmedAt
    ? new Date(task.confirmedAt).getTime() : Number.NaN;
  // Reuse the persisted reply timestamp, so replaying a receipt cannot postpone follow-up.
  // A malformed or future timestamp must not hide an overdue check-in indefinitely.
  const graceStartsAt = Number.isFinite(repliedAt) && repliedAt <= now.getTime()
    ? Math.max(dueAt, repliedAt) : dueAt;
  return now.getTime() >= graceStartsAt + graceMinutes * 60_000;
}
