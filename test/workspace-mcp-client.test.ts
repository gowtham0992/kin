import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const task = { id: "water", title: "Drink water", dueAt: "2026-09-08T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedBy: null, confirmedAt: null };
const { id: _id, ...expected } = task;
const intent = { action: "confirm", task: { id: task.id }, response: "done", expected };

describe("workspace over authenticated MCP", () => {
  it.each(["interpret", "interpretMcp"])("passes an explicit selected occurrence through %s without saving", async method => {
    const request = vi.fn(async () => ({ ok: true, json: async () => intent }));
    const confirm = vi.fn();
    const client = createWorkspaceClient({ request, mcp: async () => ({ today: async () => ({ tasks: [task] }), confirm }) });
    await expect(client[method]("Done: Drink water", undefined, task.id)).resolves.toEqual(intent);
    expect(JSON.parse((request.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ message: "Done: Drink water", selectedTaskId: task.id });
    expect(confirm).not.toHaveBeenCalled(); expect(client.pending).toBeNull();
  });

  it.each(["interpret", "interpretMcp"])("rejects %s proposing another task than the selected occurrence", async method => {
    const client = createWorkspaceClient({ request: async () => ({ ok: true, json: async () => intent }),
      mcp: async () => ({ today: async () => ({ tasks: [task] }) }) });
    await expect(client[method]("Done: Drink water", undefined, "water-evening")).rejects.toMatchObject({ status: 409 });
    expect(client.pending).toBeNull();
  });

  it.each(["confirm", "confirmViaMcp"])("cancels a queued %s before it can use a replacement session", async method => {
    const request = vi.fn(async (_url: string, options: { body: string }) => ({ ok: true,
      json: async () => ({ confirmation: { ...JSON.parse(options.body), taskId: "water" } }) }));
    const confirm = vi.fn(async (body: object) => ({ confirmation: { ...body } }));
    const mcp = vi.fn(async () => ({ confirm }));
    const client = createWorkspaceClient({ request, mcp, newRequestId: () => "old-session-save" });
    const queued = client[method]({ taskId: "water", response: "done", actor: "Maya", expected });
    client.reset();
    await expect(queued).rejects.toMatchObject({ stale: true });
    expect(mcp).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(client.pending).toBeNull();
  });

  it("reads the task through MCP before reviewing an interpreted command", async () => {
    const order: string[] = [];
    const client = createWorkspaceClient({ mcp: async () => ({ today: async () => { order.push("mcp"); return { tasks: [task] }; } }),
      request: async () => { order.push("intent"); return { ok: true, json: async () => intent }; } });
    await expect(client.interpretMcp("Done: Drink water")).resolves.toEqual(intent);
    expect(order).toEqual(["mcp", "intent"]);
  });

  it("refuses a task that changed between MCP read and interpretation", async () => {
    const client = createWorkspaceClient({ mcp: async () => ({ today: async () => ({ tasks: [{ ...task, title: "Renamed task" }] }) }),
      request: async () => ({ ok: true, json: async () => intent }) });
    await expect(client.interpretMcp("Done: Drink water")).rejects.toMatchObject({ status: 409 });
    expect(client.pending).toBeNull();
  });

  it("keeps a lost MCP save on MCP with the same reviewed request, never a REST fallback", async () => {
    const writes: object[] = [], request = vi.fn();
    const client = createWorkspaceClient({ newRequestId: () => "mcp-request-1", request, mcp: async () => ({ confirm: async (body: object) => {
      writes.push(structuredClone(body)); if (writes.length === 1) throw new Error("Lost MCP response");
      return { confirmation: { ...body }, replayed: true };
    } }) });
    await expect(client.confirmViaMcp({ taskId: "water", response: "done", actor: "Maya", expected })).rejects.toThrow("Lost MCP response");
    await expect(client.confirm({ taskId: "water", response: "done", actor: "Maya", expected })).rejects.toThrow("Resolve");
    await client.retry();
    expect(writes).toEqual([writes[0], writes[0]]);
    expect(writes[0]).toEqual({ taskId: "water", response: "done", actor: "Maya", expected, requestId: "mcp-request-1" });
    expect(request).not.toHaveBeenCalled(); expect(client.pending).toBeNull();
  });

  it("rejects mismatched MCP receipts and clears pending only for a definite rejection", async () => {
    let conflict = false;
    const client = createWorkspaceClient({ newRequestId: () => "mcp-request-1", request: vi.fn(), mcp: async () => ({ confirm: async () => {
      if (conflict) throw Object.assign(new Error("Review changed"), { definitiveRejection: true });
      return { confirmation: { requestId: "another-request", taskId: "water", response: "done" } };
    } }) });
    await expect(client.confirmViaMcp({ taskId: "water", response: "done", actor: "Maya", expected })).rejects.toThrow("Receipt mismatch");
    expect(client.pending?.requestId).toBe("mcp-request-1");
    conflict = true; await expect(client.retry()).rejects.toThrow("Review changed"); expect(client.pending).toBeNull();
  });

  it("abandons a read from an old session before interpreting text under the next account", async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn();
    const client = createWorkspaceClient({ request, mcp: async () => ({ today: () => new Promise(done => { resolve = done; }) }) });
    const reading = client.interpretMcp("Done: Drink water");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    client.reset(); resolve({ tasks: [task] });
    await expect(reading).rejects.toMatchObject({ stale: true }); expect(request).not.toHaveBeenCalled();
  });
});
