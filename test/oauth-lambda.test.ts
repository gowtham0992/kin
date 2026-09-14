import { createHash, webcrypto } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createConfiguredOAuthApp } from "../src/oauth-lambda.js";
import type { OAuthSecrets } from "../src/oauth-secrets.js";
import { familyConsentVersion, type Invitation } from "../src/invitations.js";
import { requireMembership } from "../src/membership.js";
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);

describe("configured OAuth Lambda application", () => {
  let secrets: OAuthSecrets;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    publicKey = pair.publicKey;
    const key = await exportJWK(pair.privateKey);
    secrets = {
      schemaVersion: 1,
      jwks: { keys: [{ ...key, kty: key.kty ?? "RSA", kid: "runtime-test", use: "sig", alg: "RS256" }] },
      cookieKeys: ["a".repeat(32), "b".repeat(32)],
      csrfSecret: "c".repeat(32),
      serviceClient: { clientId: "kin-service-client", clientSecret: "d".repeat(32) },
      userClient: { clientId: "kin-alexa-client-1", clientSecret: "e".repeat(32) },
    };
  });

  it("serves only a deliberate 503 while the public rollout gate is closed", async () => {
    const app = await createConfiguredOAuthApp({ KIN_PUBLIC_API_ENABLED: "false" });
    const response = await request(app).get("/.well-known/oauth-authorization-server").expect(503);

    expect(response.body).toEqual({ error: "Kin's public API is temporarily unavailable" });
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("serves discovery from the AWS-owned issuer and registers Alexa only when callbacks exist", async () => {
    const app = await createConfiguredOAuthApp({
      AWS_REGION: "us-east-1",
      KIN_OAUTH_ISSUER: "https://api-id.execute-api.us-east-1.amazonaws.com",
      KIN_MCP_RESOURCE_URI: "https://api-id.execute-api.us-east-1.amazonaws.com/mcp",
      KIN_OAUTH_STATE_TABLE: "kin-oauth-state",
      KIN_COGNITO_CLIENT_ID: "cognito-client-id",
      KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_OAUTH_SECRET_ID: "secret-arn",
      KIN_ALEXA_REDIRECT_URIS: "https://alexa.amazon.com/callback, https://layla.amazon.com/callback",
    }, { secrets });

    const response = await request(app)
      .get("/.well-known/oauth-authorization-server")
      .set("Host", "api-id.execute-api.us-east-1.amazonaws.com")
      .set("X-Forwarded-Proto", "https")
      .expect(200);

    expect(response.body).toMatchObject({
      issuer: "https://api-id.execute-api.us-east-1.amazonaws.com",
      authorization_endpoint: "https://api-id.execute-api.us-east-1.amazonaws.com/auth",
      token_endpoint: "https://api-id.execute-api.us-east-1.amazonaws.com/token",
      jwks_uri: "https://api-id.execute-api.us-east-1.amazonaws.com/jwks",
    });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails startup when any public identifier is insecure or missing", async () => {
    await expect(createConfiguredOAuthApp({
      KIN_OAUTH_ISSUER: "http://insecure.example",
      KIN_MCP_RESOURCE_URI: "https://example.com/mcp",
      KIN_OAUTH_STATE_TABLE: "state",
      KIN_COGNITO_CLIENT_ID: "client",
      KIN_OAUTH_SECRET_ID: "secret",
    }, { secrets })).rejects.toThrow("KIN_OAUTH_ISSUER must use HTTPS");
  });

  it("offers neutral recovery when an expired browser interaction cannot be loaded", async () => {
    const issuer = "https://api-id.execute-api.us-east-1.amazonaws.com";
    const app = await createConfiguredOAuthApp({ KIN_OAUTH_ISSUER: issuer, KIN_MCP_RESOURCE_URI: `${issuer}/mcp`,
      KIN_OAUTH_STATE_TABLE: "synthetic-oauth-state", KIN_COGNITO_CLIENT_ID: "synthetic-client", KIN_OAUTH_SECRET_ID: "synthetic-secret",
      KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: "kin-family-browser", KIN_BROWSER_REDIRECT_URI: `${issuer}/invite.html`,
    }, { secrets, adapter: MemoryAdapter, authenticator: { authenticate: async () => { throw new Error("Credentials must not be reached"); } } });
    const response = await request(app).get("/interaction/expired-synthetic-request")
      .set("Host", new URL(issuer).host).set("X-Forwarded-Proto", "https").expect(500);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).toBe("Kin couldn't complete sign-in. Return to the app where you started and try again.");
    expect(response.text).not.toMatch(/Alexa|expired-synthetic-request|Credentials/);
  });

  it("completes login, explicit consent, PKCE exchange, and refresh as one real flow", async () => {
    MemoryAdapter.reset();
    const issuer = "https://api-id.execute-api.us-east-1.amazonaws.com";
    const resource = `${issuer}/mcp`;
    const redirectUri = "https://alexa.amazon.com/callback";
    const app = await createConfiguredOAuthApp({
      AWS_REGION: "us-east-1",
      KIN_OAUTH_ISSUER: issuer,
      KIN_MCP_RESOURCE_URI: resource,
      KIN_OAUTH_STATE_TABLE: "kin-oauth-state",
      KIN_COGNITO_CLIENT_ID: "cognito-client-id",
      KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_OAUTH_SECRET_ID: "secret-arn",
      KIN_ALEXA_REDIRECT_URIS: redirectUri,
    }, {
      secrets,
      adapter: MemoryAdapter,
      accountStatus: { async find(accountId) { return { accountId, modifiedAt: 1 }; } },
      authenticator: {
        authenticate: async () => ({ accountId: "family-account", username: "owner@example.com" }),
      },
    });
    const cookies = new Map<string, string>();
    const verifier = "kin-pkce-verifier-that-is-long-enough-for-rfc7636";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL("/auth", issuer);
    authorize.search = new URLSearchParams({
      client_id: secrets.userClient.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "mcp:tools mcp:resources",
      resource,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "alexa-state",
    }).toString();

    let response = await browserGet(app, `${authorize.pathname}${authorize.search}`, cookies);
    expect(response.status).toBe(303);
    response = await browserGet(app, localPath(response.headers.location, issuer), cookies);
    expect(response.status).toBe(200);
    expect(response.text).toContain("Bring your care circle together");
    response = await browserPost(app, new URL(response.request.url).pathname + "/login", {
      csrf: csrfFrom(response.text),
      username: "owner@example.com",
      password: "correct horse battery staple",
    }, cookies);
    expect(response.status).toBe(303);

    response = await browserGet(app, localPath(response.headers.location, issuer), cookies);
    expect(response.status).toBe(303);
    response = await browserGet(app, localPath(response.headers.location, issuer), cookies);
    expect(response.status).toBe(200);
    expect(response.text).toContain("Connect Kin to Alexa+");
    const interactionPath = new URL(response.request.url).pathname;
    response = await browserPost(app, `${interactionPath}/consent`, {
      csrf: csrfFrom(response.text),
    }, cookies);
    expect(response.status).toBe(303);
    response = await browserGet(app, localPath(response.headers.location, issuer), cookies);
    expect(response.status).toBe(303);

    const callbackLocation = requiredLocation(response.headers.location);
    if (!callbackLocation.startsWith("https:")) {
      const unexpected = await browserGet(app, localPath(callbackLocation, issuer), cookies);
      const prompt = unexpected.text.includes("Bring your care circle")
        ? "login"
        : unexpected.text.includes("Connect Kin to Alexa+") ? "consent" : "unknown";
      throw new Error(`Unexpected ${prompt} interaction after consent`);
    }
    const callback = new URL(callbackLocation);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("alexa-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await request(app)
      .post("/token")
      .set("Host", new URL(issuer).host)
      .set("X-Forwarded-Proto", "https")
      .auth(secrets.userClient.clientId, secrets.userClient.clientSecret)
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      });
    if (token.status !== 200) throw new Error(`Token exchange failed: ${JSON.stringify(token.body)}`);
    expect(token.body).toMatchObject({
      token_type: "Bearer",
      scope: "mcp:tools mcp:resources",
      expires_in: 3_600,
    });
    expect(token.body.refresh_token).toBeTruthy();
    const verified = await jwtVerify(token.body.access_token, publicKey, {
      issuer,
      audience: resource,
      algorithms: ["RS256"],
    });
    expect(verified.payload.sub).toBe("family-account");

    const refreshed = await request(app)
      .post("/token")
      .set("Host", new URL(issuer).host)
      .set("X-Forwarded-Proto", "https")
      .auth(secrets.userClient.clientId, secrets.userClient.clientSecret)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token: token.body.refresh_token, resource })
      .expect(200);
    expect(refreshed.body.access_token).toBeTruthy();
    expect(refreshed.body.scope).toBe("mcp:tools mcp:resources");
  });

  it("lets a returning browser account review an invitation after its first sign-in without granting family access before consent", async () => {
    MemoryAdapter.reset();
    const issuer = "https://api-id.execute-api.us-east-1.amazonaws.com";
    const resource = `${issuer}/mcp`, clientId = "kin-family-browser", accountId = "returning-account";
    const code = "r".repeat(43);
    const invitation: Invitation = { circleId: "family-a", circleName: "Evelyn's family", memberId: "theo", name: "Theo",
      role: "viewer", targetKey: "synthetic-account-key", expiresAt: 2_000_000_000, status: "pending", rosterBound: true };
    let membership: unknown = null;
    const access = { circleId: invitation.circleId, directory: { async find() { return membership; } } };
    const principal = { subject: accountId, scopes: new Set(["mcp:tools"]), claims: { iss: issuer } };
    const review = vi.fn(async (account: string, submittedCode: string) => {
      expect(account).toBe(accountId); expect(submittedCode).toBe(code);
      return invitation;
    });
    const accept = vi.fn(async (account: string, submittedCode: string, consent: string, reviewed: Invitation) => {
      expect(account).toBe(accountId); expect(submittedCode).toBe(code);
      expect(consent).toBe(familyConsentVersion); expect(reviewed).toEqual(invitation);
      membership = { circleId: invitation.circleId, memberId: invitation.memberId, name: invitation.name, role: invitation.role, status: "active" };
    });
    const app = await createConfiguredOAuthApp({
      KIN_OAUTH_ISSUER: issuer, KIN_MCP_RESOURCE_URI: resource, KIN_OAUTH_STATE_TABLE: "synthetic-state",
      KIN_COGNITO_CLIENT_ID: "synthetic-cognito-client", KIN_OAUTH_SECRET_ID: "synthetic-secret",
      KIN_COGNITO_USER_POOL_ID: "us-east-1_synthetic",
      KIN_BROWSER_AUTH_ENABLED: "true", KIN_BROWSER_CLIENT_ID: clientId, KIN_BROWSER_REDIRECT_URI: `${issuer}/invite.html`,
    }, { secrets, adapter: MemoryAdapter, enrollment: { review, accept },
      accountStatus: { async find(accountId) { return { accountId, modifiedAt: 1 }; } },
      authenticator: { async authenticate() { return { accountId, username: "returning@example.com" }; } } });
    const cookies = new Map<string, string>();
    const storage = new Map<string, string>();
    let random = 0;
    const auth = createBrowserAuth({ config: { clientId, issuer, redirectUri: `${issuer}/invite.html`, resource }, origin: issuer,
      storage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) },
      now: () => 1_000_000, cryptoApi: { subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(++random) } });
    async function follow(response: Awaited<ReturnType<typeof browserGet>>) {
      for (let redirects = 0; redirects < 10; redirects++) {
        const location = response.headers.location;
        if (!location || new URL(location, issuer).pathname === "/invite.html") return response;
        response = await browserGet(app, localPath(location, issuer), cookies);
      }
      throw new Error("Browser sign-in exceeded its redirect limit");
    }
    async function signIn() {
      const login = await follow(await browserGet(app, localPath(await auth.start(), issuer), cookies));
      expect(login.status).toBe(200);
      expect(login.text).toContain('name="password"');
      return follow(await browserPost(app, new URL(login.request.url).pathname + "/login", {
        csrf: csrfFrom(login.text), username: "returning@example.com", password: "synthetic-password",
      }, cookies));
    }

    // Completing account setup may precede issuing a code. Continuing here saves
    // a real provider grant but must not create family membership.
    const firstConsent = await signIn();
    expect(firstConsent.status).toBe(200);
    expect(firstConsent.text).toContain("Review invitation");
    const firstCallback = await follow(await browserPost(app, new URL(firstConsent.request.url).pathname + "/consent", {
      csrf: csrfFrom(firstConsent.text),
    }, cookies));
    const firstRedirect = new URL(requiredLocation(firstCallback.headers.location), issuer);
    expect(firstRedirect.pathname).toBe("/invite.html");
    expect(firstRedirect.searchParams.get("code")).toBeTruthy();
    expect(firstRedirect.searchParams.has("error")).toBe(false);
    expect(review).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
    await expect(requireMembership(access, principal, "read")).rejects.toThrow("Family access denied");

    // Reuse the same provider, account and cookies: a preexisting OAuth grant
    // must not hide the only form where this nonmember can review a new code.
    const secondConsent = await signIn();
    expect(secondConsent.status, "Returning account skipped invitation entry").toBe(200);
    expect(secondConsent.text).toContain("Review invitation");
    const interactionPath = new URL(secondConsent.request.url).pathname;
    const reviewed = await browserPost(app, `${interactionPath}/invitation`, {
      csrf: csrfFrom(secondConsent.text), invitation: code,
    }, cookies);
    expect(reviewed.status).toBe(200);
    expect(reviewed.text).toContain("Evelyn&#39;s family");
    expect(reviewed.text).toContain('name="familyConsent"');
    const proof = reviewed.text.match(/name="invitationProof" value="([a-f0-9]{64})"/)?.[1];
    expect(proof).toBeTruthy();
    const form = { csrf: csrfFrom(reviewed.text), invitation: code, invitationProof: proof! };
    const unconsented = await browserPost(app, `${interactionPath}/consent`, form, cookies);
    expect(unconsented.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    await expect(requireMembership(access, principal, "read")).rejects.toThrow("Family access denied");

    const joined = await follow(await browserPost(app, `${interactionPath}/consent`, { ...form, familyConsent: familyConsentVersion }, cookies));
    const joinedRedirect = new URL(requiredLocation(joined.headers.location), issuer);
    expect(joinedRedirect.pathname).toBe("/invite.html");
    expect(joinedRedirect.searchParams.get("code")).toBeTruthy();
    expect(joinedRedirect.searchParams.has("error")).toBe(false);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(await requireMembership(access, principal, "read")).toMatchObject({ memberId: "theo", role: "viewer", status: "active" });
  });
});

