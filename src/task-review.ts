import { z } from "zod";
import type { CareTask } from "./domain.js";

export const taskReviewSchema = z.object({
  title: z.string().min(1).max(120), dueAt: z.string().datetime(),
  state: z.enum(["scheduled", "done", "skipped", "cancelled"]),
  lastResponse: z.enum(["done", "not_yet", "skipped"]).nullable(),
  confirmedAt: z.string().datetime().nullable(), confirmedBy: z.string().nullable(),
}).strict();
export type TaskReview = z.infer<typeof taskReviewSchema>;
export class TaskReviewRequired extends Error {
  constructor() { super("Review the current task before confirming. The reviewed task state is required."); }
}
export class TaskReviewConflict extends Error {
  constructor() { super("The task changed after review. Review the current task before confirming."); }
}
export function taskReview(task: CareTask): TaskReview {
  return { title: task.title, dueAt: task.dueAt, state: task.state, lastResponse: task.lastResponse,
    confirmedAt: task.confirmedAt, confirmedBy: task.confirmedBy };
}
export function assertTaskReview(task: CareTask, expected?: TaskReview) {
  if (expected && Object.entries(taskReview(task)).some(([key, value]) => value !== expected[key as keyof TaskReview])) {
    throw new TaskReviewConflict();
  }
}
