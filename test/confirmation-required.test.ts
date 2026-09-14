import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { confirmWithReceipt } from "../src/confirmation.js";
import { createHttpApp } from "../src/http.js";
import { createMcpServer } from "../src/mcp.js";
import type { Membership } from "../src/membership.js";
import { taskReview } from "../src/task-review.js";

const member: Membership = { circleId: "family", memberId: "evelyn", name: "Evelyn", role: "care_recipient", status: "active" };
const fixture = () => createDemoStore(() => new Date("2026-09-02T08:00:00.000Z"));
const input = { taskId: "morning-water", response: "done" as const, actor: "Forged", requestId: "review-required-request" };

describe("reviewed-state confirmation boundary", () => {
  it.each([undefined, null, {}])("rejects missing or incomplete reviewed state at signed-in HTTP: %j", async expected => {
    const store = fixture();
    const confirm = vi.spyOn(store, "confirm");
    const app = createHttpApp(store, undefined, {
      accessAuthorizer: { async authorize() { return { subject: "evelyn", scopes: new Set(["mcp:tools"]), claims: {} }; } },
      familyAccess: { circleId: "family", directory: { async find() { return member; } } },
    });
    const { taskId, ...body } = input;
    const result = await request(app).post(`/api/tasks/${taskId}/confirm`).set("authorization", "Bearer synthetic").send({ ...body, expected });
    expect(result.status).toBe(400);
    expect(confirm).not.toHaveBeenCalled();
    expect((await store.today()).summary.completed).toBe(0);
  });

  it("fails closed for signed-in internal callers that bypass the HTTP schema", async () => {
    const store = fixture();
    const confirm = vi.spyOn(store, "confirm");
    await expect(confirmWithReceipt(store, input, member)).rejects.toThrow("Review the current task before confirming");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires the reviewed snapshot in discovery and refuses an omitted or stale snapshot through real MCP", async () => {
    const store = fixture();
    const server = createMcpServer(store, undefined, member);
    const client = new Client({ name: "review-required", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find(tool => tool.name === "confirm_care_task")?.inputSchema.required).toContain("expected");
      const before = await client.callTool({ name: "show_today", arguments: {} });
      const reviewed = (before.structuredContent as unknown as Awaited<ReturnType<typeof store.today>>).tasks[0]!;
      await store.changeTask({ taskId: reviewed.id, action: "rename", title: "Breakfast", expected: { title: reviewed.title, dueAt: reviewed.dueAt },
        requestId: "changed-task-before-confirmation", actor: "Theo", confirm: true });
      for (const expected of [undefined, null, {}, taskReview(reviewed)]) {
        const response = await client.callTool({ name: "confirm_care_task", arguments: { ...input, expected } });
        expect(response.isError).toBe(true);
        expect((await store.today()).tasks[0]).toMatchObject({ title: "Breakfast", state: "scheduled", lastResponse: null, confirmedBy: null });
      }
      const current = (await store.today()).tasks[0]!;
      const saved = await client.callTool({ name: "confirm_care_task", arguments: { ...input, expected: taskReview(current) } });
      expect(saved.isError).toBeFalsy();
      expect((await store.today()).tasks[0]).toMatchObject({ state: "done", confirmedBy: "Evelyn" });
    } finally { await client.close(); await server.close(); }
  });
});
