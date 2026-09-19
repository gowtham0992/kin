import { createHash } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createJwtAccessAuthorizer } from "../src/auth.js";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { planMissedTaskEscalations } from "../src/escalation.js";
import { createHttpApp } from "../src/http.js";
import { InvalidCredentialsError } from "../src/cognito-authenticator.js";
import { createOAuthInteractionRouter } from "../src/oauth-interactions.js";
import { createKinOAuthProvider } from "../src/oauth-provider.js";
import { taskReview } from "../src/task-review.js";
import { desktopAuthConfig, desktopClientId, desktopRedirectUri } from "../src/desktop-auth-config.js";
import { createDesktopSession, desktopFetch } from "../scripts/lib/mcp-desktop-session.js";

const issuer = "https://family-release.example";
const clientId = "kin-family-release-browser";
const redirectUri = `${issuer}/invite.html`;
const resource = `${issuer}/mcp`;
const jwksUri = `${issuer}/jwks`;
const circleId = "synthetic-release-circle";
const accounts = {
  maya: { accountId: "synthetic-maya-account", username: "maya@example.test", password: "synthetic-maya-password" },
  evelyn: { accountId: "synthetic-evelyn-account", username: "evelyn@example.test", password: "synthetic-evelyn-password" },
} as const;
type Person = keyof typeof accounts;
let privateJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateJwk = { ...await exportJWK(pair.privateKey), alg: "RS256", use: "sig", kid: "synthetic-release-key" };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture() {
  const networkFetch = globalThis.fetch;
  // Persistence and upstream credentials are synthetic. Provider interactions, grants,
  // PKCE, signatures, JWT checks, membership rules, HTTP routes and care writes are real.
  const records = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();
  class Adapter {
    constructor(private model: string) {}
    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      records.set(`${this.model}:${id}`, { payload: structuredClone(payload), expiresAt: Date.now() + expiresIn * 1_000 });
    }
    async find(id: string) {
      const record = records.get(`${this.model}:${id}`);
      return record && record.expiresAt > Date.now() ? structuredClone(record.payload) : undefined;
    }
    async findByUid(uid: string) {
      const record = [...records.entries()].find(([key, value]) => key.startsWith(`${this.model}:`) && value.payload.uid === uid)?.[1];
      return record && record.expiresAt > Date.now() ? structuredClone(record.payload) : undefined;
    }
    async destroy(id: string) { records.delete(`${this.model}:${id}`); }
    async consume(id: string) {
      const record = records.get(`${this.model}:${id}`);
      if (record) record.payload.consumed = Math.floor(Date.now() / 1_000);
    }
    async revokeByGrantId(grantId: string) {
      for (const [key, record] of records) if (record.payload.grantId === grantId) records.delete(key);
    }
  }
  const provider = createKinOAuthProvider({ issuer, resourceUri: resource, jwks: { keys: [privateJwk] },
    cookieKeys: ["a".repeat(32), "b".repeat(32)], adapter: Adapter,
    serviceClient: { clientId: "synthetic-service-client", clientSecret: "synthetic-service-secret" },
    browserClient: { clientId, redirectUri },
    desktopClient: desktopAuthConfig(),
    findAccount: async accountId => Object.values(accounts).some(account => account.accountId === accountId)
      ? { accountId, claims: async () => ({ sub: accountId }) } : undefined,
  });
  const oauth = express();
  const authenticate = vi.fn(async (username: string, password: string) => {
    const account = Object.values(accounts).find(item => item.username === username && item.password === password);
    if (!account) throw new InvalidCredentialsError();
    return { accountId: account.accountId, username: account.username };
  });
  oauth.use(createOAuthInteractionRouter({ provider, resourceUri: resource, csrfSecret: "s".repeat(32),
    browserClientId: clientId, desktopClientId, authenticator: { authenticate } }));
  oauth.use(provider.callback());

  // Bridge only this exact HTTPS JWKS URL to the real provider's public-key endpoint.
  // Unexpected outbound requests fail closed; no AWS, DNS, TLS or internet is used.
  const jwksFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== jwksUri || (init?.method ?? "GET") !== "GET") throw new Error("Unexpected release-test network request");
    const result = await request(oauth).get("/jwks").set("Host", "family-release.example").set("X-Forwarded-Proto", "https");
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", jwksFetch);
  const authorizer = createJwtAccessAuthorizer({ issuer, audience: resource, jwksUri });
  const membershipKey = (subject: string) => JSON.stringify([issuer, subject]);
  const memberships = new Map<string, Record<string, unknown>>([
    [membershipKey(accounts.maya.accountId), { circleId, memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: true }],
    [membershipKey(accounts.evelyn.accountId), { circleId, memberId: "evelyn", name: "Evelyn", role: "care_recipient", status: "active" }],
  ]);
  let clock = new Date("2026-09-08T15:00:00.000Z");
  const store = new InMemoryCareStore([], () => new Date(clock), null, "America/Denver");
  const api = createHttpApp(store, undefined, { accessAuthorizer: authorizer,
    mcpAuthMode: "standard", canonicalMcpUri: resource, authorizationServer: issuer,
    familyAccess: { circleId, directory: { async find(principal) {
      return structuredClone(memberships.get(JSON.stringify([principal.claims.iss, principal.subject])) ?? null);
    } } },
    serveSimulator: false, serveFamilyWorkspace: true, browserAuth: { clientId, issuer, redirectUri, resource },
  });

  async function completeAuthorization(person: Person, authorizationUrl: URL, decision: "allow" | "deny" = "allow") {
    const account = accounts[person];
    const desktop = authorizationUrl.searchParams.get("client_id") === desktopClientId;
    const expectedRedirect = desktop ? desktopRedirectUri : redirectUri;
    const state = authorizationUrl.searchParams.get("state");
    expect(authorizationUrl.origin).toBe(issuer);
    // Each invocation has an independent browser cookie jar, including signed session cookies.
    const cookies = new Map<string, string>();
    const prompts: string[] = [];
    async function visit(location: string, body?: Record<string, string>) {
      const url = new URL(location, issuer);
      expect(url.origin).toBe(issuer);
      const req = body ? request(oauth).post(url.pathname + url.search).type("form").send(body)
        : request(oauth).get(url.pathname + url.search);
      req.set("Host", "family-release.example").set("X-Forwarded-Proto", "https");
      if (cookies.size) req.set("Cookie", [...cookies.values()].join("; "));
      const response = await req;
      for (const cookie of response.headers["set-cookie"] ?? []) {
        const value = cookie.split(";")[0]!;
        cookies.set(value.split("=")[0]!, value);
      }
      return response;
    }
    let response = await visit(authorizationUrl.href);
    for (let step = 0; step < 16; step++) {
      const location = response.headers.location;
      if (location && new URL(location, issuer).origin + new URL(location, issuer).pathname === expectedRedirect) {
        const callback = new URL(location, issuer);
        expect(callback.searchParams.get("state")).toBe(state);
        expect(callback.searchParams.get("iss")).toBe(issuer);
        expect(prompts).toEqual(["login", "consent"]);
        return { callback, cookies, prompts };
      }
      if (location) { response = await visit(location); continue; }
      expect(response.status, response.text).toBe(200);
      const action = response.text.match(/<form[^>]+action="([^"]+)"/)?.[1];
      const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
      expect(action).toBeTruthy(); expect(csrf).toBeTruthy();
      const isLogin = action!.endsWith("/login");
      expect(isLogin || action!.endsWith("/consent")).toBe(true);
      prompts.push(isLogin ? "login" : "consent");
      if (!isLogin) expect(response.text).toContain(desktop ? "Connect Kin to the desktop acceptance client" : "Open your family workspace");
      response = await visit(!isLogin && decision === "deny" ? action!.replace(/\/consent$/, "/cancel") : action!,
        { csrf: csrf!, ...(isLogin ? { username: account.username, password: account.password } : {}) });
    }
    throw new Error("Authorization never reached the browser callback");
  }
  async function signIn(person: Person, scope = "mcp:tools mcp:resources") {
    const verifier = `${person}-`.padEnd(64, "v");
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope, resource, state: `synthetic-${person}-state`, prompt: "login consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    const { callback, cookies, prompts } = await completeAuthorization(person, new URL(`/auth?${params}`, issuer));
    expect(callback.searchParams.has("error")).toBe(false);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    const exchange = await request(oauth).post("/token").type("form").send({ grant_type: "authorization_code",
      client_id: clientId, redirect_uri: redirectUri, resource, code, code_verifier: verifier });
    expect(exchange.status, exchange.text).toBe(200);
    expect(exchange.body.refresh_token).toBeUndefined();
    expect(typeof exchange.body.access_token).toBe("string");
    return { token: exchange.body.access_token as string, cookies, prompts };
  }
  const sdkRequests: Array<{ method: string; path: string; status: number }> = [];
  // Only HTTPS wire I/O is bridged: discovery, bearer checks, provider metadata,
  // token exchange and MCP/SSE response bodies all come from the actual applications.
  const sdkFetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (url.origin !== issuer || url.search || url.hash) throw new Error("Unexpected OAuth SDK test destination");
    const apiRoute = (url.pathname === "/mcp" && ["GET", "POST"].includes(method)) ||
      (method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname));
    const oauthRoute = (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") ||
      (method === "POST" && url.pathname === "/token");
    if (!apiRoute && !oauthRoute) throw new Error("Unexpected OAuth SDK test route");
    const app = apiRoute ? api : oauth;
    const req = method === "POST" ? request(app).post(url.pathname) : request(app).get(url.pathname);
    for (const [name, value] of new Headers(init?.headers)) req.set(name, value);
    req.set("Host", "family-release.example").set("X-Forwarded-Proto", "https");
    if (init?.body !== undefined) {
      if (typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) throw new Error("Unexpected OAuth SDK test body");
      req.send(init.body.toString());
    }
    const response = await req;
    sdkRequests.push({ method, path: url.pathname, status: response.status });
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) headers.set(name, String(value));
    return new Response([202, 204, 304].includes(response.status) ? null : response.text, { status: response.status, headers });
  };
  const get = (path: string, token: string) => request(api).get(path).auth(token, { type: "bearer" });
  const post = (path: string, token: string, body: object) => request(api).post(path).auth(token, { type: "bearer" }).send(body);
  const schedule = async (token: string) => {
    const response = await post("/api/tasks", token, { title: "Drink a glass of water", dueAt: "2026-09-08T15:05:00.000Z", requestId: "release-schedule-water" });
    expect(response.status, response.text).toBe(200);
    return response.body.task as CareTask;
  };
  const serviceToken = async () => {
    const response = await request(oauth).post("/token")
      .auth("synthetic-service-client", "synthetic-service-secret").type("form")
      .send({ grant_type: "client_credentials", scope: "mcp:service", resource });
    expect(response.status, response.text).toBe(200);
    expect(response.body.scope).toBe("mcp:service");
    return response.body.access_token as string;
  };
  return { api, store, signIn, completeAuthorization, sdkFetch, sdkRequests, get, post, schedule, serviceToken, authorizer, authenticate, jwksFetch, networkFetch,
    setClock: (value: string) => { clock = new Date(value); }, now: () => new Date(clock),
    changeMembership: (person: Person, change: Record<string, unknown>) => {
      const key = membershipKey(accounts[person].accountId);
      memberships.set(key, { ...memberships.get(key), ...change });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function sdkAuthorizationSession(f: Fixture) {
  let tokens: OAuthTokens | undefined;
  let verifier: string | undefined;
  const redirects: URL[] = [];
  const state = "synthetic-mcp-sdk-session-state";
  const authProvider: OAuthClientProvider = {
    redirectUrl: redirectUri,
    clientMetadata: { redirect_uris: [redirectUri], grant_types: ["authorization_code"],
      response_types: ["code"], token_endpoint_auth_method: "none" },
    clientInformation: () => ({ client_id: clientId, token_endpoint_auth_method: "none" }),
    state: () => state,
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => {
      if (!verifier) throw new Error("SDK has not created a PKCE verifier");
      return verifier;
    },
    redirectToAuthorization: url => { redirects.push(new URL(url)); },
  };
  return {
    redirects, state,
    tokens: () => tokens,
    verifier: () => verifier,
    replaceVerifier: (value: string) => { verifier = value; },
    connectable: () => ({
      client: new Client({ name: "kin-oauth-discovery-test", version: "0.1.0" }),
      transport: new StreamableHTTPClientTransport(new URL(resource), { authProvider, fetch: f.sdkFetch }),
    }),
  };
}

async function withSdkClient(f: Fixture, token: string, run: (client: Client) => Promise<void>) {
  const server = f.api.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback test address");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "kin-authenticated-interoperability-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (input, init) => {
      const url = new URL(input).href;
      if (url !== endpoint.href) throw new Error("Unexpected MCP test network request");
      return f.networkFetch(input, init);
    },
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    try { await client.close(); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
}
async function expectDeniedWrites(f: Fixture, token: string, task: CareTask, status: number, error: string) {
  const before = await f.store.today();
  const confirm = vi.spyOn(f.store, "confirm");
  const schedule = vi.spyOn(f.store, "scheduleTask");
  const acknowledgment = vi.spyOn(f.store, "acknowledgeEscalation");
  const responses = [
    await f.post(`/api/tasks/${task.id}/confirm`, token, { response: "done", actor: "Maya", requestId: "denied-confirmation", expected: taskReview(task) }),
    await f.post("/api/tasks", token, { title: "Unauthorized check-in", dueAt: "2026-09-08T15:10:00.000Z", requestId: "denied-schedule-task" }),
    await f.post(`/api/escalations/${encodeURIComponent(`missed_${task.id}_${task.dueAt}`)}/acknowledge`, token, { confirm: true }),
  ];
  for (const response of responses) { expect(response.status, response.text).toBe(status); expect(response.body).toEqual({ error }); }
  expect(confirm).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
  expect(acknowledgment).not.toHaveBeenCalled();
  expect(await f.store.today()).toEqual(before);
}

describe("two-account local family release journey", () => {
  it("uses the independent desktop session through actual OAuth and SDK care reads without a care write", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya"); await f.schedule(maya.token);
    const before = await f.store.today();
    const redirects: URL[] = [];
    const session = createDesktopSession(new URL(resource), url => { redirects.push(url); });
    const fetch = desktopFetch(new URL(resource), f.sdkFetch);
    const initial = new Client({ name: "kin-independent-desktop-test", version: "0.1.0" });
    const reader = new Client({ name: "kin-independent-desktop-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: session.provider, fetch });
    try {
      await expect(initial.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(redirects).toHaveLength(1);
      expect(redirects[0]!.searchParams.get("client_id")).toBe(desktopClientId);
      const { callback } = await f.completeAuthorization("evelyn", redirects[0]!);
      const code = session.acceptCallback({ method: "GET", host: callback.host, url: callback.pathname + callback.search });
      await transport.finishAuth(code);
      expect(decodeJwt((await session.provider.tokens())!.access_token)).toMatchObject({
        client_id: desktopClientId, sub: accounts.evelyn.accountId, aud: resource, scope: "mcp:tools mcp:resources",
      });
      await reader.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: session.provider, fetch }));
      expect((await reader.listTools()).tools.some(tool => tool.name === "show_today")).toBe(true);
      expect((await reader.listResources()).resources.some(item => item.uri === "ui://kin/today.html")).toBe(true);
      expect(await reader.callTool({ name: "show_today", arguments: {} })).toMatchObject({ structuredContent: before });
      expect((await reader.readResource({ uri: "ui://kin/today.html" })).contents[0]).toMatchObject({ uri: "ui://kin/today.html" });
      expect(await f.store.today()).toEqual(before);
      expect(f.sdkRequests.some(item => item.path === "/token" && item.status === 200)).toBe(true);
    } finally {
      await Promise.allSettled([initial.close(), reader.close()]); session.dispose();
    }
  });
  it("discovers OAuth from the MCP challenge and completes SDK PKCE sign-in before reading and saving care", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya");
    const task = await f.schedule(maya.token);
    const session = sdkAuthorizationSession(f);
    const initial = session.connectable(), authorized = session.connectable();
    try {
      expect(session.tokens()).toBeUndefined();
      await expect(initial.client.connect(initial.transport)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(session.redirects).toHaveLength(1);
      expect(f.sdkRequests).toContainEqual({ method: "POST", path: "/mcp", status: 401 });
      expect(f.sdkRequests).toContainEqual({ method: "GET", path: "/.well-known/oauth-protected-resource", status: 200 });
      expect(f.sdkRequests).toContainEqual({ method: "GET", path: "/.well-known/oauth-authorization-server", status: 200 });
      const authorizationUrl = session.redirects[0]!;
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${issuer}/auth`);
      expect(authorizationUrl.searchParams.get("scope")).toBe("mcp:tools mcp:resources");
      expect(authorizationUrl.searchParams.get("resource")).toBe(resource);
      expect(authorizationUrl.searchParams.get("client_id")).toBe(clientId);
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(authorizationUrl.searchParams.get("state")).toBe(session.state);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(session.verifier()).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(authorizationUrl.searchParams.get("code_challenge")).toBe(createHash("sha256").update(session.verifier()!).digest("base64url"));
      expect(session.tokens()).toBeUndefined();
      const { callback } = await f.completeAuthorization("evelyn", authorizationUrl);
      expect(callback.searchParams.get("state")).toBe(session.state);
      expect(callback.searchParams.has("error")).toBe(false);
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();
      await initial.transport.finishAuth(code!);
      expect(f.sdkRequests).toContainEqual({ method: "POST", path: "/token", status: 200 });
      expect(session.tokens()).toMatchObject({ token_type: "Bearer", scope: "mcp:tools mcp:resources" });
      expect(session.tokens()!.refresh_token).toBeUndefined();
      expect(decodeJwt(session.tokens()!.access_token)).toMatchObject({ iss: issuer, aud: resource,
        sub: accounts.evelyn.accountId, scope: "mcp:tools mcp:resources" });
      await authorized.client.connect(authorized.transport);
      expect((await authorized.client.listTools()).tools.map(tool => tool.name)).toContain("confirm_care_task");
      const today = await authorized.client.callTool({ name: "show_today", arguments: {} });
      expect(today.isError).toBeFalsy();
      expect(today.structuredContent).toMatchObject({ tasks: [task] });
      const saved = await authorized.client.callTool({ name: "confirm_care_task", arguments: {
        taskId: task.id, response: "done", actor: "Untrusted client label", requestId: "sdk-oauth-parent-done", expected: taskReview(task),
      } });
      expect(saved.isError).toBeFalsy();
      expect(saved.structuredContent).toMatchObject({ task: { id: task.id, state: "done", confirmedBy: "Evelyn" } });
      const caregiverView = await f.get("/api/today", maya.token);
      expect(caregiverView.body.summary).toMatchObject({ total: 1, completed: 1 });
      expect(session.redirects).toHaveLength(1);
    } finally { await Promise.all([initial.client.close(), authorized.client.close()]); }
  });

  it("rejects the SDK authorization code when its PKCE verifier belongs to another session", async () => {
    const f = await fixture();
    const session = sdkAuthorizationSession(f);
    const { client, transport } = session.connectable();
    try {
      await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      const { callback } = await f.completeAuthorization("evelyn", session.redirects[0]!);
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();
      session.replaceVerifier("wrong-session-verifier".padEnd(64, "x"));
      await expect(transport.finishAuth(code!)).rejects.toBeInstanceOf(InvalidGrantError);
      expect(f.sdkRequests).toContainEqual({ method: "POST", path: "/token", status: 400 });
      expect(session.tokens()).toBeUndefined();
      expect((await f.store.today()).tasks).toEqual([]);
    } finally { await client.close(); }
  });

  it("does not receive an authorization code or token when the family member declines SDK consent", async () => {
    const f = await fixture();
    const session = sdkAuthorizationSession(f);
    const { client, transport } = session.connectable();
    try {
      await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      const { callback } = await f.completeAuthorization("evelyn", session.redirects[0]!, "deny");
      expect(callback.searchParams.get("state")).toBe(session.state);
      expect(callback.searchParams.get("error")).toBe("access_denied");
      expect(callback.searchParams.has("code")).toBe(false);
      expect(session.tokens()).toBeUndefined();
      expect(f.sdkRequests.some(item => item.path === "/token")).toBe(false);
      expect((await f.store.today()).tasks).toEqual([]);
    } finally { await client.close(); }
  });

  it("connects a standard MCP SDK client with a real user grant and saves a reviewed reply exactly once", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    const task = await f.schedule(maya.token);
    expect(decodeJwt(evelyn.token).scope).toBe("mcp:tools mcp:resources");
    await withSdkClient(f, evelyn.token, async client => {
      expect(client.getServerVersion()).toEqual({ name: "kin", version: "0.1.0" });
      await expect(client.ping()).resolves.toEqual({});
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        "review_plan_pause", "pause_care_plan", "undo_care_completion",
        "show_today", "show_weekly_brief", "confirm_care_task",
      ]);
      const today = await client.callTool({ name: "show_today", arguments: {} });
      expect(today.isError).toBeFalsy();
      expect(today.structuredContent).toMatchObject({ tasks: [task], summary: { total: 1, completed: 0 } });
      f.setClock("2026-09-08T15:06:00.000Z");
      const input = { taskId: task.id, response: "done", actor: "Forged caregiver name",
        requestId: "mcp-release-parent-done", expected: taskReview(task) };
      const saved = await client.callTool({ name: "confirm_care_task", arguments: input });
      expect(saved.isError).toBeFalsy();
      expect(saved.structuredContent).toMatchObject({
        task: { id: task.id, state: "done", confirmedBy: "Evelyn", confirmedAt: f.now().toISOString() },
        confirmation: { taskId: task.id, requestId: input.requestId, response: "done", actor: "Evelyn" },
      });
      const savedState = saved.structuredContent as { task: CareTask; confirmation: unknown };
      const caregiverView = await f.get("/api/today", maya.token);
      expect(caregiverView.status).toBe(200);
      expect(caregiverView.body.tasks).toEqual([savedState.task]);
      f.setClock("2026-09-08T15:07:00.000Z");
      const retry = await client.callTool({ name: "confirm_care_task", arguments: input });
      expect(retry.isError).toBeFalsy();
      expect(retry.structuredContent).toMatchObject({ confirmation: savedState.confirmation, task: savedState.task });
      expect(retry.content).toContainEqual({ type: "text", text: `That confirmation was already recorded for ${task.title}.` });
      const conflictingIntent = await client.callTool({ name: "confirm_care_task", arguments: { ...input, response: "skipped" } });
      expect(conflictingIntent.isError).toBe(true);
      expect(conflictingIntent.structuredContent).toEqual({ code: "confirmation_conflict" });
      const stale = await client.callTool({ name: "confirm_care_task", arguments: { ...input, requestId: "mcp-stale-parent-review" } });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toEqual({ code: "review_conflict" });
      expect((await f.store.today()).tasks).toEqual([savedState.task]);

      const resources = await client.listResources();
      expect(resources.resources.map(item => item.uri)).toEqual(["ui://kin/today.html"]);
      const widget = await client.readResource({ uri: "ui://kin/today.html" });
      expect(widget.contents).toHaveLength(1);
      expect(widget.contents[0]).toMatchObject({ uri: "ui://kin/today.html", mimeType: "text/html;profile=mcp-app" });
      expect(widget.contents[0] && "text" in widget.contents[0] ? widget.contents[0].text : "").toContain("ui/initialize");
    });
  });

  it.each([
    ["revoked", { status: "revoked" }],
    ["another circle", { circleId: "different-synthetic-circle" }],
  ])("rechecks %s membership on every MCP care call after the client has initialized", async (_label, change) => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    const task = await f.schedule(maya.token);
    await withSdkClient(f, evelyn.token, async client => {
      expect((await client.callTool({ name: "show_today", arguments: {} })).structuredContent).toMatchObject({ tasks: [task] });
      f.changeMembership("evelyn", change);
      await expect(client.callTool({ name: "show_today", arguments: {} })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("family_access_denied") });
      await expect(client.callTool({ name: "confirm_care_task", arguments: {
        taskId: task.id, response: "done", actor: "Maya", requestId: "mcp-revoked-confirmation", expected: taskReview(task),
      } })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("family_access_denied") });
      await expect(client.readResource({ uri: "ui://kin/today.html" })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("family_access_denied") });
      expect((await f.store.today()).tasks).toEqual([task]);
    });
  });

  it("allows a signed-in viewer to read through MCP but not forge a parent confirmation", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    const task = await f.schedule(maya.token);
    f.changeMembership("evelyn", { role: "viewer" });
    await withSdkClient(f, evelyn.token, async client => {
      expect((await client.callTool({ name: "show_today", arguments: {} })).structuredContent).toMatchObject({ tasks: [task] });
      await expect(client.callTool({ name: "confirm_care_task", arguments: {
        taskId: task.id, response: "done", actor: "Maya", requestId: "mcp-viewer-confirmation", expected: taskReview(task),
      } })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("family_access_denied") });
      expect((await f.store.today()).tasks).toEqual([task]);
    });
  });

  it("keeps a real service-only grant limited to MCP discovery, without family data or writes", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya");
    const task = await f.schedule(maya.token);
    const token = await f.serviceToken();
    expect(decodeJwt(token).scope).toBe("mcp:service");
    await withSdkClient(f, token, async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        "show_today", "show_weekly_brief", "confirm_care_task",
      ]);
      await expect(client.callTool({ name: "show_today", arguments: {} })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("insufficient_scope") });
      await expect(client.callTool({ name: "confirm_care_task", arguments: {
        taskId: task.id, response: "done", actor: "Maya", requestId: "mcp-service-confirmation", expected: taskReview(task),
      } })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("insufficient_scope") });
      await expect(client.readResource({ uri: "ui://kin/today.html" })).rejects.toMatchObject({ code: 403, message: expect.stringContaining("insufficient_scope") });
      expect((await f.store.today()).tasks).toEqual([task]);
    });
  });

  it.each(["mcp:resources", "mcp:tools"])("keeps a narrow %s user grant limited to its own care capability", async scope => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn", scope);
    const task = await f.schedule(maya.token);
    expect(decodeJwt(evelyn.token).scope).toBe(scope);
    // A bearer-only SDK transport cannot silently request a broader replacement grant.
    await withSdkClient(f, evelyn.token, async client => {
      expect(client.getServerVersion()).toEqual({ name: "kin", version: "0.1.0" });
      await expect(client.ping()).resolves.toEqual({});
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("show_today");
      if (scope === "mcp:resources") {
        expect((await client.listResources()).resources.map(item => item.uri)).toEqual(["ui://kin/today.html"]);
        const widget = await client.readResource({ uri: "ui://kin/today.html" });
        expect(widget.contents[0]).toMatchObject({ uri: "ui://kin/today.html", mimeType: "text/html;profile=mcp-app" });
        await expect(client.callTool({ name: "show_today", arguments: {} })).rejects.toMatchObject({
          code: 403, message: expect.stringContaining("insufficient_scope"),
        });
      } else {
        const today = await client.callTool({ name: "show_today", arguments: {} });
        expect(today.isError).toBeFalsy();
        expect(today.structuredContent).toMatchObject({ tasks: [task] });
        await expect(client.readResource({ uri: "ui://kin/today.html" })).rejects.toMatchObject({
          code: 403, message: expect.stringContaining("insufficient_scope"),
        });
      }
      expect((await f.store.today()).tasks).toEqual([task]);
    });
  });

  it("connects real sign-in, shared scheduling, reviewed parent replies and caregiver-only follow-up acknowledgment", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    expect([...maya.cookies.values()]).not.toEqual([...evelyn.cookies.values()]);
    expect(f.authenticate.mock.calls.map(([username]) => username)).toEqual([accounts.maya.username, accounts.evelyn.username]);
    const mayaSession = await f.get("/api/session", maya.token), evelynSession = await f.get("/api/session", evelyn.token);
    expect(mayaSession.status).toBe(200); expect(evelynSession.status).toBe(200);
    expect(mayaSession.body).toMatchObject({ name: "Maya", memberId: "maya", role: "caregiver", permissions: { invite: true, manageDuty: true } });
    expect(evelynSession.body).toMatchObject({ name: "Evelyn", memberId: "evelyn", role: "care_recipient", permissions: { invite: false, manageDuty: false, confirm: true } });
    expect(f.jwksFetch).toHaveBeenCalled();
    const task = await f.schedule(maya.token);
    const parentView = await f.get("/api/today", evelyn.token);
    expect(parentView.status).toBe(200); expect(parentView.headers["cache-control"]).toBe("no-store");
    expect(parentView.body.tasks).toEqual([task]);
    const schedule = vi.spyOn(f.store, "scheduleTask");
    const deniedSchedule = await f.post("/api/tasks", evelyn.token, { title: "Parent cannot schedule", dueAt: "2026-09-08T15:10:00.000Z", requestId: "parent-forged-schedule" });
    expect(deniedSchedule.status).toBe(403); expect(schedule).not.toHaveBeenCalled();

    f.setClock("2026-09-08T15:06:00.000Z");
    const reply = { response: "not_yet", actor: "Forged caregiver name", requestId: "release-parent-not-yet", expected: taskReview(task) };
    const saved = await f.post(`/api/tasks/${task.id}/confirm`, evelyn.token, reply);
    expect(saved.status).toBe(201);
    expect(saved.body.task).toMatchObject({ state: "scheduled", lastResponse: "not_yet", confirmedBy: "Evelyn", confirmedAt: f.now().toISOString() });
    expect(saved.body.confirmation).toMatchObject({ actor: "Evelyn", requestId: reply.requestId });
    expect((await f.get("/api/today", maya.token)).body.tasks).toEqual([saved.body.task]);
    const retry = await f.post(`/api/tasks/${task.id}/confirm`, evelyn.token, reply);
    expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true); expect(retry.body.confirmation).toEqual(saved.body.confirmation);
    const stale = await f.post(`/api/tasks/${task.id}/confirm`, maya.token, { ...reply, response: "done", requestId: "release-stale-maya-review" });
    expect(stale.status).toBe(409); expect(stale.body).toEqual({ error: "review_conflict" });
    expect((await f.store.today()).tasks).toEqual([saved.body.task]);

    // A synthetic missing-duty follow-up exercises real planning and persistence without a publisher.
    f.setClock("2026-09-08T15:37:00.000Z");
    const plan = planMissedTaskEscalations({ snapshot: await f.store.escalationSnapshot(f.now()), now: f.now() });
    expect(plan.events).toEqual([]); expect(plan.blocked).toHaveLength(1);
    const { record } = (await f.store.queueEscalation(plan.blocked[0]!))!;
    const acknowledgment = vi.spyOn(f.store, "acknowledgeEscalation");
    const ackPath = `/api/escalations/${encodeURIComponent(record.id)}/acknowledge`;
    const recipientAck = await f.post(ackPath, evelyn.token, { confirm: true });
    expect(recipientAck.status).toBe(403); expect(recipientAck.body).toEqual({ error: "family_access_denied" });
    expect(acknowledgment).not.toHaveBeenCalled();
    expect((await f.store.today()).escalations[0]?.acknowledgedBy).toBeUndefined();
    const ack = await f.post(ackPath, maya.token, { confirm: true });
    expect(ack.status).toBe(200); expect(ack.body).toMatchObject({ id: record.id, acknowledgedBy: "Maya", acknowledgedAt: f.now().toISOString() });
    expect(acknowledgment).toHaveBeenCalledExactlyOnceWith(
      { id: record.id, memberId: "maya", name: "Maya" },
      expect.objectContaining({
        member: expect.objectContaining({ memberId: "maya", role: "caregiver", status: "active" }),
        assertCurrent: expect.any(Function),
      }),
    );
    expect((await f.get("/api/today", evelyn.token)).body.escalations).toEqual([ack.body]);
    const done = await f.post(`/api/tasks/${task.id}/confirm`, evelyn.token, { response: "done", actor: "Maya", requestId: "release-parent-done", expected: taskReview(saved.body.task) });
    expect(done.status).toBe(201); expect(done.body.task).toMatchObject({ state: "done", confirmedBy: "Evelyn" });
    expect((await f.get("/api/today", maya.token)).body.summary).toMatchObject({ total: 1, completed: 1, remaining: 0 });
  });

  it("rejects a real token whose subject and role were tampered with before any care write", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    const task = await f.schedule(maya.token);
    expect((await f.get("/api/session", evelyn.token)).status).toBe(200);
    const [header, payload, signature] = evelyn.token.split(".");
    const altered = { ...JSON.parse(Buffer.from(payload!, "base64url").toString()), sub: accounts.maya.accountId, role: "caregiver" };
    const tampered = `${header}.${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;
    expect((await f.get("/api/session", tampered)).status).toBe(401);
    await expectDeniedWrites(f, tampered, task, 401, "invalid_token");
  });

  it("rejects a genuinely signed provider token after its expiry before any care write", async () => {
    const f = await fixture();
    const maya = await f.signIn("maya");
    const task = await f.schedule(maya.token);
    const expiry = decodeJwt(maya.token).exp;
    expect(typeof expiry).toBe("number");
    // Only time is advanced. The provider-issued token and its valid signature stay unchanged.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date((expiry! + 1) * 1_000));
    expect((await f.get("/api/session", maya.token)).status).toBe(401);
    await expectDeniedWrites(f, maya.token, task, 401, "invalid_token");
  });

  it.each([
    ["revoked", { status: "revoked" }],
    ["another circle", { circleId: "different-synthetic-circle" }],
  ])("rejects %s membership even while the signed token is still valid", async (_label, change) => {
    const f = await fixture();
    const maya = await f.signIn("maya"), evelyn = await f.signIn("evelyn");
    const task = await f.schedule(maya.token);
    expect((await f.get("/api/session", evelyn.token)).status).toBe(200);
    f.changeMembership("evelyn", change);
    // The real JWT authorizer still accepts this same token; the family boundary must not.
    expect((await f.authorizer.authorize(`Bearer ${evelyn.token}`, ["mcp:tools"])).subject).toBe(accounts.evelyn.accountId);
    expect((await f.get("/api/session", evelyn.token)).status).toBe(403);
    await expectDeniedWrites(f, evelyn.token, task, 403, "family_access_denied");
    expect((await f.get("/api/session", maya.token)).status).toBe(200);
  });
});
