import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import express from "express";
import { createOAuthInteractionRouter } from "../src/oauth-interactions.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createKinOAuthProvider } from "../src/oauth-provider.js";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { KinApiStack } from "../infra/kin-api-stack.js";
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
      async revokeByGrantId(grantId: string) {
        // Revocation applies to this token model, not the in-progress
        // Interaction that must survive ending the previous account session.
        for (const [key,value] of records) {
          if (key.startsWith(`${this.model}:`) && value.grantId === grantId) records.delete(key);
        }
      }
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
    expect(result.payload.client_id).toBe(clientId);
  });
  it("rejects a stolen code without its verifier and rejects replay", async () => {
    const stolen = await code();
    expect((await exchange(stolen, "x".repeat(43))).status).toBe(400);
    const valid = await code();
    expect((await exchange(valid)).status).toBe(200);
    expect((await exchange(valid)).status).toBe(400);
  });
  it("switches accounts in both directions through CSRF-protected session termination", async () => {
    const app = express();
    const template = Template.fromStack(new KinApiStack(new App(), "AccountSwitchRoutingTest", {}));
    const routes = new Set(Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
      .map(route => route.Properties.RouteKey as string));
    // Model the gateway boundary that direct provider-only tests missed.
    app.use((req, res, next) => {
      if (req.path.startsWith("/session/") && !routes.has(`${req.method} ${req.path}`)) {
        res.status(404).send(`Cannot ${req.method} ${req.path}`);
      } else next();
    });
    app.use(createOAuthInteractionRouter({ provider, resourceUri: resource, csrfSecret: "s".repeat(32), browserClientId: clientId,
      authenticator: { async authenticate(username) { return { accountId: username, username }; } },
    }));
    app.use(provider.callback());
    const jar = new Map<string, string>();
    async function visit(location: string, body?: Record<string, string>) {
      const url = new URL(location, issuer);
      expect(url.origin).toBe(issuer);
      const req = body ? request(app).post(url.pathname + url.search).type("form").send(body) : request(app).get(url.pathname + url.search);
      req.set("Host", "kin.example").set("X-Forwarded-Proto", "https");
      if (jar.size) req.set("Cookie", [...jar.values()].join("; "));
      const response = await req;
      for (const cookie of response.headers["set-cookie"] ?? []) {
        const value = cookie.split(";")[0]!;
        jar.set(value.split("=")[0]!, value);
      }
      return response;
    }
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "mcp:tools mcp:resources", resource,
      state: "switch-test", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", prompt: "login" });
    let terminations = 0;
    for (const account of ["first@example.com", "second@example.com", "first@example.com"]) {
      let response = await visit(`/auth?${params}`);
      let completed = false;
      for (let step = 0; step < 15; step++) {
        const location = response.headers.location;
        if (location && new URL(location, issuer).pathname === "/invite.html") {
          const callback = new URL(location, issuer);
          expect(callback.searchParams.get("state")).toBe("switch-test");
          const token = await exchange(callback.searchParams.get("code")!);
          expect(token.status).toBe(200);
          const verified = await jwtVerify(token.body.access_token, publicKey, { issuer, audience: resource });
          expect(verified.payload.sub).toBe(account);
          completed = true;
          break;
        }
        if (location) { response = await visit(location); continue; }
        expect(response.status, response.text).toBe(200);
        const action = response.text.match(/<form[^>]+action="([^"]+)"/)?.[1];
        expect(action).toBeTruthy();
        if (new URL(action!, issuer).pathname === "/session/end/confirm") {
          const xsrf = response.text.match(/name="xsrf" value="([^"]+)"/)?.[1];
          expect(xsrf).toBeTruthy();
          // A forged logout must not consume the valid account-switch flow.
          expect((await visit(action!, { xsrf: "invalid", logout: "yes" })).status).toBe(400);
          response = await visit(action!, { xsrf: xsrf!, logout: "yes" });
          expect(response.status).toBe(303);
          terminations++;
        } else {
          const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
          expect(csrf).toBeTruthy();
          response = await visit(action!, { csrf: csrf!, ...(action!.endsWith("/login") ? { username: account, password: "synthetic-password" } : {}) });
        }
      }
      expect(completed, `No callback for ${account}`).toBe(true);
    }
    expect(terminations).toBe(2);
  }, 30_000);
  it("walks authorization and silently reuses the granted provider session, but rejects renewal without that session", async () => {
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
        params.set("prompt", "none"); params.set("state", "renewal-state");
        const renewed = await visit(`/auth?${params}`);
        expect(renewed.headers.location).toBeDefined();
        const renewedCallback = new URL(renewed.headers.location!, issuer);
        expect(renewedCallback.pathname).toBe("/invite.html");
        expect(renewedCallback.searchParams.get("state")).toBe("renewal-state");
        expect(renewedCallback.searchParams.get("iss")).toBe(issuer);
        expect(renewedCallback.searchParams.has("error")).toBe(false);
        const renewedToken = await exchange(renewedCallback.searchParams.get("code")!);
        expect(renewedToken.status).toBe(200);
        expect((await jwtVerify(renewedToken.body.access_token, publicKey, { issuer, audience: resource })).payload.sub).toBe("synthetic-member");
        jar.clear();
        const rejected = await visit(`/auth?${params}`);
        expect(rejected.headers.location).toBeDefined();
        const expired = new URL(rejected.headers.location!, issuer);
        expect(expired.pathname).toBe("/invite.html");
        expect(expired.searchParams.get("iss")).toBe(issuer);
        expect(expired.searchParams.get("error")).toBe("login_required");
        expect(expired.searchParams.has("code")).toBe(false);
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
