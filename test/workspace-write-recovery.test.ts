import { describe, expect, it } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);

const requestId = "uncertain-write-001";
const cases = [
  { name: "confirmation", save: (c: any) => c.confirm({ taskId: "water", response: "done", actor: "Maya" }),
    receipt: { confirmation: { requestId, taskId: "water", response: "done" } } },
  { name: "duty", save: (c: any) => c.assignDuty({ date: "2026-09-26", memberId: "maya", expectedMemberId: null }),
    receipt: { requestId, assignments: [{ date: "2026-09-26", memberId: "maya" }] } },
  { name: "roster", save: (c: any) => c.changeRoster({ action: "rename", memberId: "maya", name: "Maya", expectedName: "Old", confirm: true }),
    receipt: { requestId, action: "rename", person: { id: "maya", name: "Maya" } } },
  { name: "rotation", save: (c: any) => c.acceptDutyRotation({ startDate: "2026-09-26", reviewToken: "a".repeat(64) }),
    receipt: { requestId, startDate: "2026-09-26", endDate: "2026-10-02", assigned: 1, assignments: [{ date: "2026-09-26", memberId: "maya" }] } },
];

describe.each(cases)("$name retry uncertainty", scenario => {
  it.each([401, 403])("keeps a first %s write outcome unknown until session cleanup, without automatically resending", async status => {
    let calls = 0;
    const client = createWorkspaceClient({ newRequestId: () => requestId, request: async () => { calls++; return { ok: false, status }; } });
    await expect(scenario.save(client)).rejects.toMatchObject({ status, outcomeUnknown: true, definitiveRejection: false });
    expect(client.pending?.requestId).toBe(requestId);
    client.reset(); expect(client.pending).toBeNull();
    await expect(client.retry()).rejects.toThrow("No pending");
    expect(calls).toBe(1);
  });

  it.each([400, 401, 403, 404, 422])("does not interpret a later %s denial as proof the earlier write failed", async status => {
    const bodies: string[] = [];
    const client = createWorkspaceClient({ newRequestId: () => requestId, request: async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      if (bodies.length === 1) throw new Error("Response lost");
      if (bodies.length === 2) return { ok: false, status };
      return { ok: true, json: async () => scenario.receipt };
    } });
    await expect(scenario.save(client)).rejects.toThrow("Response lost");
    const pending = structuredClone(client.pending);
    await expect(client.retry()).rejects.toMatchObject({ status, outcomeUnknown: true, definitiveRejection: false });
    expect(client.pending).toEqual(pending);
    await expect(client.schedule({ title: "Different", dueAt: "2026-09-27T15:00:00.000Z" })).rejects.toThrow(/pending/);
    await client.retry();
    expect(client.pending).toBeNull();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });
});
