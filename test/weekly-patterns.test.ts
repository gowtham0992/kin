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
      "Morning (midnight–noon): 1 of 1 due check-ins have a recorded reply.",
      "Afternoon (noon–6 PM): 0 of 1 due check-ins have a recorded reply.",
      "Recorded reply share: 1/2 in 2026-09-12–2026-09-18 through now, versus 1/1 in 2026-09-05–2026-09-11. Difference: -50 percentage points (rounded).",
    ]);
    expect(result.patterns.points[2]!.evidenceIds).toHaveLength(3);
    expect(result.previousEvidence).toHaveLength(1);
    expect(result.patterns.notice).toContain("partial day");
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
