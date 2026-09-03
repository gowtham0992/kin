import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { createMcpServer } from "../src/mcp.js";

const fixedNow = () => new Date("2026-09-02T08:00:00.000Z");

describe("Kin MCP contract", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;

  beforeEach(async () => {
    server = createMcpServer(createDemoStore(fixedNow));
    client = new Client({ name: "kin-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
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
      stats: { scheduled: 2 },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("not medical advice");
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
      },
    });
    expect(confirmation.isError).toBeFalsy();

    const after = await client.callTool({ name: "show_today", arguments: {} });
    expect(after.structuredContent).toMatchObject({
      summary: { total: 2, completed: 1, remaining: 1 },
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
