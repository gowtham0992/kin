import { afterEach, describe, expect, it, vi } from "vitest";
import { createEchoCareClient, type EchoCareDiagnostic } from "../src/echo-care-client.js";
import { createEchoHandler } from "../src/echo-lambda.js";

const endpoint = "https://kin.example/mcp", secret = "PRIVATE-CREDENTIAL";
const task = { id: "private-task-id", title: "PRIVATE TASK TEXT", dueAt: "2026-09-11T16:00:00.000Z",
  state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null };
const snapshot = { date: "2026-09-11", tasks: [task], onDuty: null, escalations: [],
  summary: { total: 1, completed: 0, skipped: 0, remaining: 1 } };
const input = { taskId: task.id, response: "done" as const, actor: "PRIVATE ACTOR", requestId: "private-request-id",
  expected: { title: task.title, dueAt: task.dueAt, state: "scheduled" as const, lastResponse: null, confirmedAt: null, confirmedBy: null } };
const methods = ["initialize", "notifications/initialized", "tools/call"];
function fixture(onDiagnostic?: (event: EchoCareDiagnostic) => unknown) {
  const events: EchoCareDiagnostic[] = [], frames: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
    const frame = JSON.parse(String(init.body)); frames.push(frame.method);
    if (frame.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = frame.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "kin", version: "1" } }
      : { content: [{ type: "text", text: "PRIVATE TOOL TEXT" }], structuredContent: snapshot };
    return Response.json({ jsonrpc: "2.0", id: frame.id, result });
  });
  const client = createEchoCareClient(endpoint, { fetch, onDiagnostic: event => { events.push(event); return onDiagnostic?.(event); } });
  return { client, fetch, events, frames };
}
function safeEvent(event: EchoCareDiagnostic) {
  expect(Object.keys(event).sort()).toEqual(["elapsedMs", "operation", "outcome", "phase", "phaseElapsedMs", "reason", "version",
    ...(event.httpStatus === undefined ? [] : ["httpStatus"])].sort());
  for (const key of ["elapsedMs", "phaseElapsedMs"] as const) {
    expect(Number.isInteger(event[key])).toBe(true); expect(event[key]).toBeGreaterThanOrEqual(0); expect(event[key]).toBeLessThanOrEqual(60_000);
  }
  expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private-|kin\.example|Bearer|stack|issues/);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("privacy-safe Echo care diagnostics", () => {
  it("emits one allowlisted success only after snapshot validation, without recording optional GET", async () => {
    const f = fixture(); await expect(f.client.today(secret)).resolves.toEqual(snapshot);
    expect(f.frames).toEqual(methods); expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ version: 1, operation: "read", outcome: "success", reason: "none", phase: "validation" }); safeEvent(f.events[0]!);
  });
  it.each([true, false])("does not classify intentional open-SSE cleanup as network failure (valid result: %s)", async valid => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const frame = JSON.parse(String(init?.body));
      if (frame.method !== "tools/call") return original(url, init);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: frame.id,
          result: { content: [], structuredContent: valid ? snapshot : { ...snapshot, date: "PRIVATE INVALID DATE" } } })}\n\n`));
        // Real fetch bodies may error on abort even after the SDK received the
        // complete result. Leave this SSE stream open until client cleanup.
        init?.signal?.addEventListener("abort", () => controller.error(new Error("PRIVATE CLEANUP ABORT")), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    });
    if (valid) await expect(f.client.today(secret)).resolves.toEqual(snapshot);
    else await expect(f.client.today(secret)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ phase: "validation",
      outcome: valid ? "success" : "failure", reason: valid ? "none" : "result_validation" }); safeEvent(f.events[0]!);
  });
  it("still classifies a genuine upstream stream failure before a result as network failure", async () => {
    vi.useFakeTimers(); const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (JSON.parse(String(init?.body)).method !== "tools/call") return original(url, init);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE STREAM FAILURE")); } }),
        { headers: { "content-type": "text/event-stream" } });
    });
    const result = f.client.today(secret).catch(error => error);
    await vi.advanceTimersByTimeAsync(5001); expect(await result).toMatchObject({ code: "unavailable" });
    expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ phase: "tool", outcome: "failure", reason: "network" }); safeEvent(f.events[0]!);
  });
  it.each(methods)("records the exact deadline phase at %s once, even after a late response", async stalled => {
    vi.useFakeTimers(); const f = fixture(), original = f.fetch.getMockImplementation()!;
    let release!: (response: Response) => void, late!: Response;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (JSON.parse(String(init?.body)).method !== stalled) return response;
      late = response; return new Promise<Response>(resolve => { release = resolve; });
    });
    const result = f.client.today(secret).catch(error => error);
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.events).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(await result).toMatchObject({ code: "unavailable" }); expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ reason: "deadline", outcome: "failure", phase: ["initialize", "initialized", "tool"][methods.indexOf(stalled)], elapsedMs: 5000 });
    release(late); await vi.advanceTimersByTimeAsync(50); expect(f.events).toHaveLength(1); safeEvent(f.events[0]!);
  });
  it.each([401, 403, 500])("reports HTTP %s without response text and preserves public errors", async status => {
    const f = fixture(); f.fetch.mockResolvedValue(new Response("PRIVATE HTTP BODY", { status }));
    await expect(f.client.today(secret)).rejects.toMatchObject({ code: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "unavailable" });
    expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ reason: "http", phase: "initialize", httpStatus: status }); safeEvent(f.events[0]!);
  });
  it.each(["network", "protocol", "tool_error", "result_validation", "response_limit"] as const)("distinguishes %s without serializing hostile upstream details", async kind => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (kind === "network") throw new Error("PRIVATE exception stack and token");
      if (kind === "protocol") return new Response("PRIVATE invalid JSON", { headers: { "content-type": "application/json" } });
      if (kind === "response_limit") return new Response("x".repeat(524289), { headers: { "content-type": "application/json" } });
      const frame = JSON.parse(String(init?.body));
      if (frame.method !== "tools/call") return original(url, init);
      return Response.json({ jsonrpc: "2.0", id: frame.id, result: kind === "tool_error"
        ? { isError: true, content: [{ type: "text", text: "PRIVATE TOOL ERROR" }] }
        : { content: [], structuredContent: { ...snapshot, tasks: [{ ...task, title: "PRIVATE".repeat(50) }] } } });
    });
    await expect(f.client.today(secret)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ reason: kind, outcome: "failure" }); safeEvent(f.events[0]!);
  });
  it.each(["throws", "rejects", "never settles"])("isolates a diagnostic callback that %s from success and failure", async behavior => {
    const f = fixture(() => { if (behavior === "throws") throw new Error("PRIVATE CALLBACK");
      return behavior === "rejects" ? Promise.reject(new Error("PRIVATE CALLBACK")) : new Promise(() => {}); });
    await expect(f.client.today(secret)).resolves.toEqual(snapshot);
    f.fetch.mockRejectedValue(new Error("PRIVATE NETWORK"));
    await expect(f.client.today(secret)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.events).toHaveLength(2); f.events.forEach(safeEvent);
  });
  it("keeps concurrent operation traces separate and write uncertainty unchanged with no retry", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const frame = JSON.parse(String(init?.body));
      if (frame.params?.name === "confirm_care_task") throw new Error("PRIVATE WRITE NETWORK");
      return original(url, init);
    });
    const result = await Promise.allSettled([f.client.today(secret), f.client.confirm("SECOND-PRIVATE-CREDENTIAL", input)]);
    expect(result[0].status).toBe("fulfilled"); expect(result[1]).toMatchObject({ status: "rejected", reason: { code: "outcome_unknown" } });
    expect(f.events).toHaveLength(2); expect(f.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "read", reason: "none", phase: "validation" }),
      expect.objectContaining({ operation: "confirm", reason: "network", phase: "tool" }),
    ])); expect(f.fetch).toHaveBeenCalledTimes(6); f.events.forEach(safeEvent);
  });
  it("uses bounded monotonic durations when the wall clock changes", async () => {
    const f = fixture(); vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(-999999);
    let tick = 90; vi.spyOn(performance, "now").mockImplementation(() => tick += 10);
    await f.client.today(secret); expect(f.events).toHaveLength(1); safeEvent(f.events[0]!);
    expect(f.events[0]).toMatchObject({ elapsedMs: 50, phaseElapsedMs: 10 });
  });
  it("wires the default Lambda care reader to a safe structured log, retaining generic speech", async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(f.fetch);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const skillId = "amzn1.ask.skill.a7cb5179-6d37-4fe3-bb53-f39193f67ed6";
    fetch.mockRejectedValue(new Error("PRIVATE ERROR"));
    const handler = createEchoHandler({ KIN_ECHO_SKILL_ID: skillId, KIN_ECHO_ENABLED: "true", KIN_ECHO_CARE_ENABLED: "true", KIN_ECHO_MCP_ENDPOINT: endpoint });
    const result = await handler({ version: "1.0", context: { System: { application: { applicationId: skillId }, user: { userId: "PRIVATE USER", accessToken: secret } } },
      session: { new: true, sessionId: "PRIVATE SESSION", application: { applicationId: skillId } },
      request: { type: "LaunchRequest", requestId: "PRIVATE REQUEST", timestamp: "2026-09-11T16:00:00.000Z", locale: "en-US" } });
    expect(result.response.outputSpeech).toMatchObject({ ssml: "<speak>I couldn't load the family plan right now. Please try again shortly.</speak>" });
    expect(log).toHaveBeenCalledTimes(1); const record = JSON.parse(log.mock.calls[0]![0]);
    expect(record.event).toBe("kin_echo_care_result"); delete record.event; safeEvent(record);
    expect(record).toMatchObject({ reason: "network", phase: "initialize" });
  });
});