type StoredPayload = Record<string, unknown> & { uid?: string; userCode?: string; grantId?: string };

class MemoryAdapter {
  static #records = new Map<string, StoredPayload>();
  readonly #model: string;

  constructor(model: string) {
    this.#model = model;
  }

  static reset() {
    this.#records.clear();
  }

  async upsert(id: string, payload: StoredPayload) {
    MemoryAdapter.#records.set(this.key(id), structuredClone(payload));
  }

  async find(id: string) {
    return MemoryAdapter.#records.get(this.key(id));
  }

  async findByUid(uid: string) {
    return this.findBy("uid", uid);
  }

  async findByUserCode(userCode: string) {
    return this.findBy("userCode", userCode);
  }

  async consume(id: string) {
    const payload = await this.find(id);
    if (payload) MemoryAdapter.#records.set(this.key(id), { ...payload, consumed: Math.floor(Date.now() / 1_000) });
  }

  async destroy(id: string) {
    MemoryAdapter.#records.delete(this.key(id));
  }

  async revokeByGrantId(grantId: string) {
    for (const [key, payload] of MemoryAdapter.#records) {
      if (payload.grantId === grantId) MemoryAdapter.#records.delete(key);
    }
  }

  private key(id: string) {
    return `${this.#model}:${id}`;
  }

