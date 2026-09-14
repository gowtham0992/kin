import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { webcrypto } from "node:crypto";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, type AccessAuthorizer } from "../src/auth.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { createLambdaHttpHandler } from "../src/lambda-http.js";
import { createMcpCareClient, type McpTraceEvent } from "../simulator/mcp-client.js";
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);

const origin = "https://lambda-mcp.synthetic.test";
const token = "synthetic-lambda-mcp-token";
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(asynchronousStore: boolean, withSyntheticTokenExchange = false) {
  // Only Lambda's event/response boundary is bridged. The Express application,
  // MCP server, SDK client, body handling and buffered adapter are production code.
  // Every identity and care row is synthetic; no socket, AWS client or real token is used.
  vi.stubGlobal("fetch", () => { throw new Error("External network is forbidden in Lambda MCP acceptance"); });
  const task: CareTask = { id: "synthetic-check-in", title: "Synthetic check-in?", dueAt: "2026-09-10T15:00:00.000Z",
    state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null };
  const store = new InMemoryCareStore([task], () => new Date("2026-09-10T15:00:00.000Z"));
  const readToday = store.today.bind(store);
  const today = vi.spyOn(store, "today").mockImplementation(async () => {
    // Resolve on a later I/O turn, as a database read would, not a synchronous fixture Promise.
    if (asynchronousStore) await nextTurn();
    return readToday();
  });
  const confirm = vi.spyOn(store, "confirm");
  const authorizer: AccessAuthorizer = { async authorize(header) {
    await nextTurn();
    if (header !== `Bearer ${token}`) throw new AccessDeniedError(401, "invalid_token");
    return { subject: "synthetic-parent", scopes: new Set(["mcp:tools", "mcp:resources"]), claims: { iss: origin } };
  } };
  const app = createHttpApp(store, undefined, {
    accessAuthorizer: authorizer, mcpAuthMode: "standard", canonicalMcpUri: `${origin}/mcp`, authorizationServer: origin,
    familyAccess: { circleId: "synthetic-circle", directory: { async find() {
      await nextTurn();
      return { circleId: "synthetic-circle", memberId: "synthetic-parent", name: "Synthetic Parent", role: "care_recipient", status: "active" };
    } } },
    serveSimulator: false, serveFamilyWorkspace: true,
    browserAuth: { clientId: "synthetic-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp` },
  });
  const tokenApp = express();
  tokenApp.post("/token", express.urlencoded({ extended: false }), (request, response) => {
    // Only the upstream token exchange is synthetic. Browser PKCE/callback
    // validation, memory-only session ownership and authenticated fetch are real.
    if (request.body.grant_type !== "authorization_code" || request.body.code !== "synthetic-code" ||
        request.body.client_id !== "synthetic-family-browser" || request.body.redirect_uri !== `${origin}/invite.html` ||
        request.body.resource !== `${origin}/mcp` || !/^[A-Za-z0-9_-]{43}$/.test(request.body.code_verifier ?? "")) {
      response.status(400).json({ error: "invalid_grant" }); return;
    }
    response.set("cache-control", "no-store").json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: "mcp:tools mcp:resources" });
  });
  tokenApp.use(app);
  const handler = createLambdaHttpHandler(withSyntheticTokenExchange ? tokenApp : app);
  const records: Array<{ path: string; method: string; rpc?: string; status: number; contentType: string | null; bytes: number }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(input, origin), method = init?.method ?? "GET";
    if (url.origin !== origin || url.search || url.hash ||
        !((url.pathname === "/api/today" && method === "GET") || (url.pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(method)) ||
          (withSyntheticTokenExchange && url.pathname === "/token" && method === "POST"))) {
      throw new Error("Unexpected Lambda MCP acceptance destination");
    }
    if (init?.body !== undefined && typeof init.body !== "string") throw new Error("Expected a serialized request body");
    const headers = new Headers(init?.headers);
    headers.set("host", url.host);
    headers.set("x-forwarded-proto", "https");
    const body = init?.body as string | undefined;
    const response = await handler({
      version: "2.0", routeKey: "$default", rawPath: url.pathname, rawQueryString: "",
      headers: Object.fromEntries(headers), body, isBase64Encoded: false,
      requestContext: { http: { method, path: url.pathname, protocol: "HTTP/1.1", sourceIp: "127.0.0.1" }, stage: "$default" },
    }, {} as never, () => {});
    const responseHeaders = new Headers(response.headers);
    const bytes = Buffer.from(response.body ?? "", response.isBase64Encoded ? "base64" : "utf8");
    records.push({ path: url.pathname, method, ...(body && url.pathname === "/mcp" ? { rpc: JSON.parse(body).method } : {}),
      status: response.statusCode, contentType: responseHeaders.get("content-type"), bytes: bytes.length });
    return new Response([202, 204, 304].includes(response.statusCode) ? null : bytes,
      { status: response.statusCode, headers: responseHeaders });
  };
  return { fetcher, records, task, today, confirm };
}

