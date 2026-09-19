import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { desktopClientId, desktopRedirectUri } from "../src/desktop-auth-config.js";
import { createDesktopSession, desktopFetch, desktopResource } from "../scripts/lib/mcp-desktop-session.js";

const resource = new URL("https://desktop-session.example/mcp");
const verifier = "v".repeat(64);
function fixture() {
  let now = 1000;
  const redirect = vi.fn();
  const session = createDesktopSession(resource, redirect, () => now);
  const state = session.provider.state!() as string;
  const authorization = new URL("/auth", resource);
  authorization.search = new URLSearchParams({ client_id: desktopClientId, redirect_uri: desktopRedirectUri,
    response_type: "code", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: resource.href, scope: "mcp:tools mcp:resources", state }).toString();
  const callbackUrl = "/oauth/callback?" + new URLSearchParams({ state, iss: resource.origin, code: "synthetic-code" });
  const callback = { method: "GET", host: "127.0.0.1:43127", url: callbackUrl };
  session.provider.saveCodeVerifier(verifier);
  return { session, redirect, authorization, callback, state, advance: (value: number) => { now = value; },
    begin: () => session.provider.redirectToAuthorization(authorization) };
}

describe("independent desktop MCP session", () => {
  it("keeps a separate public identity and accepts one bound callback before saving in-memory tokens", async () => {
    const f = fixture();
    expect(f.session.provider.clientInformation()).toEqual({ client_id: "kin-desktop-acceptance", token_endpoint_auth_method: "none" });
    expect(f.session.provider.clientMetadata.grant_types).toEqual(["authorization_code"]);
    expect(f.session.provider.tokens()).toBeUndefined();
    f.begin();
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith(f.authorization);
    expect(f.session.acceptCallback(f.callback)).toBe("synthetic-code");
    expect(() => f.session.acceptCallback(f.callback)).toThrow("rejected");
    await f.session.provider.saveTokens({ access_token: "synthetic-access", token_type: "Bearer", scope: "mcp:tools mcp:resources" });
    expect(f.session.provider.tokens()).toMatchObject({ access_token: "synthetic-access" });
    f.session.dispose();
    expect(() => f.session.provider.tokens()).toThrow("rejected");
    expect(() => f.session.provider.codeVerifier()).toThrow("rejected");
  });
  it.each([
    { method: "POST" }, { host: "attacker.example:43127" }, { host: "127.0.0.1:43128" },
    { origin: "https://attacker.example" }, { url: "/other?code=synthetic-code" },
  ])("rejects callback origin, port, method and path changes: %j", change => {
    const f = fixture(); f.begin();
    expect(() => f.session.acceptCallback({ ...f.callback, ...change })).toThrow("rejected");
    expect(f.session.acceptCallback(f.callback)).toBe("synthetic-code");
  });
  it.each(["state", "iss", "code"])("rejects absent, replaced and duplicate %s before accepting a valid callback", key => {
    for (const operation of ["delete", "replace", "duplicate"]) {
      const f = fixture(); f.begin();
      const url = new URL(f.callback.url, desktopRedirectUri);
      if (operation === "delete") url.searchParams.delete(key);
      if (operation === "replace") url.searchParams.set(key, key === "code" ? "<script>" : "wrong-value");
      if (operation === "duplicate") url.searchParams.append(key, url.searchParams.get(key)!);
      expect(() => f.session.acceptCallback({ ...f.callback, url: url.pathname + url.search })).toThrow("rejected");
      expect(f.session.acceptCallback(f.callback)).toBe("synthetic-code");
    }
  });
  it("rejects unsolicited, oversized, unknown-query and fragment callbacks without consuming the valid one", () => {
    const f = fixture();
    expect(() => f.session.acceptCallback(f.callback)).toThrow("rejected");
    f.begin();
    for (const suffix of ["&other=1", "#fragment", "&code=" + "x".repeat(4096), "&error=access_denied"]) {
      expect(() => f.session.acceptCallback({ ...f.callback, url: f.callback.url + suffix })).toThrow("rejected");
    }
    expect(f.session.acceptCallback(f.callback)).toBe("synthetic-code");
  });
  it("consumes a validated refusal without accepting a subsequent code", () => {
    const f = fixture(); f.begin();
    const url = new URL(f.callback.url, desktopRedirectUri);
    url.searchParams.delete("code"); url.searchParams.set("error", "access_denied");
    expect(() => f.session.acceptCallback({ ...f.callback, url: url.pathname + url.search })).toThrow("declined");
    expect(() => f.session.acceptCallback(f.callback)).toThrow("rejected");
    expect(f.session.provider.tokens()).toBeUndefined();
  });
  it("expires at ten minutes and cannot acquire or use tokens after disposal", () => {
    const f = fixture(); f.begin(); f.advance(601_000);
    expect(() => f.session.acceptCallback(f.callback)).toThrow("rejected");
    expect(() => f.session.provider.codeVerifier()).toThrow("rejected");
    const early = fixture(); early.begin(); early.advance(600_999);
    expect(early.session.acceptCallback(early.callback)).toBe("synthetic-code");
  });
  it("refuses pre-callback tokens, refresh tokens, service scope and non-bearer grants", () => {
    const f = fixture();
    const token = { access_token: "synthetic-access", token_type: "Bearer", scope: "mcp:tools" };
    expect(() => f.session.provider.saveTokens(token)).toThrow("rejected");
    f.begin(); f.session.acceptCallback(f.callback);
    for (const change of [{ refresh_token: "synthetic-refresh" }, { scope: "mcp:service" }, { scope: "" },
      { token_type: "Basic" }, { access_token: "" }]) {
      expect(() => f.session.provider.saveTokens({ ...token, ...change })).toThrow("rejected");
      expect(f.session.provider.tokens()).toBeUndefined();
    }
  });
  it.each(["client_id", "redirect_uri", "resource", "state", "scope", "code_challenge_method", "code_challenge", "response_type"])(
    "refuses an authorization redirect with changed %s", key => {
      const f = fixture(); f.authorization.searchParams.set(key, "wrong-value");
      expect(f.begin).toThrow("rejected"); expect(f.redirect).not.toHaveBeenCalled();
    });
  it("rejects foreign authorization destinations and a second sign-in within one session", () => {
    const f = fixture();
    const foreign = new URL(f.authorization); foreign.hostname = "attacker.example";
    expect(() => f.session.provider.redirectToAuthorization(foreign)).toThrow("rejected");
    f.begin();
    expect(f.begin).toThrow("rejected");
    expect(() => f.session.provider.saveCodeVerifier("w".repeat(64))).toThrow("rejected");
  });
});

