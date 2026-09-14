import { z } from "zod";
import type { CareTask, Confirmation } from "./domain.js";
import { taskReview, taskReviewSchema, type TaskReview } from "./task-review.js";

export const completionUndoLifetime = 5 * 60_000;
export const completionUndoBody = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  confirmationRequestId: z.string().min(8).max(100),
  requestId: z.string().min(8).max(100),
  expected: taskReviewSchema,
  restore: taskReviewSchema,
  confirm: z.literal(true),
}).strict();
export type CompletionUndoInput = z.infer<typeof completionUndoBody> & { actor: string };
export interface UndoableConfirmation extends Confirmation { before?: TaskReview }
export interface CompletionUndoReceipt {
  id: string; requestId: string; confirmationRequestId: string;
  taskId: string; taskDueAt: string; actor: string; recordedAt: string; restored: TaskReview;
}
export interface CompletionUndoResult { undo: CompletionUndoReceipt; task: CareTask; replayed: boolean }
export interface StoredCompletionUndo { input: CompletionUndoInput; result: CompletionUndoResult }
export class CompletionUndoConflict extends Error {
  constructor() { super("That completion can no longer be undone. Review the current plan."); this.name = "CompletionUndoConflict"; }
}

export function reviewedCompletionMatches(task: CareTask, expected: TaskReview) {
  return Object.entries(taskReview(task)).every(([key, value]) => value === expected[key as keyof TaskReview]);
}

export function assertUndoableCompletion(input: CompletionUndoInput, confirmation: UndoableConfirmation | undefined | null,
  task: CareTask | undefined | null, responseVersion: string | undefined, now: Date): asserts confirmation is UndoableConfirmation & { before: TaskReview } {
  const before = taskReviewSchema.safeParse(confirmation?.before);
  const recordedAt = Date.parse(confirmation?.recordedAt ?? "");
  const { actor, ...body } = input;
  if (!completionUndoBody.safeParse(body).success || !actor || actor.length > 80) throw new CompletionUndoConflict();
  if (!confirmation || !task || !before.success || before.data.state !== "scheduled" || confirmation.response !== "done" ||
      (before.data.lastResponse !== null && before.data.lastResponse !== "not_yet") ||
      confirmation.id !== `confirmation_${input.confirmationRequestId}` ||
      confirmation.requestId !== input.confirmationRequestId || confirmation.taskId !== input.taskId || task.id !== input.taskId ||
      confirmation.taskDueAt !== task.dueAt || before.data.dueAt !== task.dueAt || before.data.title !== task.title ||
      !reviewedCompletionMatches({ id: task.id, ...before.data }, input.restore) ||
      responseVersion !== confirmation.id || task.state !== "done" || task.lastResponse !== "done" ||
      task.confirmedAt !== confirmation.recordedAt || task.confirmedBy !== confirmation.actor ||
      !reviewedCompletionMatches(task, input.expected) || !Number.isFinite(recordedAt) ||
      !Number.isFinite(now.getTime()) || recordedAt > now.getTime() || now.getTime() - recordedAt > completionUndoLifetime) {
    throw new CompletionUndoConflict();
  }
}

export function restoredCompletion(input: CompletionUndoInput, before: TaskReview, task: CareTask, now: Date): CompletionUndoResult {
  const restored = { ...task, ...before };
  return { task: restored, replayed: false, undo: {
    id: `undo_${input.requestId}`, requestId: input.requestId, confirmationRequestId: input.confirmationRequestId,
    taskId: task.id, taskDueAt: task.dueAt, actor: input.actor, recordedAt: now.toISOString(), restored: taskReview(restored),
  } };
}

export function replayCompletionUndo(receipt: StoredCompletionUndo, input: CompletionUndoInput): CompletionUndoResult {
  const previous = receipt.input, result = receipt.result;
  const { actor: _actor, ...body } = input;
  if (!completionUndoBody.safeParse(body).success || !previous || !result || previous.taskId !== input.taskId || previous.confirmationRequestId !== input.confirmationRequestId ||
      previous.requestId !== input.requestId || previous.confirm !== true || !reviewedCompletionMatches({ id: input.taskId, ...previous.expected }, input.expected) ||
      !reviewedCompletionMatches({ id: input.taskId, ...previous.restore }, input.restore) ||
      result.undo?.id !== `undo_${input.requestId}` || result.undo.requestId !== input.requestId ||
      result.undo.confirmationRequestId !== input.confirmationRequestId || result.undo.taskId !== input.taskId ||
      result.undo.taskDueAt !== input.expected.dueAt || result.task?.id !== input.taskId || result.task.dueAt !== input.expected.dueAt ||
      !taskReviewSchema.safeParse(result.undo.restored).success || !reviewedCompletionMatches(result.task, result.undo.restored) ||
      !reviewedCompletionMatches(result.task, input.restore)) {
    throw new CompletionUndoConflict();
  }
  return structuredClone({ ...result, replayed: true });
}
