import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { BedrockBriefGenerator, WeeklyBriefService } from "../src/weekly-brief.js";

const asOf = new Date("2026-09-13T18:00:00.000Z");
const task = (id: string, state: CareTask["state"], dueAt = "2026-09-13T19:00:00.000Z"): CareTask => ({
  id, title: id, dueAt, state, lastResponse: null, confirmedAt: null, confirmedBy: null,
});

describe("weekly model fallback acceptance", () => {
  const evidenceId = "task:recorded open:2026-09-13T18:00:00.000Z";
  const selection = { overviewEvidenceIds: [evidenceId], highlightEvidenceIds: [evidenceId], followUps: [] };
  it.each([
    ["unavailable", null, "end_turn"],
    ["invalid JSON", "not JSON", "end_turn"],
    ["empty text", "", "end_turn"],
    ["incomplete turn", JSON.stringify(selection), "max_tokens"],
    ["unknown source", JSON.stringify({ ...selection, highlightEvidenceIds: ["invented"] }), "end_turn"],
    ["duplicate source", JSON.stringify({ ...selection, highlightEvidenceIds: [evidenceId, evidenceId] }), "end_turn"],
    ["unsupported prose", JSON.stringify({ ...selection, overview: "A medical conclusion" }), "end_turn"],
    ["wrong follow-up type", JSON.stringify({ ...selection, followUps: [{ kind: "close_escalation_loop", evidenceId }] }), "end_turn"],
  ])("returns the same factual brief after %s model output", async (_description, text, stopReason) => {
    const store = new InMemoryCareStore([task("recorded open", "scheduled", asOf.toISOString())], () => asOf);
    const baseline = await new WeeklyBriefService(store).create(asOf);
    const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", client: { send: async () => {
      if (text === null) throw new Error("Synthetic model unavailable");
      return { stopReason, output: { message: { role: "assistant", content: [{ text }] } } } as ConverseCommandOutput;
    } } });

    expect(await new WeeklyBriefService(store, generator).create(asOf)).toEqual(baseline);
  });

  it("returns the same factual brief when model selection reaches its timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryCareStore([task("recorded open", "scheduled", asOf.toISOString())], () => asOf);
      const baseline = await new WeeklyBriefService(store).create(asOf);
      const generator = new BedrockBriefGenerator({ modelId: "synthetic-model", timeoutMs: 50, client: {
        send: async (_command, options) => new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true });
        }),
      } });
      const pending = new WeeklyBriefService(store, generator).create(asOf).catch(error => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toEqual(baseline);
    } finally { vi.useRealTimers(); }
  });
});

