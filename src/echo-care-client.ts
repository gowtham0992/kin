import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { CareTask, Confirmation, ConfirmationResponse, TodaySnapshot } from "./domain.js";
import { taskReviewSchema, type TaskReview } from "./task-review.js";
import { completionUndoBody, reviewedCompletionMatches, type CompletionUndoInput, type CompletionUndoResult } from "./response-undo.js";
import { planControlSchema, planPauseBody, planPauseProposalSchema, pausedTaskReferenceSchema, type PlanControl,
  type PlanPauseInput, type PlanPauseProposal, type PlanPauseResult } from "./plan-pause.js";

export type EchoCareErrorCode = "unauthenticated" | "forbidden" | "conflict" | "unavailable" | "outcome_unknown";
export class EchoCareError extends Error {
  constructor(readonly code: EchoCareErrorCode) {
    super(`Kin care request ${code}.`);
    this.name = "EchoCareError";
  }
}
export interface EchoConfirmationInput {
  taskId: string;
  response: ConfirmationResponse;
  actor: string;
  requestId: string;
  expected: TaskReview;
}
export interface EchoCareClient {
  reviewPlanPause?(accessToken: string): Promise<{ control: PlanControl; proposal: PlanPauseProposal | null }>;
  pausePlan?(accessToken: string, input: Omit<PlanPauseInput, "actor">): Promise<PlanPauseResult>;
  undoCompletion?(accessToken: string, input: Omit<CompletionUndoInput, "actor">): Promise<CompletionUndoResult>;
  prepareReminder?(accessToken: string, input: import("./reminder-tickets.js").ReminderTicketInput): Promise<{ ticket: string; expiresAt: number }>;
  today(accessToken: string): Promise<TodaySnapshot>;
  confirm(accessToken: string, input: EchoConfirmationInput): Promise<{
    confirmation: Confirmation; task: CareTask; refreshRequired: boolean;
  }>;
}
export interface EchoCareClientOptions {
  fetch?: StreamableHTTPClientTransportOptions["fetch"];
  timeoutMs?: number;
  /** Tests only; requires an injected fetch and an exact loopback hostname. */
  allowLoopbackForTests?: boolean;
  /** Optional metadata-only sink. It must never receive request/response data. */
  onDiagnostic?: (event: EchoCareDiagnostic) => unknown;
}
export interface EchoCareDiagnostic {
  readonly version: 1;
  readonly operation: "read" | "confirm";
  readonly phase: "input" | "initialize" | "initialized" | "tool" | "validation";
  readonly outcome: "success" | "failure";
  readonly reason: "none" | "input" | "deadline" | "network" | "http" | "tool_error" | "result_validation" | "protocol" | "response_limit";
  readonly elapsedMs: number;
  readonly phaseElapsedMs: number;
  /** Sequential client phases, including transport/body processing and cleanup.
   * Not server-only timings; rounded down separately, so sums can differ slightly. */
  readonly phases: Readonly<Partial<Record<EchoCareDiagnostic["phase"], number>>>;
  readonly httpStatus?: number;
}

