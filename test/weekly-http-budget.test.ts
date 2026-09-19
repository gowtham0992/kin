import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { InMemoryCareStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";
import { createLambdaHttpHandler } from "../src/lambda-http.js";
import { WeeklyBriefService, type BriefGenerator } from "../src/weekly-brief.js";

const now = new Date("2026-09-14T18:00:00.000Z");
const config = { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" };
const activeMember = { circleId: "synthetic-circle", memberId: "synthetic-member", name: "Synthetic account", role: "caregiver", status: "active" };

function fixture() {
  const store = new InMemoryCareStore([{ id: "synthetic-check-in", title: "Synthetic check-in", dueAt: now.toISOString(),
    state: "done", lastResponse: "done", confirmedAt: now.toISOString(), confirmedBy: "Synthetic account" }], () => now);
  const generator = (modelId: string) => vi.fn<BriefGenerator["generate"]>(async source => ({
    narrative: { overview: "One recorded synthetic check-in.", overviewEvidenceIds: source.evidence.map(item => item.id),
      highlights: [{ text: "Synthetic check-in was completed.", evidenceIds: source.evidence.map(item => item.id) }], followUps: [] },
    generation: { provider: "bedrock", modelId, stopReason: "end_turn", inputTokens: 1, outputTokens: 1 },
  }));
  const mcpGenerate = generator("synthetic-mcp-300"), workspaceGenerate = generator("synthetic-workspace-5000");
  const mcpBrief = new WeeklyBriefService(store, { generate: mcpGenerate }, "America/Denver");
  const workspaceBrief = new WeeklyBriefService(store, { generate: workspaceGenerate }, "America/Denver");
  const find = vi.fn(async (): Promise<unknown> => structuredClone(activeMember));
  const options: HttpAppOptions = {
    serveSimulator: false, serveFamilyWorkspace: true, browserAuth: config,
    canonicalMcpUri: config.resource, authorizationServer: config.issuer,
    workspaceWeeklyBrief: workspaceBrief,
    accessAuthorizer: { async authorize(header) {
      if (header !== "Bearer synthetic-valid") throw new AccessDeniedError(401, "invalid_token");
      return { subject: "synthetic-subject", scopes: new Set(["mcp:tools"]), claims: { iss: config.issuer } };
    } },
    familyAccess: { circleId: "synthetic-circle", directory: { find } },
  };
  const build = () => {
    const handler = createLambdaHttpHandler(createHttpApp(store, mcpBrief, options));
    return async (url: string, input: { method?: string; bearer?: string; body?: unknown } = {}) => {
      const [pathname, query = ""] = url.split("?"), method = input.method ?? "GET";
      return handler({ version: "2.0", routeKey: "$default", rawPath: pathname, rawQueryString: query,
        headers: { host: "kin.example", "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(input.bearer ? { authorization: input.bearer } : {}) },
        requestContext: { http: { method, path: pathname, sourceIp: "127.0.0.1" }, stage: "$default" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), isBase64Encoded: false,
      }, {} as never, () => {});
    };
  };
  return { options, find, mcpGenerate, workspaceGenerate, build };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("workspace-only weekly service selection and authorization", () => {
  it("uses the workspace service for authorized REST Week and keeps it uncached", async () => {
    const f = fixture();
    const result = await f.build()("/api/weekly-brief?timeoutMs=10000", { bearer: "Bearer synthetic-valid" });
    expect(result.statusCode).toBe(200);
    expect(new Headers(result.headers).get("cache-control")).toBe("no-store");
    expect(JSON.parse(result.body)).toMatchObject({ generation: { modelId: "synthetic-workspace-5000" },
      stats: { scheduled: 1, completed: 1 }, overviewEvidenceIds: ["task:synthetic-check-in:2026-09-14T18:00:00.000Z"] });
    expect(f.workspaceGenerate).toHaveBeenCalledOnce(); expect(f.mcpGenerate).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer synthetic-invalid"])("rejects missing/invalid credentials %s before invoking either generator", async bearer => {
    const f = fixture(); const result = await f.build()("/api/weekly-brief", { bearer });
    expect(result.statusCode).toBe(401); expect(f.find).not.toHaveBeenCalled();
    expect(f.workspaceGenerate).not.toHaveBeenCalled(); expect(f.mcpGenerate).not.toHaveBeenCalled();
  });

  it.each([null, { ...activeMember, status: "revoked" }, { ...activeMember, circleId: "foreign-circle" },
    { ...activeMember, role: "unknown-role" }])("rejects denied membership %j before invoking either generator", async member => {
    const f = fixture(); f.find.mockResolvedValue(member);
    const result = await f.build()("/api/weekly-brief", { bearer: "Bearer synthetic-valid" });
    expect(result.statusCode).toBe(403);
    expect(f.workspaceGenerate).not.toHaveBeenCalled(); expect(f.mcpGenerate).not.toHaveBeenCalled();
  });

  it("rechecks membership after a successful request and does not generate again after revocation", async () => {
    const f = fixture(), invoke = f.build();
    expect((await invoke("/api/weekly-brief", { bearer: "Bearer synthetic-valid" })).statusCode).toBe(200);
    f.find.mockResolvedValue({ ...activeMember, status: "revoked" });
    expect((await invoke("/api/weekly-brief", { bearer: "Bearer synthetic-valid" })).statusCode).toBe(403);
    expect(f.find).toHaveBeenCalledTimes(3); expect(f.workspaceGenerate).toHaveBeenCalledOnce();
    expect(f.mcpGenerate).not.toHaveBeenCalled();
  });

  it("withholds a completed brief if membership is revoked while generation is pending", async () => {
    const f = fixture(), generate = f.workspaceGenerate.getMockImplementation()!;
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const completion = new Promise<void>(resolve => { finish = resolve; });
    f.workspaceGenerate.mockImplementationOnce(async source => { enter(); await completion; return generate(source); });
    const pending = f.build()("/api/weekly-brief", { bearer: "Bearer synthetic-valid" });
    await entered;
    f.find.mockResolvedValue({ ...activeMember, status: "revoked" });
    finish();
    const result = await pending;
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "family_access_denied" });
    expect(result.body).not.toContain("Synthetic check-in");
    expect(f.find).toHaveBeenCalledTimes(2); expect(f.workspaceGenerate).toHaveBeenCalledOnce();
  });

  it.each(["caregiver", "care_recipient", "viewer"])("preserves existing read access for an active %s", async role => {
    const f = fixture(); f.find.mockResolvedValue({ ...activeMember, role });
    const result = await f.build()("/api/weekly-brief", { bearer: "Bearer synthetic-valid" });
    expect(result.statusCode).toBe(200); expect(f.workspaceGenerate).toHaveBeenCalledOnce();
  });

  it.each(["alexa", "standard"] as const)("keeps the original MCP service in %s mode, including browser Ask calls", async mcpAuthMode => {
    const f = fixture(); f.options.mcpAuthMode = mcpAuthMode;
    const result = await f.build()("/mcp", { method: "POST", bearer: "Bearer synthetic-valid",
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "show_weekly_brief", arguments: {} } } });
    expect(result.statusCode).toBe(200);
    const data = result.body.split("\n").find((line: string) => line.startsWith("data: "));
    const payload = data ? JSON.parse(data.slice(6)) : JSON.parse(result.body);
    expect(payload.result.structuredContent.generation.modelId).toBe("synthetic-mcp-300");
    expect(f.mcpGenerate).toHaveBeenCalledOnce(); expect(f.workspaceGenerate).not.toHaveBeenCalled();
  });

  it("preserves the original REST behavior when no separate workspace service is supplied", async () => {
    const f = fixture(); delete f.options.workspaceWeeklyBrief;
    const result = await f.build()("/api/weekly-brief", { bearer: "Bearer synthetic-valid" });
    expect(JSON.parse(result.body).generation.modelId).toBe("synthetic-mcp-300");
    expect(f.mcpGenerate).toHaveBeenCalledOnce(); expect(f.workspaceGenerate).not.toHaveBeenCalled();
  });

  it.each(["serveFamilyWorkspace", "accessAuthorizer", "familyAccess", "browserAuth"] as const)(
    "refuses to attach the workspace service without %s", key => {
      const f = fixture(); delete f.options[key];
      expect(() => f.build()).toThrow(); expect(f.workspaceGenerate).not.toHaveBeenCalled();
    },
  );
});
