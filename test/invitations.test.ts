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
  status: "pending", expiresAt: Math.floor(now().getTime() / 1000) + 86400,
};
function fixture(record: unknown = invitation) {
  const send = vi.fn<(command: GetCommand | TransactWriteCommand) => Promise<unknown>>(async command => command instanceof GetCommand ? { Item: record } : {});
  const service = createDynamoFamilyEnrollment({ tableName: "care-test", circleId: "family-a", issuer, now, client: { send } });
  return { service, send };
}

describe("family invitation acceptance", () => {
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
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems?.[0]?.Update).toMatchObject({
      Key: invitationKey("family-a", code),
      ConditionExpression: expect.stringContaining("expiresAt > :now"),
      ExpressionAttributeValues: { ":target": invitation.targetKey, ":role": "caregiver", ":consent": familyConsentVersion },
    });
    expect(transaction.input.TransactItems?.[1]?.Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(PK)",
      Item: { ...membershipKey("family-a", issuer, "account-a"), status: "active", role: "caregiver", consentVersion: familyConsentVersion },
    });
  });

  it("recognizes an accepted retry without reactivating revoked access", async () => {
    const accepted = { ...invitation, status: "accepted" };
    const { service, send } = fixture(accepted);
    const access = { status: "active", acceptedInvitation: invitationKey("family-a", code).SK, consentVersion: familyConsentVersion, role: "caregiver", memberId: "maya" };
    send.mockImplementation(async command => command instanceof GetCommand
      ? { Item: command.input.Key?.SK === invitation.targetKey ? access : accepted } : {});
    await expect(service.accept("account-a", code, familyConsentVersion, invitation)).resolves.toBeUndefined();
    access.status = "revoked";
    await expect(service.accept("account-a", code, familyConsentVersion, invitation)).rejects.toThrow();
    expect(send.mock.calls.some(([command]) => command instanceof TransactWriteCommand)).toBe(false);
  });
});