function careDiagnostic(operation: EchoCareDiagnostic["operation"], sink: EchoCareClientOptions["onDiagnostic"]) {
  const started = performance.now();
  let phase: EchoCareDiagnostic["phase"] = "input", phaseStarted = started, finished = false;
  const phases: Partial<Record<EchoCareDiagnostic["phase"], number>> = {};
  let streamFailure: { phase: EchoCareDiagnostic["phase"]; phaseStarted: number } | undefined;
  const duration = (value: number) => Number.isFinite(value) ? Math.min(60_000, Math.max(0, Math.floor(value))) : 0;
  return {
    phase(next: EchoCareDiagnostic["phase"]) {
      if (!finished) {
        const now = performance.now();
        phases[phase] = duration((phases[phase] ?? 0) + duration(now - phaseStarted));
        phase = next; phaseStarted = now; streamFailure = undefined;
      }
    },
    noteStreamFailure() {
      // A completed SSE response can disconnect while the next POST succeeds.
      // Retain a failure hint, but let the operation's validated result decide.
      if (!finished && !streamFailure) streamFailure = { phase, phaseStarted };
    },
    finish(reason: EchoCareDiagnostic["reason"], httpStatus?: number) {
      if (finished) return;
      finished = true;
      const now = performance.now();
      phases[phase] = duration((phases[phase] ?? 0) + duration(now - phaseStarted));
      if (streamFailure && (reason === "protocol" || reason === "deadline")) {
        reason = "network"; phase = streamFailure.phase; phaseStarted = streamFailure.phaseStarted;
      }
      // Construct only allowlisted primitives; never spread upstream objects or
      // inspect error messages, schema issues, bodies, identifiers, or headers.
      const record: EchoCareDiagnostic = Object.freeze({ version: 1, operation, phase,
        outcome: reason === "none" ? "success" : "failure", reason,
        elapsedMs: duration(now - started), phaseElapsedMs: duration(now - phaseStarted),
        phases: Object.freeze({ ...phases }),
        ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {}),
      });
      try { void Promise.resolve(sink?.(record)).catch(() => {}); } catch { /* Diagnostics cannot change the care outcome. */ }
    },
  };
}
type CareDiagnostic = ReturnType<typeof careDiagnostic>;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const name = z.string().min(1).max(80);
const instant = z.string().max(40).datetime();
const response = z.enum(["done", "not_yet", "skipped"]);
const reviewSchema = taskReviewSchema.extend({ dueAt: instant, confirmedAt: instant.nullable(), confirmedBy: name.nullable() });
const taskSchema = reviewSchema.extend({
  id,
  routineId: id.optional(), changedAt: instant.optional(), changedBy: name.optional(),
  rescheduledFrom: z.object({ taskId: id, dueAt: instant }).strict().optional(),
  rescheduledTo: z.object({ taskId: id, dueAt: instant }).strict().optional(),
}).strict();
const dutySchema = z.object({ memberId: id, memberName: name, startsAt: instant, endsAt: instant,
  changedAt: instant.optional(), changedBy: name.optional() }).strict();
const escalationSchema = z.object({
  id: z.string().min(1).max(200), taskId: id, dueAt: instant, updatedAt: instant,
  recipientMemberName: name.nullable(), recipientMemberId: id.nullable().optional(),
  status: z.enum(["blocked", "queued", "sending", "sent", "failed", "receipt_pending"]),
  responseState: z.enum(["not_yet", "no_response"]).optional(), responseRecordedAt: instant.nullable().optional(),
  acknowledgedBy: name.optional(), acknowledgedAt: instant.optional(), sentAt: instant.optional(),
}).strict();
const count = z.number().int().min(0).max(500);
const todaySchema = z.object({
  date: z.iso.date(), tasks: z.array(taskSchema).max(500), onDuty: dutySchema.nullable(),
  escalations: z.array(escalationSchema).max(500),
  summary: z.object({ total: count, completed: count, remaining: count, skipped: count }).strict(),
}).strict().refine(snapshot => {
  const { tasks, summary } = snapshot;
  return new Set(tasks.map(task => task.id)).size === tasks.length &&
    tasks.every(task => task.state !== "cancelled") && summary.total === tasks.length &&
    summary.completed === tasks.filter(task => task.state === "done").length &&
    summary.skipped === tasks.filter(task => task.state === "skipped").length &&
    summary.remaining === tasks.filter(task => task.state === "scheduled").length;
});
const confirmationSchema = z.object({
  id: z.string().min(1).max(256), requestId: z.string().min(8).max(100), taskId: id,
  taskDueAt: instant, response, actor: name, recordedAt: instant,
}).strict();
const receiptSchema = z.object({ confirmation: confirmationSchema, task: taskSchema, refreshRequired: z.boolean() });
const inputSchema = z.object({ taskId: id, response, actor: name, requestId: z.string().min(8).max(100), expected: reviewSchema }).strict();
const undoReceiptSchema = z.object({
  undo: z.object({ id: z.string().min(1).max(256), requestId: z.string().min(8).max(100), confirmationRequestId: z.string().min(8).max(100),
    taskId: id, taskDueAt: instant, actor: name, recordedAt: instant, restored: reviewSchema }).strict(),
  task: taskSchema, replayed: z.boolean(),
}).strict();
const pauseResultSchema = z.object({ control: planControlSchema, replayed: z.boolean(), cancelledTasks: z.array(taskSchema).max(25),
  receipt: z.object({ startsAt: instant, endsAt: instant, requestId: z.string().min(8).max(100), recordedAt: instant, actor: name,
    timeZone: z.string().min(1).max(100), cancelled: z.array(pausedTaskReferenceSchema).max(25), nextTask: pausedTaskReferenceSchema.nullable() }).strict(),
}).strict();
const maxBodyBytes = 512 * 1024;

