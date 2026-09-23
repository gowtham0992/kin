import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListToolsResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { taskReviewSchema, type TaskReview } from "../src/task-review.js";

export interface McpTraceEvent {
  tool: string;
  phase: "request" | "result" | "error";
  rpcId?: string | number;
  requestId?: string;
  durationMs?: number;
  errorCode?: string;
  result?: {
    response?: "done" | "not_yet" | "skipped";
    completed?: number;
    total?: number;
    scheduled?: number;
    skipped?: number;
    stillOpen?: number;
    closedUnanswered?: number;
    escalations?: number;
    refreshRequired?: boolean;
    generatedBy?: "bedrock" | "deterministic";
  };
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function accessError(status: 401 | 403) {
  return Object.assign(new Error(status === 401 ? "Sign in to Kin again." : "Your account cannot perform this action."), {
    status, definitiveRejection: true,
  });
}

function traceSummary(tool: string, result: Record<string, unknown>): NonNullable<McpTraceEvent["result"]> {
  const summary: NonNullable<McpTraceEvent["result"]> = {};
  const counts = record(tool === "show_weekly_brief" ? result.stats : result.summary);
  const keys = tool === "show_weekly_brief"
    ? ["completed", "scheduled", "skipped", "stillOpen", "closedUnanswered", "escalations"] as const
    : ["completed", "total"] as const;
  for (const key of keys) {
    const value = counts[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) summary[key] = value;
  }
  if (tool === "confirm_care_task") {
    const response = record(result.confirmation).response;
    if (response === "done" || response === "not_yet" || response === "skipped") summary.response = response;
    if (typeof result.refreshRequired === "boolean") summary.refreshRequired = result.refreshRequired;
  }
  if (tool === "show_weekly_brief" && (result.generatedBy === "bedrock" || result.generatedBy === "deterministic")) summary.generatedBy = result.generatedBy;
  return summary;
}

export interface McpCareClientOptions {
  onTrace?: (event: McpTraceEvent) => void;
  fetch?: StreamableHTTPClientTransportOptions["fetch"];
  clientName?: string;
}

// The family browser injects its existing session owner; this client never owns tokens or starts OAuth.
// Each request owns its connection; a failed write is never automatically replayed.
export function createMcpCareClient(endpoint: URL, options: McpCareClientOptions = {}) {
  const target = new URL(endpoint.href), authenticatedFetch = options.fetch;
  if (authenticatedFetch && (target.href !== `${target.origin}/mcp` || target.username || target.password ||
      !["https:", "http:"].includes(target.protocol) || (typeof location !== "undefined" && target.origin !== location.origin))) {
    throw new Error("Authenticated MCP must use the exact same-origin endpoint");
  }
  const familyFetch: McpCareClientOptions["fetch"] = authenticatedFetch ? async (input, init = {}) => {
    const resource = new URL(input instanceof Request ? input.url : String(input), target);
    if (resource.href !== target.href) throw new Error("MCP request escaped its endpoint");
    const method = String(init.method ?? "GET").toUpperCase();
    // SDK 1.x optionally opens GET after initialized/202. Kin uses stateless request/response POSTs.
    // Resolve that optional stream locally: never send credentials, discovery, or retry traffic for it.
    if (method === "GET") return new Response(null, { status: 405 });
    if (method !== "POST" && method !== "DELETE") throw new Error("Unsupported MCP method");
    let response: Response;
    try { response = await authenticatedFetch(resource.href, { ...init, redirect: "error", credentials: "omit", cache: "no-store" }); }
    catch (error) {
      const status = record(error).status;
      if (status === 401 || status === 403) throw accessError(status);
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw accessError(response.status);
    }
    return response;
  } : undefined;
  const emit = (event: McpTraceEvent) => {
    // Tracing is optional observation; even an async observer cannot fail a care operation.
    try { void Promise.resolve(options.onTrace?.(event)).catch(() => {}); } catch {}
  };
  async function call(name: string, args: Record<string, unknown> = {}, validate?: (result: Record<string, unknown>) => void,
    rpcMethod: "tools/call" | "tools/list" | "resources/read" = "tools/call") {
    const client = new Client({ name: options.clientName ?? "kin-demonstration", version: "0.1.0" });
    const signal = AbortSignal.timeout(8000);
    const transport = new StreamableHTTPClientTransport(target, familyFetch ? { fetch: familyFetch,
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } } : undefined);
    const send = transport.send.bind(transport);
    let startedAt = performance.now();
    let rpcId: string | number | undefined;
    let requestId: string | undefined;
    let errorCode = "request_failed";
    transport.send = (...sendArgs) => {
      const [message] = sendArgs;
      for (const frame of Array.isArray(message) ? message : [message]) {
        if (!("method" in frame) || frame.method !== rpcMethod || !("id" in frame) || (rpcMethod === "tools/call" && frame.params?.name !== name)) continue;
        rpcId = typeof frame.id === "number" && Number.isSafeInteger(frame.id) ? frame.id : identifier(frame.id);
        requestId = identifier(record(frame.params?.arguments).requestId);
        startedAt = performance.now();
        emit({ tool: name, phase: "request", ...(rpcId !== undefined ? { rpcId } : {}), ...(requestId ? { requestId } : {}) });
      }
      // Forward the original message and every option unchanged, including future SDK options.
      return send(...sendArgs);
    };
    const trace = (phase: "result" | "error", details: Pick<McpTraceEvent, "result" | "errorCode">) => emit({
      tool: name, phase, ...(rpcId !== undefined ? { rpcId } : {}), ...(requestId ? { requestId } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)), ...details,
    });
    try {
      await client.connect(transport, { signal });
      if (rpcMethod !== "tools/call") {
        const result = rpcMethod === "tools/list" ? await client.listTools({}, { signal }) : await client.readResource({ uri: String(args.uri) }, { signal });
        trace("result", { result: {} });
        return result as Record<string, unknown>;
      }
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      if (result.isError || !result.structuredContent) {
        const details = result.structuredContent as Record<string, unknown> | undefined;
        if (details?.code === "family_access_denied") {
          errorCode = "family_access_denied";
          // A final authorization recheck may reject the response after a valid
          // commit. Close the private view, but never describe this as not saved.
          throw Object.assign(new Error("Family access changed. The save outcome is unconfirmed."), {
            status: 403, definitiveRejection: false, outcomeUnknown: true, requestId: identifier(args.requestId),
          });
        }
        errorCode = details?.code === "review_conflict" || details?.code === "task_not_found" || details?.code === "confirmation_conflict" ? details.code : "invalid_result";
        throw Object.assign(new Error("MCP tool did not return a confirmed result"), {
          definitiveRejection: details?.code === "review_conflict" || details?.code === "task_not_found" || details?.code === "confirmation_conflict",
        });
      }
      const structured = result.structuredContent as Record<string, unknown>;
      try { validate?.(structured); } catch (error) { errorCode = "receipt_mismatch"; throw error; }
      trace("result", { result: traceSummary(name, structured) });
      return structured;
    } catch (error) {
      const status = record(error).status;
      if ((status === 401 || status === 403) && errorCode !== "family_access_denied") errorCode = status === 401 ? "authentication_required" : "access_denied";
      trace("error", { errorCode: signal.aborted ? "timeout" : errorCode });
      throw error;
    } finally {
      // Cleanup failure must not turn an acknowledged write into a failed write.
      await client.close().catch(() => {});
    }
  }
  return {
    today: () => call("show_today"),
    brief: () => call("show_weekly_brief"),
    listTools: () => call("tools/list", {}, undefined, "tools/list") as Promise<ListToolsResult>,
    readResource: (uri: string) => call("resources/read", { uri }, undefined, "resources/read") as Promise<ReadResourceResult>,
    async confirm(input: { taskId: string; response: string; actor: string; requestId: string; expected: TaskReview }) {
      if (!taskReviewSchema.safeParse(input.expected).success) {
        throw Object.assign(new Error("Review the current task before confirming."), { definitiveRejection: true });
      }
      const result = await call("confirm_care_task", input, structured => {
        const receipt = record(structured.confirmation);
        if (receipt.requestId !== input.requestId || receipt.taskId !== input.taskId || receipt.response !== input.response) {
          throw new Error("Confirmation receipt mismatch");
        }
      });
      return { ...result, snapshot: result.refreshRequired ? null : result };
    },
  };
}
