import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { BedrockBriefGenerator, WeeklyBriefService } from "../src/weekly-brief.js";

const asOf = new Date("2026-09-14T18:00:00.000Z");
const fixedNow = () => asOf;
const task = (index: number, state: CareTask["state"] = "scheduled"): CareTask => ({
  id: `check-in-${index}`, title: `Synthetic check-in ${index}`,
  dueAt: `2026-09-14T08:${String(index).padStart(2, "0")}:00.000Z`, state,
  lastResponse: state === "done" ? "done" : state === "skipped" ? "skipped" : null,
  confirmedAt: state === "done" || state === "skipped" ? asOf.toISOString() : null,
  confirmedBy: state === "done" || state === "skipped" ? "Synthetic account" : null,
});
const taskId = (record: CareTask) => `task:${record.id}:${record.dueAt}`;

describe("complete weekly aggregate citations", () => {
  it("cites the whole counted group when the only completion is the sixth source", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(index, index === 5 ? "done" : "scheduled"));
    const brief = await new WeeklyBriefService(new InMemoryCareStore(tasks, fixedNow)).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 6, completed: 1, skipped: 0, stillOpen: 5, escalations: 0 });
    expect(brief.highlights).toEqual([{
      text: "1 of 6 recorded care tasks were completed.", evidenceIds: tasks.map(taskId),
    }]);
  });

  it("cites every cancellation counted by a cancellation-only highlight", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(index, "cancelled"));
    const brief = await new WeeklyBriefService(new InMemoryCareStore(tasks, fixedNow)).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 0, completed: 0, skipped: 0, stillOpen: 0, escalations: 0 });
    expect(brief.highlights).toEqual([{
      text: "6 check-ins were cancelled before they were due.", evidenceIds: tasks.map(taskId),
    }]);
  });

  it("cites every recorded follow-up when more than four contribute to its total", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(index));
    const store = new InMemoryCareStore(tasks, fixedNow);
    const evidenceIds: string[] = [];
    for (const record of tasks) {
      const queued = await store.queueEscalation({ taskId: record.id, taskTitle: record.title,
        dueAt: record.dueAt, reason: "no_active_duty_assignment" });
      expect(queued).not.toBeNull();
      evidenceIds.push(`escalation:${queued!.record.id}`);
    }
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.stats.escalations).toBe(6);
    expect(brief.highlights.find(point => point.text === "6 family follow-ups were recorded.")).toEqual({
      text: "6 family follow-ups were recorded.", evidenceIds,
    });
  });

  it("grounds the full overview after eight sources while excluding outside-window and untouched future tasks", async () => {
    const counted = Array.from({ length: 9 }, (_, index) => task(index, index === 8 ? "done" : "scheduled"));
    const cancelled = task(9, "cancelled");
    const store = new InMemoryCareStore([...counted, cancelled,
      { ...task(10), dueAt: "2026-09-14T19:00:00.000Z" },
      { ...task(11), dueAt: "2026-09-07T08:00:00.000Z" },
    ], fixedNow);
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.period).toEqual({ startDate: "2026-09-08", endDate: "2026-09-14" });
    expect(brief.stats).toEqual({ scheduled: 9, completed: 1, skipped: 0, stillOpen: 8, escalations: 0 });
    expect(brief.evidence.map(item => item.id)).toEqual([...counted, cancelled].map(taskId).concat("task:check-in-11:2026-09-07T08:00:00.000Z"));
    expect(brief.evidence.at(-1)!.fact).toContain("Prior comparison period:");
    expect(brief.overviewEvidenceIds).toEqual([...counted, cancelled].map(taskId));
  });

  it("grounds a model-selected brief's factual overview in all contributing sources, not just the selection", async () => {
    const tasks = Array.from({ length: 9 }, (_, index) => task(index, index === 8 ? "done" : "scheduled"));
    const store = new InMemoryCareStore([...tasks, task(9, "cancelled")], fixedNow);
    const queued = await store.queueEscalation({ taskId: tasks[0]!.id, taskTitle: tasks[0]!.title,
      dueAt: tasks[0]!.dueAt, reason: "no_active_duty_assignment" });
    expect(queued).not.toBeNull();
    const selectedId = taskId(tasks[0]!);
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", client: { send: async () => ({
      stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: JSON.stringify({
        overviewEvidenceIds: [selectedId], highlightEvidenceIds: [selectedId], followUps: [],
      }) }] } },
    } as ConverseCommandOutput) } });
    const brief = await new WeeklyBriefService(store, generator).create(asOf);

    expect(brief.generatedBy).toBe("bedrock");
    expect(brief.overview).toContain("9 care tasks (1 completed, 8 still open, and 0 skipped) and 1 family follow-up");
    expect(brief.overview).toContain("1 check-in was cancelled");
    expect(brief.highlights).toEqual([{ text: "Synthetic check-in 0 was still open.", evidenceIds: [selectedId] }]);
    expect(brief.overviewEvidenceIds).toEqual([
      ...tasks.map(taskId), taskId(task(9, "cancelled")), `escalation:${queued!.record.id}`,
    ]);
  });
});
