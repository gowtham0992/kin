import { createHash } from "node:crypto";
import { z } from "zod";
import { validateTimeZone } from "./calendar.js";
import type { CareTask } from "./domain.js";
import { taskReview, taskReviewSchema } from "./task-review.js";

export const pauseDurationMs = 168 * 3_600_000;
export const pauseReviewLifetimeMs = 5 * 60_000;
export const pauseTaskLimit = 25;
const instant = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const windowSchema = z.object({ startsAt: instant, endsAt: instant }).strict()
  .refine(value => Date.parse(value.endsAt) - Date.parse(value.startsAt) === pauseDurationMs);
const pauseSchema = z.object({ requestId, startsAt: instant, endsAt: instant, recordedAt: instant, actor: z.string().min(1).max(80) }).strict()
  .refine(value => Date.parse(value.endsAt) - Date.parse(value.startsAt) === pauseDurationMs &&
    Date.parse(value.recordedAt) >= Date.parse(value.startsAt) && Date.parse(value.recordedAt) <= Date.parse(value.startsAt) + pauseReviewLifetimeMs);
export const planControlSchema = z.object({ version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pause: pauseSchema.optional() }).strict();
export type PlanControl = z.infer<typeof planControlSchema>;
export const planPauseBody = z.object({ startsAt: instant, endsAt: instant,
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/), requestId, confirm: z.literal(true) }).strict()
  .refine(value => Date.parse(value.endsAt) - Date.parse(value.startsAt) === pauseDurationMs);
export type PlanPauseInput = z.infer<typeof planPauseBody> & { actor: string };
export interface PlanPauseWindow { startsAt: string; endsAt: string }
export interface PlanPauseSnapshot { circleId: string; timeZone: string; control: PlanControl; tasks: CareTask[] }
export interface PausedTaskReference { id: string; title: string; dueAt: string }
export interface PlanPauseProposal extends PlanPauseWindow {
  timeZone: string; durationHours: 168; expiresAt: string; reviewToken: string;
  tasks: PausedTaskReference[]; nextTask: PausedTaskReference | null;
}
export interface PlanPauseReceipt extends PlanPauseWindow {
  requestId: string; recordedAt: string; actor: string; timeZone: string;
  cancelled: PausedTaskReference[]; nextTask: PausedTaskReference | null;
}
export interface PlanPauseResult { receipt: PlanPauseReceipt; control: PlanControl; cancelledTasks: CareTask[]; replayed: boolean }
export interface StoredPlanPause { input: PlanPauseInput; result: PlanPauseResult }
export const pausedTaskReferenceSchema = z.object({ id: identity, title: z.string().min(1).max(120), dueAt: instant }).strict();
export const planPauseProposalSchema = z.object({ startsAt: instant, endsAt: instant, timeZone: z.string().min(1).max(100),
  durationHours: z.literal(168), expiresAt: instant, reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.array(pausedTaskReferenceSchema).max(pauseTaskLimit), nextTask: pausedTaskReferenceSchema.nullable(),
}).strict().refine(value => {
  try { validateTimeZone(value.timeZone); } catch { return false; }
  return Date.parse(value.endsAt) - Date.parse(value.startsAt) === pauseDurationMs &&
    Date.parse(value.expiresAt) - Date.parse(value.startsAt) === pauseReviewLifetimeMs &&
    new Set(value.tasks.map(task => task.id)).size === value.tasks.length &&
    value.tasks.every(task => task.dueAt > value.startsAt && task.dueAt < value.endsAt) &&
    (!value.nextTask || value.nextTask.dueAt >= value.endsAt);
});
export class PlanPauseConflict extends Error {
  constructor() { super("The plan changed or this pause cannot be applied. Review the current plan again."); this.name = "PlanPauseConflict"; }
}
export function makePauseWindow(now: Date): PlanPauseWindow {
  if (!Number.isFinite(now.getTime())) throw new PlanPauseConflict();
  return { startsAt: now.toISOString(), endsAt: new Date(now.getTime() + pauseDurationMs).toISOString() };
}
const reference = (task: CareTask): PausedTaskReference => ({ id: task.id, title: task.title, dueAt: task.dueAt });
const untouched = (task: CareTask) => task.state === "scheduled" && task.lastResponse === null && task.confirmedAt === null && task.confirmedBy === null;
const ordered = (a: CareTask, b: CareTask) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id);

function reviewedSnapshot(snapshot: PlanPauseSnapshot, window: PlanPauseWindow) {
  if (!windowSchema.safeParse(window).success || !snapshot.circleId || snapshot.circleId.length > 100 ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 500 || !planControlSchema.safeParse(snapshot.control).success) throw new PlanPauseConflict();
  try { validateTimeZone(snapshot.timeZone); } catch { throw new PlanPauseConflict(); }
  if (snapshot.control.pause && snapshot.control.pause.endsAt > window.startsAt) throw new PlanPauseConflict();
  const tasks = snapshot.tasks.map(task => {
    if (!identity.safeParse(task.id).success || !taskReviewSchema.safeParse(taskReview(task)).success || !instant.safeParse(task.dueAt).success) throw new PlanPauseConflict();
    return structuredClone(task);
  }).sort(ordered);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new PlanPauseConflict();
  const selected = tasks.filter(task => untouched(task) && task.dueAt > window.startsAt && task.dueAt < window.endsAt);
  if (selected.length > pauseTaskLimit) throw new PlanPauseConflict();
  return { tasks, selected };
}

