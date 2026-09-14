import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createJwtAccessAuthorizer, type AccessAuthorizer } from "../src/auth.js";
import { InMemoryCareStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";
import { createLambdaHttpHandler } from "../src/lambda-http.js";
import { createStringParameterProvider } from "../src/parameter.js";
import * as mcp from "../src/mcp.js";
import { createMcpInitializeTiming, startMcpTiming, type McpInitializeTiming, type McpInitializeTimingRecord, type McpInitializeTimingSink } from "../src/mcp-initialize-timing.js";

const origin = "https://initialize-timing.synthetic.test";
const marker = "PRIVATE_SYNTHETIC_MUST_NOT_APPEAR";
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: marker, version: "1" },
} };
let key: CryptoKey, wrongKey: CryptoKey, jwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  wrongKey = (await generateKeyPair("RS256")).privateKey;
  jwk = { ...await exportJWK(pair.publicKey), alg: "RS256", use: "sig", kid: "synthetic-key" };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function token(claims: JWTPayload = {}, signingKey = key) {
  return new SignJWT({ sub: marker, iss: origin, aud: `${origin}/mcp`, exp: 4_000_000_000,
    scope: "mcp:tools", ...claims }).setProtectedHeader({ alg: "RS256", kid: "synthetic-key" }).sign(signingKey);
}

