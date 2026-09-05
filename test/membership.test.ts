import { describe, expect, it, vi } from "vitest";
import { createDynamoMembershipDirectory, mcpCarePermission, membershipKey } from "../src/membership.js";

const principal = { subject: "subject-a", scopes: new Set<string>(), claims: { iss: "https://issuer.example" } };

describe("membership persistence and dispatch", () => {
  it("isolates circle, issuer, and subject in membership keys", () => {
    const base = membershipKey("a", "issuer", "subject");
    expect(membershipKey("b", "issuer", "subject")).not.toEqual(base);
    expect(membershipKey("a", "other", "subject")).not.toEqual(base);
    expect(membershipKey("a", "issuer", "other")).not.toEqual(base);
    expect(membershipKey("a", "ab", "c")).not.toEqual(membershipKey("a", "a", "bc"));
  });

  it("uses a strongly consistent membership read on every lookup", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { status: "active" } }).mockResolvedValueOnce({});
    const directory = createDynamoMembershipDirectory({ tableName: "care-test", circleId: "family-a", client: { send } });
    expect(await directory.find(principal)).toEqual({ status: "active" });
    expect(await directory.find(principal)).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      TableName: "care-test", Key: membershipKey("family-a", principal.claims.iss, principal.subject), ConsistentRead: true,
    });
  });

  it("does not look up identities without a verified issuer", async () => {
    const send = vi.fn();
    const directory = createDynamoMembershipDirectory({ tableName: "care-test", circleId: "family-a", client: { send } });
    expect(await directory.find({ ...principal, claims: {} })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("denies batch or unknown tool dispatch and protects resource access", () => {
    expect(() => mcpCarePermission([{ method: "tools/list" }, { method: "tools/call" }])).toThrow();
    expect(() => mcpCarePermission({ method: "tools/call", params: { name: "future_admin_tool" } })).toThrow();
    expect(mcpCarePermission({ method: "resources/read" })).toBe("read");
  });
});
