import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDynamoOidcAdapter } from "../src/oauth-dynamo-adapter.js";
import { createKinOAuthProvider } from "../src/oauth-provider.js";

type Command = GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand;
const issuer = "https://oauth-race.example";
const resource = `${issuer}/mcp`;
const clientId = "synthetic-browser-client";
const redirectUri = `${issuer}/invite.html`;
const verifier = "v".repeat(43);
const instant = new Date("2026-09-10T16:00:00.000Z");

// Only DynamoDB is substituted. The provider, PKCE, real adapter commands and
// token HTTP boundary run unchanged. A barrier forces both code reads to finish
// before either exchange consumes it, rather than relying on scheduler luck.
class SyntheticDynamo {
  rows = new Map<string, Record<string, any>>();
  codeReads = 0;
  synchronizeCodeReads = false;
  consumeFailure: Error | undefined;
  #release: (() => void) | undefined;
  #barrier = new Promise<void>(resolve => { this.#release = resolve; });
  key(value: Record<string, any>) { return JSON.stringify([value.PK, value.SK]); }
  async send(command: Command): Promise<Record<string, unknown>> {
    if (command instanceof TransactWriteCommand) {
      for (const operation of command.input.TransactItems ?? []) {
        if (operation.Put?.Item) this.rows.set(this.key(operation.Put.Item), structuredClone(operation.Put.Item));
        if (operation.Delete?.Key) this.rows.delete(this.key(operation.Delete.Key));
      }
      return {};
    }
    if (command instanceof GetCommand) {
      const Item = structuredClone(this.rows.get(this.key(command.input.Key!)));
      if (command.input.Key!.PK === "MODEL#AuthorizationCode" && this.synchronizeCodeReads) {
        this.codeReads += 1;
        if (this.codeReads === 2) this.#release!();
        await this.#barrier;
      }
      return { Item };
    }
    if (command instanceof QueryCommand) return { Items: [...this.rows.values()].filter(row => row.PK === command.input.ExpressionAttributeValues?.[":pk"]) };
    if (this.consumeFailure) throw this.consumeFailure;
    const row = this.rows.get(this.key(command.input.Key!));
    const condition = command.input.ConditionExpression ?? "";
    const now = command.input.ExpressionAttributeValues?.[":consumed"];
    if (!row || (condition.includes("attribute_not_exists(#payload.#consumed)") && Object.hasOwn(row.payload, "consumed")) ||
        (condition.includes("#expiresAt > :consumed") && row.expiresAt !== undefined && row.expiresAt <= now)) {
      throw Object.assign(new Error("Condition not satisfied"), { name: "ConditionalCheckFailedException" });
    }
    row.payload.consumed = now;
    return {};
  }
}

describe("OAuth single-use consumption", () => {
  let privateJwk: Record<string, unknown>;
  let publicKey: CryptoKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    publicKey = pair.publicKey;
    privateJwk = { ...await exportJWK(pair.privateKey), alg: "RS256", use: "sig", kid: "synthetic-race-key" };
  });
  afterEach(() => vi.useRealTimers());

  async function fixture() {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(instant);
    const storage = new SyntheticDynamo();
    const Adapter = createDynamoOidcAdapter({ tableName: "synthetic-oauth", client: storage, now: () => new Date(instant) });
    const provider = createKinOAuthProvider({ issuer, resourceUri: resource, jwks: { keys: [privateJwk] }, cookieKeys: ["a".repeat(32), "b".repeat(32)],
      adapter: Adapter, serviceClient: { clientId: "synthetic-service-client", clientSecret: "synthetic-service-secret" }, browserClient: { clientId, redirectUri },
      findAccount: async accountId => ({ accountId, claims: async () => ({ sub: accountId }) }),
    });
    const grant = new provider.Grant({ accountId: "synthetic-member", clientId });
    grant.addResourceScope(resource, "mcp:tools mcp:resources");
    const grantId = await grant.save();
    const AuthorizationCode = (provider as unknown as { AuthorizationCode: new (input: Record<string, unknown>) => { save(): Promise<string> } }).AuthorizationCode;
    const code = await new AuthorizationCode({ accountId: "synthetic-member", clientId, grantId, redirectUri, resource, scope: "mcp:tools mcp:resources",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256" }).save();
    const exchange = (codeVerifier = verifier) => request(provider.callback()).post("/token").type("form").send({
      grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, resource, code, code_verifier: codeVerifier,
    });
    return { storage, Adapter, exchange };
  }

  it("issues exactly one token when two valid code exchanges read the same unconsumed state", async () => {
    const { storage, exchange } = await fixture();
    storage.synchronizeCodeReads = true;
    const results = await Promise.all([exchange(), exchange()]);
    expect(storage.codeReads).toBe(2);
    expect(results.map(result => result.status).sort()).toEqual([200, 400]);
    const denied = results.find(result => result.status === 400)!;
    expect(denied.body.error).toBe("invalid_grant");
    expect(denied.body.access_token).toBeUndefined();
    const token = results.find(result => result.status === 200)!.body.access_token;
    expect((await jwtVerify(token, publicKey, { issuer, audience: resource })).payload.sub).toBe("synthetic-member");
    // JWT access tokens are not persisted by this provider; count the actual
    // token responses, then verify the sole successful token above.
    expect(results.filter(result => typeof result.body.access_token === "string")).toHaveLength(1);
  });

  it("does not consume a code when PKCE is wrong and rejects sequential replay", async () => {
    const { exchange } = await fixture();
    expect((await exchange("x".repeat(43))).body.error).toBe("invalid_grant");
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).body.error).toBe("invalid_grant");
  });

  it.each(["AuthorizationCode", "RefreshToken", "DeviceCode"])("rejects a second atomic consume for %s", async model => {
    const { Adapter } = await fixture();
    const adapter = new Adapter(model);
    await adapter.upsert("synthetic-id", {}, 60);
    const outcomes = await Promise.allSettled([adapter.consume("synthetic-id"), adapter.consume("synthetic-id")]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { error: "invalid_grant", statusCode: 400 } });
  });

  it("fails closed when the code expires between read and consumption", async () => {
    const { Adapter } = await fixture();
    const adapter = new Adapter("AuthorizationCode");
    await adapter.upsert("expired-id", {}, 0);
    await expect(adapter.consume("expired-id")).rejects.toMatchObject({ error: "invalid_grant", statusCode: 400 });
  });

  it("rejects a code that was deleted after its read without recreating it", async () => {
    const { Adapter, storage } = await fixture();
    await expect(new Adapter("AuthorizationCode").consume("deleted-id")).rejects.toMatchObject({ error: "invalid_grant", statusCode: 400 });
    expect([...storage.rows.values()].some(row => row.id === "deleted-id")).toBe(false);
  });

  it("does not mislabel a database outage as replay", async () => {
    const { storage, Adapter } = await fixture();
    const outage = new Error("Synthetic database unavailable");
    storage.consumeFailure = outage;
    await expect(new Adapter("AuthorizationCode").consume("synthetic-id")).rejects.toBe(outage);
  });
});