describe("authenticated MCP through the buffered Lambda HTTP adapter", () => {
  it.each([false, true])("returns show_today after initialize and successful REST reads (deferred repository: %s)", async asynchronousStore => {
    const f = fixture(asynchronousStore);
    const rest = await f.fetcher(new URL(`${origin}/api/today`), { headers: { authorization: `Bearer ${token}` } });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({ tasks: [f.task], summary: { total: 1, completed: 0 } });

    const client = new Client({ name: "synthetic-lambda-mcp-acceptance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: f.fetcher,
    });
    try {
      await client.connect(transport, { timeout: 1_000 });
      const result = await client.callTool({ name: "show_today", arguments: {} }, undefined, { timeout: 1_000 });
      expect(result.isError, JSON.stringify(f.records)).not.toBe(true);
      expect(result.structuredContent, JSON.stringify(f.records)).toMatchObject({ tasks: [f.task], summary: { total: 1, completed: 0 } });
      const again = await client.callTool({ name: "show_today", arguments: {} }, undefined, { timeout: 1_000 });
      expect(again.structuredContent).toEqual(result.structuredContent);
      expect(f.today).toHaveBeenCalledTimes(3);
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.records.some(record => record.rpc === "initialize" && record.status === 200)).toBe(true);
      expect(f.records.some(record => record.rpc === "tools/call" && record.status === 200 && record.bytes > 0)).toBe(true);
    } catch (cause) {
      // Only method/status/byte-count diagnostics are retained, never request headers or care data.
      throw new Error(`Buffered Lambda MCP failed after ${f.today.mock.calls.length} snapshot reads: ${JSON.stringify(f.records)}`, { cause });
    } finally { await client.close(); }
  });

  it("returns signed-in Ask Kin reads through the real browser session owner and care client", async () => {
    const f = fixture(true, true), saved = new Map<string, string>();
    vi.stubGlobal("location", { origin });
    let random = 0;
    const config = { clientId: "synthetic-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp` };
    const auth = createBrowserAuth({ config, origin, request: f.fetcher, now: () => 1_000_000,
      storage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) },
      cryptoApi: { subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(++random) },
    });
    const authorization = new URL(await auth.start("ask"));
    const callback = new URL(config.redirectUri);
    callback.search = new URLSearchParams({ code: "synthetic-code", state: authorization.searchParams.get("state")!, iss: origin }).toString();
    await expect(auth.complete(callback.href)).resolves.toBe(true);
    expect(auth.connected).toBe(true); expect(auth.returnView).toBe("ask"); expect(saved.size).toBe(0);
    const rest = await auth.request("/api/today");
    expect(rest.status).toBe(200);
    const trace: McpTraceEvent[] = [];
    const care = createMcpCareClient(new URL(config.resource), { fetch: auth.request.bind(auth), onTrace: event => { trace.push(event); } });
    for (let read = 0; read < 2; read++) {
      await expect(care.today()).resolves.toMatchObject({ tasks: [f.task], summary: { total: 1, completed: 0 } });
    }
    expect(trace.map(event => [event.tool, event.phase])).toEqual([
      ["show_today", "request"], ["show_today", "result"], ["show_today", "request"], ["show_today", "result"],
    ]);
    expect(trace.filter(event => event.phase === "result").map(event => event.result)).toEqual([{ completed: 0, total: 1 }, { completed: 0, total: 1 }]);
    expect(JSON.stringify(trace)).not.toContain(token);
    expect(f.records.filter(record => record.path === "/token")).toHaveLength(1);
    expect(f.records.filter(record => record.rpc === "initialize")).toHaveLength(2);
    expect(f.records.some(record => record.path === "/mcp" && record.method === "GET")).toBe(false);
    expect(f.today).toHaveBeenCalledTimes(3); expect(f.confirm).not.toHaveBeenCalled();
    auth.disconnect(); expect(auth.connected).toBe(false); expect(saved.size).toBe(0);
  });

});
