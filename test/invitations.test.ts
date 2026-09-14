import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createDynamoFamilyEnrollment, familyConsentVersion, invitationKey, prepareInvitation, type Invitation } from "../src/invitations.js";
import { membershipKey } from "../src/membership.js";

const now = () => new Date("2026-09-05T12:00:00Z");
const issuer = "https://kin.example";
const code = "a".repeat(43);
const invitation: Invitation = {
  circleId: "family-a", circleName: "Evelyn's circle", memberId: "maya", name: "Maya", role: "caregiver",
  targetKey: membershipKey("family-a", issuer, "account-a").SK,
  status: "pending", expiresAt: Math.floor(now().getTime() / 1000) + 86400, rosterBound: true,
};
function fixture(record: unknown = invitation) {
  const send = vi.fn<(command: GetCommand | TransactWriteCommand) => Promise<unknown>>(async command => command instanceof GetCommand ? {
    Item: command.input.Key?.SK === "MEMBER#maya"
      ? { accountKey: invitation.targetKey, pendingInvitation: invitationKey("family-a", code).SK }
      : record,
  } : {});
  const service = createDynamoFamilyEnrollment({ tableName: "care-test", circleId: "family-a", issuer, now, client: { send } });
  return { service, send };
}

describe("family invitation acceptance", () => {
  it.each([
    ["review", undefined], ["review", false], ["accept", undefined], ["accept", false],
  ] as const)("rejects a pending invitation during %s when rosterBound is %s", async (operation, rosterBound) => {
    const legacy = { ...invitation, rosterBound };
    const { service, send } = fixture(legacy);
    const result = operation === "review" ? service.review("account-a", code)
      : service.accept("account-a", code, familyConsentVersion, legacy);
    await expect(result).rejects.toThrow("Ask your organizer for a new invitation");
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it.each(["removed", "false"])("rejects a binding marker %s after review but before commit", async change => {
    const stored: Record<string, unknown> = { ...invitation, rosterBound: true };
    const roster = { accountKey: invitation.targetKey, pendingInvitation: invitationKey("family-a", code).SK };
    let access: unknown;
    const { service, send } = fixture(stored);
    send.mockImplementation(async command => {
      if (command instanceof GetCommand) return { Item: structuredClone(command.input.Key?.SK === "MEMBER#maya" ? roster : stored) };
      if (change === "removed") delete stored.rosterBound;
      else stored.rosterBound = false;
      const update = command.input.TransactItems!.find(item => item.Update?.Key?.SK === invitationKey("family-a", code).SK)!.Update!;
      // Evaluate the generated invitation predicate against the changed row, not its earlier read snapshot.
      const matches = update.ConditionExpression!.split(" AND ").every(clause => {
        const match = /^([#\w]+) (=|>) (:\w+)$/.exec(clause);
        if (!match) throw new Error("Unsupported test predicate");
        const field = update.ExpressionAttributeNames?.[match[1]!] ?? match[1]!;
        const expected = update.ExpressionAttributeValues![match[3]!];
        return match[2] === "=" ? stored[field] === expected : Number(stored[field]) > Number(expected);
      });
      if (!matches) throw Object.assign(new Error("condition rejected"), { name: "TransactionCanceledException" });
      access = command.input.TransactItems!.find(item => item.Put)?.Put?.Item;
      return {};
    });
    const reviewed = await service.review("account-a", code);
    await expect(service.accept("account-a", code, familyConsentVersion, reviewed)).rejects.toThrow("unavailable");
    expect(access).toBeUndefined();
    expect(stored.status).toBe("pending");
  });

  it("rejects a replaced roster-bound code before writing", async () => {
    const bound = { ...invitation, rosterBound: true };
    const { service, send } = fixture(bound);
    send.mockImplementation(async command => command instanceof GetCommand ? { Item:
      command.input.Key?.SK === "MEMBER#maya"
        ? { accountKey: invitation.targetKey, pendingInvitation: invitationKey("family-a", "b".repeat(43)).SK }
        : bound } : {});
    await expect(service.accept("account-a", code, familyConsentVersion, bound)).rejects.toThrow("unavailable");
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("rechecks the roster binding inside the acceptance transaction", async () => {
    const bound = { ...invitation, rosterBound: true };
    const { service, send } = fixture(bound);
    send.mockImplementation(async command => command instanceof GetCommand ? { Item:
      command.input.Key?.SK === "MEMBER#maya"
        ? { accountKey: invitation.targetKey, pendingInvitation: invitationKey("family-a", code).SK }
        : bound } : {});
    await service.accept("account-a", code, familyConsentVersion, bound);
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)?.[0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems?.[0]?.ConditionCheck).toMatchObject({
      Key: { PK: "CIRCLE#family-a", SK: "MEMBER#maya" },
      ConditionExpression: "accountKey = :target AND pendingInvitation = :invitation",
      ExpressionAttributeValues: { ":target": invitation.targetKey, ":invitation": invitationKey("family-a", code).SK },
    });
    expect(transaction.input.TransactItems?.[2]?.Put?.Item).not.toHaveProperty("canInvite");
    expect(transaction.input.TransactItems?.[1]?.Update).toMatchObject({
      ConditionExpression: expect.stringContaining("rosterBound = :bound"),
      ExpressionAttributeValues: { ":bound": true },
    });
  });

  it("prepares an expiring account-bound invitation without storing the raw code", () => {
    const draft = prepareInvitation({ circleId: "family-a", circleName: "Evelyn", issuer, accountId: "account-a", memberId: "maya", name: "Maya", role: "viewer" }, now());
    expect(draft.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(draft.item)).not.toContain(draft.code);
    expect(draft.item.expiresAt).toBe(invitation.expiresAt);
    expect(draft.item.targetKey).toBe(invitation.targetKey);
  });

  it.each([null, { ...invitation, circleId: "other" }, { ...invitation, targetKey: membershipKey("family-a", issuer, "other").SK },
    { ...invitation, status: "revoked" }, { ...invitation, role: "admin" }, { ...invitation, expiresAt: Math.floor(now().getTime() / 1000) }])(
    "rejects unavailable invitations without a write: %j", async record => {
      const { service, send } = fixture(record);
      await expect(service.accept("account-a", code, familyConsentVersion, invitation)).rejects.toThrow("unavailable");
      expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
    },
  );

  it("requires explicit versioned consent and the same reviewed terms", async () => {
    const { service, send } = fixture();
    await expect(service.accept("account-a", code, "", invitation)).rejects.toThrow();
    await expect(service.accept("account-a", code, familyConsentVersion, { ...invitation, role: "viewer" })).rejects.toThrow();
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });

  it("atomically consumes the invitation and creates a non-overwriting membership", async () => {
    const { service, send } = fixture();
    const reviewed = await service.review("account-a", code);
    await service.accept("account-a", code, familyConsentVersion, reviewed);
    const transaction = send.mock.calls.find(([command]) => command instanceof TransactWriteCommand)?.[0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems?.[1]?.Update).toMatchObject({
      Key: invitationKey("family-a", code),
      ConditionExpression: expect.stringContaining("expiresAt > :now"),
      ExpressionAttributeValues: { ":target": invitation.targetKey, ":role": "caregiver", ":consent": familyConsentVersion },
    });
    expect(transaction.input.TransactItems?.[2]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK)",
      Item: { ...membershipKey("family-a", issuer, "account-a"), status: "active", role: "caregiver", consentVersion: familyConsentVersion },
    });
  });

  it("recognizes an accepted legacy retry without reactivating revoked access", async () => {
    const legacy = { ...invitation, rosterBound: undefined };
    const accepted = { ...legacy, status: "accepted" };
    const { service, send } = fixture(accepted);
    const access = { status: "active", acceptedInvitation: invitationKey("family-a", code).SK, consentVersion: familyConsentVersion, role: "caregiver", memberId: "maya" };
    send.mockImplementation(async command => command instanceof GetCommand
      ? { Item: command.input.Key?.SK === invitation.targetKey ? access : accepted } : {});
    await expect(service.accept("account-a", code, familyConsentVersion, legacy)).resolves.toBeUndefined();
    access.status = "revoked";
    await expect(service.accept("account-a", code, familyConsentVersion, legacy)).rejects.toThrow();
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
});
