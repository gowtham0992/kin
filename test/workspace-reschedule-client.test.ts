import { describe, expect, it, vi } from "vitest";
const { createWorkspaceClient } = await import(new URL("../simulator/workspace-client.js", import.meta.url).href);
const input = { taskId: "one-off", action: "reschedule", dueAt: "2026-09-15T19:00:00.000Z", expected: { title: "A call", dueAt: "2026-09-14T19:00:00.000Z" }, confirm: true };
const result = { requestId: "move-review-1", taskId: input.taskId, action: "reschedule", changed: 1, replacement: { taskId: `care-${"a".repeat(40)}`, dueAt: input.dueAt } };
describe("reschedule client receipt", () => {
  it.each([undefined, { ...result.replacement, taskId: input.taskId }, { ...result.replacement, dueAt: "2026-09-16T19:00:00.000Z" }])("keeps malformed replacement receipt %j pending then retries the same reviewed time", async replacement => {
    const request = vi.fn(async (_url: string, _options: { body: string }) => ({ ok: true, json: async () => ({ ...result, replacement }) }));
    const client = createWorkspaceClient({ request, newRequestId: () => result.requestId });
    await expect(client.changeTask(input)).rejects.toThrow("Receipt mismatch");
    expect(client.pending).toMatchObject(input);
    request.mockImplementation(async () => ({ ok: true, json: async () => result }));
    expect(await client.retry()).toEqual(result); expect(client.pending).toBeNull();
    expect(request.mock.calls[0]![0]).toBe(request.mock.calls[1]![0]);
    expect(request.mock.calls[0]![1].body).toBe(request.mock.calls[1]![1].body);
  });
  it("drops a known-disabled write without carrying it into another identity", async () => {
    const client = createWorkspaceClient({ request: async () => ({ ok: false, status: 422 }), newRequestId: () => result.requestId });
    await expect(client.changeTask(input)).rejects.toMatchObject({ definitiveRejection: true });
    expect(client.pending).toBeNull(); client.reset(); expect(client.pending).toBeNull();
  });
});
