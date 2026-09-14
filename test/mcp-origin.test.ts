import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp, type HttpAppOptions } from "../src/http.js";
import { createLambdaHttpHandler } from "../src/lambda-http.js";

const origin = "https://kin-origin.synthetic.test";
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "origin-regression", version: "1" },
} });
const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");
afterEach(() => { vi.restoreAllMocks(); });

function configured(overrides: Partial<HttpAppOptions> = {}) {
  const authorize = vi.fn(async (header: string | undefined) => {
    if (header !== "Bearer synthetic-origin-token") throw new AccessDeniedError(401, "invalid_token");
    return { subject: "synthetic-parent", scopes: new Set(["mcp:tools", "mcp:resources"]), claims: {} };
  });
  const store = createDemoStore(fixedNow), today = vi.spyOn(store, "today"), confirm = vi.spyOn(store, "confirm");
  const app = createHttpApp(store, undefined, {
    canonicalMcpUri: `${origin}/mcp`, authorizationServer: "https://login.synthetic.test",
    mcpAuthMode: "standard", accessAuthorizer: { authorize }, serveSimulator: false,
    familyAccess: { circleId: "synthetic-circle", directory: { async find() {
      return { circleId: "synthetic-circle", memberId: "synthetic-parent", name: "Synthetic Parent", role: "care_recipient", status: "active" };
    } } }, ...overrides,
  });
  return { app, authorize, today, confirm };
}

function lambdaRequest(app: ReturnType<typeof createHttpApp>) {
  const handler = createLambdaHttpHandler(app);
  return async (headers: Record<string, string> = {}, method = "POST", body: string | undefined = initialize) => {
    const response = await handler({
      version: "2.0", routeKey: "$default", rawPath: "/mcp", rawQueryString: "",
      headers: { host: new URL(origin).host, "content-type": "application/json", accept: "application/json, text/event-stream",
        authorization: "Bearer synthetic-origin-token", ...headers }, body, isBase64Encoded: false,
      requestContext: { http: { method, path: "/mcp", protocol: "HTTP/1.1", sourceIp: "127.0.0.1" }, stage: "$default" },
    }, {} as never, () => {});
    return { status: response.statusCode, headers: new Headers(response.headers), body: response.body ?? "" };
  };
}

