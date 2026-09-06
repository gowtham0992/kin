import { createHash } from "node:crypto";
import { z } from "zod";
import type { CareTask } from "./domain.js";

export const scheduleTaskBody = z.object({ title: z.string().trim().min(1).max(120),
  dueAt: z.iso.datetime(), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }).strict();
export class PlanConflict extends Error { constructor() { super("This scheduling request already belongs to a different task"); } }
export interface ScheduleTaskInput { id: string; title: string; dueAt: string }
export function scheduledTask(input: ScheduleTaskInput, now: Date): CareTask {
  const due = new Date(input.dueAt);
  if (!Number.isFinite(due.getTime()) || due.getTime() <= now.getTime() || due.getTime() > now.getTime() + 30 * 86400000 || !input.title.trim() || input.title.length > 120) {
    throw new RangeError("Schedule a named check-in in the next 30 days");
  }
  return { ...input, dueAt: due.toISOString(), state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null };
}
export function scheduledTaskId(memberId: string, requestId: string) {
  return `care-${createHash("sha256").update(JSON.stringify([memberId, requestId])).digest("hex").slice(0, 40)}`;
}
export function sameScheduledTask(task: CareTask, input: ScheduleTaskInput): CareTask {
if (task.title !== input.title || task.dueAt !== new Date(input.dueAt).toISOString()) throw new PlanConflict();
  return task;
}
