import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type DutyAssignment } from "../src/domain.js";
import { calendarDayBounds, shiftCalendarDate } from "../src/calendar.js";
import { acceptedDutyRotation, dutyRotationWindow, DutyRotationConflict, proposeDutyRotation, validateDutyRotation,
  type DutyRotationInput, type DutyRotationSnapshot } from "../src/duty-rotation.js";

const now = new Date("2026-09-08T15:00:00.000Z");
const window = dutyRotationWindow(now, "UTC");
const members = [
  { id: "parent", name: "Parent", relationship: "parent" as const, canReceiveAlerts: false },
  { id: "maya", name: "Maya", relationship: "daughter" as const, canReceiveAlerts: true },
  { id: "theo", name: "Theo", relationship: "son" as const, canReceiveAlerts: true },
];
const duty = (date: string, memberId = "maya", timeZone = "UTC"): DutyAssignment => ({ memberId, memberName: memberId === "maya" ? "Maya" : "Theo", ...calendarDayBounds(date, timeZone) });
function snapshot(assignments: Record<string, DutyAssignment> = {}): DutyRotationSnapshot {
  return { circleId: "test-family", today: window.today, timeZone: "UTC", rosterVersion: null, members: structuredClone(members),
    days: window.dates.map(date => ({ date, assignment: assignments[date] ?? null })) };
}
function input(proposal: ReturnType<typeof proposeDutyRotation>): DutyRotationInput {
  return { startDate: proposal.startDate, reviewToken: proposal.reviewToken, requestId: "rotation-test-01", actor: "Maya", confirm: true };
}