function configuredEndpoint(endpoint: string | URL, options: EchoCareClientOptions): URL {
  try {
    const raw = String(endpoint), url = new URL(raw);
    const testLoopback = options.allowLoopbackForTests === true && !!options.fetch &&
      url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if ((!testLoopback && url.protocol !== "https:") || raw !== `${url.origin}/mcp` ||
        url.username || url.password) throw new Error();
    return url;
  } catch { throw new EchoCareError("unavailable"); }
}

// Bound bytes before the SDK parses JSON/SSE. This protects the voice process
// from oversized responses, not just oversized fields in the final object.
function boundedResponse(upstream: Response, signal: AbortSignal, diagnostic: CareDiagnostic): Response {
  if (!upstream.body) return upstream;
  const reader = upstream.body.getReader();
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { signal.removeEventListener("abort", cancel); controller.close(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > maxBodyBytes) {
          diagnostic.finish("response_limit");
          signal.removeEventListener("abort", cancel); cancel();
          controller.error(new EchoCareError("unavailable"));
          return;
        }
        controller.enqueue(chunk.value);
      } catch {
        // An aborted body can be normal cleanup after the complete SSE result.
        // Deadlines/errors are recorded before abort; validation owns success.
        if (!signal.aborted) diagnostic.noteStreamFailure();
        signal.removeEventListener("abort", cancel); controller.error(new EchoCareError("unavailable"));
      }
    },
    cancel() { signal.removeEventListener("abort", cancel); cancel(); },
  });
  return new Response(body, { status: upstream.status, headers: upstream.headers });
}

