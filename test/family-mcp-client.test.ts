import { webcrypto } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpCareClient, type McpTraceEvent } from "../simulator/mcp-client.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { AccessDeniedError } from "../src/auth.js";
import { taskReview } from "../src/task-review.js";
import { FamilyAccessDeniedError } from "../src/membership.js";
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const origin = "https://kin.example", endpoint = new URL(`${origin}/mcp`);
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});
async function fixture() {
  const store = createDemoStore(() => new Date("2026-09-02T08:00:00.000Z"));
  let denial: number | undefined;
  const app = createHttpApp(store, undefined, { serveSimulator: false, mcpAuthMode: "standard",
    canonicalMcpUri: endpoint.href, authorizationServer: origin,
    accessAuthorizer: { async authorize(header) {
      if (denial || header !== "Bearer synthetic-family-token") throw new AccessDeniedError(denial === 403 ? 403 : 401, "invalid_token");
      return { subject: "synthetic-maya", scopes: new Set(["mcp:tools", "mcp:resources"]), claims: { iss: origin } };
    } },
    familyAccess: { circleId: "synthetic-circle", directory: { async find() {
      return { circleId: "synthetic-circle", memberId: "maya", name: "Maya", role: "caregiver", status: "active" };
    } } },
  });
  // Supertest's implicit wildcard listener can coexist with another IPv4
  // service on the same port on macOS, while its requests always use 127.0.0.1.
  // Own one exact IPv4 endpoint for this fixture and close it after the test.
  const server = createServer(app).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const wire: Array<{ method: string; url: string; frame: Record<string, any>; headers: Headers }> = [];
  const localTargets: Array<{ url: string; address: ReturnType<Server["address"]> }> = [];
  const http = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/token") return Response.json({ access_token: "synthetic-family-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools mcp:resources" });
    expect(url).toBe(endpoint.href); expect(init.method).toBe("POST");
    const headers = new Headers(init.headers), frame = JSON.parse(String(init.body));
    wire.push({ method: init.method!, url, frame, headers });
    const outgoing = request(server).post("/mcp");
    localTargets.push({ url: outgoing.url, address: (outgoing.app as Server).address() });
    for (const [key, value] of headers) outgoing.set(key, value);
    const result = await outgoing.send(frame);
    return new Response(result.status === 202 ? null : result.text, { status: result.status, headers: result.headers as Record<string, string> });
  });
  const saved = new Map<string, string>();
  const auth = createBrowserAuth({ config: { clientId: "kin-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: endpoint.href }, origin,
    storage: { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) },
    cryptoApi: { subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(7) }, now: () => 1000, request: http });
  const login = new URL(await auth.start());
  await auth.complete(`${origin}/invite.html?code=synthetic&iss=${encodeURIComponent(origin)}&state=${login.searchParams.get("state")}`);
  http.mockClear();
  vi.stubGlobal("location", { origin });
  const fallback = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unowned fetch is forbidden"));
  const events: McpTraceEvent[] = [];
  const authenticatedFetch = vi.fn((input: string | URL, init?: RequestInit) => auth.request(input, init) as Promise<Response>);
  const client = createMcpCareClient(endpoint, { fetch: authenticatedFetch, clientName: "kin-family-workspace", onTrace: event => events.push(event) });
  return { store, client, wire, localTargets, events, http, fallback, authenticatedFetch, auth, deny: (status: number) => { denial = status; } };
}

