import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
import { createMcpCareClient } from "../simulator/mcp-client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { taskReview } from "../src/task-review.js";
// @ts-expect-error Browser JavaScript module exercised directly by integration tests.
import { createConfirmationSender } from "../simulator/care-client.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function fixture() {
  const store = createDemoStore(() => new Date("2026-09-02T08:00:00.000Z"));
  const app = createHttpApp(store);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await once(server, "listening");
  const client = createMcpCareClient(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`));
  return { client, store, app };
}
const input = { taskId: "morning-water", response: "done", actor: "Evelyn", requestId: "simulator-mcp-0001" };

describe("simulator over real Streamable HTTP", () => {
  it("rejects a stale review through MCP and releases the pending confirmation", async () => {
    const { client, store } = await fixture();
    const expected = taskReview((await store.today()).tasks.find(task => task.id === input.taskId)!);
    await store.confirm({ ...input, response: "not_yet", requestId: "family-update-0001" });
    const sender = createConfirmationSender({ send: client.confirm, newRequestId: () => input.requestId });
    await expect(sender.confirm({ ...input, expected })).rejects.toMatchObject({ definitiveRejection: true });
    expect(sender.pending).toBeNull();
    expect((await store.today()).tasks.find(task => task.id === input.taskId)).toMatchObject({ lastResponse: "not_yet", state: "scheduled" });
  });

  it("replays a saved reviewed confirmation even though its original review is now stale", async () => {
    const { client, store } = await fixture();
    const expected = taskReview((await store.today()).tasks.find(task => task.id === input.taskId)!);
    await client.confirm({ ...input, expected });
    expect(await client.confirm({ ...input, expected })).toMatchObject({ confirmation: { requestId: input.requestId } });
  });
  it("confirms through MCP, shares state with the family API, and replays the same receipt", async () => {
    const { client, app } = await fixture();
    expect(await client.today()).toMatchObject({ summary: { completed: 0 } });
    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId }, snapshot: { summary: { completed: 1 } } });
    expect(await client.confirm(input)).toMatchObject({ confirmation: { requestId: input.requestId } });
    expect((await request(app).get("/api/today")).body.summary.completed).toBe(1);
    expect(await client.brief()).toMatchObject({ generatedBy: "deterministic" });
  });

  it("keeps the saved receipt when the snapshot read fails", async () => {
    const { client, store } = await fixture();
    vi.spyOn(store, "today").mockRejectedValue(new Error("Unavailable"));
    expect(await client.confirm(input)).toMatchObject({ refreshRequired: true, snapshot: null, confirmation: { requestId: input.requestId } });
  });

  it("does not treat a tool error as a successful confirmation", async () => {
    const { client } = await fixture();
    await expect(client.confirm({ ...input, taskId: "missing" })).rejects.toThrow();
  });

  it("rejects a mismatched receipt even when the server reports success", async () => {
    const { client } = await fixture();
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [], structuredContent: { confirmation: { requestId: "wrong-receipt" } },
    });
    await expect(client.confirm(input)).rejects.toThrow("receipt mismatch");
  });

  it("does not expose the demo client when simulator assets are disabled", async () => {
    const app = createHttpApp(createDemoStore(), undefined, { serveSimulator: false });
    expect((await request(app).get("/mcp-client.js")).status).toBe(404);
  });
});
