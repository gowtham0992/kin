import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createConfiguredOAuthApp } from "../src/oauth-lambda.js";
import { createKinOAuthProvider } from "../src/oauth-provider.js";
import type { OAuthSecrets } from "../src/oauth-secrets.js";

const issuer = "https://desktop-auth.example", resource = `${issuer}/mcp`;
const clientId = "kin-desktop-acceptance", redirectUri = "http://127.0.0.1:43127/oauth/callback";
const verifier = "synthetic-desktop-pkce-verifier-long-enough-for-rfc7636";
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("optional independent desktop OAuth client", () => {
  let secrets: OAuthSecrets, publicKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true }); publicKey = pair.publicKey;
    secrets = { schemaVersion: 1, jwks: { keys: [{ ...await exportJWK(pair.privateKey), kty: "RSA", kid: "synthetic-desktop-key", use: "sig", alg: "RS256" }] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)], csrfSecret: "c".repeat(32),
      serviceClient: { clientId: "synthetic-service-client", clientSecret: "d".repeat(32) },
      userClient: { clientId: "synthetic-alexa-client", clientSecret: "e".repeat(32) } };
  });
  async function fixture(enabled: string | null = "true") {
    const records = new Map<string, Record<string, any>>();
    class Adapter {
      constructor(private model: string) {}
      async upsert(id: string, payload: Record<string, unknown>) { records.set(`${this.model}:${id}`, structuredClone(payload)); }
      async find(id: string) { return structuredClone(records.get(`${this.model}:${id}`)); }
      async findByUid(uid: string) { return [...records.entries()].find(([key, row]) => key.startsWith(`${this.model}:`) && row.uid === uid)?.[1]; }
      async destroy(id: string) { records.delete(`${this.model}:${id}`); }
      async consume(id: string) { records.get(`${this.model}:${id}`)!.consumed = Math.floor(Date.now() / 1000); }
      async revokeByGrantId(id: string) { for (const [key, row] of records) if (row.grantId === id) records.delete(key); }
    }
    const app = await createConfiguredOAuthApp({ KIN_OAUTH_ISSUER: issuer, KIN_MCP_RESOURCE_URI: resource,
      KIN_OAUTH_STATE_TABLE: "synthetic-state", KIN_COGNITO_CLIENT_ID: "synthetic-cognito-client", KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_OAUTH_SECRET_ID: "synthetic-secret", KIN_DESKTOP_AUTH_ENABLED: enabled ?? undefined,
      KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: "kin-family-browser", KIN_BROWSER_REDIRECT_URI: `${issuer}/invite.html`,
    }, { secrets, adapter: Adapter,
      authenticator: { authenticate: async () => ({ accountId: "synthetic-family-account", username: "synthetic@example.test" }) },
      accountStatus: { find: async accountId => ({ accountId, modifiedAt: 1 }) },
    });
    const cookies = new Map<string, string>();
    async function visit(path: string, form?: Record<string, string>) {
      const url = new URL(path, issuer); expect(url.origin).toBe(issuer);
      const req = form ? request(app).post(url.pathname + url.search).type("form").send(form) : request(app).get(url.pathname + url.search);
      const response = await req.set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https").set("Cookie", [...cookies.values()].join("; "));
      for (const header of response.headers["set-cookie"] ?? []) { const value = header.split(";")[0]!; cookies.set(value.split("=")[0]!, value); }
      return response;
    }
    async function authorize(params: Record<string, string | undefined> = {}, complete = true, deny = false) {
      const query = { client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "mcp:tools mcp:resources", resource,
        state: "synthetic-desktop-state", prompt: "login consent", code_challenge: challenge, code_challenge_method: "S256", ...params };
      const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
      let response = await visit(`/auth?${search}`); const pages: string[] = [];
      for (let step = 0; complete && step < 12; step++) {
        const location = response.headers.location;
        if (location && new URL(location, issuer).origin !== issuer) break;
        if (location) { response = await visit(location); continue; }
        if (response.status !== 200) break;
        pages.push(response.text);
        const action = response.text.match(/<form[^>]+action="([^"]+)"/)?.[1];
        const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
        expect(action).toBeTruthy(); expect(csrf).toBeTruthy();
        const login = action!.endsWith("/login");
        response = await visit(deny && !login ? action!.replace(/\/consent$/, "/cancel") : action!,
          { csrf: csrf!, ...(login ? { username: "synthetic@example.test", password: "synthetic-password" } : {}) });
      }
      return { response, pages, callback: new URL(response.headers.location ?? "/", issuer) };
    }
    const token = (body: Record<string, string>) => request(app).post("/token").set("Host", new URL(issuer).host)
      .set("X-Forwarded-Proto", "https").type("form").send({ client_id: clientId, ...body });
    const exchange = (code: string, overrides: Record<string, string> = {}) => token({ grant_type: "authorization_code", code, redirect_uri: redirectUri,
      code_verifier: verifier, resource, ...overrides });
    return { app, authorize, token, exchange };
  }

  it("issues a resource-bound public-client token only after separate desktop consent and S256", async () => {
    const f = await fixture(); const { callback, pages } = await f.authorize();
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("synthetic-desktop-state");
    expect(callback.searchParams.get("iss")).toBe(issuer);
    expect(pages.join(" ")).toContain("Connect Kin to the desktop acceptance client");
    expect(pages.join(" ")).not.toMatch(/Alexa|voice confirmations|Open your family workspace/);
    const result = await f.exchange(callback.searchParams.get("code")!);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:tools mcp:resources" });
    expect(result.body.refresh_token).toBeUndefined();
    expect((await jwtVerify(result.body.access_token, publicKey, { issuer, audience: resource })).payload)
      .toMatchObject({ sub: "synthetic-family-account", client_id: clientId, scope: "mcp:tools mcp:resources" });
  });
  it.each(["false", null])("leaves the desktop client unregistered when enabled is %j", async enabled => {
    const f = await fixture(enabled);
    const result = await f.authorize({}, false);
    expect(result.response.status).toBe(400); expect(result.response.headers.location).toBeUndefined();
  });
  it.each(["", "TRUE", "1", " true "])("rejects invalid enable value %j", async enabled => {
    await expect(fixture(enabled)).rejects.toThrow("KIN_DESKTOP_AUTH_ENABLED");
  });
  it.each(["http://127.0.0.1:43128/oauth/callback", "http://localhost:43127/oauth/callback", "http://[::1]:43127/oauth/callback",
    "http://127.0.0.1:43127/other", "http://127.0.0.1:43127/oauth/callback?next=foreign", "http://127.0.0.1:43127/oauth/callback#fragment",
    "http://127.0.0.1:43127/*", "https://foreign.example/callback"])("rejects unregistered callback %s before redirecting", async callback => {
    const f = await fixture(); const result = await f.authorize({ redirect_uri: callback }, false);
    expect(result.response.status).toBe(400); expect(result.response.headers.location).toBeUndefined();
  });
  it.each([undefined, "plain"])("rejects missing or unsupported PKCE %j before consent", async method => {
    const f = await fixture(); const result = await f.authorize({ code_challenge_method: method, code_challenge: method ? challenge : undefined });
    expect(result.callback.searchParams.get("error")).toBe("invalid_request"); expect(result.pages).toEqual([]);
  });
  it.each(["mcp:service", "mcp:tools mcp:service", "", "openid", "mcp:tools unknown"])("rejects unsupported desktop scope %j before consent", async scope => {
    const f = await fixture(); const result = await f.authorize({ scope });
    expect(result.callback.searchParams.get("error")).toBe("invalid_scope"); expect(result.pages).toEqual([]);
  });
  it.each([undefined, "https://foreign.example/mcp"])("rejects missing or foreign resource %j", async target => {
    const f = await fixture(); const result = await f.authorize({ resource: target });
    expect(result.callback.searchParams.get("error")).toBe("invalid_target"); expect(result.pages).toEqual([]);
  });
  it("does not issue a code when desktop consent is declined", async () => {
    const f = await fixture(); const result = await f.authorize({}, true, true);
    expect(result.callback.searchParams.get("error")).toBe("access_denied"); expect(result.callback.searchParams.has("code")).toBe(false);
  });
  it("rejects a wrong verifier, code replay and another client's code exchange", async () => {
    const f = await fixture(); const wrong = await f.authorize();
    expect((await f.exchange(wrong.callback.searchParams.get("code")!, { code_verifier: "x".repeat(43) })).body.error).toBe("invalid_grant");
    const stolen = await f.authorize();
    expect((await f.exchange(stolen.callback.searchParams.get("code")!, { client_id: "kin-family-browser" })).body.error).toBe("invalid_grant");
    const valid = await f.authorize(); const code = valid.callback.searchParams.get("code")!;
    expect((await f.exchange(code)).status).toBe(200);
    expect((await f.exchange(code)).body.error).toBe("invalid_grant");
  });
  it.each(["client_credentials", "refresh_token"])("does not authorize the desktop client for %s", async grantType => {
    const f = await fixture(); const result = await f.token({ grant_type: grantType, scope: "mcp:service", resource, refresh_token: "synthetic-unsupported" });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_request", error_description: "requested grant type is not allowed for this client" });
  });
  it.each(["service", "user", "echo", "browser"])("rejects an identity collision with the %s client", kind => {
    const existing = { clientId, clientSecret: "synthetic-client-secret" };
    expect(() => createKinOAuthProvider({ issuer, resourceUri: resource, jwks: secrets.jwks, cookieKeys: secrets.cookieKeys,
      adapter: class {}, serviceClient: kind === "service" ? existing : secrets.serviceClient,
      ...(kind === "user" ? { userClient: { ...existing, redirectUris: ["https://alexa.example/callback"] } } : {}),
      ...(kind === "echo" ? { echoClient: { ...existing, redirectUris: ["https://alexa.example/callback"] } } : {}),
      ...(kind === "browser" ? { browserClient: { clientId, redirectUri: `${issuer}/invite.html` } } : {}),
      desktopClient: { clientId, redirectUri },
    })).toThrow("separate identity");
  });
});
