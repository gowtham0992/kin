import { describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { browserAuthConfig } from "../src/browser-auth-config.js";
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);
const origin = "https://kin.example";
const config = { clientId: "kin-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp` };
function fixture() {
  const data = new Map<string, string>();
  const storage = { setItem: (k: string, v: string) => data.set(k,v), getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => data.delete(k) };
  let clock = 1000000;
  let random = 0;
  const request = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" }));
  const auth = createBrowserAuth({ config, origin, storage, request, now: () => clock,
    cryptoApi: { subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(++random) } });
  const callback = async (view?: unknown) => { const url = new URL(await auth.start(view)); return `${config.redirectUri}?code=synthetic-code&iss=${encodeURIComponent(origin)}&state=${url.searchParams.get("state")}`; };
  return { auth, data, request, callback, advance: (ms: number) => { clock += ms; } };
}

describe("family browser authorization", () => {
  it.each(["ask", "today", "plan", "circle", "week", "invite", "access"])("restores only the selected %s view after successful authorization", async view => {
    const { auth, data, callback } = fixture();
    const url = await callback(view);
    expect(auth.returnView).toBe(null);
    expect(JSON.parse(data.get("kin.browser-login")!).returnView).toBe(view);
    expect(new URL(url).searchParams.has("returnView")).toBe(false);
    await expect(auth.complete(url)).resolves.toBe(true);
    expect(auth.returnView).toBe(view);
    expect(data.size).toBe(0);
  });
  it.each([undefined, null, "", "https://foreign.example", "//foreign.example", "/auth", "#ask", "ask?next=https://foreign.example", "ask/../access", "%61sk", "ASK", ["ask"], { view: "ask" }].map(view => ({ view })))("falls back to today for an invalid entry view: $view", async ({ view }) => {
    const { auth, data, callback } = fixture();
    const url = await callback(view);
    expect(JSON.parse(data.get("kin.browser-login")!).returnView).toBe("today");
    await auth.complete(url);
    expect(auth.returnView).toBe("today");
  });
  it.each([undefined, "https://foreign.example", "//foreign.example", "#ask", "ask?next=other", ["ask"], { view: "ask" }].map(returnView => ({ returnView })))("does not trust an old or altered pending return view: $returnView", async ({ returnView }) => {
    const { auth, data, callback } = fixture();
    const url = await callback("ask");
    const pending = JSON.parse(data.get("kin.browser-login")!);
    data.set("kin.browser-login", JSON.stringify({ ...pending, returnView }));
    await expect(auth.complete(url)).resolves.toBe(true);
    expect(auth.returnView).toBe("today");
  });
  it("does not expose a return view before the token exchange succeeds", async () => {
    const { auth, callback, request } = fixture();
    const url = await callback("ask");
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exchange = auth.complete(url);
    expect(auth.returnView).toBe(null);
    finish(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(exchange).rejects.toThrow();
    expect(auth.returnView).toBe(null);
  });
  it.each(["disconnect", "suspend"])("clears the completed return view on %s", async method => {
    const { auth, callback } = fixture();
    await auth.complete(await callback("ask"));
    auth[method]();
    expect(auth.returnView).toBe(null);
  });
  it("clears the completed return view when another callback fails validation", async () => {
    const { auth, callback } = fixture();
    const url = await callback("ask");
    await auth.complete(url);
    await expect(auth.complete(url)).rejects.toThrow();
    expect(auth.returnView).toBe(null);
  });
  it("does not restore a view when its token response arrives after a newer sign-in starts", async () => {
    const { auth, callback, request } = fixture();
    const url = await callback("ask");
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exchange = auth.complete(url);
    const next = await callback("week");
    await auth.complete(next);
    finish(Response.json({ access_token: "stale-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" }));
    await expect(exchange).rejects.toThrow();
    expect(auth.returnView).toBe("week");
    expect(auth.connected).toBe(true);
  });
  it("does not recreate a pending attempt when a digest finishes after disconnect", async () => {
    const data = new Map<string, string>();
    let finish!: (value: ArrayBuffer) => void;
    const auth = createBrowserAuth({ config, origin,
      storage: { setItem: (key: string, value: string) => data.set(key, value), getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => data.delete(key) },
      cryptoApi: { getRandomValues: (array: Uint8Array) => array.fill(1), subtle: { digest: () => new Promise(resolve => { finish = resolve; }) } },
    });
    const attempt = auth.start("ask");
    auth.disconnect();
    finish(new Uint8Array(32).buffer);
    await expect(attempt).rejects.toThrow();
    expect(data.size).toBe(0);
    expect(auth.returnView).toBe(null);
  });
  it("requests login and connection review on every sign-in so returning accounts can enter an invitation", async () => {
    const { auth, callback } = fixture();
    const firstCallback = await callback();
    await auth.complete(firstCallback);
    expect(auth.connected).toBe(true);
    const next = new URL(await auth.start());
    expect(new Set(next.searchParams.get("prompt")?.split(" "))).toEqual(new Set(["login", "consent"]));
    expect(auth.connected).toBe(false);
    expect(next.searchParams.get("state")).not.toBe(new URL(firstCallback).searchParams.get("state"));
  });
  it("uses an S256 challenge and never stores the returned bearer token", async () => {
    const { auth, data, callback, request } = fixture();
    const url = await callback();
    const pending = JSON.parse([...data.values()][0]!);
    expect(pending.verifier).toHaveLength(43);
    await auth.complete(url);
    expect(auth.connected).toBe(true);
    expect(data.size).toBe(0);
    expect(request.mock.calls[0]![1].body).toContain(`code_verifier=${pending.verifier}`);
    const next = new URL(await auth.start());
    const nextPending = JSON.parse([...data.values()][0]!);
    expect(next.searchParams.get("code_challenge")).toBe(createHash("sha256").update(nextPending.verifier).digest("base64url"));
    expect(next.searchParams.get("code_challenge_method")).toBe("S256");
    expect(next.searchParams.has("client_secret")).toBe(false);
  });
  it.each(["state=foreign", "iss=https://foreign.example", "code=one&code=two", "error=access_denied"])("rejects altered callback %s without a token request", async alteration => {
    const { auth, callback, request } = fixture();
    const url = new URL(await callback());
    const changed = new URLSearchParams(alteration);
    for (const key of new Set(changed.keys())) { url.searchParams.delete(key); for (const value of changed.getAll(key)) url.searchParams.append(key,value); }
    await expect(auth.complete(url.href)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects expired attempts and consumed callbacks", async () => {
    const stale = fixture();
    const url = await stale.callback(); stale.advance(600001);
    await expect(stale.auth.complete(url)).rejects.toThrow();
    expect(stale.request).not.toHaveBeenCalled();
    const fresh = fixture(); const valid = await fresh.callback();
    await fresh.auth.complete(valid);
    await expect(fresh.auth.complete(valid)).rejects.toThrow();
    expect(fresh.request).toHaveBeenCalledTimes(1);
  });
  it("sends tokens only to same-origin API paths and rejects expired or closed sessions", async () => {
    const { auth, callback, request, advance } = fixture();
    await auth.complete(await callback()); request.mockClear();
    await auth.request("/api/invitations/options");
    expect(new Headers(request.mock.calls[0]![1].headers).get("authorization")).toBe("Bearer synthetic-token");
    await expect(auth.request("https://foreign.example/api/steal")).rejects.toThrow();
    await expect(auth.request("/token")).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    advance(3600001);
    await expect(auth.request("/api/invitations/options")).rejects.toThrow();
    auth.disconnect(); expect(auth.connected).toBe(false);
  });
  it("sends the browser token only to the exact MCP resource for POST or DELETE", async () => {
    const { auth, callback, request } = fixture();
    await auth.complete(await callback()); request.mockClear();
    for (const method of ["POST", "DELETE"]) await auth.request(config.resource, { method, redirect: "follow", credentials: "include", headers: { authorization: "Bearer wrong", "mcp-protocol-version": "2025-11-25" } });
    expect(request.mock.calls).toHaveLength(2);
    for (const [url, init] of request.mock.calls) {
      expect(url).toBe(config.resource);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-token");
      expect(new Headers(init.headers).get("mcp-protocol-version")).toBe("2025-11-25");
    }
  });
  it("rejects MCP endpoint variations and discovery methods before attaching a token", async () => {
    const { auth, callback, request } = fixture();
    await auth.complete(await callback()); request.mockClear();
    for (const path of ["/mcp/", "/mcp?resource=other", "/mcp?", "/mcp#fragment", "/mcp#", "https://foreign.example/mcp", "https://name:password@kin.example/mcp", "/.well-known/oauth-protected-resource", "/auth", "/token"]) {
      await expect(auth.request(path, { method: "POST" })).rejects.toThrow();
    }
    for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) await expect(auth.request("/mcp", { method })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([401, 403])("passes MCP HTTP %s through without automatic login and clears only invalid authentication", async status => {
    const { auth, callback, request } = fixture();
    await auth.complete(await callback()); request.mockClear();
    const denied = Response.json({ error: "denied" }, { status });
    request.mockResolvedValueOnce(denied);
    expect(await auth.request("/mcp", { method: "POST" })).toBe(denied);
    expect(auth.connected).toBe(status !== 401);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not restore access when a token response arrives after closing the session", async () => {
    const { auth, callback, request } = fixture();
    const url = await callback();
    let finish!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const exchange = auth.complete(url);
    auth.disconnect();
    finish(Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" }));
    await expect(exchange).rejects.toThrow();
    expect(auth.connected).toBe(false);
  });
  it("clears page access without destroying an outgoing PKCE attempt", async () => {
    const { auth, data, callback } = fixture();
    const url = await callback();
    auth.suspend();
    expect(data.size).toBe(1);
    await auth.complete(url);
    auth.suspend();
    expect(auth.connected).toBe(false);
  });
  it.each(["http://kin.example/invite.html", "https://other.example/invite.html", `${origin}/invite.html?next=other`])("rejects unsafe registered redirect %s", redirectUri => {
    expect(() => browserAuthConfig({ ...config, redirectUri })).toThrow();
  });
});