function fixture(input: { audienceFailure?: boolean; absentMember?: boolean; sink?: McpInitializeTimingSink; authorizer?: AccessAuthorizer } = {}) {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const records: McpInitializeTimingRecord[] = [];
  const send = vi.fn(async () => {
    clock += 40;
    if (input.audienceFailure) throw new Error(marker);
    return { Parameter: { Value: `${origin}/mcp` } };
  });
  const audience = createStringParameterProvider({ parameterName: "/synthetic/resource", client: { send } });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== `${origin}/jwks` || init?.method !== "GET") throw new Error("Unexpected outbound request in timing fixture");
    clock += 75;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const authorizer = input.authorizer ?? createJwtAccessAuthorizer({ issuer: origin, audience, jwksUri: `${origin}/jwks` });
  const store = new InMemoryCareStore([], () => new Date("2026-09-11T15:00:00.000Z"));
  const read = vi.spyOn(store, "today"), write = vi.spyOn(store, "confirm");
  const find = vi.fn(async () => {
    clock += 11;
    return input.absentMember ? undefined : { circleId: "synthetic-circle", memberId: "synthetic-member", name: marker, role: "caregiver", status: "active" };
  });
  const options: HttpAppOptions = {
    accessAuthorizer: authorizer, canonicalMcpUri: `${origin}/mcp`, authorizationServer: origin, mcpAuthMode: "standard",
    familyAccess: { circleId: "synthetic-circle", directory: { find } }, serveSimulator: false,
    onMcpInitializeTiming: input.sink ?? (record => { records.push(record); }),
  };
  const handler = createLambdaHttpHandler(createHttpApp(store, undefined, options));
  async function invoke(body: unknown = initialize, bearer?: string, path = "/mcp") {
    const response = await handler({
      version: "2.0", routeKey: "$default", rawPath: path, rawQueryString: "", isBase64Encoded: false,
      headers: { host: "initialize-timing.synthetic.test", "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
      requestContext: { http: { method: "POST", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1" }, stage: "$default" },
    }, {} as never, () => {});
    return { status: response.statusCode, headers: response.headers,
      text: Buffer.from(response.body ?? "", response.isBase64Encoded ? "base64" : "utf8").toString() };
  }
  return { invoke, records, send, fetcher, find, read, write, authorizer, options };
}

describe("metadata-only initialize timing", () => {
  it("measures cold dependency waits and preserves one-per-environment audience/JWKS caches", async () => {
    const f = fixture(), bearer = await token();
    const first = await f.invoke(initialize, bearer), second = await f.invoke(initialize, bearer);
    expect(first).toEqual(second);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toContain("text/event-stream");
    expect(first.text).toContain('"protocolVersion":"2025-11-25"');
    expect(f.records).toEqual([
      { event: "kin_mcp_initialize_timing", version: 1, outcome: "success", elapsedMs: 126, httpStatus: 200,
        phases: { audience: 40, jwt: 75, jwks: 75, membership: 11, server_setup: 0, server_connect: 0, request_handle: 0 } },
      { event: "kin_mcp_initialize_timing", version: 1, outcome: "success", elapsedMs: 11, httpStatus: 200,
        phases: { audience: 0, jwt: 0, jwks: 0, membership: 11, server_setup: 0, server_connect: 0, request_handle: 0 } },
    ]);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.find).toHaveBeenCalledTimes(2);
    expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    expect(JSON.stringify(f.records)).not.toContain(marker); expect(JSON.stringify(f.records)).not.toContain(bearer);
  });

  it.each([
    ["missing", undefined], ["malformed", "not.a.valid.jwt"],
    ["issuer", { iss: "https://wrong.synthetic.test" }], ["audience", { aud: "https://wrong.synthetic.test/mcp" }],
    ["expiry", { exp: 1 }], ["subject", { sub: undefined }], ["signature", "wrong-signature"], ["algorithm", "wrong-algorithm"],
  ] as const)("preserves401 and discloses no input on %s rejection", async (_kind, variant) => {
    const f = fixture();
    const bearer = variant === undefined ? undefined : variant === "not.a.valid.jwt" ? variant :
      variant === "wrong-signature" ? await token({}, wrongKey) : variant === "wrong-algorithm"
        ? await new SignJWT({ sub: marker, iss: origin, aud: `${origin}/mcp`, exp: 4_000_000_000, scope: "mcp:tools" })
          .setProtectedHeader({ alg: "HS256", kid: "synthetic-key" }).sign(new Uint8Array(32).fill(7)) : await token(variant);
    const response = await f.invoke(initialize, bearer);
    expect(response.status).toBe(401); expect(JSON.parse(response.text)).toEqual({ error: "invalid_token" });
    expect(f.records).toHaveLength(1); expect(f.records[0]).toMatchObject({ outcome: "failure", httpStatus: 401 });
    expect(JSON.stringify(f.records)).not.toContain(marker);
    if (bearer) expect(JSON.stringify(f.records)).not.toContain(bearer);
    expect(f.find).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["scope", "membership"])("preserves403 for revoked %s", async kind => {
    const f = fixture({ absentMember: kind === "membership" });
    const response = await f.invoke(initialize, await token(kind === "scope" ? { scope: "openid" } : {}));
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toEqual({ error: kind === "scope" ? "insufficient_scope" : "family_access_denied" });
    expect(f.records).toHaveLength(1); expect(f.records[0]).toMatchObject({ outcome: "failure", httpStatus: 403 });
    expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  });

  it("preserves audience exceptions as500, resets failed lookup and never labels an unsent status200", async () => {
    const f = fixture({ audienceFailure: true }), bearer = await token();
    vi.spyOn(console, "error").mockImplementation(() => {}); // Existing error logger is not the diagnostic sink.
    for (let i = 0; i < 2; i++) {
      const response = await f.invoke(initialize, bearer);
      expect(response.status).toBe(500); expect(JSON.parse(response.text)).toEqual({ error: "Internal server error" });
    }
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.records).toEqual([0, 1].map(() => ({ event: "kin_mcp_initialize_timing", version: 1, outcome: "failure", elapsedMs: 40, phases: { audience: 40 } })));
    expect(JSON.stringify(f.records)).not.toContain(marker);
  });

  it("keeps service-only discovery independent of membership", async () => {
    const f = fixture({ absentMember: true });
    expect((await f.invoke(initialize, await token({ scope: "mcp:service" }))).status).toBe(200);
    expect(f.records).toHaveLength(1); expect(f.records[0]?.outcome).toBe("success");
    expect(f.find).not.toHaveBeenCalled(); expect(f.records[0]?.phases.membership).toBeUndefined();
  });

  it.each(["throw", "reject", "pending"])("does not change successful initialization when the sink is %s", async kind => {
    const f = fixture({ sink: () => {
      if (kind === "throw") throw new Error(marker);
      return kind === "reject" ? Promise.reject(new Error(marker)) : new Promise(() => {});
    } });
    expect((await f.invoke(initialize, await token())).status).toBe(200);
    expect(f.find).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
  });

  it("leaves every non-initialize method uninstrumented", async () => {
    const f = fixture(), bearer = await token();
    for (const method of ["notifications/initialized", "ping", "tools/list", "Initialize"])
      await f.invoke({ jsonrpc: "2.0", id: 1, method }, bearer);
    await f.invoke([initialize], bearer);
    expect(f.records).toEqual([]);
  });

  it.each(["server_setup", "server_connect", "request_handle"] as const)("records %s failure without changing the500 response or exposing its error", async phase => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (phase === "server_setup") vi.spyOn(mcp, "createMcpServer").mockImplementationOnce(() => { throw new Error(marker); });
    else if (phase === "server_connect") vi.spyOn(StreamableHTTPServerTransport.prototype, "start").mockRejectedValueOnce(new Error(marker));
    else vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockRejectedValueOnce(new Error(marker));
    const response = await f.invoke(initialize, await token());
    expect(response.status).toBe(500);
    expect(f.records).toHaveLength(1); expect(f.records[0]?.outcome).toBe("failure");
    expect(f.records[0]?.phases[phase]).toBe(0);
    if (phase === "server_setup") expect(f.records[0]?.httpStatus).toBeUndefined();
    else expect(f.records[0]?.httpStatus).toBe(500);
    expect(JSON.stringify(f.records)).not.toContain(marker);
    expect(f.read).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  });

  it("logs only the fixed record through the default sink", async () => {
    const f = fixture();
    delete f.options.onMcpInitializeTiming;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = createLambdaHttpHandler(createHttpApp(new InMemoryCareStore([]), undefined, f.options));
    await handler({ version: "2.0", routeKey: "$default", rawPath: "/mcp", rawQueryString: "", isBase64Encoded: false,
      headers: { "content-type": "application/json" }, body: JSON.stringify(initialize),
      requestContext: { http: { method: "POST", path: "/mcp" }, stage: "$default" },
    }, {} as never, () => {});
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toEqual({ event: "kin_mcp_initialize_timing", version: 1, outcome: "failure", elapsedMs: 0, phases: {}, httpStatus: 401 });
  });
});

