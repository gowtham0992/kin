import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import express from "express";
import { createOAuthInteractionRouter } from "../src/oauth-interactions.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createKinOAuthProvider } from "../src/oauth-provider.js";
const issuer = "https://kin.example";
const clientId = "kin-family-browser";
const redirectUri = `${issuer}/invite.html`;
const resource = `${issuer}/mcp`;
const verifier = "v".repeat(43);

describe("public browser OAuth client", () => {
  let provider: ReturnType<typeof createKinOAuthProvider>;
  let publicKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true }); publicKey = pair.publicKey;
    const jwk = { ...await exportJWK(pair.privateKey), alg: "RS256", use: "sig", kid: "browser-test" };
    const records = new Map<string, Record<string, unknown>>();
    class Adapter {
      constructor(private model: string) {}
      async upsert(id: string, payload: Record<string, unknown>) { records.set(`${this.model}:${id}`, { ...payload }); }
      async find(id: string) { return records.get(`${this.model}:${id}`); }
      async findByUid(uid: string) { return [...records.entries()].find(([key,value]) => key.startsWith(`${this.model}:`) && value.uid === uid)?.[1]; }
      async destroy(id: string) { records.delete(`${this.model}:${id}`); }
      async consume(id: string) { const value = await this.find(id); if (value) value.consumed = Math.floor(Date.now()/1000); }
      async revokeByGrantId(grantId: string) { for (const [key,value] of records) if (value.grantId === grantId) records.delete(key); }
    }
    provider = createKinOAuthProvider({ issuer, resourceUri: resource, jwks: { keys: [jwk] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)], adapter: Adapter,
      serviceClient: { clientId: "alexa-service-client", clientSecret: "synthetic-service-secret" }, browserClient: { clientId, redirectUri },
      findAccount: async accountId => ({ accountId, claims: async () => ({ sub: accountId }) }),
    });
  });
  async function code() {
    const grant = new provider.Grant({ accountId: "synthetic-member", clientId });
    grant.addResourceScope(resource, "mcp:tools mcp:resources");
    const grantId = await grant.save();
    const AuthorizationCode = (provider as unknown as { AuthorizationCode: new (input: Record<string, unknown>) => { save(): Promise<string> } }).AuthorizationCode;
    return new AuthorizationCode({ accountId: "synthetic-member", clientId, grantId, redirectUri,
      resource, scope: "mcp:tools mcp:resources", codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256" }).save();
  }
  const exchange = (code: string, codeVerifier = verifier) => request(provider.callback()).post("/token").type("form")
    .send({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, resource, code, code_verifier: codeVerifier });
  it("exchanges a bound code without a client secret and issues no refresh token", async () => {
    const response = await exchange(await code());
    expect(response.status).toBe(200);
    expect(response.body.refresh_token).toBeUndefined();
    const result = await jwtVerify(response.body.access_token, publicKey, { issuer, audience: resource });
    expect(result.payload.sub).toBe("synthetic-member");
    expect(result.payload.scope).toContain("mcp:tools");
  });
  it("rejects a stolen code without its verifier and rejects replay", async () => {
    const stolen = await code();
    expect((await exchange(stolen, "x".repeat(43))).status).toBe(400);
    const valid = await code();
    expect((await exchange(valid)).status).toBe(200);
    expect((await exchange(valid)).status).toBe(400);
  });
  it("walks authorization, account sign-in, consent, and browser callback with the real provider", async () => {
    const app = express();
    app.use(createOAuthInteractionRouter({ provider, resourceUri: resource, csrfSecret: "s".repeat(32), browserClientId: clientId,
      authenticator: { async authenticate() { return { accountId: "synthetic-member", username: "synthetic@example.com" }; } },
    }));
    app.use(provider.callback());
    const jar = new Map<string,string>();
    async function visit(location: string, body?: Record<string,string>) {
      const url = new URL(location, issuer);
      expect(url.origin).toBe(issuer);
      const req = body ? request(app).post(url.pathname + url.search).type("form").send(body) : request(app).get(url.pathname + url.search);
      req.set("Host", "kin.example").set("X-Forwarded-Proto", "https");
      if (jar.size) req.set("Cookie", [...jar.values()].join("; "));
      const response = await req;
      for (const cookie of response.headers["set-cookie"] ?? []) { const value = cookie.split(";")[0]!; jar.set(value.split("=")[0]!,value); }
      return response;
    }
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "mcp:tools mcp:resources", resource,
      state: "synthetic-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "login" });
    let response = await visit(`/auth?${params}`);
    for (let step = 0; step < 10; step++) {
      const location = response.headers.location;
      if (location && new URL(location,issuer).pathname === "/invite.html") {
        const callback = new URL(location,issuer);
        expect(callback.searchParams.get("state")).toBe("synthetic-state");
        expect(callback.searchParams.get("iss")).toBe(issuer);
        expect((await exchange(callback.searchParams.get("code")!)).status).toBe(200);
        return;
      }
      if (location) { response = await visit(location); continue; }
      expect(response.status, response.text).toBe(200);
      const action = response.text.match(/<form[^>]+action="([^"]+)"/)?.[1];
      const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
      expect(action).toBeTruthy(); expect(csrf).toBeTruthy();
      if (action!.endsWith("/consent")) {
        expect(response.text).toContain("Open your family workspace");
        expect(response.text).not.toContain("Connect Kin to Alexa+");
      }
      response = await visit(action!, { csrf: csrf!, ...(action!.endsWith("/login") ? { username: "synthetic@example.com", password: "synthetic-password" } : {}) });
    }
    throw new Error("Authorization did not reach the browser callback");
  });
});
