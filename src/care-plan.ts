import { createHash } from "node:crypto";
import { z } from "zod";
import type { CareTask } from "./domain.js";
import { calendarDate, shiftCalendarDate } from "./calendar.js";

export const scheduleRoutineBody = z.object({ title: z.string().trim().min(1).max(120),
  dueAts: z.array(z.iso.datetime()).min(2).max(14), timeZone: z.string().min(1).max(100),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }).strict();
export interface ScheduleRoutineInput { id: string; title: string; dueAts: string[]; timeZone: string }
export function routineTasks(input: ScheduleRoutineInput, now: Date): CareTask[] {
  if (input.dueAts.length < 2 || input.dueAts.length > 14) throw new RangeError("Choose 2 to 14 daily check-ins");
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const first = new Date(input.dueAts[0]!);
  const start = calendarDate(first, input.timeZone), wallTime = clock.format(first);
  return input.dueAts.map((dueAt, index) => {
    const date = new Date(dueAt);
    if (calendarDate(date, input.timeZone) !== shiftCalendarDate(start, index) || clock.format(date) !== wallTime) {
      throw new RangeError("Daily check-ins must keep the same local time on consecutive dates");
    }
    return scheduledTask({ id: `${input.id}-${index + 1}`, title: input.title, dueAt }, now);
  });
}
export function sameRoutine(receipt: { input: ScheduleRoutineInput; tasks: CareTask[] }, input: ScheduleRoutineInput): CareTask[] {
  if (JSON.stringify(receipt.input) !== JSON.stringify(input)) throw new PlanConflict();
  return structuredClone(receipt.tasks);
}

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
