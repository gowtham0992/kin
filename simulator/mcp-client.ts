import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TaskReview } from "../src/task-review.js";

// Local demonstration only. Production family authentication remains separate.
// Each request owns its connection; a failed write is never automatically replayed.
export function createMcpCareClient(endpoint: URL) {
  async function call(name: string, args: Record<string, unknown> = {}) {
    const client = new Client({ name: "kin-demonstration", version: "0.1.0" });
    const signal = AbortSignal.timeout(8000);
    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint), { signal });
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      if (result.isError || !result.structuredContent) {
        const details = result.structuredContent as Record<string, unknown> | undefined;
        throw Object.assign(new Error("MCP tool did not return a confirmed result"), {
          definitiveRejection: details?.code === "review_conflict" || details?.code === "task_not_found",
        });
      }
      return result.structuredContent as Record<string, unknown>;
    } finally {
      // Cleanup failure must not turn an acknowledged write into a failed write.
      await client.close().catch(() => {});
    }
  }
  return {
    today: () => call("show_today"),
    brief: () => call("show_weekly_brief"),
    async confirm(input: { taskId: string; response: string; actor: string; requestId: string; expected?: TaskReview }) {
      const result = await call("confirm_care_task", input);
      const receipt = result.confirmation as { requestId?: string } | undefined;
      if (receipt?.requestId !== input.requestId) throw new Error("Confirmation receipt mismatch");
      return { ...result, snapshot: result.refreshRequired ? null : result };
    },
  };
}
