import { describe, expect, it } from "vitest";
import { weeklyPatterns } from "../src/weekly-patterns.js";
import { WeeklyBriefService } from "../src/weekly-brief.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
const now = new Date("2026-09-18T23:00:00.000Z");
const task = (id: string, dueAt: string, fields: Partial<CareTask> = {}): CareTask => ({ id, title: id, dueAt, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null, ...fields });
const current = (tasks: CareTask[]) => ({ startDate: "2026-09-12", endDate: "2026-09-18", tasks, escalations: [] });
const previous = (tasks: CareTask[]) => ({ startDate: "2026-09-05", endDate: "2026-09-11", tasks, escalations: [] });
describe("deterministic recorded-reply patterns", () => {
  it("reconciles time-of-day counts and percentage-point difference to every contributing occurrence", () => {
    const result = weeklyPatterns(current([
      task("morning", "2026-09-18T15:00:00.000Z", { lastResponse: "not_yet" }),
      task("afternoon", "2026-09-18T19:00:00.000Z", { state: "closed_unanswered" }),
      task("cancelled", "2026-09-18T16:00:00.000Z", { state: "cancelled" }),
      task("future", "2026-09-19T02:00:00.000Z"),
    ]), previous([task("prior", "2026-09-11T15:00:00.000Z", { state: "done", lastResponse: "done" })]), now, "America/Denver");
    expect(result.patterns.points.map(point => point.text)).toEqual([
      "Morning (midnight–noon): 1 of 1 due check-in has a recorded reply.",
      "Afternoon (noon–6 PM): 0 of 1 due check-in has a recorded reply.",
      "Recorded replies: 1 of 2 due check-ins for Sep 12–18, 2026 (so far), compared with 1 of 1 for Sep 5–11, 2026. Reply share is 50 percentage points lower (rounded).",
    ]);
    expect(result.patterns.points[2]!.evidenceIds).toHaveLength(3);
    expect(result.previousEvidence).toHaveLength(1);
    expect(result.patterns.notice).toContain("partial day");
  });
  it.each([
    ["done", "scheduled", "Reply share is 100 percentage points higher (rounded)."],
    ["scheduled", "done", "Reply share is 100 percentage points lower (rounded)."],
    ["done", "done", "Rounded change in reply share: 0 percentage points."],
  ] as const)("describes %s versus %s without implying a health improvement", (currentState, previousState, difference) => {
    const result = weeklyPatterns(current([task("current", "2026-09-18T15:00:00.000Z", { state: currentState })]),
      previous([task("previous", "2026-09-11T15:00:00.000Z", { state: previousState })]), now, "America/Denver");
    const comparison = result.patterns.points.at(-1)!;
    expect(comparison.text).toContain(difference);
    expect(comparison.text).toContain("due check-in for Sep 12–18, 2026 (so far)");
    expect(comparison.text).not.toMatch(/better|worse|improved|declined/);
    expect(comparison.evidenceIds).toEqual(["task:current:2026-09-18T15:00:00.000Z", "task:previous:2026-09-11T15:00:00.000Z"]);
  });
  it("keeps calendar labels exact across the year boundary in a western time zone", () => {
    const result = weeklyPatterns({ startDate: "2026-12-29", endDate: "2027-01-04", tasks: [task("new", "2027-01-04T19:00:00.000Z")], escalations: [] },
      { startDate: "2026-12-22", endDate: "2026-12-28", tasks: [task("old", "2026-12-28T19:00:00.000Z")], escalations: [] },
      new Date("2027-01-04T23:00:00.000Z"), "America/Denver");
    expect(result.patterns.points.at(-1)!.text).toContain("Dec 29, 2026–Jan 4, 2027 (so far)");
    expect(result.patterns.points.at(-1)!.text).toContain("Dec 22–28, 2026");
  });
  it("does not call slightly different reply shares unchanged when their difference rounds to zero", () => {
    const result = weeklyPatterns(current(Array.from({ length: 201 }, (_, index) => task(`current-${index}`, "2026-09-18T15:00:00.000Z", { state: index < 100 ? "done" : "scheduled" }))),
      previous(Array.from({ length: 200 }, (_, index) => task(`previous-${index}`, "2026-09-11T15:00:00.000Z", { state: index < 100 ? "done" : "scheduled" }))), now, "America/Denver");
    const comparison = result.patterns.points.at(-1)!;
    expect(comparison.text).toContain("100 of 201");
    expect(comparison.text).toContain("100 of 200");
    expect(comparison.text).toContain("Rounded change in reply share: 0 percentage points.");
    expect(comparison.text).not.toMatch(/unchanged|same|equal|lower|higher/);
    expect(comparison.evidenceIds).toHaveLength(401);
  });
  it("distinguishes missing prior data from a measured zero and never divides by zero", () => {
    for (const prior of [null, previous([])]) {
      const result = weeklyPatterns(current([task("one", "2026-09-18T15:00:00.000Z")]), prior, now, "America/Denver");
      expect(result.patterns.points).toHaveLength(1);
      expect(result.patterns.notice).toContain(prior === null ? "could not be loaded" : "not enough");
      expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    }
  });
  it("uses the local due hour, not UTC, and rejects duplicate occurrences", () => {
    const evening = task("evening", "2026-09-18T02:00:00.000Z");
    expect(weeklyPatterns(current([evening]), previous([]), now, "America/Denver").patterns.points[0]!.text).toContain("Evening");
    expect(() => weeklyPatterns(current([evening, evening]), previous([]), now, "America/Denver")).toThrow("Duplicate pattern evidence");
  });
  it("exposes prior citations without changing current-week counts or overview citations", async () => {
    const store = new InMemoryCareStore([
      task("current", "2026-09-18T15:00:00.000Z", { state: "done" }),
      task("prior", "2026-09-11T15:00:00.000Z"),
    ], () => now);
    const brief = await new WeeklyBriefService(store).create(now);
    expect(brief.stats.scheduled).toBe(1);
    const ids = new Set(brief.evidence.map(fact => fact.id));
    expect(brief.patterns.points.every(point => point.evidenceIds.every(id => ids.has(id)))).toBe(true);
    expect(brief.evidence.find(fact => fact.id.startsWith("task:prior:"))!.fact).toContain("Prior comparison period");
    expect(brief.overviewEvidenceIds.some(id => id.startsWith("task:prior:"))).toBe(false);
  });
});
