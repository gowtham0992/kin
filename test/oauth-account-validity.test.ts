import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createConfiguredOAuthApp } from "../src/oauth-lambda.js";
import type { OAuthSecrets } from "../src/oauth-secrets.js";

const issuer = "https://account-validity.example", resource = `${issuer}/mcp`;
const browser = { id: "kin-family-browser", redirect: `${issuer}/invite.html` };
const alexa = { id: "synthetic-alexa-client", redirect: "https://alexa.example/callback", secret: "synthetic-client-secret" };
const verifier = "v".repeat(43), instant = Date.parse("2026-09-11T20:00:00.789Z");

describe("current account authority on OAuth sessions and grants", () => {
  let secrets: OAuthSecrets, publicKey: CryptoKey;
  const servers: Server[] = [];
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true }); publicKey = pair.publicKey;
    secrets = { schemaVersion: 1, jwks: { keys: [{ ...await exportJWK(pair.privateKey), kty: "RSA", alg: "RS256", use: "sig", kid: "account-validity-test" }] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)], csrfSecret: "c".repeat(32),
      serviceClient: { clientId: "synthetic-service-client", clientSecret: "synthetic-service-secret" },
      userClient: { clientId: alexa.id, clientSecret: alexa.secret } };
  });
  afterEach(async () => {
    try {
      await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
        server.closeAllConnections();
      })));
    } finally { vi.useRealTimers(); }
  });

  async function fixture(client = browser) {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(instant);
    const rows = new Map<string, Record<string, any>>();
    class Adapter {
      constructor(private model: string) {}
      async upsert(id: string, value: Record<string, unknown>) { rows.set(`${this.model}:${id}`, structuredClone(value)); }
      async find(id: string) { return structuredClone(rows.get(`${this.model}:${id}`)); }
      async findByUid(uid: string) { return [...rows.entries()].find(([key, row]) => key.startsWith(`${this.model}:`) && row.uid === uid)?.[1]; }
      async destroy(id: string) { rows.delete(`${this.model}:${id}`); }
      async consume(id: string) { const row = rows.get(`${this.model}:${id}`)!; if (row.consumed) throw new Error("Synthetic replay"); row.consumed = Math.floor(Date.now() / 1000); }
      async revokeByGrantId(id: string) { for (const [key, row] of rows) if (row.grantId === id) rows.delete(key); }
    }
    const state = { enabled: true, modifiedAt: instant - 100, unavailable: false };
    const authenticate = vi.fn(async () => ({ accountId: "synthetic-account", username: "synthetic@example.com", authenticatedAt: Date.now() }));
    const find = vi.fn(async (accountId: string) => {
      if (state.unavailable) throw new Error("Synthetic account directory unavailable");
      return state.enabled ? { accountId, modifiedAt: state.modifiedAt } : undefined;
    });
    // The previous runtime ignores accountStatus, so the denial cases exercise
    // the real unsafe provider path before the fix, rather than failing on import.
    const dependencies = { secrets, adapter: Adapter, authenticator: { authenticate }, accountStatus: { find } };
    const app = await createConfiguredOAuthApp({ KIN_OAUTH_ISSUER: issuer, KIN_MCP_RESOURCE_URI: resource,
      KIN_OAUTH_STATE_TABLE: "synthetic-state", KIN_COGNITO_CLIENT_ID: "synthetic-client", KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_OAUTH_SECRET_ID: "synthetic-secret", KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: browser.id,
      KIN_BROWSER_REDIRECT_URI: browser.redirect, KIN_ALEXA_REDIRECT_URIS: alexa.redirect }, dependencies);
    // Supertest(app) binds a wildcard listener but always connects to IPv4.
    // Bind that same address explicitly so a separate IPv4-only service cannot
    // own the selected port on platforms with distinct wildcard port binding.
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("Expected an owned IPv4 loopback listener");
    const http = request(server);
    const cookies = new Map<string, string>();
    async function visit(location: string, body?: Record<string, string>) {
      const url = new URL(location, issuer); expect(url.origin).toBe(issuer);
      const req = body ? http.post(url.pathname + url.search).type("form").send(body) : http.get(url.pathname + url.search);
      req.set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https");
      if (cookies.size) req.set("Cookie", [...cookies.values()].join("; "));
      const response = await req;
      for (const cookie of response.headers["set-cookie"] ?? []) { const value = cookie.split(";")[0]!; cookies.set(value.split("=")[0]!, value); }
      return response;
    }
    async function authorize(prompt = "login consent") {
      const params = new URLSearchParams({ client_id: client.id, redirect_uri: client.redirect, response_type: "code", resource,
        scope: "mcp:tools mcp:resources", state: "synthetic-state", prompt,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      let response = await visit(`/auth?${params}`);
      for (let step = 0; step < 12; step++) {
        const location = response.headers.location;
        if (location && new URL(location, issuer).href.startsWith(`${client.redirect}?`)) return new URL(location, issuer);
        if (location) { response = await visit(location); continue; }
        expect(response.status).toBe(200);
        const action = response.text.match(/<form[^>]+action="([^"]+)"/)?.[1];
        const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
        expect(action).toBeTruthy(); expect(csrf).toBeTruthy();
        response = await visit(action!, { csrf: csrf!, ...(action!.endsWith("/login")
          ? { username: "synthetic@example.com", password: "synthetic-password", ts: "9999999999" } : {}) });
      }
      throw new Error("Synthetic authorization exceeded redirect bound");
    }
    function token(body: Record<string, string>) {
      const req = http.post("/token").set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https").type("form");
      if (client.id === alexa.id) req.auth(alexa.id, alexa.secret);
      return req.send({ client_id: client.id, resource, ...body });
    }
    const exchange = (callback: URL) => token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: client.redirect, code_verifier: verifier });
    return { state, rows, find, authenticate, authorize, exchange, token };
  }

  it("preserves fractional authentication time through authorization code and configured refresh, ignoring form timestamps", async () => {
    const f = await fixture(alexa);
    const callback = await f.authorize();
    expect([...f.rows.entries()].find(([key]) => key.startsWith("AuthorizationCode:"))?.[1].authTime).toBe(instant / 1000);
    const first = await f.exchange(callback); expect(first.status).toBe(200);
    expect((await jwtVerify(first.body.access_token, publicKey, { issuer, audience: resource })).payload.sub).toBe("synthetic-account");
    expect([...f.rows.entries()].find(([key]) => key.startsWith("RefreshToken:"))?.[1].authTime).toBe(instant / 1000);
    const refreshed = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
    expect(refreshed.status).toBe(200); expect(refreshed.body.access_token).toBeTruthy();
  });

  it("denies silent authorization after account disable instead of trusting the old provider cookie", async () => {
    const f = await fixture(); expect((await f.exchange(await f.authorize())).status).toBe(200);
    f.state.enabled = false;
    const callback = await f.authorize("none");
    expect(callback.searchParams.get("error")).toBe("login_required"); expect(callback.searchParams.has("code")).toBe(false);
    expect(f.authenticate).toHaveBeenCalledTimes(1);
  });

  it("invalidates pre-change sessions within the same second and allows a clean fresh login without a loop", async () => {
    const f = await fixture(); expect((await f.exchange(await f.authorize())).status).toBe(200);
    vi.setSystemTime(instant + 100); f.state.modifiedAt = instant + 50;
    expect((await f.authorize("none")).searchParams.get("error")).toBe("login_required");
    const fresh = await f.exchange(await f.authorize()); expect(fresh.status).toBe(200);
    expect(f.authenticate).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "changed", "missing-authentication"])("rejects a previously issued code when %s before exchange", async reason => {
    const f = await fixture(); const callback = await f.authorize();
    if (reason === "disabled") f.state.enabled = false;
    if (reason === "changed") { vi.setSystemTime(instant + 100); f.state.modifiedAt = instant + 50; }
    if (reason === "missing-authentication") for (const [key, row] of f.rows) if (key.startsWith("AuthorizationCode:")) delete row.authTime;
    const response = await f.exchange(callback);
    expect(response.status).toBe(400); expect(response.body.error).toBe("invalid_grant"); expect(response.body.access_token).toBeUndefined();
  });

  it.each(["disabled", "changed"])("rejects configured refresh issuance when the account is %s", async reason => {
    const f = await fixture(alexa); const first = await f.exchange(await f.authorize()); expect(first.status).toBe(200);
    if (reason === "disabled") f.state.enabled = false;
    else { vi.setSystemTime(instant + 100); f.state.modifiedAt = instant + 50; }
    const response = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
    expect(response.status).toBe(400); expect(response.body.error).toBe("invalid_grant"); expect(response.body.access_token).toBeUndefined();
  });

  it("fails closed on account-directory failure without minting a token or exposing provider details", async () => {
    const f = await fixture(); const callback = await f.authorize(); f.state.unavailable = true;
    const response = await f.exchange(callback);
    expect(response.status).toBe(500); expect(response.body.access_token).toBeUndefined();
    expect(response.text).not.toContain("Synthetic account directory unavailable");
  });
});
