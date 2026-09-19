import { z } from "zod";
import type { CircleSnapshot, DutyAssignment } from "./domain.js";

const dutyChangeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).nullable(),
  expectedMemberId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).nullable().optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
  actor: z.string().trim().min(1).max(80).optional(),
}).strict().refine(input => (input.expectedMemberId !== undefined) === (input.requestId !== undefined))
  .refine(input => input.memberId !== null || (typeof input.expectedMemberId === "string" && input.requestId !== undefined));

export type DutyChangeInput = z.infer<typeof dutyChangeSchema>;
export type DutyChangeResult = CircleSnapshot & { requestId?: string };
export interface DutyChangeReceipt { input: DutyChangeInput; result: DutyChangeResult }
export class DutyConflict extends Error {
  constructor() { super("The duty assignment changed. Refresh and review the handoff again."); this.name = "DutyConflict"; }
}

export function validateDutyChange(input: DutyChangeInput): DutyChangeInput {
  const parsed = dutyChangeSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid duty assignment");
  return parsed.data;
}

export function assertDutyReview(current: DutyAssignment | undefined, input: DutyChangeInput) {
  if (input.requestId !== undefined && (current?.memberId ?? null) !== input.expectedMemberId) throw new DutyConflict();
}

export function replayDutyChange(receipt: DutyChangeReceipt, input: DutyChangeInput): DutyChangeResult {
  const fingerprint = (value: DutyChangeInput) => JSON.stringify([
    value.date, value.memberId, value.expectedMemberId, value.requestId, value.actor,
  ]);
  if (fingerprint(receipt.input) !== fingerprint(input)) throw new DutyConflict();
  return structuredClone(receipt.result);
}

export function appliedDutySnapshot(current: CircleSnapshot, input: DutyChangeInput, assignment: DutyAssignment | null): DutyChangeResult {
  return { ...structuredClone(current),
    assignments: [...current.assignments.filter(day => day.date !== input.date), ...(assignment ? [{ date: input.date, ...assignment }] : [])]
      .sort((left, right) => left.date.localeCompare(right.date)),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
}
