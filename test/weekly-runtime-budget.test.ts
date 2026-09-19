import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredApp } from "../src/runtime.js";
import { createHttpApp } from "../src/http.js";
import { createBedrockBriefGenerator, WeeklyBriefService } from "../src/weekly-brief.js";

// Observe runtime wiring without opening sockets or resolving AWS credentials.
// The real service/generator constructors remain in use; nothing invokes them.
vi.mock("../src/http.js", () => ({ createHttpApp: vi.fn() }));
vi.mock("../src/weekly-brief.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/weekly-brief.js")>();
  return { ...actual, createBedrockBriefGenerator: vi.fn(actual.createBedrockBriefGenerator) };
});

const environment = {
  AWS_REGION: "us-east-1", KIN_DYNAMODB_TABLE: "synthetic-table", KIN_CIRCLE_ID: "synthetic-circle",
  KIN_TIME_ZONE: "America/Denver", KIN_BEDROCK_MODEL_ID: "amazon.nova-micro-v1:0",
  KIN_BROWSER_AUTH_ENABLED: "true", KIN_FAMILY_WORKSPACE_ENABLED: "true",
  KIN_BROWSER_CLIENT_ID: "kin-family-browser", KIN_BROWSER_REDIRECT_URI: "https://kin.example/invite.html",
  KIN_OAUTH_ISSUER: "https://kin.example", KIN_OAUTH_JWKS_URI: "https://kin.example/jwks",
  KIN_MCP_CANONICAL_URI: "https://kin.example/mcp",
};

beforeEach(() => { vi.clearAllMocks(); });

describe("separate server-side weekly model budgets", () => {
  it("wires distinct privacy-safe diagnostic labels to both runtime surfaces", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      createConfiguredApp({ ...environment, KIN_BEDROCK_MODEL_ID: "" });
      const [store, mcpBrief, options] = vi.mocked(createHttpApp).mock.calls[0]!;
      vi.spyOn(store, "activityBetween").mockImplementation(async period => ({ ...period, tasks: [], escalations: [] }));
      await mcpBrief!.create(new Date("2026-09-18T16:00:00.000Z"));
      await options!.workspaceWeeklyBrief!.create(new Date("2026-09-18T16:00:00.000Z"));
      expect(log.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
        { event: "kin_weekly_brief_result", surface: "mcp", outcome: "deterministic", reason: "model_disabled", elapsedMs: expect.any(Number) },
        { event: "kin_weekly_brief_result", surface: "workspace", outcome: "deterministic", reason: "model_disabled", elapsedMs: expect.any(Number) },
      ]);
    } finally { log.mockRestore(); }
  });
  it("gives only the enabled workspace a distinct 5000ms service while MCP remains 300ms", () => {
    createConfiguredApp(environment);
    expect(vi.mocked(createBedrockBriefGenerator).mock.calls.map(([options]) => options)).toEqual([
      { modelId: "amazon.nova-micro-v1:0", region: "us-east-1", timeoutMs: 300 },
      { modelId: "amazon.nova-micro-v1:0", region: "us-east-1", timeoutMs: 5000 },
    ]);
    const [store, mcpBrief, options] = vi.mocked(createHttpApp).mock.calls[0]!;
    expect(store).toBeDefined();
    expect(mcpBrief).toBeInstanceOf(WeeklyBriefService);
    expect(options?.workspaceWeeklyBrief).toBeInstanceOf(WeeklyBriefService);
    expect(options?.workspaceWeeklyBrief).not.toBe(mcpBrief);
  });

  it.each(["50", "1000", "5000"])("accepts bounded decimal workspace override %s without changing MCP", value => {
    createConfiguredApp({ ...environment, KIN_WORKSPACE_BEDROCK_TIMEOUT_MS: value });
    expect(vi.mocked(createBedrockBriefGenerator).mock.calls.map(([options]) => options.timeoutMs)).toEqual([300, Number(value)]);
  });

  it.each(["", " ", "0", "49", "-50", "5001", "10000", "NaN", "Infinity", "5000ms", "50.5", "1e3", "0x100", "+50", "050", "5000\n"])(
    "rejects malformed or out-of-range workspace override %j instead of coercing/truncating it", value => {
      expect(() => createConfiguredApp({ ...environment, KIN_WORKSPACE_BEDROCK_TIMEOUT_MS: value }))
        .toThrow("KIN_WORKSPACE_BEDROCK_TIMEOUT_MS");
      expect(createHttpApp).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing MCP override independent of the workspace default", () => {
    createConfiguredApp({ ...environment, KIN_BEDROCK_TIMEOUT_MS: "250" });
    expect(vi.mocked(createBedrockBriefGenerator).mock.calls.map(([options]) => options.timeoutMs)).toEqual([250, 5000]);
  });

  it.each(["false", undefined])("does not construct or pass a long-budget service when workspace is %s", enabled => {
    createConfiguredApp({ ...environment, KIN_FAMILY_WORKSPACE_ENABLED: enabled });
    expect(vi.mocked(createBedrockBriefGenerator).mock.calls.map(([options]) => options.timeoutMs)).toEqual([300]);
    expect(vi.mocked(createHttpApp).mock.calls[0]![2]?.workspaceWeeklyBrief).toBeUndefined();
  });

  it("keeps both surfaces deterministic when no model is configured", () => {
    createConfiguredApp({ ...environment, KIN_BEDROCK_MODEL_ID: "" });
    expect(createBedrockBriefGenerator).not.toHaveBeenCalled();
    const [, mcpBrief, options] = vi.mocked(createHttpApp).mock.calls[0]!;
    expect(mcpBrief).toBeInstanceOf(WeeklyBriefService);
    expect(options?.workspaceWeeklyBrief).toBeInstanceOf(WeeklyBriefService);
  });

  it("does not construct either model path when the public API is paused", () => {
    createConfiguredApp({ ...environment, KIN_PUBLIC_API_ENABLED: "false" });
    expect(createBedrockBriefGenerator).not.toHaveBeenCalled();
    expect(createHttpApp).not.toHaveBeenCalled();
  });
});
