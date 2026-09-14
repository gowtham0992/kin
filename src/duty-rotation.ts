import { createHash } from "node:crypto";
import { z } from "zod";
import { calendarDate, calendarDayBounds, shiftCalendarDate, validateTimeZone } from "./calendar.js";
import type { CircleMember, DutyAssignment } from "./domain.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { return shiftCalendarDate(value, 0) === value; } catch { return false; }
});
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const personName = z.string().min(1).max(80);
export const dutyRotationBody = z.object({
  startDate: date,
  reviewToken: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  confirm: z.literal(true),
}).strict();
const rotationInput = dutyRotationBody.extend({ actor: personName.optional() });
export type DutyRotationInput = z.infer<typeof rotationInput>;
export interface DutyRotationDay {
  date: string;
  source: "existing" | "proposed" | "uncovered";
  assignment: DutyAssignment | null;
}
export interface DutyRotationProposal {
  startDate: string; endDate: string; basisStartDate: string; basisEndDate: string; timeZone: string; reviewToken: string;
  days: DutyRotationDay[];
  members: Array<{ id: string; name: string; basisAssignedDays: number; existingNextWeekDays: number; proposedDays: number; totalAssignedDays: number }>;
  proposedDays: number; uncoveredDays: number;
}
export interface DutyRotationResult {
  requestId: string; startDate: string; endDate: string; assigned: number;
  assignments: Array<DutyAssignment & { date: string }>; replayed: boolean;
}
export interface DutyRotationReceipt { input: DutyRotationInput; result: DutyRotationResult }
export class DutyRotationConflict extends Error {
  constructor() { super("The rotation changed. Refresh and review next week's proposal again."); this.name = "DutyRotationConflict"; }
}
const memberSchema = z.object({ id: memberId, name: personName, relationship: z.enum(["parent", "daughter", "son", "caregiver"]), canReceiveAlerts: z.boolean() }).strict();
const assignmentSchema = z.object({ memberId, memberName: personName, startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  changedAt: z.iso.datetime().optional(), changedBy: personName.optional() }).strict();
export interface DutyRotationSnapshot {
  circleId: string; today: string; timeZone: string; rosterVersion: number | null;
  members: CircleMember[];
  days: Array<{ date: string; assignment: DutyAssignment | null }>;
}

const stableIdOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export function dutyRotationWindow(now: Date, timeZone: string) {
  const today = calendarDate(now, validateTimeZone(timeZone));
  return { today, basisStartDate: shiftCalendarDate(today, -7), basisEndDate: shiftCalendarDate(today, 6),
    startDate: shiftCalendarDate(today, 7), endDate: shiftCalendarDate(today, 13),
    dates: Array.from({ length: 21 }, (_, index) => shiftCalendarDate(today, index - 7)) };
}

