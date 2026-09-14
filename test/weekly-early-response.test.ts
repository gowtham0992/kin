import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type ConfirmationResponse } from "../src/domain.js";
import { WeeklyBriefService } from "../src/weekly-brief.js";

describe("weekly evidence before a task's due time", () => {
  it.each(["not_yet", "done", "skipped"] as ConfirmationResponse[])("retains an early %s response, but not an untouched future schedule", async response => {
    const now = new Date("2026-09-11T10:00:00Z");
    const task = { id: "water", title: "Water", dueAt: "2026-09-11T18:00:00.000Z", state: "scheduled" as const, lastResponse: null, confirmedBy: null, confirmedAt: null };
    const store = new InMemoryCareStore([task, { ...task, id: "untouched" }], () => now);
    await store.confirm({ taskId: task.id, response, actor: "Synthetic parent", requestId: "early-reply" });
    const brief = await new WeeklyBriefService(store).create(now);
    expect(brief.evidence).toHaveLength(1);
    expect(brief.evidence[0]?.id).toBe(`task:water:${task.dueAt}`);
    expect(brief.headline).not.toContain("No care activity");
    expect(brief.stats).toMatchObject({ scheduled: 1, completed: response === "done" ? 1 : 0,
      skipped: response === "skipped" ? 1 : 0, stillOpen: response === "not_yet" ? 1 : 0 });
  });
});