describe("desktop network boundary", () => {
  it.each(["http://host/mcp", "https://u:p@host/mcp", "https://host/mcp?token=x", "https://host/mcp#x", "https://host/other"])(
    "rejects resource %s", value => { expect(() => desktopResource(value)).toThrow(); });
  it("pins normal protocol requests and disables redirects with a bounded timeout", async () => {
    const network = vi.fn().mockResolvedValue(new Response("{}"));
    const fetch = desktopFetch(resource, network);
    for (const [method, path] of [["POST", "/mcp"], ["GET", "/mcp"], ["POST", "/token"],
      ["GET", "/.well-known/oauth-protected-resource"], ["GET", "/.well-known/oauth-authorization-server"]]) {
      await fetch(new URL(path!, resource), { method });
      expect(network.mock.lastCall![1]).toMatchObject({ method, redirect: "error" });
      expect(network.mock.lastCall![1].signal).toBeInstanceOf(AbortSignal);
    }
  });
  it.each(["https://attacker.example/token", "http://desktop-session.example/mcp", "https://u:p@desktop-session.example/token",
    "https://desktop-session.example/token?secret=x", "https://desktop-session.example/token#x", "https://desktop-session.example/register",
    "https://desktop-session.example/api/tasks"])("rejects network escape %s before transmission", async value => {
      const network = vi.fn();
      await expect(desktopFetch(resource, network)(new URL(value), { method: "POST" })).rejects.toThrow("rejected");
      expect(network).not.toHaveBeenCalled();
    });
});