// The token binds the reviewed state; it is not an authorization credential.
// Allocation is recalculated on the server, never supplied by the client.
export function proposeDutyRotation(snapshot: DutyRotationSnapshot): DutyRotationProposal {
  const window = dutyRotationWindow(new Date(calendarDayBounds(snapshot.today, snapshot.timeZone).startsAt), snapshot.timeZone);
  if (!snapshot.circleId || snapshot.members.length > 50 ||
      (snapshot.rosterVersion !== null && (!Number.isSafeInteger(snapshot.rosterVersion) || snapshot.rosterVersion < 0)) ||
      snapshot.days.length !== 21) throw new DutyRotationConflict();
  const members = snapshot.members.map(member => memberSchema.parse(member)).sort((a, b) => stableIdOrder(a.id, b.id));
  if (new Set(members.map(member => member.id)).size !== members.length) throw new DutyRotationConflict();
  const days = snapshot.days.map(day => ({ date: date.parse(day.date), assignment: day.assignment === null ? null : assignmentSchema.parse(day.assignment) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.some((day, index) => day.date !== window.dates[index])) throw new DutyRotationConflict();
  for (const day of days) {
    if (day.assignment && (Date.parse(day.assignment.endsAt) <= Date.parse(day.assignment.startsAt) ||
        calendarDate(new Date(day.assignment.startsAt), snapshot.timeZone) !== day.date)) throw new DutyRotationConflict();
  }
  const normalized = { circleId: snapshot.circleId, today: snapshot.today, timeZone: snapshot.timeZone, rosterVersion: snapshot.rosterVersion, members, days };
  const reviewToken = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const eligible = members.filter(member => member.canReceiveAlerts);
  const counts = eligible.map(member => ({ id: member.id, name: member.name,
    basisAssignedDays: days.filter(day => day.date <= window.basisEndDate && day.assignment?.memberId === member.id).length,
    existingNextWeekDays: days.filter(day => day.date >= window.startDate && day.assignment?.memberId === member.id).length,
    proposedDays: 0, totalAssignedDays: days.filter(day => day.assignment?.memberId === member.id).length }));
  // A tie goes to whoever has gone longest without a prior assignment, then ID.
  const latest = new Map(eligible.map(member => [member.id, days.filter(day => day.date < window.startDate && day.assignment?.memberId === member.id).at(-1)?.date ?? ""]));
  const proposed = days.filter(day => day.date >= window.startDate).map(day => {
    if (day.assignment) {
      latest.set(day.assignment.memberId, day.date);
      return { ...structuredClone(day), source: "existing" as const };
    }
    const chosen = [...counts].sort((a, b) => a.totalAssignedDays - b.totalAssignedDays ||
      (latest.get(a.id) ?? "").localeCompare(latest.get(b.id) ?? "") || stableIdOrder(a.id, b.id))[0];
    if (!chosen) return { ...day, source: "uncovered" as const };
    chosen.proposedDays += 1; chosen.totalAssignedDays += 1; latest.set(chosen.id, day.date);
    return { date: day.date, source: "proposed" as const, assignment: { memberId: chosen.id, memberName: chosen.name, ...calendarDayBounds(day.date, snapshot.timeZone) } };
  });
  return { startDate: window.startDate, endDate: window.endDate, basisStartDate: window.basisStartDate, basisEndDate: window.basisEndDate,
    timeZone: snapshot.timeZone, reviewToken, days: proposed, members: counts,
    proposedDays: proposed.filter(day => day.source === "proposed").length, uncoveredDays: proposed.filter(day => day.source === "uncovered").length };
}

export function validateDutyRotation(rawInput: DutyRotationInput): DutyRotationInput {
  const parsed = rotationInput.safeParse(rawInput);
  if (!parsed.success) throw new Error("Invalid duty rotation");
  return parsed.data;
}
export function acceptedDutyRotation(proposal: DutyRotationProposal, input: DutyRotationInput, at: Date): DutyRotationResult {
  if (proposal.startDate !== input.startDate || proposal.reviewToken !== input.reviewToken || proposal.uncoveredDays > 0) throw new DutyRotationConflict();
  return { requestId: input.requestId, startDate: proposal.startDate, endDate: proposal.endDate, assigned: proposal.proposedDays, replayed: false,
    assignments: proposal.days.map(day => ({ date: day.date, ...day.assignment!, ...(day.source === "proposed"
      ? { changedAt: at.toISOString(), ...(input.actor ? { changedBy: input.actor } : {}) } : {}) })) };
}
export function replayDutyRotation(receipt: DutyRotationReceipt, input: DutyRotationInput): DutyRotationResult {
  const prior = rotationInput.safeParse(receipt.input);
  const result = receipt.result;
  if (!prior.success || prior.data.startDate !== input.startDate || prior.data.reviewToken !== input.reviewToken || prior.data.requestId !== input.requestId ||
      !result || result.requestId !== input.requestId || result.startDate !== input.startDate || result.endDate !== shiftCalendarDate(input.startDate, 6) ||
      !Number.isInteger(result.assigned) || result.assigned < 0 || result.assigned > 7 || result.replayed !== false || !Array.isArray(result.assignments) || result.assignments.length !== 7) throw new DutyRotationConflict();
  for (const [index, day] of result.assignments.entries()) {
    const { date: dayDate, ...assignment } = day;
    if (dayDate !== shiftCalendarDate(input.startDate, index) || !assignmentSchema.safeParse(assignment).success) throw new DutyRotationConflict();
  }
  return { ...structuredClone(result), replayed: true };
}