describe("family browser over authenticated MCP", () => {
  it("owns one explicit IPv4 listener matching every local transport destination", async () => {
    const f = await fixture();
    await f.client.today();
    await f.client.today();
    expect(f.localTargets.length).toBeGreaterThan(2);
    for (const target of f.localTargets) {
      expect(target.address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
      const address = target.address as { port: number };
      expect(target.url).toBe(`http://127.0.0.1:${address.port}/mcp`);
    }
    expect(new Set(f.localTargets.map(target => target.url)).size).toBe(1);
  });
  it("keeps simultaneous fixtures on independent listeners and care stores", async () => {
    const first = await fixture(), second = await fixture();
    const expected = taskReview((await first.store.today()).tasks.find(task => task.id === "morning-water")!);
    await first.client.confirm({ taskId: "morning-water", response: "done", actor: "Maya", requestId: "independent-fixture-01", expected });
    expect(await second.client.today()).toMatchObject({ summary: { completed: 0 } });
    expect(await first.client.today()).toMatchObject({ summary: { completed: 1 } });
    expect(new Set(first.localTargets.map(target => target.url)).size).toBe(1);
    expect(new Set(second.localTargets.map(target => target.url)).size).toBe(1);
    expect(first.localTargets[0]!.url).not.toBe(second.localTargets[0]!.url);
    expect((await second.store.today()).summary.completed).toBe(0);
  });
  it.each(["before", "after"])("signals access loss %s a commit without inventing an outcome or losing the retry identity", async phase => {
    const f = await fixture(), original = f.store.confirm.bind(f.store);
    vi.spyOn(f.store, "confirm").mockImplementation(async (...args) => {
      if (phase === "after") await original(...args);
      f.deny(403); throw new FamilyAccessDeniedError();
    });
    const workspace = createWorkspaceClient({ mcp: async () => f.client, request: vi.fn(), newRequestId: () => "access-loss-receipt-01" });
    const input = { taskId: "morning-water", response: "done", actor: "Maya",
      expected: taskReview((await f.store.today()).tasks.find(task => task.id === "morning-water")!) };
    await expect(workspace.confirmViaMcp(input)).rejects.toMatchObject({ status: 403, definitiveRejection: false,
      outcomeUnknown: true, requestId: "access-loss-receipt-01" });
    expect(workspace.pending).toMatchObject({ ...input, requestId: "access-loss-receipt-01" });
    expect((await f.store.today()).summary.completed).toBe(phase === "after" ? 1 : 0);
    expect(f.wire.filter(item => item.frame.method === "tools/call" && item.frame.params.name === "confirm_care_task")).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ phase: "error", errorCode: "family_access_denied", requestId: "access-loss-receipt-01" });
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}])("rejects an absent or malformed review before opening a connection: %j", async expected => {
    const { client, wire, http } = await fixture();
    // JavaScript callers do not receive TypeScript's required-field protection.
    await expect(client.confirm({ taskId: "morning-water", response: "done", actor: "Maya", requestId: "missing-review-01",
      expected: expected as never })).rejects.toMatchObject({ definitiveRejection: true });
    expect(wire).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
  it("uses the existing browser token for real MCP reads and reviewed writes without GET, OAuth discovery, or fallback fetch", async () => {
    const { store, client, wire, events, fallback, http, authenticatedFetch } = await fixture();
    expect(await client.today()).toMatchObject({ summary: { completed: 0 } });
    const expected = taskReview((await store.today()).tasks.find(task => task.id === "morning-water")!);
    expect(await client.confirm({ taskId: "morning-water", response: "done", actor: "Forged name", requestId: "family-mcp-confirm-01", expected })).toMatchObject({ confirmation: { actor: "Maya", requestId: "family-mcp-confirm-01" } });
    expect(await client.brief()).toMatchObject({ generatedBy: "deterministic" });
    expect((await store.today()).summary.completed).toBe(1);
    expect(wire.filter(item => item.frame.method === "initialize").map(item => item.frame.params.clientInfo.name)).toEqual(Array(3).fill("kin-family-workspace"));
    expect(wire.filter(item => item.frame.method === "tools/call").map(item => item.frame.params.name)).toEqual(["show_today", "confirm_care_task", "show_weekly_brief"]);
    expect(wire.every(item => item.url === endpoint.href && item.method === "POST" && item.headers.get("authorization") === "Bearer synthetic-family-token")).toBe(true);
    expect(http.mock.calls.every(([url, init]) => url === endpoint.href && init?.method === "POST")).toBe(true);
    expect(authenticatedFetch.mock.calls.every(([url, init]) => url === endpoint.href && init?.method === "POST")).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(events.map(event => event.phase)).toEqual(["request", "result", "request", "result", "request", "result"]);
    expect(JSON.stringify(events)).not.toMatch(/synthetic-family-token|Forged|Maya|Bearer|kin\.example/);
  });
  it("rejects a locally closed session definitively before attempting any MCP request", async () => {
    const { auth, client, http, fallback } = await fixture();
    auth.disconnect();
    await expect(client.today()).rejects.toMatchObject({ status: 401, definitiveRejection: true });
    expect(http).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });
  it.each([
    { label: "wrong task", altered: { taskId: "different-task" } },
    { label: "missing task", altered: { taskId: undefined } },
    { label: "wrong response", altered: { response: "not_yet" } },
    { label: "missing response", altered: { response: undefined } },
  ])("rejects a same-ID receipt with $label before emitting success, then accepts the real replay", async ({ altered }) => {
      const { client, http, events, store } = await fixture();
      const original = http.getMockImplementation()!;
      http.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        const frame = JSON.parse(String(init?.body));
        if (frame.method !== "tools/call" || frame.params.name !== "confirm_care_task") return response;
        const stream = await response.text(), data = stream.split("\n").find(line => line.startsWith("data: "));
        expect(data).toBeDefined();
        const payload = JSON.parse(data!.slice(6));
        Object.assign(payload.result.structuredContent.confirmation, altered);
        return new Response(stream.replace(data!, `data: ${JSON.stringify(payload)}`), { status: response.status, headers: response.headers });
      });
      const input = { taskId: "morning-water", response: "done", actor: "Forged name", requestId: "family-mcp-receipt-01",
        expected: taskReview((await store.today()).tasks.find(task => task.id === "morning-water")!) };
      await expect(client.confirm(input)).rejects.toThrow("receipt mismatch");
      expect(events.map(event => event.phase)).toEqual(["request", "error"]);
      expect(events[1]).toMatchObject({ rpcId: events[0]!.rpcId, requestId: input.requestId, errorCode: "receipt_mismatch" });
      expect(events[1]).not.toHaveProperty("result");
      // The real write happened. Keep its identity available for an explicit retry, not a new write.
      expect((await store.today()).summary.completed).toBe(1);
      http.mockImplementation(original);
      expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId, taskId: input.taskId, response: input.response, actor: "Maya" } });
      expect((await store.today()).summary.completed).toBe(1);
      expect(events.map(event => event.phase)).toEqual(["request", "error", "request", "result"]);
    });
  it.each([401, 403])("passes HTTP %s to the caller without exposing response details or attempting login", async status => {
    const { client, http, fallback, auth } = await fixture();
    await client.today(); http.mockClear();
    http.mockResolvedValueOnce(Response.json({ error: "PRIVATE RESPONSE" }, { status, headers: { "www-authenticate": 'Bearer resource_metadata="https://foreign.example/metadata", error="insufficient_scope"' } }));
    let caught: any;
    try { await client.today(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ status, definitiveRejection: true });
    expect(String(caught)).not.toContain("PRIVATE RESPONSE");
    expect(http).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    expect(auth.connected).toBe(status !== 401);
  });
  it("performs actual tools/list and resources/read without placing names or resource contents in protocol traces", async () => {
    const { client, events, wire } = await fixture();
    const discovery = await client.listTools();
    expect(discovery.tools.map(tool => tool.name)).toContain("show_today");
    const resource = await client.readResource("ui://kin/today.html");
    expect(resource.contents[0]).toMatchObject({ uri: "ui://kin/today.html", mimeType: "text/html;profile=mcp-app" });
    expect(wire.filter(item => ["tools/list", "resources/read"].includes(String(item.frame.method))).map(item => item.frame.method)).toEqual(["tools/list", "resources/read"]);
    expect(events.map(event => [event.tool, event.phase])).toEqual([["tools/list", "request"], ["tools/list", "result"], ["resources/read", "request"], ["resources/read", "result"]]);
    expect(JSON.stringify(events)).not.toMatch(/ui:\/\/|<html|synthetic-family-token/);
  });
  it("rejects cross-origin or noncanonical MCP endpoints before any authenticated fetch", async () => {
    vi.stubGlobal("location", { origin });
    const authenticatedFetch = vi.fn();
    for (const url of ["https://foreign.example/mcp", `${origin}/api/today`, `${origin}/mcp?x=1`, `${origin}/mcp?`, `${origin}/mcp#`, `${origin}/mcp#other`, "https://name:password@kin.example/mcp"]) {
      expect(() => createMcpCareClient(new URL(url), { fetch: authenticatedFetch })).toThrow();
    }
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
