import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { InMemoryCareStore } from "../src/domain.js";
import { DynamoCareRepository } from "../src/dynamo-care-repository.js";
import { createMcpServer } from "../src/mcp.js";
import { mcpCarePermission, type Membership } from "../src/membership.js";
import type { CareWriteAuthorization } from "../src/care-write-authorization.js";

describe("pause MCP capability and permission contract", () => {
  it.each(["enabled", "default-off-dynamo", "viewer", "missing-authorization", "anonymous"])("advertises exactly authorized tools for %s", async mode => {
    const memory = new InMemoryCareStore([]);
    Object.defineProperty(memory, "completionUndoEnabled", { value: false });
    const store = mode === "default-off-dynamo" ? new DynamoCareRepository({ tableName: "synthetic", circleId: "family", client: { async send() { throw new Error("Discovery must not read care data"); } } }) : memory;
    const member: Membership = { circleId: "family", memberId: "parent", name: "Parent", role: mode === "viewer" ? "viewer" : "care_recipient", status: "active" };
    const authorization: CareWriteAuthorization = { member, key: null, async assertCurrent() {} };
    const server = createMcpServer(store, undefined, mode === "anonymous" ? undefined : member, ["anonymous", "missing-authorization"].includes(mode) ? undefined : authorization);
    const client = new Client({ name: "pause-contract", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(right); await client.connect(left);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
        ...(mode === "enabled" ? ["review_plan_pause", "pause_care_plan"] : []),
        "show_today", "show_weekly_brief", "confirm_care_task",
      ]);
      if (mode === "default-off-dynamo") expect(store.planPauseEnabled).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it("assigns both review and write to the narrow pause permission", () => {
    for (const name of ["review_plan_pause", "pause_care_plan"]) expect(mcpCarePermission({ method: "tools/call", params: { name } })).toBe("pause_plan");
  });
});
