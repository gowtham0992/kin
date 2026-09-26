import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { createMcpCareClient, type McpTraceEvent } from "../simulator/mcp-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { taskReview } from "../src/task-review.js";
// @ts-expect-error Browser JavaScript module exercised directly by integration tests.
import { createConfirmationSender } from "../simulator/care-client.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture(onTrace?: (event: McpTraceEvent) => void) {
  const store = createDemoStore(() => new Date("2026-09-02T08:00:00.000Z"));
  const app = createHttpApp(store);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await once(server, "listening");
  const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const client = createMcpCareClient(endpoint, { onTrace });
  const input = { ...baseInput, expected: taskReview((await store.today()).tasks.find(task => task.id === baseInput.taskId)!) };
  return { client, store, app, endpoint, input };
}
const baseInput = { taskId: "morning-water", response: "done", actor: "Evelyn", requestId: "simulator-mcp-0001" };

describe("simulator over real Streamable HTTP", () => {
  it("traces actual outgoing wire IDs and validated results without changing transport options or cancellation", async () => {
    const events: McpTraceEvent[] = [];
    const frames: Array<{ id: string | number; params: { name: string } }> = [];
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
      if (typeof options?.body === "string") {
        const body = JSON.parse(options.body);
        if (body.method === "tools/call") frames.push(body);
      }
      return fetch(resource, options);
    });
    const send = vi.spyOn(StreamableHTTPClientTransport.prototype, "send");
    const connect = vi.spyOn(Client.prototype, "connect");
    const originalCallTool = Client.prototype.callTool;
    let precedingPings = 0;
    const callTool = vi.spyOn(Client.prototype, "callTool").mockImplementation(async function (this: Client, ...args) {
      // Real protocol messages vary the next wire ID; a fabricated constant cannot satisfy this test.
      for (let index = 0; index <= precedingPings; index++) await this.ping(args[2]);
      precedingPings++;
      return originalCallTool.apply(this, args);
    });
    const { client, input } = await fixture(event => events.push(event));

    await client.today();
    await client.confirm(input);
    await client.brief();

    expect(events.map(event => [event.tool, event.phase])).toEqual([
      ["show_today", "request"], ["show_today", "result"],
      ["confirm_care_task", "request"], ["confirm_care_task", "result"],
      ["show_weekly_brief", "request"], ["show_weekly_brief", "result"],
    ]);
    expect(events.filter(event => event.phase === "request").map(event => event.rpcId)).toEqual(frames.map(frame => frame.id));
    expect(events.filter(event => event.phase === "result").map(event => event.rpcId)).toEqual(frames.map(frame => frame.id));
    expect(frames.map(frame => frame.params.name)).toEqual(["show_today", "confirm_care_task", "show_weekly_brief"]);
    expect(new Set(frames.map(frame => frame.id)).size).toBe(3);
    expect(events[3]).toMatchObject({ requestId: input.requestId, result: { response: "done", completed: 1, total: 2 } });
    expect(events[5]).toMatchObject({ result: { generatedBy: "deterministic" } });
    for (const event of events.filter(event => event.phase === "result")) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.durationMs)).toBe(true);
    }
    const sentTools = send.mock.calls.filter(([frame]) => !Array.isArray(frame) && "method" in frame && frame.method === "tools/call");
    expect(sentTools).toHaveLength(3);
    for (const [, options] of sentTools) expect(options).toHaveProperty("resumptionToken");
    for (let i = 0; i < callTool.mock.calls.length; i++) {
      expect(callTool.mock.calls[i]![2]?.signal).toBe(connect.mock.calls[i]![1]?.signal);
      expect(callTool.mock.calls[i]![2]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("records fixed error codes for real tool rejections and never emits a success receipt", async () => {
    const events: McpTraceEvent[] = [];
    const { client, store, input } = await fixture(event => events.push(event));
    const expected = taskReview((await store.today()).tasks.find(task => task.id === input.taskId)!);
    await store.confirm({ ...input, response: "not_yet", requestId: "intervening-update-1" });

    await expect(client.confirm({ ...input, expected })).rejects.toMatchObject({ definitiveRejection: true, status: 409 });
    await expect(client.confirm({ ...input, taskId: "unknown" })).rejects.toMatchObject({ definitiveRejection: true });

    expect(events.map(event => event.phase)).toEqual(["request", "error", "request", "error"]);
    expect(events[1]).toMatchObject({ errorCode: "review_conflict", requestId: input.requestId, rpcId: events[0]!.rpcId });
    expect(events[3]).toMatchObject({ errorCode: "task_not_found", requestId: input.requestId, rpcId: events[2]!.rpcId });
    expect(events.every(event => !event.result)).toBe(true);
  });

  it("does not let throwing observers change confirmations, replay receipts, or cleanup", async () => {
    const observer = vi.fn(() => { throw new Error("Observer failure"); });
    const close = vi.spyOn(Client.prototype, "close");
    const { client, store, input } = await fixture(observer);

    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId } });
    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId } });

    expect(observer).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledTimes(2);
    expect((await store.today()).summary.completed).toBe(1);
  });

  it("keeps private result fields and arbitrary request values out of trace events", async () => {
    const events: McpTraceEvent[] = [];
    const { client, store, endpoint, input } = await fixture(event => events.push(event));
    const snapshot = await store.today();
    vi.spyOn(store, "today").mockResolvedValue({ ...snapshot,
      tasks: snapshot.tasks.map(task => ({ ...task, title: "Private medical note" })),
      summary: { ...snapshot.summary, token: "private-token" },
      _meta: { headers: { Authorization: "Bearer private-auth" } },
    } as Awaited<ReturnType<typeof store.today>>);

    await client.today();
    await client.confirm({ ...input, actor: "Private Person", requestId: "private-email@example.test" });

    expect(events).toHaveLength(4);
    expect(events[1]?.result).toEqual({ completed: 0, total: 2 });
    expect(events[2]).not.toHaveProperty("requestId");
    expect(events[3]).not.toHaveProperty("requestId");
    const serialized = JSON.stringify(events);
    for (const privateValue of ["Private", "private-", "Authorization", "headers", "_meta", endpoint.href, input.taskId]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("reports receipt mismatch and untrusted tool errors without copying messages or metadata", async () => {
    const events: McpTraceEvent[] = [];
    const { client, input } = await fixture(event => events.push(event));
    const callTool = vi.spyOn(Client.prototype, "callTool");
    callTool.mockResolvedValueOnce({ content: [], structuredContent: { confirmation: { requestId: "wrong" }, token: "private-token" } });
    await expect(client.confirm(input)).rejects.toThrow("receipt mismatch");
    expect(events).toEqual([expect.objectContaining({ tool: "confirm_care_task", phase: "error", errorCode: "receipt_mismatch" })]);
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Private error details" }], structuredContent: { code: "private-code" } });
    await expect(client.today()).rejects.toThrow();
    expect(events[1]).toMatchObject({ tool: "show_today", phase: "error", errorCode: "invalid_result" });
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events.every(event => event.phase === "error" && !event.result && event.rpcId === undefined)).toBe(true);
  });

  it("rejects a stale review through MCP and releases the pending confirmation", async () => {
    const { client, store, input } = await fixture();
    const expected = taskReview((await store.today()).tasks.find(task => task.id === input.taskId)!);
    await store.confirm({ ...input, response: "not_yet", requestId: "family-update-0001" });
    const sender = createConfirmationSender({ send: client.confirm, newRequestId: () => input.requestId });
    await expect(sender.confirm({ ...input, expected })).rejects.toMatchObject({ definitiveRejection: true });
    expect(sender.pending).toBeNull();
    expect((await store.today()).tasks.find(task => task.id === input.taskId)).toMatchObject({ lastResponse: "not_yet", state: "scheduled" });
  });

  it("releases a definitive confirmation identity conflict without suggesting an endless retry", async () => {
    const events: McpTraceEvent[] = [];
    const { client, input } = await fixture(event => events.push(event));
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ isError: true, content: [], structuredContent: { code: "confirmation_conflict" } });
    const sender = createConfirmationSender({ send: client.confirm, newRequestId: () => input.requestId });
    await expect(sender.confirm(input)).rejects.toMatchObject({ definitiveRejection: true });
    expect(sender.pending).toBeNull();
    expect(events).toEqual([expect.objectContaining({ phase: "error", errorCode: "confirmation_conflict" })]);
    expect(events.some(event => event.phase === "result")).toBe(false);
  });

  it("replays a saved reviewed confirmation even though its original review is now stale", async () => {
    const { client, store, input } = await fixture();
    const expected = taskReview((await store.today()).tasks.find(task => task.id === input.taskId)!);
    await client.confirm({ ...input, expected });
    expect(await client.confirm({ ...input, expected })).toMatchObject({ confirmation: { requestId: input.requestId } });
  });
  it("confirms through MCP, shares state with the family API, and replays the same receipt", async () => {
    const { client, app, input } = await fixture();
    expect(await client.today()).toMatchObject({ summary: { completed: 0 } });
    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId }, snapshot: { summary: { completed: 1 } } });
    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId } });
    expect((await request(app).get("/api/today")).body.summary.completed).toBe(1);
    expect(await client.brief()).toMatchObject({ generatedBy: "deterministic" });
  });

  it("keeps the saved receipt when the snapshot read fails", async () => {
    const { client, store, input } = await fixture();
    vi.spyOn(store, "today").mockRejectedValue(new Error("Unavailable"));
    expect(await client.confirm(input)).toMatchObject({ refreshRequired: true, snapshot: null, confirmation: { requestId: input.requestId } });
  });

  it("does not treat a tool error as a successful confirmation", async () => {
    const { client, input } = await fixture();
    await expect(client.confirm({ ...input, taskId: "missing" })).rejects.toThrow();
  });

  it("rejects a mismatched receipt even when the server reports success", async () => {
    const { client, input } = await fixture();
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [], structuredContent: { confirmation: { requestId: "wrong-receipt" } },
    });
    await expect(client.confirm(input)).rejects.toThrow("receipt mismatch");
  });
  it.each([{ taskId: "different-task" }, { response: "not_yet" }])("does not trace a same-ID wrong confirmation as success: %j", async altered => {
    const events: McpTraceEvent[] = [];
    const { client, input } = await fixture(event => events.push(event));
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({ content: [], structuredContent: { confirmation: { ...input, ...altered } } });
    await expect(client.confirm(input)).rejects.toThrow("receipt mismatch");
    expect(events).toEqual([expect.objectContaining({ phase: "error", errorCode: "receipt_mismatch" })]);
    expect(events.some(event => event.phase === "result")).toBe(false);
  });

  it("does not expose the demo client when simulator assets are disabled", async () => {
    const app = createHttpApp(createDemoStore(), undefined, { serveSimulator: false });
    expect((await request(app).get("/mcp-client.js")).status).toBe(404);
  });
});
