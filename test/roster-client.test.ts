import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const add = { action: "add", name: "Robin", relationship: "caregiver", confirm: true };
const id = `person-${"a".repeat(40)}`;
const receipt = { requestId: "roster-request-1", action: "add", person: { id, name: "Robin", relationship: "caregiver", canReceiveAlerts: false, canRename: true } };
const ok = (data: unknown) => ({ ok: true, json: async () => data });

describe("circle change retry contract", () => {
  it("retries duty eligibility with the same receipt identity after a lost response", async () => {
    const body = { action: "enable_duty", memberId: id, name: "Robin", expectedName: "Robin", confirm: true };
    const request = vi.fn(async (): Promise<unknown> => { throw new Error("Offline"); });
    const client = createWorkspaceClient({ request, newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster(body)).rejects.toThrow("Offline");
    request.mockResolvedValue(ok({ ...receipt, action: "enable_duty", person: { ...receipt.person, canReceiveAlerts: false, canRename: false } }));
    await expect(client.retry()).rejects.toThrow("Receipt mismatch");
    const accepted = { ...receipt, action: "enable_duty", person: { ...receipt.person, canReceiveAlerts: true, canRename: false } };
    request.mockResolvedValue(ok(accepted));
    await expect(client.retry()).resolves.toEqual(accepted);
    expect(client.pending).toBeNull();
  });
  it("holds the original reviewed request after a lost acknowledgment and prevents competing changes", async () => {
    const request = vi.fn(async (_url: string, _options: { body?: string }): Promise<unknown> => { throw new Error("Connection lost"); });
    const client = createWorkspaceClient({ request, newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster(add)).rejects.toThrow("Connection lost");
    expect(client.pendingKind).toBe("circle change");
    const copy = client.pending; copy.name = "Tampered";
    await expect(client.changeRoster({ ...add, name: "Other" })).rejects.toThrow("Resolve");
    await expect(client.schedule({ title: "Call", dueAt: "2026-09-08T12:00:00Z" })).rejects.toThrow("Resolve");
    await expect(client.assignDuty({ date: "2026-09-08", memberId: "maya", expectedMemberId: null })).rejects.toThrow("Resolve");
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya" })).rejects.toThrow("Resolve");
    request.mockResolvedValue(ok(receipt));
    await expect(client.retry()).resolves.toEqual(receipt);
    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1]![1].body).toBe(request.mock.calls[0]![1].body);
    expect(JSON.parse(request.mock.calls[1]![1].body!)).toEqual({ ...add, requestId: "roster-request-1" });
    expect(client.pending).toBeNull();
  });

  it.each([400, 401, 403, 404, 409, 422])("releases a definitive rejection (%s) for a fresh review", async status => {
    const client = createWorkspaceClient({ request: async () => ({ ok: false, status }), newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster(add)).rejects.toMatchObject({ status });
    expect(client.pending).toBeNull();
  });

  it.each([500, 503, 429])("keeps an uncertain or transient outcome (%s) for the same-request retry", async status => {
    const client = createWorkspaceClient({ request: async () => ({ ok: false, status }), newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster(add)).rejects.toMatchObject({ status });
    expect(client.pending).toEqual({ ...add, requestId: "roster-request-1" });
  });

  it.each([
    { ...receipt, requestId: "wrong-request" },
    { ...receipt, action: "rename" },
    { ...receipt, person: { ...receipt.person, name: "Different" } },
    { ...receipt, person: { ...receipt.person, canReceiveAlerts: true } },
    { ...receipt, person: { ...receipt.person, relationship: "parent" } },
  ])("does not acknowledge a mismatched add receipt: %j", async result => {
    const client = createWorkspaceClient({ request: async () => ok(result), newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster(add)).rejects.toThrow("Receipt mismatch");
    expect(client.pending).not.toBeNull();
  });

  it("requires the reviewed person identity on a rename receipt", async () => {
    const request = vi.fn(async () => ok({ ...receipt, action: "rename" }));
    const client = createWorkspaceClient({ request, newRequestId: () => "roster-request-1" });
    await expect(client.changeRoster({ action: "rename", memberId: "theo", expectedName: "Theo", name: "Robin", confirm: true })).rejects.toThrow("Receipt mismatch");
    request.mockResolvedValue(ok({ ...receipt, action: "rename", person: { ...receipt.person, id: "theo" } }));
    await client.retry();
    expect(client.pending).toBeNull();
  });

  it("discards a previous session's response without clearing the new session's pending change", async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(async (): Promise<unknown> => new Promise(resolve => { finish = resolve; }));
    const client = createWorkspaceClient({ request, newRequestId: () => "roster-request-1" });
    const old = client.changeRoster(add);
    client.reset();
    request.mockRejectedValueOnce(new Error("Offline"));
    await expect(client.changeRoster({ ...add, name: "New session" })).rejects.toThrow("Offline");
    finish(ok(receipt));
    await expect(old).rejects.toMatchObject({ stale: true });
    expect(client.pending.name).toBe("New session");
  });
});
