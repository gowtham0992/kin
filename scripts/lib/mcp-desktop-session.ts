import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { desktopClientId, desktopRedirectUri } from "../../src/desktop-auth-config.js";

const callback = new URL(desktopRedirectUri);
const lifetimeMs = 10 * 60 * 1000;
const scopes = "mcp:tools mcp:resources";
const invalid = () => new Error("Desktop authorization was rejected. Start a fresh acceptance session.");

export function desktopResource(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Provide the deployed HTTPS /mcp URL without credentials, query, or fragment.");
  }
  return url;
}

/** No browser-session credentials, disk token cache, refresh grant or DCR. */
export function createDesktopSession(resource: URL, onAuthorize: (url: URL) => void, now = Date.now) {
  desktopResource(resource.href);
  const issuer = resource.origin;
  const state = randomBytes(32).toString("base64url");
  const deadline = now() + lifetimeMs;
  let tokens: OAuthTokens | undefined, verifier: string | undefined;
  let redirected = false, consumed = false, disposed = false;
  const active = () => { if (disposed || now() >= deadline) throw invalid(); };
  const provider: OAuthClientProvider = {
    redirectUrl: desktopRedirectUri,
    clientMetadata: { client_name: "Kin desktop acceptance", redirect_uris: [desktopRedirectUri],
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: scopes },
    clientInformation: () => ({ client_id: desktopClientId, token_endpoint_auth_method: "none" }),
    state: () => { active(); return state; },
    tokens: () => { active(); return tokens; },
    saveTokens: value => {
      active();
      if (!consumed || value.refresh_token || !value.access_token || value.token_type.toLowerCase() !== "bearer" ||
          !value.scope || value.scope.split(/\s+/).some(scope => !scopes.split(" ").includes(scope))) throw invalid();
      tokens = value;
    },
    saveCodeVerifier: value => {
      active();
      if (redirected || !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) throw invalid();
      verifier = value;
    },
    codeVerifier: () => { active(); if (!verifier) throw invalid(); return verifier; },
    redirectToAuthorization: url => {
      active();
      const p = url.searchParams;
      if (redirected || !verifier || url.origin !== issuer || url.pathname !== "/auth" || url.username || url.password || url.hash ||
          p.get("client_id") !== desktopClientId || p.get("redirect_uri") !== desktopRedirectUri ||
          p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" ||
          p.get("code_challenge") !== createHash("sha256").update(verifier).digest("base64url") ||
          p.get("resource") !== resource.href || p.get("scope") !== scopes || p.get("state") !== state ||
          [...p.keys()].some(key => p.getAll(key).length !== 1)) throw invalid();
      redirected = true;
      onAuthorize(new URL(url));
    },
  };
  return {
    provider,
    acceptCallback(request: { method?: string; host?: string; url?: string; origin?: string }): string {
      active();
      if (!redirected || consumed || request.method !== "GET" || request.host !== callback.host || request.origin ||
          !request.url?.startsWith("/oauth/callback?") || request.url.length > 4096) throw invalid();
      const url = new URL(request.url, callback.origin), p = url.searchParams;
      const suppliedState = p.get("state") ?? "";
      const expected = Buffer.from(state), supplied = Buffer.from(suppliedState);
      if (url.origin !== callback.origin || url.pathname !== callback.pathname || url.hash ||
          supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || p.get("iss") !== issuer ||
          [...p.keys()].some(key => !["state", "iss", "code", "error", "error_description"].includes(key) || p.getAll(key).length !== 1) ||
          (p.has("error") && p.has("code"))) throw invalid();
      if (p.has("error")) { consumed = true; throw new Error("Desktop authorization was declined. No care records were read."); }
      const code = p.get("code");
      if (!code || !/^[A-Za-z0-9._~-]{1,1024}$/.test(code)) throw invalid();
      consumed = true;
      return code;
    },
    dispose() { disposed = true; tokens = undefined; verifier = undefined; },
  };
}

/** Pin metadata, token exchange and MCP traffic to the operator's chosen issuer. */
export function desktopFetch(resource: URL, network: FetchLike = fetch): FetchLike {
  desktopResource(resource.href);
  return async (input, init) => {
    const url = new URL(input), method = init?.method ?? "GET";
    const permitted = (url.pathname === "/mcp" && ["GET", "POST", "DELETE"].includes(method)) ||
      (method === "POST" && url.pathname === "/token") ||
      (method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(url.pathname));
    if (url.origin !== resource.origin || url.username || url.password || url.search || url.hash || !permitted) throw invalid();
    return network(url, { ...init, redirect: "error", signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  };
}