describe("timing recorder isolation and sink safety", () => {
  it.each(["throw", "reject", "pending"])("does not throw, await or expose a sink that will %s", kind => {
    const timing = createMcpInitializeTiming(() => {
      if (kind === "throw") throw new Error(marker);
      return kind === "reject" ? Promise.reject(new Error(marker)) : new Promise(() => {});
    }, () => 0);
    expect(timing.finish("success", 200)).toBeUndefined();
  });
  it("keeps interleaved records independent, freezes both levels, and finishes once", () => {
    const records: McpInitializeTimingRecord[] = []; let a = 10, b = 100;
    const first = createMcpInitializeTiming(r => records.push(r), () => a), second = createMcpInitializeTiming(r => records.push(r), () => b);
    const one = first.start("membership"), two = second.start("jwt");
    a += 7; one(); one(); b += 31; two(); second.finish("failure", 401); first.finish("success", 200);
    a += 50; first.start("jwks")(); first.finish("failure", 500);
    expect(records.map(r => [r.outcome, r.elapsedMs, r.phases])).toEqual([["failure", 31, { jwt: 31 }], ["success", 7, { membership: 7 }]]);
    for (const r of records) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.phases)).toBe(true); }
  });

  it.each(["audience", "jwt", "jwks", "membership", "server_setup", "server_connect", "request_handle"] as const)("measures only the named %s phase", phase => {
    const records: McpInitializeTimingRecord[] = []; let now = 0;
    const timing = createMcpInitializeTiming(r => records.push(r), () => now), end = timing.start(phase);
    now = 37.9; end(); timing.finish("success", 200);
    expect(records[0]?.phases).toEqual({ [phase]: 37 }); expect(records[0]?.elapsedMs).toBe(37);
  });

  it.each([[-4, 0], [NaN, 0], [Infinity, 0], [100_000, 60_000]])("bounds nonfinite and out-of-range measurements %s", (duration, expected) => {
    const records: McpInitializeTimingRecord[] = []; let now = 0;
    const timing = createMcpInitializeTiming(r => records.push(r), () => now), end = timing.start("audience");
    now = duration; end(); timing.finish("success", 999);
    expect(records[0]).toEqual({ event: "kin_mcp_initialize_timing", version: 1, outcome: "success", elapsedMs: expected, phases: { audience: expected } });
  });

  it("never inspects untrusted phase or outcome objects or permits arbitrary record keys", () => {
    const records: McpInitializeTimingRecord[] = [];
    const poison = { get toString() { throw new Error(marker); } };
    const timing = createMcpInitializeTiming(r => records.push(r), () => 0);
    timing.start(poison as never)(); timing.start("__proto__" as never)();
    timing.finish(poison as never, poison as never);
    expect(records).toEqual([{ event: "kin_mcp_initialize_timing", version: 1, outcome: "failure", elapsedMs: 0, phases: {} }]);
  });

  it.each(["start", "end"])("preserves original authorization when observer %s throws", async stage => {
    const f = fixture(), bearer = await token();
    const observer: McpInitializeTiming = { start() { if (stage === "start") throw new Error(marker); return () => { throw new Error(marker); }; }, finish() {} };
    await expect(f.authorizer.authorize(`Bearer ${bearer}`, ["mcp:tools"], observer)).resolves.toMatchObject({ subject: marker });
    await expect(f.authorizer.authorize("Bearer malformed", [], observer)).rejects.toMatchObject({ status: 401 });
    expect(() => startMcpTiming(observer, "membership")()).not.toThrow();
  });
});
