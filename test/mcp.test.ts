import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createMcpServer } from "../src/mcp.js";
import { taskReview } from "../src/task-review.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin MCP contract", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let store: ReturnType<typeof createDemoStore>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T23:00:00.000Z"));
    store = createDemoStore(fixedNow);
    server = createMcpServer(store);
    client = new Client({ name: "kin-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client.close();
    await server.close();
  });

  it("advertises only working care-loop tools with widget metadata", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "show_today",
      "show_weekly_brief",
      "confirm_care_task",
    ]);
    expect(result.tools[0]?._meta?.ui).toEqual({ resourceUri: "ui://kin/today.html" });
  });

  it("returns a structured, non-medical weekly brief", async () => {
    const result = await client.callTool({ name: "show_weekly_brief", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      generatedBy: "deterministic",
      period: { endDate: "2026-09-02" },
      stats: { scheduled: 2 },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("not medical advice");
  });

  it("serves the bundled widget through the actual MCP resource", async () => {
    const result = await client.readResource({ uri: "ui://kin/today.html" });
    const resource = result.contents[0];
    expect(resource?.mimeType).toBe("text/html;profile=mcp-app");
    const html = resource && "text" in resource ? resource.text as string : "";
    expect(html.includes("ui/initialize")).toBe(true);
    expect(html.includes("https://unpkg.com")).toBe(false);
    expect(html.includes('from "@modelcontextprotocol/ext-apps"')).toBe(false);
  });

  it("runs the complete show-confirm-show loop", async () => {
    const before = await client.callTool({ name: "show_today", arguments: {} });
    expect(before.isError).toBeFalsy();
    expect(before.structuredContent).toMatchObject({
      summary: { total: 2, completed: 0, remaining: 2 },
    });

    const confirmation = await client.callTool({
      name: "confirm_care_task",
      arguments: {
        taskId: "morning-water",
        response: "done",
        actor: "Mom",
        requestId: "voice-turn-0001",
        expected: taskReview((await store.today()).tasks[0]!),
      },
    });
    expect(confirmation.isError).toBeFalsy();

    const after = await client.callTool({ name: "show_today", arguments: {} });
    expect(after.structuredContent).toMatchObject({
      summary: { total: 2, completed: 1, remaining: 1 },
    });
  });

  it("keeps a committed confirmation successful when the view cannot refresh", async () => {
    const expected = taskReview((await store.today()).tasks[0]!);
    vi.spyOn(store, "today").mockRejectedValue(new Error("Read unavailable"));
    const result = await client.callTool({ name: "confirm_care_task", arguments: {
      taskId: "morning-water", response: "done", actor: "Evelyn", requestId: "mcp-saved-read-failed", expected,
    } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      task: { state: "done" }, confirmation: { requestId: "mcp-saved-read-failed" }, refreshRequired: true,
    });
  });

  it("rejects malformed tool input at the MCP boundary", async () => {
    const result = await client.callTool({
      name: "confirm_care_task",
      arguments: {
        taskId: "morning-water",
        response: "definitely",
        actor: "Mom",
        requestId: "short",
      },
    });
    expect(result.isError).toBe(true);
  });
});
