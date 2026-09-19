import { describe, expect, it } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { BedrockBriefGenerator, type WeeklyBriefSource } from "../src/weekly-brief.js";

const id = `task:care-${"a9".repeat(20)}:2026-09-17T18:00:00.000Z`;
const source: WeeklyBriefSource = {
  period: { startDate: "2026-09-12", endDate: "2026-09-18" },
  stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 },
  evidence: [{ id, kind: "care_task", occurredAt: "2026-09-17T18:00:00.000Z", fact: "Water was still open." }],
};
const response = (ids: string[]): ConverseCommandOutput => ({ $metadata: {}, stopReason: "end_turn",
  output: { message: { role: "assistant", content: [{ text: JSON.stringify({
    overviewEvidenceIds: [ids[0]], highlightEvidenceIds: ids, followUps: [],
  }) }] } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } });

describe("bounded weekly model references", () => {
  it("supplies only eligible follow-ups so the model need not infer acknowledgment rules", async () => {
    const mixed: WeeklyBriefSource = { ...source, evidence: [...source.evidence,
      { id: "ack", kind: "escalation", occurredAt: "2026-09-17T18:00:00.000Z", fact: "Acknowledged.", acknowledged: true },
      { id: "pending", kind: "escalation", occurredAt: "2026-09-17T18:00:00.000Z", fact: "Sent.", acknowledged: false },
      { id: "done", kind: "care_task", occurredAt: "2026-09-17T18:00:00.000Z", fact: "Water was completed." },
    ] };
    const generator = new BedrockBriefGenerator({ modelId: "test", client: { send: async command => {
      const sent = JSON.parse(command.input.messages![0]!.content![0]!.text!);
      expect(sent.eligibleFollowUps).toEqual([
        { kind: "check_open_task", evidenceId: sent.evidence[0].id },
        { kind: "close_escalation_loop", evidenceId: "pending" },
      ]);
      return response([sent.evidence[0].id]);
    } } });
    await expect(generator.generate(mixed)).resolves.toHaveProperty("generation.provider", "bedrock");
  });
  it("tells the model the overview limit enforced by the response validator", async () => {
    const generator = new BedrockBriefGenerator({ modelId: "test", client: { send: async command => {
      expect(command.input.system?.map(block => block.text ?? "").join("\n"))
        .toContain("Choose one to eight overview evidence IDs.");
      return response([id]);
    } } });
    await expect(generator.generate(source)).resolves.toHaveProperty("generation.provider", "bedrock");
  });
  it("uses short references for long IDs and restores the original public citations", async () => {
    const original = structuredClone(source);
    const generator = new BedrockBriefGenerator({ modelId: "test", client: { send: async command => {
      const sent = JSON.parse(command.input.messages![0]!.content![0]!.text!);
      expect(sent.evidence[0].id.length).toBeLessThan(16);
      expect(sent.evidence[0].fact).toBe(source.evidence[0]!.fact);
      return response([sent.evidence[0].id]);
    } } });
    const result = await generator.generate(source);
    expect(result.narrative.highlights).toEqual([{ text: "Water was still open.", evidenceIds: [id] }]);
    expect(result.narrative.overviewEvidenceIds).toEqual([id]);
    expect(source).toEqual(original);
  });

  it("does not collide with existing short evidence IDs", async () => {
    const collision = { ...source, evidence: [...source.evidence, { ...source.evidence[0]!, id: "e1", fact: "Walk was still open." }] };
    const generator = new BedrockBriefGenerator({ modelId: "test", client: { send: async command => {
      const sent = JSON.parse(command.input.messages![0]!.content![0]!.text!);
      expect(new Set(sent.evidence.map((e: { id: string }) => e.id)).size).toBe(2);
      expect(sent.evidence[0].id.length).toBeLessThan(16);
      return response(sent.evidence.map((e: { id: string }) => e.id));
    } } });
    expect((await generator.generate(collision)).narrative.highlights.map(p => p.evidenceIds[0])).toEqual([id, "e1"]);
  });

  it("rejects duplicate citations after resolving a short reference", async () => {
    const generator = new BedrockBriefGenerator({ modelId: "test", client: { send: async command => {
      const sent = JSON.parse(command.input.messages![0]!.content![0]!.text!);
      return response([sent.evidence[0].id, id]);
    } } });
    await expect(generator.generate(source)).rejects.toThrow("duplicate evidence");
  });
});
