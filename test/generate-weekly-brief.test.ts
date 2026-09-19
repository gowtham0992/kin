import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ dynamo: vi.fn(), bedrock: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/client-dynamodb")>(),
  DynamoDBClient: class {},
}));
vi.mock("@aws-sdk/lib-dynamodb", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>(),
  DynamoDBDocumentClient: { from: () => ({ send: network.dynamo }) },
}));
vi.mock("@aws-sdk/client-bedrock-runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>(),
  BedrockRuntimeClient: class { send = network.bedrock; },
}));

const task = { PK: "CIRCLE#synthetic-circle", SK: "TASK#2026-09-14T15:00:00.000Z#synthetic-check-in",
  entityType: "CareTask", id: "synthetic-check-in", title: "Synthetic check-in", dueAt: "2026-09-14T15:00:00.000Z",
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const evidenceId = `task:${task.id}:${task.dueAt}`;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-14T18:00:00.000Z"));
  vi.stubEnv("KIN_DYNAMODB_TABLE", "synthetic-table"); vi.stubEnv("KIN_BEDROCK_MODEL_ID", "synthetic-model");
  vi.stubEnv("KIN_CIRCLE_ID", "synthetic-circle"); vi.stubEnv("AWS_REGION", "us-east-1"); vi.stubEnv("KIN_TIME_ZONE", "UTC");
  vi.stubEnv("KIN_BEDROCK_TIMEOUT_MS", undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  network.dynamo.mockReset().mockImplementation(async (command: QueryCommand) => ({
    Items: String(command.input.ExpressionAttributeValues?.[":start"]).startsWith("TASK#") ? [task] : [],
  }));
  network.bedrock.mockReset().mockResolvedValue({ $metadata: {}, stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 }, output: { message: {
    role: "assistant", content: [{ text: JSON.stringify({ overviewEvidenceIds: [evidenceId], highlightEvidenceIds: [evidenceId], followUps: [] }) }],
  } } } satisfies ConverseCommandOutput);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

describe("weekly CLI Bedrock timeout configuration", () => {
  it.each([
    { value: undefined, budget: 300 }, { value: "50", budget: 50 },
    { value: "10000", budget: 10_000 }, { value: "5e2", budget: 500 },
  ])("uses $budget ms for KIN_BEDROCK_TIMEOUT_MS=$value and emits fallback after abort", async ({ value, budget }) => {
    vi.stubEnv("KIN_BEDROCK_TIMEOUT_MS", value);
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>(resolve => { started = resolve; });
    network.bedrock.mockImplementation((_command: ConverseCommand, options: { abortSignal: AbortSignal }) => {
      started(options.abortSignal);
      return new Promise((_resolve, reject) => options.abortSignal.addEventListener("abort", () => reject(new Error("Synthetic deadline")), { once: true }));
    });
    const execution = import("../scripts/generate-weekly-brief.js");
    const signal = await ready;
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(signal.aborted).toBe(false); expect(console.log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true); await execution;
    // Current and preceding periods each read bounded task and escalation windows.
    expect(network.dynamo).toHaveBeenCalledTimes(4); expect(network.bedrock).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0]);
    expect(output).toMatchObject({ generatedBy: "deterministic", generation: null,
      stats: { scheduled: 1, completed: 0, skipped: 0, stillOpen: 1, escalations: 0 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["49", "10001", "50.5", "300ms", "", "NaN", "Infinity"])("rejects exact numeric conversion of %j before any storage or model send", async value => {
    vi.stubEnv("KIN_BEDROCK_TIMEOUT_MS", value);
    await expect(import("../scripts/generate-weekly-brief.js")).rejects.toThrow("Bedrock brief timeout must be an integer from 50 to 10000 milliseconds");
    expect(network.dynamo).not.toHaveBeenCalled(); expect(network.bedrock).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled();
  });
});
