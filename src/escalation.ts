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
  dueAt: string;
  reason: "no_active_duty_assignment";
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
