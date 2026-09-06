import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoAccessManagement } from "../src/access-management.js";
import { membershipKey } from "../src/membership.js";
import { AccessDeniedError } from "../src/auth.js";
import { createDemoStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";

const issuer = "https://kin.example", circleId = "family-a";
const principal = { subject: "organizer", scopes: new Set(["mcp:tools"]), claims: { iss: issuer } };
const organizer = { circleId, memberId: "maya", name: "Maya", role: "caregiver", status: "active", canInvite: true };
const target = { ...membershipKey(circleId, issuer, "recipient"), circleId, memberId: "theo", name: "Theo", role: "viewer", status: "active", privateMetadata: "must not leak" };
function fixture(record: unknown = organizer, items: unknown[] = [target]) {
  const familyAccess = { circleId, directory: { find: vi.fn(async () => record) } };
  const send = vi.fn<(command: QueryCommand | TransactWriteCommand) => Promise<unknown>>(async command => command instanceof QueryCommand ? { Items: items } : {});
  const accessManagement = createDynamoAccessManagement({ tableName: "test-care", familyAccess, client: { send }, now: () => new Date("2026-09-06T01:00:00Z") });
  const app = createHttpApp(createDemoStore(), undefined, { familyAccess, accessManagement, accessAuthorizer: { async authorize(header) {
    if (!header) throw new AccessDeniedError(401, "invalid_token"); return principal;
  } } });
  return { app, send, accessManagement };
}
describe("organizer access management", () => {
  it("projects bounded memberships without account hashes or private metadata", async () => {
    const { app, send } = fixture();
    const response = await request(app).get("/api/access").set("authorization", "Bearer test").expect(200);
    expect(response.body).toEqual({ members: [{ memberId: "theo", name: "Theo", role: "viewer", status: "active", organizer: false, canRevoke: true }] });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(send.mock.calls[0]![0].input).toMatchObject({ Limit: 100, ConsistentRead: true });
  });
  it.each(["/api/access", "/api/ACCESS", "/api/access/"])("requires organizer authority even on route variants: %s", async path => {
    const { app, send } = fixture({ ...organizer, canInvite: false });
    await request(app).get(path).set("authorization", "Bearer test").expect(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects missing authentication, unconfirmed changes, and caller-chosen account keys", async () => {
    const { app, send } = fixture();
    await request(app).post("/api/access/revoke").send({ memberId: "theo", confirm: true }).expect(401);
    for (const body of [{ memberId: "theo" }, { memberId: "theo", confirm: true, SK: target.SK }]) {
      await request(app).post("/api/access/revoke").set("authorization", "Bearer test").send(body).expect(400);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it("atomically rechecks the organizer and target and preserves the first revocation audit", async () => {
    const { app, send } = fixture();
    await request(app).post("/api/access/revoke").set("authorization", "Bearer test").send({ memberId: "theo", confirm: true }).expect(200, { memberId: "theo", status: "revoked" });
    const command = send.mock.calls[1]![0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(2);
    expect(command.input.TransactItems![0]!.ConditionCheck).toMatchObject({ Key: membershipKey(circleId, issuer, "organizer"), ConditionExpression: expect.stringContaining("canInvite = :yes") });
    expect(command.input.TransactItems![1]!.Update).toMatchObject({ Key: { PK: target.PK, SK: target.SK }, ConditionExpression: expect.stringContaining("canInvite = :no"), UpdateExpression: expect.stringContaining("if_not_exists(revokedAt, :time)") });
  });
  it("does not revoke self, other organizers, or ambiguous member mappings", async () => {
    const self = fixture(); await expect(self.accessManagement.revoke(principal, "maya")).rejects.toThrow("denied"); expect(self.send).not.toHaveBeenCalled();
    for (const items of [[{ ...target, canInvite: true }], [target, target], []]) {
      const { app, send } = fixture(organizer, items);
      await request(app).post("/api/access/revoke").set("authorization", "Bearer test").send({ memberId: "theo", confirm: true }).expect(409);
      expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
    }
  });
  it("fails closed on truncated or foreign-circle directory data", async () => {
    const truncated = fixture(); truncated.send.mockResolvedValue({ Items: [target], LastEvaluatedKey: { PK: "more" } });
    await expect(truncated.accessManagement.list(principal)).rejects.toThrow("exceeds");
    await expect(fixture(organizer, [{ ...target, circleId: "other" }]).accessManagement.list(principal)).rejects.toThrow("Invalid");
  });
  it("reports a transaction race as a conflict, not a successful revocation", async () => {
    const { app, send } = fixture();
    send.mockImplementation(async command => { if (command instanceof QueryCommand) return { Items: [target] }; throw Object.assign(new Error("race"), { name: "TransactionCanceledException" }); });
    await request(app).post("/api/access/revoke").set("authorization", "Bearer test").send({ memberId: "theo", confirm: true }).expect(409, { error: "access_change_unavailable" });
  });
});