export function createEchoCareClient(endpoint: string | URL, options: EchoCareClientOptions = {}): EchoCareClient {
  const target = configuredEndpoint(endpoint, options);
  // Leave room for Lambda startup, cleanup and Alexa's response delivery.
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new EchoCareError("unavailable");
  const fetcher = options.fetch ?? globalThis.fetch;

  async function call(accessToken: string, tool: "show_today" | "confirm_care_task" | "undo_care_completion" | "prepare_plan_reminder" | "review_plan_pause" | "pause_care_plan", args: Record<string, unknown>, diagnostic: CareDiagnostic) {
    if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(accessToken)) {
      diagnostic.finish("input"); throw new EchoCareError("unauthenticated");
    }
    const client = new Client({ name: "kin-echo", version: "0.1.0" });
    const controller = new AbortController(), endAt = Date.now() + timeoutMs;
    let writeDispatched = false;
    const failure = () => new EchoCareError(writeDispatched ? "outcome_unknown" : "unavailable");
    let rejectDeadline: (reason: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { diagnostic.finish("deadline"); rejectDeadline(failure()); controller.abort(); }, timeoutMs);
    const transport = new StreamableHTTPClientTransport(target, {
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.href !== target.href) throw failure();
        if (controller.signal.aborted) throw failure();
        const method = String(init.method ?? "GET").toUpperCase();
        // The SDK optionally opens a GET stream after initialized/202. This
        // stateless service never needs it, nor discovery or credential refresh.
        if (method === "GET") return new Response(null, { status: 405 });
        if (method !== "POST") throw failure();
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${accessToken}`);
        const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        const frame = typeof init.body === "string" ? JSON.parse(init.body) as { method?: string; params?: { name?: string } } : null;
        // Optional GET is handled above; only real POST phases move the trace.
        if (frame?.method === "initialize") diagnostic.phase("initialize");
        else if (frame?.method === "notifications/initialized") diagnostic.phase("initialized");
        else if (frame?.method === "tools/call") diagnostic.phase("tool");
        if (frame?.method === "tools/call" && ["confirm_care_task", "undo_care_completion", "pause_care_plan"].includes(String(frame.params?.name))) writeDispatched = true;
        let upstream: Response;
        try { upstream = await fetcher(target.href, { ...init, headers, signal, redirect: "error", credentials: "omit", cache: "no-store" }); }
        catch (error) { diagnostic.finish("network"); throw error; }
        if (upstream.redirected || (upstream.url && upstream.url !== target.href)) {
          void upstream.body?.cancel().catch(() => {});
          throw failure();
        }
        if (upstream.status === 401 || upstream.status === 403) {
          diagnostic.finish("http", upstream.status);
          void upstream.body?.cancel().catch(() => {});
          throw new EchoCareError(upstream.status === 401 ? "unauthenticated" : "forbidden");
        }
        if (!upstream.ok) {
          diagnostic.finish("http", upstream.status);
          void upstream.body?.cancel().catch(() => {});
          throw failure();
        }
        return boundedResponse(upstream, signal, diagnostic);
      },
    });
    try {
      return await Promise.race([(async () => {
        await client.connect(transport, { signal: controller.signal });
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal });
        if (result.isError || !result.structuredContent) {
          diagnostic.finish(result.isError ? "tool_error" : "result_validation");
          const code = (result.structuredContent as Record<string, unknown> | undefined)?.code;
          if (["review_conflict", "task_not_found", "confirmation_conflict", "undo_conflict", "pause_conflict"].includes(String(code))) throw new EchoCareError("conflict");
          throw failure();
        }
        return result.structuredContent;
      })(), deadline]);
    } catch (error) {
      diagnostic.finish("protocol");
      if (error instanceof EchoCareError) {
        // Parsing failures after dispatch cannot establish that a write failed.
        if (error.code === "unavailable" && writeDispatched) throw failure();
        throw error;
      }
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
      // SDK close is currently local/instant, but never let cleanup consume a
      // Lambda invocation or turn an acknowledged write into an unknown result.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.resolve().then(() => client.close()).catch(() => {}),
        new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, Math.min(25, Math.max(0, endAt - Date.now()))); })]);
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  }

  return {
    async reviewPlanPause(accessToken) {
      const diagnostic = careDiagnostic("read", options.onDiagnostic);
      const content = await call(accessToken, "review_plan_pause", {}, diagnostic);
      diagnostic.phase("validation");
      const result = z.object({ control: planControlSchema, proposal: planPauseProposalSchema.nullable() }).strict().safeParse(content);
      if (!result.success || (!result.data.proposal && !result.data.control.pause) ||
          (result.data.proposal && result.data.control.pause && result.data.control.pause.endsAt > result.data.proposal.startsAt)) {
        diagnostic.finish("result_validation"); throw new EchoCareError("unavailable");
      }
      diagnostic.finish("none"); return result.data;
    },
    async pausePlan(accessToken, input) {
      const diagnostic = careDiagnostic("confirm", options.onDiagnostic);
      const parsed = planPauseBody.safeParse(input);
      if (!parsed.success) { diagnostic.finish("input"); throw new EchoCareError("conflict"); }
      const content = await call(accessToken, "pause_care_plan", parsed.data, diagnostic);
      diagnostic.phase("validation");
      const result = pauseResultSchema.safeParse(content), receipt = result.success ? result.data.receipt : undefined;
      if (!result.success || !receipt || receipt.requestId !== input.requestId || receipt.startsAt !== input.startsAt || receipt.endsAt !== input.endsAt ||
          result.data.control.version < 1 || result.data.control.pause?.requestId !== input.requestId ||
          result.data.control.pause.startsAt !== input.startsAt || result.data.control.pause.endsAt !== input.endsAt ||
          result.data.control.pause.recordedAt !== receipt.recordedAt || result.data.control.pause.actor !== receipt.actor ||
          !planPauseProposalSchema.safeParse({ startsAt: receipt.startsAt, endsAt: receipt.endsAt, timeZone: receipt.timeZone,
            durationHours: 168, expiresAt: new Date(Date.parse(input.startsAt) + 300_000).toISOString(), reviewToken: input.reviewToken,
            tasks: receipt.cancelled, nextTask: receipt.nextTask }).success ||
          result.data.cancelledTasks.some(task => task.state !== "cancelled" || task.lastResponse !== null || task.confirmedAt !== null || task.confirmedBy !== null ||
            task.changedAt !== receipt.recordedAt || task.changedBy !== receipt.actor || task.dueAt <= receipt.recordedAt || task.dueAt >= input.endsAt) ||
          JSON.stringify(receipt.cancelled) !== JSON.stringify(result.data.cancelledTasks.map(({ id, title, dueAt }) => ({ id, title, dueAt })))) {
        diagnostic.finish("result_validation"); throw new EchoCareError("outcome_unknown");
      }
      diagnostic.finish("none"); return result.data;
    },
    async undoCompletion(accessToken, input) {
      const diagnostic = careDiagnostic("confirm", options.onDiagnostic);
      const parsed = completionUndoBody.safeParse(input);
      if (!parsed.success) { diagnostic.finish("input"); throw new EchoCareError("conflict"); }
      const content = await call(accessToken, "undo_care_completion", parsed.data, diagnostic);
      diagnostic.phase("validation");
      const result = undoReceiptSchema.safeParse(content);
      if (!result.success || result.data.undo.requestId !== input.requestId || result.data.undo.confirmationRequestId !== input.confirmationRequestId ||
          result.data.undo.taskId !== input.taskId || result.data.undo.taskDueAt !== input.expected.dueAt ||
          result.data.task.id !== input.taskId || result.data.task.dueAt !== input.expected.dueAt ||
          result.data.undo.restored.state !== "scheduled" || !reviewedCompletionMatches(result.data.task, result.data.undo.restored) ||
          !reviewedCompletionMatches(result.data.task, input.restore)) {
        diagnostic.finish("result_validation"); throw new EchoCareError("outcome_unknown");
      }
      diagnostic.finish("none"); return result.data;
    },
    async today(accessToken) {
      const diagnostic = careDiagnostic("read", options.onDiagnostic);
      const content = await call(accessToken, "show_today", {}, diagnostic);
      diagnostic.phase("validation");
      const result = todaySchema.safeParse(content);
      if (!result.success) { diagnostic.finish("result_validation"); throw new EchoCareError("unavailable"); }
      diagnostic.finish("none");
      return result.data;
    },
    async prepareReminder(accessToken, input) {
      const diagnostic = careDiagnostic("confirm", options.onDiagnostic);
      const content = await call(accessToken, "prepare_plan_reminder", input, diagnostic);
      diagnostic.phase("validation");
      const result = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() }).strict().safeParse(content);
      if (!result.success) { diagnostic.finish("result_validation"); throw new EchoCareError("unavailable"); }
      diagnostic.finish("none"); return result.data;
    },
    async confirm(accessToken, input) {
      const diagnostic = careDiagnostic("confirm", options.onDiagnostic);
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) { diagnostic.finish("input"); throw new EchoCareError("conflict"); }
      const content = await call(accessToken, "confirm_care_task", parsed.data, diagnostic);
      diagnostic.phase("validation");
      const result = receiptSchema.safeParse(content);
      if (!result.success || result.data.confirmation.requestId !== parsed.data.requestId ||
          result.data.confirmation.taskId !== parsed.data.taskId || result.data.confirmation.response !== parsed.data.response ||
          result.data.confirmation.taskDueAt !== parsed.data.expected.dueAt || result.data.task.id !== parsed.data.taskId ||
          result.data.task.dueAt !== parsed.data.expected.dueAt) { diagnostic.finish("result_validation"); throw new EchoCareError("outcome_unknown"); }
      diagnostic.finish("none");
      return result.data;
    },
  };
}
