import { describe, expect, it, vi } from "vitest";
const { createInvitationClient, invitationError } = await import(new URL("../simulator/invite-client.js", import.meta.url).href);
const input = { memberId: "theo", email: "theo@example.com", role: "viewer" };
const receipt = { code: "a".repeat(43), expiresAt: 1788700000, memberId: "theo", role: "viewer" };

describe("invitation screen request safety", () => {
  it("coalesces repeated clicks and sends only the allowed fields without persisting a code", async () => {
    const request = vi.fn(async () => Response.json(receipt, { status: 201 }));
    const client = createInvitationClient({ request });
    const first = client.issue({ ...input, canInvite: true });
    expect(client.issue(input)).toBe(first);
    expect(await first).toEqual(receipt);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(["/api/invitations", expect.objectContaining({
      method: "POST", cache: "no-store", body: JSON.stringify(input),
    })]);
  });
  it("does not automatically retry a write after a network failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    const client = createInvitationClient({ request });
    await expect(client.issue(input)).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledTimes(1);
    expect(invitationError(undefined, true)).toContain("may have been created");
  });
  it.each([401, 403, 404, 409, 400])("preserves actionable server rejection %i", async status => {
    const client = createInvitationClient({ request: async () => Response.json({}, { status }) });
    await expect(client.issue(input)).rejects.toMatchObject({ status });
    expect(invitationError(status, true)).not.toContain("may have been created");
  });
  it.each([{ ...receipt, memberId: "someone-else" }, { ...receipt, role: "caregiver" }, { ...receipt, code: "invalid" }, { ...receipt, expiresAt: 0 }])("refuses a malformed or mismatched receipt", async value => {
    const client = createInvitationClient({ request: async () => Response.json(value) });
    await expect(client.issue(input)).rejects.toThrow("Invalid invitation receipt");
  });
});
