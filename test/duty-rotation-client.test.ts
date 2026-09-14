import { describe, expect, it } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const proposal = { startDate: "2026-09-15", reviewToken: "a".repeat(64) };
const receipt = { requestId: "rotation-request", startDate: proposal.startDate, endDate: "2026-09-21", assigned: 1,
  assignments: [{ date: proposal.startDate, memberId: "theo" }], replayed: false };

describe("reviewed rotation client", () => {
  it("retains one immutable request across a lost response and locks other mutations", async () => {
    const bodies: string[] = [];
    const client = createWorkspaceClient({ newRequestId: () => "rotation-request", request: async (_url: string, options: RequestInit) => {
      bodies.push(options.body as string);
      if (bodies.length === 1) throw new Error("Lost response");
      return { ok: true, json: async () => receipt };
    } });
    await expect(client.acceptDutyRotation(proposal)).rejects.toThrow("Lost response");
    await expect(client.assignDuty({ date: "2026-09-08", memberId: "maya", expectedMemberId: "theo" })).rejects.toThrow("Resolve");
    await expect(client.confirm({ taskId: "water", response: "done" })).rejects.toThrow("Resolve");
    await expect(client.schedule({ title: "Water", dueAt: "2026-09-09T12:00:00Z" })).rejects.toThrow("Resolve");
    expect(client.pendingKind).toBe("weekly rotation");
    await client.retry();
    expect(bodies).toEqual([bodies[0], bodies[0]]);
    expect(JSON.parse(bodies[0]!)).toEqual({ ...proposal, requestId: "rotation-request", confirm: true });
    expect(client.pending).toBeNull();
  });
  it("requires fresh review after a definite conflict", async () => {
    const client = createWorkspaceClient({ newRequestId: () => "rotation-request", request: async () => ({ ok: false, status: 409 }) });
    await expect(client.acceptDutyRotation(proposal)).rejects.toMatchObject({ status: 409 });
    expect(client.pending).toBeNull();
  });
  it("does not accept a receipt for another proposed week", async () => {
    const client = createWorkspaceClient({ newRequestId: () => "rotation-request", request: async () => ({ ok: true,
      json: async () => ({ ...receipt, startDate: "2026-09-22" }) }) });
    await expect(client.acceptDutyRotation(proposal)).rejects.toThrow("Receipt mismatch");
    expect(client.pending).toMatchObject(proposal);
  });
});
