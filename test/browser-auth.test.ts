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
  const callback = async () => { const url = new URL(await auth.start()); return `${config.redirectUri}?code=synthetic-code&iss=${encodeURIComponent(origin)}&state=${url.searchParams.get("state")}`; };
  return { auth, data, request, callback, advance: (ms: number) => { clock += ms; } };
}

describe("family browser authorization", () => {
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
