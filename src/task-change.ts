import { z } from "zod";
import { createHash } from "node:crypto";
import type { CareTask } from "./domain.js";
import { scheduledTask } from "./care-plan.js";

export const taskChangeBody = z.object({
  action: z.enum(["rename", "cancel", "reschedule", "close_unanswered"]),
  title: z.string().trim().min(1).max(120).optional(),
  dueAt: z.iso.datetime().refine(value => new Date(value).toISOString() === value).optional(),
  expected: z.object({ title: z.string().min(1).max(120), dueAt: z.iso.datetime() }).strict(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  confirm: z.literal(true),
}).strict().refine(input => input.action === "rename" ? input.title !== undefined && input.dueAt === undefined
  : input.action === "reschedule" ? input.title === undefined && input.dueAt !== undefined
  : input.title === undefined && input.dueAt === undefined);

export type TaskChange = z.infer<typeof taskChangeBody> & { taskId: string; actor: string };
export interface TaskChangeResult { requestId: string; taskId: string; action: TaskChange["action"]; changed: 1;
  replacement?: { taskId: string; dueAt: string } }
export interface TaskChangeReceipt { input: TaskChange; result: TaskChangeResult }
export class TaskChangeConflict extends Error {
  constructor() { super("The check-in changed. Refresh and review it again."); this.name = "TaskChangeConflict"; }
}

export function assertEditableTask(task: CareTask | undefined, input: TaskChange, now: Date): asserts task is CareTask {
  const closing = input.action === "close_unanswered";
  if (!task || task.id !== input.taskId || (!closing && task.routineId !== undefined) || task.state !== "scheduled" ||
      task.lastResponse !== null || task.confirmedAt !== null || task.confirmedBy !== null ||
      task.title !== input.expected.title || task.dueAt !== input.expected.dueAt ||
      !Number.isFinite(Date.parse(task.dueAt)) ||
      (closing ? Date.parse(task.dueAt) >= now.getTime() : Date.parse(task.dueAt) <= now.getTime())) {
    throw new TaskChangeConflict();
  }
}

export function changedTask(task: CareTask, input: TaskChange, at: string): CareTask {
  return { ...task, ...(input.action !== "rename" ? { state: input.action === "close_unanswered" ? "closed_unanswered" as const : "cancelled" as const } : { title: input.title! }),
    ...(input.action === "reschedule" ? { rescheduledTo: { taskId: replacementTaskId(input), dueAt: input.dueAt! } } : {}),
    changedAt: at, changedBy: input.actor };
}

function replacementTaskId(input: TaskChange): string {
  return `care-${createHash("sha256").update(JSON.stringify(["reschedule", input.taskId, input.requestId])).digest("hex").slice(0, 40)}`;
}

export function rescheduledTask(task: CareTask, input: TaskChange, now: Date): CareTask | undefined {
  if (input.action !== "reschedule") return undefined;
  if (!input.dueAt || !Number.isFinite(Date.parse(input.dueAt)) || new Date(input.dueAt).toISOString() !== input.dueAt ||
      Date.parse(input.dueAt) === Date.parse(task.dueAt)) throw new RangeError("Choose a different time in the next 30 days");
  return { ...scheduledTask({ id: replacementTaskId(input), title: task.title, dueAt: input.dueAt }, now),
    rescheduledFrom: { taskId: task.id, dueAt: task.dueAt } };
}

export function taskChangeResult(input: TaskChange): TaskChangeResult {
  return { requestId: input.requestId, taskId: input.taskId, action: input.action, changed: 1,
    ...(input.action === "reschedule" ? { replacement: { taskId: replacementTaskId(input), dueAt: input.dueAt! } } : {}) };
}

export function replayTaskChange(receipt: TaskChangeReceipt, input: TaskChange): TaskChangeResult {
  const previous = receipt.input;
  // The receipt key is scoped to a stable member. A later display-name change is not a new intent.
  if (!previous || previous.taskId !== input.taskId || previous.action !== input.action || previous.title !== input.title || previous.dueAt !== input.dueAt ||
      previous.expected?.title !== input.expected.title || previous.expected?.dueAt !== input.expected.dueAt ||
      previous.requestId !== input.requestId || previous.confirm !== true || receipt.result?.requestId !== input.requestId ||
      receipt.result.taskId !== input.taskId || receipt.result.action !== input.action || receipt.result.changed !== 1 ||
      (input.action === "reschedule" ? receipt.result.replacement?.taskId !== replacementTaskId(input) || receipt.result.replacement?.dueAt !== input.dueAt
        : receipt.result.replacement !== undefined)) {
    throw new TaskChangeConflict();
  }
  return structuredClone(receipt.result);
}
