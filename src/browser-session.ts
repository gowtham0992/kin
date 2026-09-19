import { createHash, randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Express, Request } from "express";
import { AccessDeniedError, alexaScopes, type AccessAuthorizer } from "./auth.js";
import type { BrowserAuthConfig } from "./browser-auth-config.js";
import { requireMembership, type FamilyAccess } from "./membership.js";

export interface BrowserSession { token: string; expiresAt: number }
export interface BrowserSessionStore {
  get(id: string): Promise<BrowserSession | null>;
  put(id: string, session: BrowserSession): Promise<void>;
  revoke(id: string): Promise<void>;
}
const cookie = "__Host-kin-workspace";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "strict" as const, path: "/" };
const invalid = () => new AccessDeniedError(401, "invalid_token");
const binding = (id: string) => createHash("sha256").update(id).digest("hex");
function sessionId(request: Request) {
  const values = (request.headers.cookie ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${cookie}=`));
  if (!values.length) return null;
  if (values.length !== 1 || !new RegExp(`^${cookie}=[A-Za-z0-9_-]{43}$`).test(values[0]!)) throw invalid();
  return values[0]!.slice(cookie.length + 1);
}

/** Full browser boundary: hostile sites must not use ambient cookies as authority.
 * Bearer-only native MCP clients retain their existing authentication path. */
export function installBrowserSessions(app: Express, input: {
  store: BrowserSessionStore; config: BrowserAuthConfig | (() => Promise<BrowserAuthConfig>);
  authorizer: AccessAuthorizer; familyAccess: FamilyAccess; now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const config = async () => typeof input.config === "function" ? input.config() : input.config;
  async function boundary(request: Request) {
    const trusted = (await config()).issuer;
    if (request.get("x-kin-workspace") !== "1" ||
        (request.get("sec-fetch-site") && request.get("sec-fetch-site") !== "same-origin") ||
        (request.get("origin") !== undefined && request.get("origin") !== trusted) ||
        (request.method !== "GET" && request.get("origin") !== trusted)) {
      throw new AccessDeniedError(403, "insufficient_scope");
    }
  }
  async function current(request: Request) {
    const id = sessionId(request);
    const session = id ? await input.store.get(id) : null;
    if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now() ||
        typeof session.token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(session.token)) throw invalid();
    return session;
  }
  app.all("/browser-session", async (request, response, next) => {
    response.set("cache-control", "no-store");
    try {
      await boundary(request);
      if (request.method === "DELETE") {
        const id = sessionId(request);
        if (id) await input.store.revoke(id);
        response.clearCookie(cookie, cookieOptions).status(204).end(); return;
      }
      if (request.method === "POST") {
        const header = request.get("authorization");
        const token = /^Bearer ([\x21-\x7e]{1,16384})$/.exec(header ?? "")?.[1];
        if (!token) throw invalid();
        const principal = await input.authorizer.authorize(header, [alexaScopes.tools]);
        if (principal.claims.client_id !== (await config()).clientId) throw invalid();
        await requireMembership(input.familyAccess, principal, "read");
        const exp = principal.claims.exp;
        if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= now()) throw invalid();
        const expiresAt = Math.min(exp * 1000, now() + 3600000);
        const previous = sessionId(request);
        if (previous) await input.store.revoke(previous);
        const id = randomBytes(32).toString("base64url");
        await input.store.put(id, { token, expiresAt });
        response.cookie(cookie, id, { ...cookieOptions, maxAge: expiresAt - now() });
        response.json({ expiresAt }); return;
      }
      if (request.method === "GET") {
        const session = await current(request);
        const principal = await input.authorizer.authorize(`Bearer ${session.token}`, [alexaScopes.tools]);
        await requireMembership(input.familyAccess, principal, "read");
        response.json({ expiresAt: session.expiresAt, binding: binding(sessionId(request)!) }); return;
      }
      response.status(405).end();
    } catch (error) { next(error); }
  });
  app.use(async (request, response, next) => {
    if (!(request.path.startsWith("/api/") || request.path === "/mcp") || request.get("authorization")) { next(); return; }
    try {
      if (!sessionId(request)) { next(); return; }
      response.set("cache-control", "no-store");
      await boundary(request);
      if (request.get("x-kin-session") !== binding(sessionId(request)!)) throw invalid();
      const session = await current(request);
      request.headers.authorization = `Bearer ${session.token}`;
      // Existing JWT, scope, membership and write preconditions still run downstream.
      next();
    } catch (error) { next(error); }
  });
}

export function createDynamoBrowserSessions(input: { tableName: string; region?: string;
  client?: { send(command: GetCommand | PutCommand | UpdateCommand): Promise<unknown> } }): BrowserSessionStore {
  const client = input.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region: input.region }));
  const key = (id: string) => ({ PK: `BROWSER_SESSION#${createHash("sha256").update(id).digest("hex")}`, SK: "SESSION" });
  return {
    async get(id) {
      const result = await client.send(new GetCommand({ TableName: input.tableName, Key: key(id), ConsistentRead: true })) as { Item?: { token: string; validUntilMs: number; revoked?: boolean } };
      return result.Item && !result.Item.revoked ? { token: result.Item.token, expiresAt: result.Item.validUntilMs } : null;
    },
    async put(id, session) {
      await client.send(new PutCommand({ TableName: input.tableName, Item: { ...key(id), token: session.token,
        validUntilMs: session.expiresAt, expiresAt: Math.ceil(session.expiresAt / 1000) }, ConditionExpression: "attribute_not_exists(PK)" }));
    },
    async revoke(id) {
      await client.send(new UpdateCommand({ TableName: input.tableName, Key: key(id),
        UpdateExpression: "SET revoked = :yes REMOVE #token", ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#token": "token" }, ExpressionAttributeValues: { ":yes": true } })).catch(error => {
          if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
        });
    },
  };
}
