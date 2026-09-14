import { describe, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoRosterManagement, createMemoryRosterManagement, rosterChangeBody, RosterConflict, type RosterMemberRecord } from "../src/roster-management.js";
import { membershipKey } from "../src/membership.js";
const principal = { subject: "account", scopes: new Set(["mcp:tools"]), claims: { iss: "https://kin.example" } };
const account = { circleId: "family", memberId: "gowtham", name: "Gowtham", role: "caregiver", status: "active", canInvite: true };
const actorKey = membershipKey("family", principal.claims.iss, principal.subject).SK;
const sourceId = `person-${"a".repeat(40)}`;
const source = (): RosterMemberRecord => ({ id: sourceId, name: "Gowtham", relationship: "caregiver", canReceiveAlerts: false, createdBy: actorKey });
const body = { action: "connect_self", memberId: sourceId, name: "Gowtham", expectedName: "Gowtham", requestId: "connect-001", confirm: true };
function setup(members = [source()]) {
 return { members, service: createMemoryRosterManagement({ members, familyAccess: { circleId: "family", directory: { find: async () => account } }, accessMemberIds: new Set(["gowtham"]), now: () => new Date("2026-09-13T22:00:00Z") }) };
}
describe("connect existing caregiver to own account", () => {
 it("atomically replaces only the unused source, preserves a recovery copy, and never rewrites access or phone records", async () => {
  const old = { ...source(), PK: "CIRCLE#family", SK: `MEMBER#${sourceId}`, entityType: "CircleMember" };
  const send = vi.fn(async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
   if (command instanceof GetCommand) return {};
   if (command instanceof QueryCommand) return { Items: command.input.ExpressionAttributeValues![":prefix"] === "MEMBER#" ? [old] : [{ ...account, PK: "CIRCLE#family", SK: actorKey }] };
   return {};
  });
  const service = createDynamoRosterManagement({ tableName: "care", familyAccess: { circleId: "family", directory: { find: async () => account } }, client: { send } });
  await service.change(principal, rosterChangeBody.parse(body));
  const tx = send.mock.calls.find(([c]) => c instanceof TransactWriteCommand)![0] as TransactWriteCommand;
  const items = tx.input.TransactItems!;
  expect(items.find(i => i.Delete)?.Delete).toMatchObject({ Key: { PK: "CIRCLE#family", SK: `MEMBER#${sourceId}` }, ConditionExpression: expect.stringContaining("attribute_not_exists(accountKey)") });
  expect(items.find(i => i.Put?.Item?.id === "gowtham")?.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(PK)", Item: { accountKey: actorKey, canReceiveAlerts: true } });
  expect(items.find(i => i.Put?.Item?.entityType === "RosterRequest")?.Put?.Item?.previousPerson).toEqual(old);
  expect(items.filter(i => i.Update || i.Put || i.Delete).every(i => !String(i.Update?.Key?.SK ?? i.Put?.Item?.SK ?? i.Delete?.Key?.SK).startsWith("ACCESS#"))).toBe(true);
  expect(items[0]?.ConditionCheck?.ConditionExpression).toContain("memberId = :actor");
 });
 it("offers only an eligible self-created entry and keeps the account identity on connection and retry", async () => {
  const { members, service } = setup();
  expect((await service.list(principal)).members[0]).toMatchObject({ canConnectSelf: true });
  const input = rosterChangeBody.parse(body);
  const result = await service.change(principal, input);
  expect(result.person).toMatchObject({ id: "gowtham", canReceiveAlerts: true, canRename: false });
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({ id: "gowtham", accountKey: actorKey });
  expect(await service.change(principal, input)).toEqual(result);
 });
 it.each([{ accountKey: "someone-else" }, { pendingInvitation: "pending" }, { createdBy: "other" }, { relationship: "parent" }, { canReceiveAlerts: true }])("rejects another identity or already-used person: %j", async override => {
  const { members, service } = setup([{ ...source(), ...override } as RosterMemberRecord]);
  const before = structuredClone(members);
  await expect(service.change(principal, body as never)).rejects.toBeInstanceOf(RosterConflict);
  expect(members).toEqual(before);
 });
 it("rejects a stale name or an existing canonical roster entry", async () => {
  await expect(setup().service.change(principal, { ...body, expectedName: "Old" } as never)).rejects.toBeInstanceOf(RosterConflict);
  const { service } = setup([source(), { ...source(), id: "gowtham" }]);
  await expect(service.change(principal, body as never)).rejects.toBeInstanceOf(RosterConflict);
 });
 it("does not accept a client-chosen destination account or skipped confirmation", () => {
  expect(rosterChangeBody.safeParse({ ...body, targetMemberId: "maya" }).success).toBe(false);
  expect(rosterChangeBody.safeParse({ ...body, confirm: false }).success).toBe(false);
 });
});