describe("reviewed next-week responsibility rotation", () => {
  it("alternates the seven uncovered days deterministically and does not assign the parent", () => {
    const proposal = proposeDutyRotation(snapshot());
    expect(proposal.days.map(day => [day.date, day.assignment?.memberId, day.source])).toEqual(
      Array.from({ length: 7 }, (_, index) => [shiftCalendarDate("2026-09-15", index), index % 2 ? "theo" : "maya", "proposed"]));
    expect(proposal).toMatchObject({ startDate: "2026-09-15", endDate: "2026-09-21", basisStartDate: "2026-09-01", basisEndDate: "2026-09-14", proposedDays: 7, uncoveredDays: 0 });
    expect(proposal.members).toEqual([
      { id: "maya", name: "Maya", basisAssignedDays: 0, existingNextWeekDays: 0, proposedDays: 4, totalAssignedDays: 4 },
      { id: "theo", name: "Theo", basisAssignedDays: 0, existingNextWeekDays: 0, proposedDays: 3, totalAssignedDays: 3 },
    ]);
  });

  it("gives fewer new days to the caregiver already carrying more assigned responsibility", () => {
    const proposal = proposeDutyRotation(snapshot(Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
      const date = shiftCalendarDate("2026-09-08", index); return [date, duty(date)];
    }))));
    expect(proposal.days.map(day => day.assignment?.memberId)).toEqual(["theo", "theo", "theo", "theo", "theo", "maya", "theo"]);
    expect(proposal.members.map(member => [member.id, member.basisAssignedDays, member.proposedDays, member.totalAssignedDays])).toEqual([["maya", 5, 1, 6], ["theo", 0, 6, 6]]);
  });

  it("uses longest since a prior assignment before stable ID when assigned counts tie", () => {
    const proposal = proposeDutyRotation(snapshot({ "2026-09-01": duty("2026-09-01", "theo"), "2026-09-14": duty("2026-09-14", "maya") }));
    expect(proposal.days.slice(0, 3).map(day => day.assignment?.memberId)).toEqual(["theo", "maya", "theo"]);
  });

  it("preserves every existing next-week commitment exactly, even an ineligible former caregiver", () => {
    const existing = { ...duty("2026-09-16", "former"), memberName: "Former caregiver", changedAt: now.toISOString(), changedBy: "Organizer" };
    const proposal = proposeDutyRotation(snapshot({ "2026-09-16": existing, "2026-09-21": duty("2026-09-21") }));
    expect(proposal.days[1]).toEqual({ date: "2026-09-16", assignment: existing, source: "existing" });
    expect(proposal.days[6]).toEqual({ date: "2026-09-21", assignment: duty("2026-09-21"), source: "existing" });
    expect(proposal.proposedDays).toBe(5);
    expect(proposal.days[0]?.assignment?.memberId).toBe("theo");
  });

  it("returns uncovered days without inventing an eligible caregiver and rejects applying that proposal", () => {
    const empty = snapshot(); empty.members = empty.members.map(member => ({ ...member, canReceiveAlerts: false }));
    const proposal = proposeDutyRotation(empty);
    expect(proposal.members).toEqual([]);
    expect(proposal.days.every(day => day.source === "uncovered" && day.assignment === null)).toBe(true);
    expect(proposal).toMatchObject({ proposedDays: 0, uncoveredDays: 7 });
    expect(() => acceptedDutyRotation(proposal, input(proposal), now)).toThrow(DutyRotationConflict);
  });

  it("shows already-covered weeks as a zero-change proposal", () => {
    const proposal = proposeDutyRotation(snapshot(Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
      const date = shiftCalendarDate("2026-09-15", index); return [date, duty(date)];
    }))));
    expect(proposal).toMatchObject({ proposedDays: 0, uncoveredDays: 0 });
    expect(acceptedDutyRotation(proposal, input(proposal), now)).toMatchObject({ assigned: 0, replayed: false });
  });

  it("uses local calendar days through DST and year boundaries, not 24-hour offsets", () => {
    const dstWindow = dutyRotationWindow(new Date("2026-10-25T04:30:00Z"), "America/Denver");
    expect(dstWindow).toMatchObject({ today: "2026-10-24", startDate: "2026-10-31", endDate: "2026-11-06" });
    const proposal = proposeDutyRotation({ ...snapshot(), today: dstWindow.today, timeZone: "America/Denver",
      days: dstWindow.dates.map(date => ({ date, assignment: null })) });
    const fallbackDay = proposal.days.find(day => day.date === "2026-11-01")!.assignment!;
    expect(Date.parse(fallbackDay.endsAt) - Date.parse(fallbackDay.startsAt)).toBe(25 * 60 * 60 * 1000);
    expect(dutyRotationWindow(new Date("2026-12-28T15:00:00Z"), "UTC")).toMatchObject({ startDate: "2027-01-04", endDate: "2027-01-10" });
  });

  it("is independent of directory and read order", () => {
    const original = snapshot(), reordered = structuredClone(original);
    reordered.members.reverse(); reordered.days.reverse();
    expect(proposeDutyRotation(reordered)).toEqual(proposeDutyRotation(original));
  });

  it("uses a locale-independent ASCII ID tie break", () => {
    const state = snapshot();
    state.members = ["z-person", "a-person", "A-person", "_person"].map(id => ({ id, name: id, relationship: "caregiver", canReceiveAlerts: true }));
    expect(proposeDutyRotation(state).days.slice(0, 4).map(day => day.assignment?.memberId)).toEqual(["A-person", "_person", "a-person", "z-person"]);
  });

  it.each(["circle", "zone", "roster", "name", "eligibility", "basis", "target", "duty-audit"])("invalidates review after a relevant %s change", change => {
    const original = snapshot({ "2026-09-08": duty("2026-09-08") });
    const proposal = proposeDutyRotation(original), next = structuredClone(original);
    if (change === "circle") next.circleId = "another-family";
    if (change === "zone") next.timeZone = "Etc/UTC";
    if (change === "roster") next.rosterVersion = 1;
    if (change === "name") next.members[1]!.name = "Maya Chen";
    if (change === "eligibility") next.members[1]!.canReceiveAlerts = false;
    if (change === "basis") next.days[0]!.assignment = duty(next.days[0]!.date);
    if (change === "target") next.days[14]!.assignment = duty(next.days[14]!.date);
    if (change === "duty-audit") next.days[7]!.assignment!.changedAt = now.toISOString();
    expect(() => acceptedDutyRotation(proposeDutyRotation(next), input(proposal), now)).toThrow(DutyRotationConflict);
  });

  it.each([{ confirm: false }, { reviewToken: "0".repeat(64) }, { startDate: "2026-09-16" }])("does not apply an unconfirmed, forged, or retargeted review %j", patch => {
    const proposal = proposeDutyRotation(snapshot());
    expect(() => {
      const accepted = validateDutyRotation({ ...input(proposal), ...patch } as DutyRotationInput);
      return acceptedDutyRotation(proposal, accepted, now);
    }).toThrow();
  });

  it.each([{ startDate: "2026-02-30" }, { requestId: "short" }, { reviewToken: "not-a-hash" }, { assignments: [] }, { confirm: "true" }, { actor: "x".repeat(81) }])("rejects malformed or overposted input %j", patch => {
    expect(() => validateDutyRotation({ ...input(proposeDutyRotation(snapshot())), ...patch } as DutyRotationInput)).toThrow("Invalid duty rotation");
  });

  it("rejects incomplete, duplicate, corrupt, or oversized read snapshots", () => {
    const original = snapshot();
    const variants = [
      { ...original, days: original.days.slice(1) },
      { ...original, days: [original.days[0]!, ...original.days.slice(0, 20)] },
      { ...original, members: [members[1]!, members[1]!] },
      { ...original, members: Array.from({ length: 51 }, (_, index) => ({ ...members[1]!, id: `member-${index}` })) },
      { ...original, rosterVersion: -1 },
    ];
    for (const variant of variants) expect(() => proposeDutyRotation(variant)).toThrow(DutyRotationConflict);
  });
});