describe("MCP browser-origin boundary", () => {
  it.each(["POST", "GET", "DELETE", "OPTIONS", "HEAD"])("rejects foreign Origin before parsing or authorizing %s", async method => {
    const f = configured();
    const response = await lambdaRequest(f.app)({ origin: "https://foreign.synthetic.test" }, method, "{invalid JSON");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBeNull();
    if (method !== "HEAD") expect(JSON.parse(response.body)).toEqual({ error: "invalid_origin" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.today).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each([
    "null", "", "not an origin", `${origin}/`, `${origin}/mcp`, `${origin}?`, `${origin}#`,
    `${origin} https://foreign.synthetic.test`, `${origin}, https://foreign.synthetic.test`,
    `https://user@${new URL(origin).host}`, `https://user:password@${new URL(origin).host}`,
    "file://kin-origin.synthetic.test", ` ${origin}`, `${origin}\t`,
    "https://KIN-ORIGIN.synthetic.test", `${origin}:443`, `${origin}:8443`,
    "http://kin-origin.synthetic.test", "https://login.synthetic.test",
  ])("rejects malformed, noncanonical or untrusted origin %j", async suppliedOrigin => {
    const f = configured();
    const response = await lambdaRequest(f.app)({ origin: suppliedOrigin });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_origin" });
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("never promotes Host or forwarded headers into a trusted origin", async () => {
    const f = configured(), send = lambdaRequest(f.app);
    const response = await send({ origin: "https://foreign.synthetic.test", host: "foreign.synthetic.test",
      forwarded: "host=foreign.synthetic.test;proto=https", "x-forwarded-host": "foreign.synthetic.test", "x-forwarded-proto": "https" });
    expect(response.status).toBe(403);
    expect(f.authorize).not.toHaveBeenCalled();
    const legitimate = await send({ origin, host: "untrusted-host.synthetic.test", "x-forwarded-host": "foreign.synthetic.test", "x-forwarded-proto": "http" });
    expect(legitimate.status).toBe(200);
    expect(legitimate.body).toContain('"protocolVersion":"2025-11-25"');
  });

  it.each([undefined, origin])("preserves authentication for an allowed origin %j", async suppliedOrigin => {
    const f = configured();
    const response = await lambdaRequest(f.app)({ ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }), authorization: "" });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_token" });
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp:tools mcp:resources"`);
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.today).not.toHaveBeenCalled();
  });

  it.each(["GET", "DELETE"])("preserves unsupported-method behavior for valid %s origins", async method => {
    const response = await lambdaRequest(configured().app)({ origin }, method, undefined);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("uses the async canonical resource's exact origin and port, not the issuer", async () => {
    const canonicalMcpUri = vi.fn(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return `${origin}:8443/mcp`;
    });
    const f = configured({ canonicalMcpUri }), send = lambdaRequest(f.app);
    expect((await send({ origin: `${origin}:8443` })).status).toBe(200);
    expect((await send({ origin })).status).toBe(403);
    expect(canonicalMcpUri).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenCalledOnce();
  });

  it.each([
    async () => { throw new Error("synthetic private resolver detail"); },
    async () => "https://user:private-value@kin-origin.synthetic.test/mcp",
  ])("fails closed without exposing resolver/configuration details", async canonicalMcpUri => {
    const f = configured({ canonicalMcpUri });
    const response = await lambdaRequest(f.app)({ origin });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Internal server error" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.today).not.toHaveBeenCalled();
  });

  it("does not add resource lookup work to a native request with no Origin", async () => {
    const canonicalMcpUri = vi.fn(async () => { throw new Error("must not be used by this authorized initialization"); });
    const response = await lambdaRequest(configured({ canonicalMcpUri }).app)();
    expect(response.status).toBe(200);
    expect(response.body).toContain('"protocolVersion":"2025-11-25"');
    expect(canonicalMcpUri).not.toHaveBeenCalled();
  });

  it.each([undefined, origin])("keeps authenticated SDK initialize/list/read working with Origin %j", async suppliedOrigin => {
    const f = configured({ canonicalMcpUri: async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return `${origin}/mcp`;
    } }), send = lambdaRequest(f.app);
    const fetcher: FetchLike = async (input, init = {}) => {
      if (String(input) !== `${origin}/mcp`) throw new Error("Unexpected synthetic SDK destination");
      const headers = new Headers(init.headers);
      if (suppliedOrigin !== undefined) headers.set("origin", suppliedOrigin);
      const result = await send(Object.fromEntries(headers), init.method ?? "GET", init.body as string | undefined);
      return new Response([202, 204, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
    };
    const client = new Client({ name: "synthetic-origin-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: "Bearer synthetic-origin-token" } }, fetch: fetcher,
    });
    try {
      await client.connect(transport, { timeout: 1000 });
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("show_today");
      const result = await client.callTool({ name: "show_today", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ summary: { total: 2, completed: 0 } });
      expect(f.today).toHaveBeenCalledOnce();
      expect(f.confirm).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it("does not treat a fabricated local Host as an actual local listening socket", async () => {
    const app = createHttpApp(createDemoStore(fixedNow));
    const response = await lambdaRequest(app)({ host: "127.0.0.1:3030", origin: "http://127.0.0.1:3030" });
    expect(response.status).toBe(403);
  });

  it("permits only loopback browser origins at the actual local listening port", async () => {
    const app = createHttpApp(createDemoStore(fixedNow));
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected loopback test listener");
      const endpoint = `http://127.0.0.1:${address.port}/mcp`;
      const send = (suppliedOrigin: string, host = `127.0.0.1:${address.port}`) => fetch(endpoint, {
        method: "POST", headers: { origin: suppliedOrigin, host, "x-forwarded-host": new URL(suppliedOrigin).host,
          "content-type": "application/json", accept: "application/json, text/event-stream" }, body: initialize,
      });
      for (const allowed of [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]) {
        const response = await send(allowed);
        expect(response.status, allowed).toBe(200);
        expect(await response.text()).toContain('"protocolVersion":"2025-11-25"');
      }
      for (const rejected of [`http://localhost:${address.port === 65535 ? 65534 : address.port + 1}`,
        `https://localhost:${address.port}`, `http://foreign.synthetic.test:${address.port}`,
        `http://localhost.foreign.synthetic.test:${address.port}`]) {
        const response = await send(rejected, new URL(rejected).host);
        expect(response.status, rejected).toBe(403);
        expect(await response.json()).toEqual({ error: "invalid_origin" });
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
