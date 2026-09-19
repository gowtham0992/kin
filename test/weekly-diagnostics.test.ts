import { describe, expect, it, vi } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { InMemoryCareStore } from "../src/domain.js";
import { BedrockBriefGenerator, WeeklyBriefService } from "../src/weekly-brief.js";

const asOf = new Date("2026-09-18T16:00:00.000Z");
const secret = "PRIVATE care text, credential, and model response";
const store = () => new InMemoryCareStore([{ id: "private-task", title: secret,
  dueAt: "2026-09-18T15:00:00.000Z", state: "scheduled", lastResponse: null,
  confirmedAt: null, confirmedBy: null }], () => asOf);
const selection = { overviewEvidenceIds: ["task:private-task:2026-09-18T15:00:00.000Z"],
  highlightEvidenceIds: ["task:private-task:2026-09-18T15:00:00.000Z"], followUps: [] };
const output = (text: string, stopReason: ConverseCommandOutput["stopReason"] = "end_turn"): ConverseCommandOutput => ({ $metadata: {}, stopReason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
  output: { message: { role: "assistant" as const, content: [{ text }] } } });

describe("privacy-safe weekly generation diagnostics", () => {
  it.each([
    ["generation_failed", () => { throw new Error(secret); }],
    ["incomplete_response", () => Promise.resolve(output(secret, "max_tokens"))],
    ["empty_response", () => Promise.resolve(output(""))],
    ["invalid_json", () => Promise.resolve(output(secret))],
    ["invalid_selection", () => Promise.resolve(output(JSON.stringify({ ...selection, extra: secret })))],
    ["invalid_selection", () => Promise.resolve(output(JSON.stringify({ ...selection, highlightEvidenceIds: [secret] })))],
  ] as const)("reports %s without disclosing input or provider text", async (reason, send) => {
    const onDiagnostic = vi.fn();
    const brief = await new WeeklyBriefService(store(), new BedrockBriefGenerator({
      modelId: "synthetic", client: { send },
    }), "UTC", onDiagnostic).create(asOf);
    expect(brief.generatedBy).toBe("deterministic");
    expect(brief.stats.stillOpen).toBe(1);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ outcome: "fallback", reason, elapsedMs: expect.any(Number) });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/PRIVATE|private-task|credential|synthetic/);
    expect(brief).not.toHaveProperty("diagnostic");
  });

  it("reports validated success without changing the public result", async () => {
    const onDiagnostic = vi.fn();
    const brief = await new WeeklyBriefService(store(), new BedrockBriefGenerator({ modelId: "synthetic",
      client: { send: async () => output(JSON.stringify(selection)) },
    }), "UTC", onDiagnostic).create(asOf);
    expect(brief.generatedBy).toBe("bedrock");
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ outcome: "bedrock", reason: "validated", elapsedMs: expect.any(Number) });
  });

  it.each(["model_disabled", "empty_activity"] as const)("distinguishes intentional deterministic output: %s", async reason => {
    const onDiagnostic = vi.fn(); const generate = vi.fn();
    await new WeeklyBriefService(reason === "empty_activity" ? new InMemoryCareStore([], () => asOf) : store(),
      reason === "model_disabled" ? null : { generate }, "UTC", onDiagnostic).create(asOf);
    expect(generate).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ outcome: "deterministic", reason, elapsedMs: expect.any(Number) });
  });

  it("contains observer failures so logging cannot break a safe fallback", async () => {
    const observer = vi.fn(() => { throw new Error("logging unavailable"); });
    const brief = await new WeeklyBriefService(store(), { generate: async () => { throw new Error(secret); } }, "UTC", observer).create(asOf);
    expect(brief.generatedBy).toBe("deterministic");
    expect(observer).toHaveBeenCalledExactlyOnceWith({ outcome: "fallback", reason: "generation_failed", elapsedMs: expect.any(Number) });
  });

  it("reports the hard deadline once even when the provider never settles", async () => {
    vi.useFakeTimers();
    try {
      const observer = vi.fn();
      const brief = new WeeklyBriefService(store(), new BedrockBriefGenerator({ modelId: "synthetic", timeoutMs: 50,
        client: { send: () => new Promise(() => {}) },
      }), "UTC", observer).create(asOf);
      await vi.advanceTimersByTimeAsync(50);
      expect((await brief).generatedBy).toBe("deterministic");
      expect(observer).toHaveBeenCalledExactlyOnceWith({ outcome: "fallback", reason: "deadline", elapsedMs: expect.any(Number) });
    } finally { vi.useRealTimers(); }
  });
});
