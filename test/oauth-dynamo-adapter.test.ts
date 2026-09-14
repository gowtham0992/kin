import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createDynamoOidcAdapter } from "../src/oauth-dynamo-adapter.js";

const now = () => new Date("2026-09-04T02:00:00.000Z");

describe("Dynamo OAuth adapter", () => {
  it("atomically stores a token with expiry and its secondary indexes", async () => {
    const send = vi.fn(async (
      _command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
    ) => ({}));
    const Adapter = createDynamoOidcAdapter({
      tableName: "kin-oauth-state",
      client: { send },
      clockToleranceSeconds: 5,
      now,
    });
    const adapter = new Adapter("AuthorizationCode");

    await adapter.upsert("code-1", {
      grantId: "grant-1",
      userCode: "user-code-1",
      accountId: "family-member-1",
    }, 60);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    if (!(command instanceof TransactWriteCommand)) throw new Error("Expected transaction");
    expect(command.input.TransactItems).toHaveLength(3);
    expect(command.input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      PK: "MODEL#AuthorizationCode",
      SK: "VALUE#code-1",
      expiresAt: 1_788_487_265,
    });
    expect(command.input.TransactItems?.[2]?.Put?.Item).toMatchObject({
      PK: "GRANT#grant-1",
      SK: "AuthorizationCode#code-1",
    });
  });

  it("resolves a session UID through a strongly consistent lookup", async () => {
    const send = vi.fn(async (
      _command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
    ) => ({}))
      .mockResolvedValueOnce({ Item: {
        PK: "LOOKUP#UID#session-uid",
        SK: "MODEL#Session",
        model: "Session",
        id: "session-1",
        expiresAt: 1_788_487_300,
      } })
      .mockResolvedValueOnce({ Item: {
        PK: "MODEL#Session",
        SK: "VALUE#session-1",
        model: "Session",
        id: "session-1",
        payload: { uid: "session-uid", accountId: "family-member-1" },
        expiresAt: 1_788_487_300,
      } });
    const Adapter = createDynamoOidcAdapter({
      tableName: "kin-oauth-state",
      client: { send },
      now,
    });

    await expect(new Adapter("Session").findByUid("session-uid")).resolves.toEqual({
      uid: "session-uid",
      accountId: "family-member-1",
    });
    expect(send.mock.calls.every(([command]) =>
      command instanceof GetCommand && command.input.ConsistentRead === true)).toBe(true);
  });

  it("treats an expired item as absent even before DynamoDB TTL cleanup", async () => {
    const send = vi.fn(async (
      _command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand,
    ) => ({ Item: {
      PK: "MODEL#AccessToken",
      SK: "VALUE#expired-token",
      model: "AccessToken",
      id: "expired-token",
      payload: { accountId: "family-member-1" },
      expiresAt: 1_788_487_199,
    } }));
    const Adapter = createDynamoOidcAdapter({
      tableName: "kin-oauth-state",
      client: { send },
      now,
    });

    await expect(new Adapter("AccessToken").find("expired-token")).resolves.toBeUndefined();
  });

  it("records one-time token consumption and revokes every grant member", async () => {
    const members = Array.from({ length: 51 }, (_, index) => ({
      PK: "GRANT#grant-1",
      SK: `AccessToken#token-${index}`,
      model: "AccessToken",
      id: `token-${index}`,
    }));
    const send = vi.fn(async (command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand) => {
      if (command instanceof QueryCommand) return { Items: members };
      return {};
    });
    const Adapter = createDynamoOidcAdapter({
      tableName: "kin-oauth-state",
      client: { send },
      now,
    });
    const adapter = new Adapter("AuthorizationCode");

    await adapter.consume("code-1");
    await adapter.revokeByGrantId("grant-1");

    const consume = send.mock.calls[0]?.[0];
    expect(consume).toBeInstanceOf(UpdateCommand);
    if (!(consume instanceof UpdateCommand)) throw new Error("Expected update");
    expect(consume.input.ExpressionAttributeValues?.[":consumed"]).toBe(1_788_487_200);
    expect(consume.input.ConditionExpression).toBe("attribute_exists(PK) AND attribute_not_exists(#payload.#consumed) AND (attribute_not_exists(#expiresAt) OR #expiresAt > :consumed)");
    expect(consume.input.ExpressionAttributeNames).toEqual({ "#payload": "payload", "#consumed": "consumed", "#expiresAt": "expiresAt" });
    const transactions = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.input.TransactItems).toHaveLength(100);
    expect(transactions[1]?.input.TransactItems).toHaveLength(2);
  });
});
