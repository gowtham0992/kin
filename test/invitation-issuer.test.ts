import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { createCognitoInvitableAccounts, createDynamoInvitationIssuer } from "../src/invitation-issuer.js";
import { AccessDeniedError } from "../src/auth.js";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { membershipKey } from "../src/membership.js";

const issuer = "https://kin.example";
const principal = { subject: "organizer", scopes: new Set(["mcp:tools"]), claims: { iss: issuer } };
const member = { circleId: "family-a", memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: true };
const body = { memberId: "theo", email: "theo@example.com", role: "viewer" as const };
function fixture(record: unknown = member) {
  const directory = { find: vi.fn(async () => record) };
  const familyAccess = { circleId: "family-a", directory };
  const accounts = { resolve: vi.fn(async () => "recipient") };
  const send = vi.fn<(command: GetCommand | TransactWriteCommand) => Promise<unknown>>(async command => command instanceof GetCommand
    ? { Item: { id: "theo", name: "Theo", entityType: "CircleMember" } } : {});
  const invitationIssuer = createDynamoInvitationIssuer({ tableName: "care-test", familyAccess, circleName: "Evelyn's family", issuer, accounts, client: { send }, now: () => new Date("2026-09-05T12:00:00Z") });
  const app = createHttpApp(createDemoStore(), undefined, { familyAccess, invitationIssuer, accessAuthorizer: {
    async authorize(header) { if (!header) throw new AccessDeniedError(401, "invalid_token"); return principal; },
  } });
  return { app, send, accounts, invitationIssuer, directory };
}

describe("organizer invitation issuing", () => {
  it.each([null, { ...member, canInvite: false }, { ...member, canInvite: undefined }, { ...member, role: "viewer" }, { ...member, status: "revoked" }, { ...member, circleId: "other" }])(
    "rejects callers without active organizer authority: %j", async record => {
      const { app, accounts, send } = fixture(record);
      await request(app).post("/api/invitations").set("authorization", "Bearer user").send(body).expect(403);
      await request(app).get("/api/invitations/options").set("authorization", "Bearer user").expect(403);
      expect(accounts.resolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("requires authentication and rejects caller-chosen identities or names", async () => {
    const { app, send } = fixture();
    await request(app).post("/api/invitations").send(body).expect(401);
    await request(app).get("/api/invitations/options").expect(401);
    await request(app).post("/api/invitations").set("authorization", "Bearer user").send({ ...body, name: "Impersonated", accountId: "forged" }).expect(400);
    expect(send).not.toHaveBeenCalled();
  });
  it("returns only roster identity choices to an organizer, without implying account access", async () => {
    const { app } = fixture();
    const response = await request(app).get("/api/invitations/options").set("authorization", "Bearer user").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.members.length).toBeGreaterThan(0);
    for (const choice of response.body.members) {
      expect(Object.keys(choice).sort()).toEqual(["id", "name", "relationship"]);
      expect(choice.id).not.toBe("maya");
    }
  });
  it.each(["/api/invitations/options/", "/api/INVITATIONS/OPTIONS"])("enforces organizer permission on Express route variants: %s", async path => {
    const { app } = fixture({ ...member, canInvite: false });
    await request(app).get(path).set("authorization", "Bearer user").expect(403);
  });
  it("does not expose organizer options in an unauthenticated demo or when the family API is disabled", async () => {
    const { invitationIssuer } = fixture();
    await request(createHttpApp(createDemoStore(), undefined, { invitationIssuer })).get("/api/invitations/options").expect(401);
    await request(createHttpApp(createDemoStore(), undefined, { invitationIssuer, serveSimulator: false })).get("/api/invitations/options").expect(404);
  });
  it("issues a code without granting membership and freezes account/roster/organizer checks in one transaction", async () => {
    const { app, send } = fixture();
    const response = await request(app).post("/api/invitations").set("authorization", "Bearer user").send(body).expect(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ memberId: "theo", role: "viewer", code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)?.[0] as TransactWriteCommand;
    const items = transaction.input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items[0]?.ConditionCheck).toMatchObject({ Key: membershipKey("family-a", issuer, "organizer"), ConditionExpression: expect.stringContaining("canInvite = :yes") });
    expect(items[1]?.ConditionCheck).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)" });
    expect(items[2]?.Update).toMatchObject({ ConditionExpression: expect.stringContaining("attribute_not_exists(accountKey) OR accountKey = :target"), UpdateExpression: "SET accountKey = :target, pendingInvitation = :invitation" });
    expect(items[3]?.Put?.Item).toMatchObject({ name: "Theo", status: "pending", rosterBound: true, issuedBy: membershipKey("family-a", issuer, "organizer").SK });
    expect(JSON.stringify(items)).not.toContain(response.body.code);
    expect(items.filter(item => item.Put)).toHaveLength(1);
  });
  it("returns no code when permission or roster conditions change during the transaction", async () => {
    const { app, send } = fixture();
    send.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: { id: "theo", name: "Theo", entityType: "CircleMember" } };
      throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException" });
    });
    const response = await request(app).post("/api/invitations").set("authorization", "Bearer user").send(body).expect(409);
    expect(response.body).toEqual({ error: "invitation_unavailable" });
  });
});

describe("existing account verification", () => {
  const confirmed = { $metadata: {}, Enabled: true, UserStatus: "CONFIRMED" as const, Username: "theo", UserAttributes: [
    { Name: "sub", Value: "recipient" }, { Name: "email", Value: "theo@example.com" }, { Name: "email_verified", Value: "true" },
  ] };
  it.each([{ ...confirmed, Enabled: false }, { ...confirmed, UserStatus: "FORCE_CHANGE_PASSWORD" as const }, { ...confirmed, UserAttributes: [] },
    { ...confirmed, UserAttributes: confirmed.UserAttributes.filter(a => a.Name !== "email_verified") }])("rejects incomplete or disabled accounts: %j", async account => {
    const directory = createCognitoInvitableAccounts({ userPoolId: "test-pool", client: { send: vi.fn(async () => account) } });
    await expect(directory.resolve(body.email)).rejects.toThrow("could not be issued");
  });
  it("derives the stable subject from a read-only verified account lookup", async () => {
    const send = vi.fn(async (_command: AdminGetUserCommand) => confirmed);
    const directory = createCognitoInvitableAccounts({ userPoolId: "test-pool", client: { send } });
    expect(await directory.resolve(body.email)).toBe("recipient");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls[0]?.[0].input).toEqual({ UserPoolId: "test-pool", Username: body.email });
  });
});
