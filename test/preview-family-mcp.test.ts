import express from "express";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMcpCareClient } from "../simulator/mcp-client.js";

const token = "Bearer synthetic-family-mcp-maya";
let server: Server, origin: string, script: string;
const addedSignals: Array<["SIGINT" | "SIGTERM", (...args: any[]) => void]> = [];

beforeAll(async () => {
  // Import the real CLI fixture without opening its fixed preview port. The
  // test owns one ephemeral loopback listener; no AWS or real accounts exist.
  let app!: express.Application;
  const signals = new Map((["SIGINT", "SIGTERM"] as const).map(signal => [signal, new Set(process.listeners(signal))]));
  const argv = process.argv;
  const listen = vi.spyOn(express.application, "listen").mockImplementation(function (this: express.Application) {
    app = this;
    return createServer();
  });
  try {
    process.argv = [process.execPath, "preview-invitations.ts", "mcp-family", "3043"];
    await import("../scripts/preview-invitations.js");
  } finally {
    process.argv = argv;
    listen.mockRestore();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) if (!signals.get(signal)!.has(listener)) addedSignals.push([signal, listener]);
    }
  }
  server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${origin}/synthetic-family-mcp.js`);
  expect(response.status).toBe(200);
  script = await response.text();
});

afterAll(async () => {
  for (const [signal, listener] of addedSignals) process.removeListener(signal, listener);
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
});

async function proxy(request: typeof fetch) {
  let options!: { request: typeof fetch };
  const elements = new Map<string, { hidden: boolean; textContent: string; listeners: Map<string, () => void>; addEventListener: (name: string, action: () => void) => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const listeners = new Map<string, () => void>();
      elements.set(id, { hidden: false, textContent: "", listeners, addEventListener: (name, action) => { listeners.set(name, action); } });
    }
    return elements.get(id)!;
  };
  // Execute only the known fixture module returned by our own local listener.
  // The workspace dependency is the boundary stub; its request proxy is real.
  const fixtureModule = script.replace("import { createWorkspace } from '/workspace.js';", "");
  await runInNewContext(`(async () => { ${fixtureModule}\n })()`, {
    createWorkspace(value: typeof options) { options = value; return { async open() {}, reset() {} }; },
    document: { getElementById: element }, location: { origin }, URL, Headers, Response, fetch: request,
  });
  return { request: options.request, close: () => element("browser-disconnect").listeners.get("click")!() };
}

describe("synthetic family MCP preview boundary", () => {
  it("accepts the actual local browser Origin and requires the synthetic bearer for real MCP reads", async () => {
    const care = createMcpCareClient(new URL("/mcp", origin), { fetch: (url, init = {}) => fetch(url, {
      ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin, authorization: token },
    }) });
    expect(await care.today()).toMatchObject({ summary: { total: 2, completed: 0 } });
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-fixture", version: "1" },
    } });
    const send = (authorization: string, suppliedOrigin = origin) => fetch(`${origin}/mcp`, {
      method: "POST", headers: { authorization, origin: suppliedOrigin, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: frame,
    });
    expect((await send("")).status).toBe(401);
    expect((await send("Bearer wrong-synthetic-account")).status).toBe(401);
    expect((await send(token, "https://foreign.synthetic.test")).status).toBe(403);
    expect((await fetch(`${origin}/api/session`)).status).toBe(401);
  });

  it("advertises MCP only in the explicit account proxy, not fake OAuth metadata", async () => {
    expect((await fetch(`${origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
    const raw = await fetch(`${origin}/api/session`, { headers: { authorization: token } });
    expect(await raw.json()).not.toHaveProperty("mcpConversation");
    const fixture = await proxy(fetch);
    const transformed = await fixture.request("/api/session");
    expect(await transformed.json()).toMatchObject({ name: "Maya", memberId: "maya", mcpConversation: true });
  });

  it("adds the fixture capability to successful sessions while retaining meaningful response metadata", async () => {
    const fixture = await proxy(async () => new Response(JSON.stringify({ name: "Maya", permissions: { confirm: true } }), {
      status: 200, statusText: "Synthetic OK", headers: { "content-type": "application/json", "cache-control": "no-store", "content-length": "1", etag: "old-body", "x-fixture": "kept" },
    }));
    const response = await fixture.request("/api/session");
    expect(await response.json()).toEqual({ name: "Maya", permissions: { confirm: true }, mcpConversation: true });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("Synthetic OK");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-fixture")).toBe("kept");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
  });

  it.each([401, 403])("does not add capability or consume a denied %s session response", async status => {
    const original = new Response(JSON.stringify({ error: "synthetic_denied" }), { status });
    const fixture = await proxy(async () => original);
    const response = await fixture.request("/api/session");
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ error: "synthetic_denied" });
  });

  it("does not transform other successful API responses", async () => {
    const original = new Response(JSON.stringify({ tasks: [] }));
    const fixture = await proxy(async () => original);
    expect(await fixture.request("/api/today")).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it("rejects a session that finishes parsing after its synthetic account was closed", async () => {
    let release!: (value: unknown) => void;
    const original = new Response("{}");
    vi.spyOn(original, "json").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const fixture = await proxy(async () => original);
    const pending = fixture.request("/api/session");
    // Let fetch resolve; parsing remains held by the explicit deferred value.
    await new Promise<void>(resolve => setImmediate(resolve));
    fixture.close();
    release?.({ name: "Maya" });
    await expect(pending).rejects.toMatchObject({ stale: true });
  });
});
