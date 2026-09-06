import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const ok = (data: unknown) => ({ ok: true, json: async () => data });

describe("authenticated workspace requests", () => {
  it("keeps one scheduling identity after an uncertain response and rejects changed input", async () => {
    const request = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return ok({ requestId: body.requestId, task: { title: body.title, dueAt: body.dueAt } });
    });
    request.mockRejectedValueOnce(new Error("connection lost"));
    const client = createWorkspaceClient({ request, newRequestId: () => "schedule-request" });
    const input = { title: "Call together", dueAt: "2026-09-06T12:00:00.000Z" };
    await expect(client.schedule(input)).rejects.toThrow("connection lost");
    await expect(client.schedule({ ...input, title: "Different" })).rejects.toThrow("pending task");
    await client.retry();
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("rejects a mismatched receipt and retries the original confirmation identity", async () => {
    const request = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return ok({ confirmation: { ...body, taskId: "wrong" } });
    });
    const client = createWorkspaceClient({ request, newRequestId: () => "stable-request" });
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya" })).rejects.toThrow("Receipt mismatch");
    expect(client.pending.requestId).toBe("stable-request");
    request.mockImplementation(async (_url, options) => ok({ confirmation: { ...JSON.parse(options.body), taskId: "water" } }));
    await client.retry();
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
    expect(client.pending).toBeNull();
  });
  it("discards data that finishes decoding after the workspace session closes", async () => {
    let resolve!: (value: unknown) => void;
    const body = new Promise(done => { resolve = done; });
    const parsing = vi.fn(() => body);
    const client = createWorkspaceClient({ request: async () => ({ ok: true, json: parsing }) });
    const read = client.today();
    await vi.waitFor(() => expect(parsing).toHaveBeenCalled());
    client.reset(); resolve({ privateData: "old family" });
    await expect(read).rejects.toMatchObject({ stale: true });
  });
  it("clears a definitively denied check-in without retrying it", async () => {
    const request = vi.fn(async () => ({ ok: false, status: 403 }));
    const client = createWorkspaceClient({ request, newRequestId: () => "denied-request" });
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya" })).rejects.toMatchObject({ status: 403 });
    expect(client.pending).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  });
});