describe("memory rotation acceptance", () => {
  it("shares the injected roster with directory management and invalidates reviews when it changes", async () => {
    const roster = structuredClone(members), store = new InMemoryCareStore([], () => now, null, "UTC", [], roster);
    const proposal = await store.proposeDutyRotation();
    roster[1]!.name = "Maya Chen";
    await expect(store.acceptDutyRotation(input(proposal))).rejects.toThrow(DutyRotationConflict);
    expect((await store.proposeDutyRotation()).members.find(member => member.id === "maya")!.name).toBe("Maya Chen");
    roster.push({ id: "new-person", name: "New person", relationship: "son", canReceiveAlerts: true });
    const refreshed = await store.proposeDutyRotation();
    expect(refreshed.members.map(member => member.id)).toEqual(["maya", "new-person", "theo"]);
    expect((await store.circle()).members).toEqual(roster);
  });

  it("writes the reviewed week, preserves existing commitments, and replays a durable result after rollover", async () => {
    let clock = now;
    const existing = { date: "2026-09-16", ...duty("2026-09-16", "theo") };
    const store = new InMemoryCareStore([], () => clock, null, "UTC", [existing]);
    const proposal = await store.proposeDutyRotation();
    const result = await store.acceptDutyRotation(input(proposal));
    expect(result).toMatchObject({ assigned: 6, replayed: false });
    expect(result.assignments[1]).toEqual(existing);
    clock = new Date("2026-09-15T15:00:00Z");
    expect((await store.circle()).assignments).toEqual(result.assignments);
    expect(await store.acceptDutyRotation({ ...input(proposal), actor: "Maya Chen" })).toEqual({ ...result, replayed: true });
    await expect(store.acceptDutyRotation({ ...input(proposal), reviewToken: "f".repeat(64) })).rejects.toThrow(DutyRotationConflict);
  });

  it("rejects a stale proposal after a current-week handoff without writing any target days", async () => {
    const store = new InMemoryCareStore([], () => now);
    const proposal = await store.proposeDutyRotation();
    await store.assignDuty({ date: "2026-09-08", memberId: "theo" });
    await expect(store.acceptDutyRotation(input(proposal))).rejects.toThrow(DutyRotationConflict);
    expect((await store.proposeDutyRotation()).days.every(day => day.source === "proposed")).toBe(true);
  });

  it("prevents simultaneous different requests from overwriting the first accepted rotation", async () => {
    const store = new InMemoryCareStore([], () => now), proposal = await store.proposeDutyRotation();
    const outcomes = await Promise.allSettled([store.acceptDutyRotation(input(proposal)), store.acceptDutyRotation({ ...input(proposal), requestId: "rotation-test-02" })]);
    expect(outcomes.map(value => value.status)).toEqual(["fulfilled", "rejected"]);
    expect((await store.proposeDutyRotation()).proposedDays).toBe(0);
  });
});