describe("weekly acceptance facts", () => {
  it("identifies account attribution without claiming to verify the person speaking", async () => {
    const brief = await new WeeklyBriefService(new InMemoryCareStore([], () => asOf)).create(asOf);
    expect(brief.safetyNotice).toContain("Names identify the Kin account used, not a verified speaker.");
  });
  it("describes a cancellation-only week without claiming no activity or zero-of-zero completion", async () => {
    const store = new InMemoryCareStore([task("Canceled walk", "cancelled"), task("Untouched future", "scheduled")], () => asOf);
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.stats).toEqual({ scheduled: 0, completed: 0, skipped: 0, stillOpen: 0, escalations: 0 });
    expect(brief.headline).toBe("1 check-in was cancelled before it was due");
    expect(brief.overview).toContain("1 check-in was cancelled before it was due; cancelled check-ins are excluded from the task counts.");
    expect(brief.highlights).toEqual([{ text: "1 check-in was cancelled before it was due.", evidenceIds: ["task:Canceled walk:2026-09-13T19:00:00.000Z"] }]);
    expect(brief.followUps).toEqual([]);
    expect(JSON.stringify(brief)).not.toContain("Untouched future");
  });

  it("reconciles mixed recorded activity and cancellation sources without stale or future schedules", async () => {
    const store = new InMemoryCareStore([
      task("old open", "scheduled", "2026-09-06T18:00:00.000Z"),
      task("completed", "done", asOf.toISOString()), task("skipped", "skipped", asOf.toISOString()),
      task("open", "scheduled", asOf.toISOString()),
      { ...task("early reply", "scheduled"), lastResponse: "not_yet", confirmedAt: asOf.toISOString() },
      task("cancelled one", "cancelled"), task("cancelled two", "cancelled"), task("future untouched", "scheduled"),
    ], () => asOf);
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.period).toEqual({ startDate: "2026-09-07", endDate: "2026-09-13" });
    expect(brief.stats).toEqual({ scheduled: 4, completed: 1, skipped: 1, stillOpen: 2, escalations: 0 });
    expect(brief.evidence).toHaveLength(7);
    expect(brief.evidence.at(-1)).toMatchObject({ id: "task:old open:2026-09-06T18:00:00.000Z", fact: "Prior comparison period: old open; no reply is recorded." });
    expect(brief.overview).toContain("2 check-ins were cancelled before they were due; cancelled check-ins are excluded from the task counts.");
    expect(brief.highlights.find(point => point.text.startsWith("1 of 4"))?.evidenceIds).toEqual([
      "task:completed:2026-09-13T18:00:00.000Z", "task:skipped:2026-09-13T18:00:00.000Z",
      "task:open:2026-09-13T18:00:00.000Z", "task:early reply:2026-09-13T19:00:00.000Z",
    ]);
    expect(brief.highlights.find(point => point.text.startsWith("2 check-ins"))?.evidenceIds).toEqual([
      "task:cancelled one:2026-09-13T19:00:00.000Z", "task:cancelled two:2026-09-13T19:00:00.000Z",
    ]);
    expect(brief.overviewEvidenceIds).not.toContain("task:old open:2026-09-06T18:00:00.000Z");
    expect(JSON.stringify(brief)).not.toContain("future untouched");
  });

  it.each(["not-a-date", "2026-09-13T18:00:00.001Z"])("does not claim acknowledgment from an invalid or future timestamp: %s", async acknowledgedAt => {
    const store = new InMemoryCareStore([], () => asOf);
    store.activityBetween = async period => ({ ...period, tasks: [], escalations: [{
      id: "pending", taskId: "water", dueAt: "2026-09-13T16:00:00.000Z", updatedAt: asOf.toISOString(),
      status: "sent", recipientMemberId: "synthetic-caregiver", recipientMemberName: "Synthetic caregiver",
      sentAt: "2026-09-13T17:00:00.000Z", acknowledgedAt,
    }] });
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.evidence[0]?.acknowledged).toBe(false);
    expect(brief.evidence[0]?.fact).toContain("Acknowledgment timing is unavailable; no valid acknowledgment is established for this brief.");
    expect(brief.evidence[0]?.fact).not.toContain(`A caregiver acknowledged it at ${acknowledgedAt}`);
    expect(brief.followUps).toEqual([{ text: "Ask a caregiver to acknowledge the follow-up.", evidenceIds: ["escalation:pending"] }]);
    expect(brief.responsibility.acknowledgment).toMatchObject({ withinWindow: 0, timingUnavailable: 1 });
  });

  it("does not present a future provider-acceptance timestamp as an observed fact", async () => {
    const store = new InMemoryCareStore([], () => asOf);
    store.activityBetween = async period => ({ ...period, tasks: [], escalations: [{
      id: "future-time", taskId: "water", dueAt: "2026-09-13T16:00:00.000Z", updatedAt: asOf.toISOString(),
      status: "sent", recipientMemberId: "synthetic-caregiver", recipientMemberName: "Synthetic caregiver",
      sentAt: "2026-09-13T18:00:00.001Z",
    }] });
    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief.evidence[0]?.fact).not.toContain("Messaging service accepted it at 2026-09-13T18:00:00.001Z");
    expect(brief.responsibility.acknowledgment).toMatchObject({ eligible: 0, timingUnavailable: 1 });
  });
});
