import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createConfiguredOAuthApp } from "../src/oauth-lambda.js";
import { createKinOAuthProvider } from "../src/oauth-provider.js";
import type { OAuthSecrets } from "../src/oauth-secrets.js";

const issuer = "https://echo-auth.example", resource = `${issuer}/mcp`;
const redirect = "https://pitangui.amazon.com/api/skill/link/synthetic-vendor";
const verifier = "synthetic-echo-pkce-verifier-long-enough-for-rfc7636";
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("classic Echo account linking", () => {
  let secrets: OAuthSecrets, publicKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true }); publicKey = pair.publicKey;
    secrets = { schemaVersion: 1, jwks: { keys: [{ ...await exportJWK(pair.privateKey), kty: "RSA", kid: "synthetic-echo-key", use: "sig", alg: "RS256" }] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)], csrfSecret: "c".repeat(32),
      serviceClient: { clientId: "synthetic-service-client", clientSecret: "d".repeat(32) },
      userClient: { clientId: "synthetic-mcp-user-client", clientSecret: "e".repeat(32) },
      echoClient: { clientId: "synthetic-classic-echo-client", clientSecret: "f".repeat(32) } };
  });

  function environment() {
    return { KIN_OAUTH_ISSUER: issuer, KIN_MCP_RESOURCE_URI: resource, KIN_OAUTH_STATE_TABLE: "synthetic-state",
      KIN_COGNITO_CLIENT_ID: "synthetic-cognito-client", KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic", KIN_OAUTH_SECRET_ID: "synthetic-secret",
      KIN_ALEXA_REDIRECT_URIS: "https://alexa.example/callback", KIN_ECHO_REDIRECT_URIS: redirect,
      KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: "synthetic-browser-client", KIN_BROWSER_REDIRECT_URI: `${issuer}/invite.html` };
  }

  async function fixture(overrides: Record<string, string> = {}, configuredSecrets = secrets) {
    const rows = new Map<string, Record<string, any>>();
    class Adapter {
      constructor(private model: string) {}
      async upsert(id: string, payload: Record<string, unknown>) { rows.set(`${this.model}:${id}`, structuredClone(payload)); }
      async find(id: string) { return structuredClone(rows.get(`${this.model}:${id}`)); }
      async findByUid(uid: string) { return [...rows.entries()].find(([key, row]) => key.startsWith(`${this.model}:`) && row.uid === uid)?.[1]; }
      async destroy(id: string) { rows.delete(`${this.model}:${id}`); }
      async consume(id: string) { const row = rows.get(`${this.model}:${id}`)!; if (row.consumed) throw new Error("Synthetic replay"); row.consumed = Math.floor(Date.now() / 1000); }
      async revokeByGrantId(id: string) { for (const [key, row] of rows) if (row.grantId === id) rows.delete(key); }
    }
    const account = { enabled: true, unavailable: false };
    const app = await createConfiguredOAuthApp({ ...environment(), ...overrides }, {
      secrets: configuredSecrets, adapter: Adapter,
      authenticator: { authenticate: async () => ({ accountId: "synthetic-family-account", username: "synthetic@example.com" }) },
      accountStatus: { async find(accountId) {
        if (account.unavailable) throw new Error("Synthetic directory unavailable");
        return account.enabled ? { accountId, modifiedAt: 1 } : undefined;
      } },
    });
    const cookies = new Map<string, string>();
    async function visit(path: string, form?: Record<string, string>) {
      const url = new URL(path, issuer); expect(url.origin).toBe(issuer);
      const req = form ? request(app).post(url.pathname + url.search).type("form").send(form) : request(app).get(url.pathname + url.search);
      const response = await req.set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https").set("Cookie", [...cookies.values()].join("; "));
      for (const header of response.headers["set-cookie"] ?? []) { const value = header.split(";")[0]!; cookies.set(value.split("=")[0]!, value); }
      return response;
    }
    async function authorize(params: Record<string, string | undefined> = {}, complete = true) {
      const query = { client_id: secrets.echoClient!.clientId, redirect_uri: redirect, response_type: "code", scope: "mcp:tools", state: "synthetic-alexa-state",
        code_challenge: challenge, code_challenge_method: "S256", ...params };
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
        response = await visit(action!, { csrf: csrf!, ...(action!.endsWith("/login") ? { username: "synthetic@example.com", password: "synthetic-password" } : {}) });
      }
      return { response, pages, callback: new URL(response.headers.location ?? "/", issuer) };
    }
    function token(body: Record<string, string>, client = secrets.echoClient!) {
      return request(app).post("/token").set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https")
        .auth(client.clientId, client.clientSecret).type("form").send(body);
    }
    const exchange = (code: string, codeVerifier = verifier) => token({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: codeVerifier });
    return { app, account, authorize, token, exchange };
  }

  it("completes explicit Echo consent, S256 code exchange and refresh without a resource parameter", async () => {
    const f = await fixture(); const { callback, pages } = await f.authorize();
    expect(callback.origin + callback.pathname).toBe(redirect);
    expect(callback.searchParams.get("state")).toBe("synthetic-alexa-state");
    expect(callback.searchParams.get("error")).toBeNull();
    expect(pages.join(" ")).toContain("Connect Kin to your Echo");
    expect(pages.join(" ")).toContain("Anyone who can speak to this Echo");
    expect(pages.join(" ")).not.toContain("Connect Kin to Alexa+");
    const first = await f.exchange(callback.searchParams.get("code")!);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" });
    expect(first.body.refresh_token).toBeTruthy();
    expect((await jwtVerify(first.body.access_token, publicKey, { issuer, audience: resource })).payload)
      .toMatchObject({ sub: "synthetic-family-account", scope: "mcp:tools", client_id: secrets.echoClient!.clientId });
    const refreshed = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ scope: "mcp:tools", expires_in: 3600 });
    expect(refreshed.body.refresh_token).toBeTruthy();
    expect((await jwtVerify(refreshed.body.access_token, publicKey, { issuer, audience: resource })).payload.scope).toBe("mcp:tools");
  });

  it.each(["mcp:resources", "mcp:service", "mcp:tools mcp:resources", ""]) ("rejects Echo scope %j before consent", async scope => {
    const f = await fixture(); const { callback, pages } = await f.authorize({ scope });
    expect(callback.searchParams.get("error")).toBe("invalid_scope"); expect(pages).toEqual([]);
  });

  it.each([undefined, "plain"]) ("rejects missing PKCE or unsupported challenge method %j", async method => {
    const f = await fixture(); const { callback, pages } = await f.authorize({ code_challenge_method: method, code_challenge: method ? challenge : undefined });
    expect(callback.searchParams.get("error")).toBe("invalid_request"); expect(pages).toEqual([]);
  });

  it("rejects a foreign resource instead of replacing it with the Echo default", async () => {
    const f = await fixture(); const result = await f.authorize({ resource: "https://attacker.example/mcp" });
    expect(result.callback.searchParams.get("error")).toBe("invalid_target"); expect(result.pages).toEqual([]);
  });

  it("does not redirect authorization codes to an unregistered callback", async () => {
    const f = await fixture(); const result = await f.authorize({ redirect_uri: "https://attacker.example/callback" }, false);
    expect(result.response.status).toBe(400); expect(result.response.headers.location).toBeUndefined();
  });

  it.each(["browser", "mcp"]) ("still rejects absent resource for the %s authorization client", async kind => {
    const f = await fixture(); const result = await f.authorize(kind === "browser"
      ? { client_id: environment().KIN_BROWSER_CLIENT_ID, redirect_uri: environment().KIN_BROWSER_REDIRECT_URI }
      : { client_id: secrets.userClient.clientId, redirect_uri: environment().KIN_ALEXA_REDIRECT_URIS }, false);
    expect(result.callback.searchParams.get("error")).toBe("invalid_target");
  });

  it("rejects a wrong code verifier and replayed authorization code", async () => {
    const f = await fixture(); const wrong = await f.authorize();
    expect((await f.exchange(wrong.callback.searchParams.get("code")!, "x".repeat(43))).body.error).toBe("invalid_grant");
    const valid = await f.authorize(); const code = valid.callback.searchParams.get("code")!;
    expect((await f.exchange(code)).status).toBe(200);
    expect((await f.exchange(code)).body.error).toBe("invalid_grant");
  });

  it("requires Echo client authentication and denies refresh scope escalation", async () => {
    const f = await fixture(); const { callback } = await f.authorize();
    const first = await f.exchange(callback.searchParams.get("code")!); expect(first.status).toBe(200);
    const badSecret = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token }, { ...secrets.echoClient!, clientSecret: "invalid-secret" });
    expect(badSecret.status).toBe(401); expect(badSecret.body.error).toBe("invalid_client");
    const escalation = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token, scope: "mcp:resources" });
    expect(escalation.status).toBe(400); expect(escalation.body.error).toBe("invalid_scope");
  });

  it("invalidates disabled-account refresh but reports directory outages as server errors", async () => {
    const f = await fixture(); const { callback } = await f.authorize();
    const first = await f.exchange(callback.searchParams.get("code")!); expect(first.status).toBe(200);
    f.account.unavailable = true;
    expect((await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token })).status).toBe(500);
    f.account.unavailable = false; f.account.enabled = false;
    const disabled = await f.token({ grant_type: "refresh_token", refresh_token: first.body.refresh_token });
    expect(disabled.status).toBe(400); expect(disabled.body.error).toBe("invalid_grant");
  });

  it("keeps existing version-one secrets usable while failing closed if Echo callbacks lack dedicated credentials", async () => {
    const { echoClient: _unused, ...existing } = secrets;
    await expect(fixture({ KIN_ECHO_REDIRECT_URIS: "" }, existing)).resolves.toBeDefined();
    await expect(fixture({}, existing)).rejects.toThrow("Echo account linking requires dedicated client credentials");
    const f = await fixture({ KIN_ECHO_REDIRECT_URIS: "" });
    const result = await f.authorize({}, false);
    expect(result.response.status).toBe(400); expect(result.response.headers.location).toBeUndefined();
  });

  it.each(["service", "user", "browser"]) ("rejects an Echo identity shared with the %s client", kind => {
    const clientId = kind === "service" ? secrets.serviceClient.clientId : kind === "user" ? secrets.userClient.clientId : environment().KIN_BROWSER_CLIENT_ID;
    expect(() => createKinOAuthProvider({ issuer, resourceUri: resource, jwks: secrets.jwks, cookieKeys: secrets.cookieKeys,
      adapter: class {}, serviceClient: secrets.serviceClient, userClient: { ...secrets.userClient, redirectUris: [environment().KIN_ALEXA_REDIRECT_URIS] },
      browserClient: { clientId: environment().KIN_BROWSER_CLIENT_ID, redirectUri: environment().KIN_BROWSER_REDIRECT_URI },
      echoClient: { ...secrets.echoClient!, clientId: ` ${clientId} `, redirectUris: [redirect] },
    })).toThrow("separate identity");
  });

  it.each(["http://alexa.example/callback", "https://alexa.example/callback#fragment", "https://user:secret@alexa.example/callback", "https://alexa.example/*"]) ("rejects unsafe Echo callback configuration %s", callback => {
    expect(() => createKinOAuthProvider({ issuer, resourceUri: resource, jwks: secrets.jwks, cookieKeys: secrets.cookieKeys,
      adapter: class {}, serviceClient: secrets.serviceClient,
      echoClient: { ...secrets.echoClient!, redirectUris: [callback] },
    })).toThrow(/Echo redirect URI/);
  });
});
