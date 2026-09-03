import {
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import {
  BedrockBriefGenerator,
  type BriefGenerator,
  WeeklyBriefService,
} from "../src/weekly-brief.js";

const asOf = new Date("2026-09-02T18:00:00.000Z");
const fixedNow = () => asOf;

describe("WeeklyBriefService", () => {
  it("builds a deterministic, evidence-linked brief without a model", async () => {
    const store = createDemoStore(fixedNow);
    await store.confirm({
      taskId: "morning-water",
      response: "done",
      actor: "Evelyn",
      requestId: "weekly-test-0001",
    });
    const snapshot = await store.today();
    await store.queueEscalation({
      id: "missed_afternoon-walk_2026-09-02T21:00:00.000Z",
      taskId: "afternoon-walk",
      taskTitle: "Take the afternoon walk",
      dueAt: "2026-09-02T21:00:00.000Z",
      createdAt: asOf.toISOString(),
      recipient: snapshot.onDuty!,
    });

    const brief = await new WeeklyBriefService(store).create(asOf);

    expect(brief).toMatchObject({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 2, completed: 1, stillOpen: 1, escalations: 1 },
      generatedBy: "deterministic",
      generation: null,
    });
    const allowed = new Set(brief.evidence.map((item) => item.id));
    for (const point of [...brief.highlights, ...brief.followUps]) {
      expect(point.evidenceIds.length).toBeGreaterThan(0);
      expect(point.evidenceIds.every((id) => allowed.has(id))).toBe(true);
    }
    expect(brief.safetyNotice).toContain("not medical advice");
  });

  it("uses a grounded generated narrative", async () => {
    const store = createDemoStore(fixedNow);
    const generator: BriefGenerator = {
      generate: vi.fn(async (source) => ({
        narrative: {
          overview: "Two care tasks were recorded this week.",
          overviewEvidenceIds: [source.evidence[0]!.id],
          highlights: [{
            text: "The water task is still open.",
            evidenceIds: [source.evidence[0]!.id],
          }],
          followUps: [],
        },
        generation: {
          provider: "bedrock" as const,
          modelId: "amazon.nova-micro-v1:0",
          stopReason: "end_turn",
          inputTokens: 100,
          outputTokens: 40,
        },
      })),
    };

    const brief = await new WeeklyBriefService(store, generator).create(asOf);

    expect(brief.generatedBy).toBe("bedrock");
    expect(brief.headline).toBe("2 recorded tasks are still open");
  });

  it("falls back safely when the generator fails", async () => {
    const generator: BriefGenerator = {
      generate: vi.fn(async () => {
        throw new Error("invalid or unavailable model output");
      }),
    };

    const brief = await new WeeklyBriefService(createDemoStore(fixedNow), generator).create(asOf);

    expect(brief.generatedBy).toBe("deterministic");
    expect(brief.generation).toBeNull();
    expect(brief.headline).toBe("2 recorded tasks are still open");
  });

  it("uses the care circle's local calendar instead of UTC", async () => {
    const instant = new Date("2026-09-03T04:30:00.000Z");
    const store = createDemoStore(() => instant, "America/Denver");

    const brief = await new WeeklyBriefService(
      store,
      null,
      "America/Denver",
    ).create(instant);

    expect(brief.period).toEqual({ startDate: "2026-08-27", endDate: "2026-09-02" });
    expect(brief.stats.scheduled).toBe(2);
  });
});

describe("BedrockBriefGenerator", () => {
  it("accepts only a completed JSON response with known evidence IDs", async () => {
    const send = vi.fn(async (_command: ConverseCommand) => ({
      stopReason: "end_turn",
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify({
            overviewEvidenceIds: ["task:one"],
            highlightEvidenceIds: ["task:one"],
            followUps: [{ kind: "check_open_task", evidenceId: "task:one" }],
          }) }],
        },
      },
    } as ConverseCommandOutput));
    const generator = new BedrockBriefGenerator({
      client: { send },
      modelId: "amazon.nova-micro-v1:0",
    });

    const result = await generator.generate({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
      evidence: [{
        id: "task:one",
        kind: "care_task",
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was still open.",
      }],
    });

    expect(result.generation).toMatchObject({
      provider: "bedrock",
      inputTokens: 80,
      outputTokens: 30,
    });
    expect(result.narrative.highlights).toEqual([{
      text: "Drink water was still open.",
      evidenceIds: ["task:one"],
    }]);
    expect(result.narrative.followUps[0]?.text).toBe(
      "Check whether the still-open task needs a new time or family follow-up.",
    );
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      modelId: "amazon.nova-micro-v1:0",
      inferenceConfig: { temperature: 0.1 },
      requestMetadata: { application: "kin", feature: "weekly-brief" },
    });
  });

  it("rejects invented evidence and incomplete model turns", async () => {
    const response = (stopReason: string) => ({
      stopReason,
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify({
            overviewEvidenceIds: ["made-up"],
            highlightEvidenceIds: ["made-up"],
            followUps: [],
          }) }],
        },
      },
    } as ConverseCommandOutput);
    const source = {
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
      evidence: [{
        id: "task:one",
        kind: "care_task" as const,
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was still open.",
      }],
    };

    await expect(new BedrockBriefGenerator({
      client: { send: async () => response("end_turn") },
      modelId: "model",
    }).generate(source)).rejects.toThrow("unknown evidence");
    await expect(new BedrockBriefGenerator({
      client: { send: async () => response("max_tokens") },
      modelId: "model",
    }).generate(source)).rejects.toThrow("did not complete");
  });

  it("rejects a follow-up applied to the wrong event type", async () => {
    const client = {
      send: async () => ({
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [{ text: JSON.stringify({
              overviewEvidenceIds: ["task:done"],
              highlightEvidenceIds: ["task:done"],
              followUps: [{ kind: "check_open_task", evidenceId: "task:done" }],
            }) }],
          },
        },
      } as ConverseCommandOutput),
    };
    const generator = new BedrockBriefGenerator({ client, modelId: "model" });

    await expect(generator.generate({
      period: { startDate: "2026-08-27", endDate: "2026-09-02" },
      stats: { scheduled: 1, completed: 1, skipped: 0, stillOpen: 0, escalations: 0 },
      evidence: [{
        id: "task:done",
        kind: "care_task",
        occurredAt: "2026-09-02T15:00:00.000Z",
        fact: "Drink water was completed.",
      }],
    })).rejects.toThrow("inapplicable follow-up");
  });
});