/** This token binds a review, not authorization. Re-read with the same start/end at commit. */
export function proposePlanPause(snapshot: PlanPauseSnapshot, window: PlanPauseWindow): PlanPauseProposal {
  const { tasks, selected } = reviewedSnapshot(snapshot, window);
  const next = tasks.find(task => untouched(task) && task.dueAt >= window.endsAt);
  const basis = { circleId: snapshot.circleId, timeZone: snapshot.timeZone, control: planControlSchema.parse(snapshot.control),
    ...window, tasks: tasks.map(task => ({ id: task.id, ...taskReview(task) })) };
  return { ...window, timeZone: snapshot.timeZone, durationHours: 168,
    expiresAt: new Date(Date.parse(window.startsAt) + pauseReviewLifetimeMs).toISOString(),
    reviewToken: createHash("sha256").update(JSON.stringify(basis)).digest("hex"),
    tasks: selected.map(reference), nextTask: next ? reference(next) : null };
}

/** Atomic persistence of every returned cancellation, control, and receipt belongs to the repository. */
export function acceptPlanPause(snapshot: PlanPauseSnapshot, input: PlanPauseInput, now: Date): PlanPauseResult {
  const { actor, ...body } = input;
  if (!planPauseBody.safeParse(body).success || !z.string().min(1).max(80).safeParse(actor).success || !Number.isFinite(now.getTime()) ||
      now.getTime() < Date.parse(input.startsAt) || now.getTime() > Date.parse(input.startsAt) + pauseReviewLifetimeMs) throw new PlanPauseConflict();
  const window = { startsAt: input.startsAt, endsAt: input.endsAt };
  const proposal = proposePlanPause(snapshot, window), { selected } = reviewedSnapshot(snapshot, window);
  if (snapshot.control.version === Number.MAX_SAFE_INTEGER || proposal.reviewToken !== input.reviewToken ||
      selected.some(task => task.dueAt <= now.toISOString())) throw new PlanPauseConflict();
  const recordedAt = now.toISOString();
  return { control: { version: snapshot.control.version + 1, pause: { ...window, requestId: input.requestId, actor, recordedAt } },
    cancelledTasks: selected.map(task => ({ ...task, state: "cancelled", changedAt: recordedAt, changedBy: actor })),
    receipt: { ...window, requestId: input.requestId, actor, recordedAt, timeZone: snapshot.timeZone,
      cancelled: proposal.tasks, nextTask: proposal.nextTask }, replayed: false };
}

/** All task creation/reopening writers must also CAS this control version, even outside the interval. */
export function assertTaskOutsidePause(control: PlanControl, dueAt: string) {
  if (!planControlSchema.safeParse(control).success || !instant.safeParse(dueAt).success ||
      (control.pause && dueAt >= control.pause.startsAt && dueAt < control.pause.endsAt)) throw new PlanPauseConflict();
}

export function replayPlanPause(receipt: StoredPlanPause, input: PlanPauseInput): PlanPauseResult {
  const { actor: _actor, ...body } = input, previous = receipt?.input, result = receipt?.result;
  const { actor: priorActor, ...priorBody } = previous ?? {};
  if (!planPauseBody.safeParse(body).success || !planPauseBody.safeParse(priorBody).success ||
      ["startsAt", "endsAt", "requestId", "reviewToken", "confirm"].some(key => body[key as keyof typeof body] !== priorBody[key as keyof typeof priorBody]) ||
      !result || result.replayed !== false || !planControlSchema.safeParse(result.control).success || !Array.isArray(result.cancelledTasks) ||
      result.cancelledTasks.length > pauseTaskLimit || result.receipt?.requestId !== input.requestId || result.receipt.startsAt !== input.startsAt ||
      result.receipt.endsAt !== input.endsAt || result.receipt.actor !== priorActor || !instant.safeParse(result.receipt.recordedAt).success ||
      result.control.version === 0 || !result.control.pause || result.control.pause.startsAt !== input.startsAt || result.control.pause.endsAt !== input.endsAt ||
      result.control.pause.requestId !== input.requestId || result.control.pause.actor !== priorActor ||
      result.control.pause.recordedAt !== result.receipt.recordedAt) throw new PlanPauseConflict();
  try { validateTimeZone(result.receipt.timeZone); } catch { throw new PlanPauseConflict(); }
  const tasks = result.cancelledTasks;
  const cancelled = z.array(pausedTaskReferenceSchema).max(pauseTaskLimit).safeParse(result.receipt.cancelled);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length ||
      tasks.some(task => !identity.safeParse(task.id).success || !taskReviewSchema.safeParse(taskReview(task)).success || task.state !== "cancelled" ||
        task.lastResponse !== null || task.confirmedAt !== null || task.confirmedBy !== null || task.dueAt <= result.receipt.recordedAt ||
        task.dueAt >= input.endsAt || task.changedAt !== result.receipt.recordedAt || task.changedBy !== priorActor) ||
      !cancelled.success || JSON.stringify(cancelled.data) !== JSON.stringify(tasks.map(reference))) throw new PlanPauseConflict();
  if (result.receipt.nextTask !== null && (!identity.safeParse(result.receipt.nextTask?.id).success ||
      !z.string().min(1).max(120).safeParse(result.receipt.nextTask.title).success || !instant.safeParse(result.receipt.nextTask.dueAt).success ||
      result.receipt.nextTask.dueAt < input.endsAt)) throw new PlanPauseConflict();
  return structuredClone({ ...result, replayed: true });
}