  private async findBy(field: "uid" | "userCode", value: string) {
    for (const [key, payload] of MemoryAdapter.#records) {
      if (key.startsWith(`${this.#model}:`) && payload[field] === value) return payload;
    }
    return undefined;
  }
}

async function browserGet(
  app: Awaited<ReturnType<typeof createConfiguredOAuthApp>>,
  path: string,
  cookies: Map<string, string>,
) {
  const response = await request(app)
    .get(path)
    .set("Host", "api-id.execute-api.us-east-1.amazonaws.com")
    .set("X-Forwarded-Proto", "https")
    .set("Cookie", [...cookies.values()].join("; "));
  captureCookies(response.headers["set-cookie"], cookies);
  return response;
}

async function browserPost(
  app: Awaited<ReturnType<typeof createConfiguredOAuthApp>>,
  path: string,
  body: Record<string, string>,
  cookies: Map<string, string>,
) {
  const response = await request(app)
    .post(path)
    .set("Host", "api-id.execute-api.us-east-1.amazonaws.com")
    .set("X-Forwarded-Proto", "https")
    .set("Cookie", [...cookies.values()].join("; "))
    .type("form")
    .send(body);
  captureCookies(response.headers["set-cookie"], cookies);
  return response;
}

function captureCookies(headers: string | string[] | undefined, jar: Map<string, string>) {
  for (const header of typeof headers === "string" ? [headers] : headers ?? []) {
    const pair = header.split(";", 1)[0];
    if (!pair) continue;
    const name = pair.split("=", 1)[0];
    if (name) jar.set(name, pair);
  }
}

function localPath(location: string | undefined, issuer: string) {
  const url = new URL(requiredLocation(location), issuer);
  return `${url.pathname}${url.search}`;
}

function requiredLocation(location: string | undefined) {
  if (!location) throw new Error("Expected redirect location");
  return location;
}

function csrfFrom(html: string) {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  if (!match?.[1]) throw new Error("CSRF token not found");
  return match[1];
}
