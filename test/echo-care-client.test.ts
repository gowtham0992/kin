import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEchoCareClient, EchoCareError } from "../src/echo-care-client.js";
import { createDemoStore, InMemoryCareStore } from "../src/domain.js";
import { createHttpApp } from "../src/http.js";
import { taskReview } from "../src/task-review.js";
import { acceptPlanPause, makePauseWindow, proposePlanPause } from "../src/plan-pause.js";

const endpoint = "https://kin.example/mcp", token = "synthetic-echo-token";
const task = { id: "water", title: "Drink water", dueAt: "2026-09-11T16:00:00.000Z", state: "scheduled" as const,
  lastResponse: null, confirmedAt: null, confirmedBy: null };
const snapshot = { date: "2026-09-11", tasks: [task], onDuty: null, escalations: [],
  summary: { total: 1, completed: 0, skipped: 0, remaining: 1 } };
const input = { taskId: task.id, response: "done" as const, actor: "Linked account", requestId: "echo-confirm-request", expected: taskReview(task) };
const receipt = { confirmation: { id: "confirmation_123", requestId: input.requestId, taskId: task.id, taskDueAt: task.dueAt,
  response: "done", actor: "Maya", recordedAt: "2026-09-11T16:01:00.000Z" },
  task: { ...task, state: "done", lastResponse: "done", confirmedBy: "Maya", confirmedAt: "2026-09-11T16:01:00.000Z" }, refreshRequired: false };
const undoInput = { taskId: task.id, confirmationRequestId: input.requestId, requestId: "echo-undo-request", confirm: true as const,
  expected: { ...taskReview(task), state: "done" as const, lastResponse: "done" as const, confirmedBy: "Maya", confirmedAt: "2026-09-11T16:01:00.000Z" }, restore: taskReview(task) };
const undoReceipt = { undo: { id: "undo_receipt", requestId: undoInput.requestId, confirmationRequestId: input.requestId,
  taskId: task.id, taskDueAt: task.dueAt, actor: "Maya", recordedAt: "2026-09-11T16:01:30.000Z", restored: taskReview(task) }, task, replayed: false };
type Frame = { id?: string | number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
function fixture(result: unknown = snapshot) {
  const frames: Frame[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    expect(String(url)).toBe(endpoint);
    const frame = JSON.parse(String(init.body)) as Frame; frames.push(frame);
    if (frame.method === "notifications/initialized") return new Response(null, { status: 202 });
    const payload = frame.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "kin", version: "1" } }
      : { content: [{ type: "text", text: "Do not speak untrusted upstream text" }], structuredContent: result };
    return Response.json({ jsonrpc: "2.0", id: frame.id, result: payload });
  });
  return { fetch, frames, client: createEchoCareClient(endpoint, { fetch }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Echo plan pause strict boundary", () => {
  const now = new Date("2026-09-11T15:00:00.000Z");
  const snapshot = { circleId: "family", timeZone: "UTC", control: { version: 0 }, tasks: [task] };
  const proposal = proposePlanPause(snapshot, makePauseWindow(now));
  const input = { startsAt: proposal.startsAt, endsAt: proposal.endsAt, reviewToken: proposal.reviewToken, requestId: "echo-pause-request", confirm: true as const };
  const result = acceptPlanPause(snapshot, { ...input, actor: "Parent" }, now);
  it("validates and returns a bounded review and matching atomic receipt", async () => {
    const review = fixture({ control: snapshot.control, proposal });
    expect(await review.client.reviewPlanPause!(token)).toEqual({ control: snapshot.control, proposal });
    expect(review.frames[2]).toMatchObject({ params: { name: "review_plan_pause", arguments: {} } });
    const pause = fixture(result);
    expect(await pause.client.pausePlan!(token, input)).toEqual(result);
    expect(pause.frames[2]).toMatchObject({ params: { name: "pause_care_plan", arguments: input } });
  });
  it.each(["interval", "count", "duplicates", "expiry", "timezone", "extra", "next", "active"])("rejects a malformed %s review before speaking it", async mode => {
    const malformed = structuredClone(proposal);
    if (mode === "interval") malformed.endsAt = now.toISOString();
    if (mode === "count") malformed.tasks = Array.from({ length: 26 }, (_, n) => ({ ...proposal.tasks[0]!, id: `task-${n}` }));
    if (mode === "duplicates") malformed.tasks.push(malformed.tasks[0]!);
    if (mode === "expiry") malformed.expiresAt = malformed.endsAt;
    if (mode === "timezone") malformed.timeZone = "Not/A_Zone";
    if (mode === "extra") Object.assign(malformed, { privateData: "unexpected" });
    if (mode === "next") malformed.nextTask = proposal.tasks[0]!;
    const f = fixture({ control: mode === "active" ? result.control : snapshot.control, proposal: malformed });
    await expect(f.client.reviewPlanPause!(token)).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["request", "control", "interval", "task-state", "task-audit", "duplicates", "next", "extra"])("treats a mismatched %s result as unknown rather than a failed write", async mode => {
    const malformed = structuredClone(result);
    if (mode === "request") malformed.receipt.requestId = "other-request";
    if (mode === "control") malformed.control.pause!.requestId = "other-request";
    if (mode === "interval") malformed.receipt.endsAt = proposal.startsAt;
    if (mode === "task-state") malformed.cancelledTasks[0]!.state = "done";
    if (mode === "task-audit") malformed.cancelledTasks[0]!.changedAt = "2026-09-11T15:01:00.000Z";
    if (mode === "duplicates") { malformed.receipt.cancelled.push(malformed.receipt.cancelled[0]!); malformed.cancelledTasks.push(malformed.cancelledTasks[0]!); }
    if (mode === "next") malformed.receipt.nextTask = proposal.tasks[0]!;
    if (mode === "extra") Object.assign(malformed.cancelledTasks[0]!, { responseVersion: "private" });
    const f = fixture(malformed);
    await expect(f.client.pausePlan!(token, input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.frames.filter(frame => frame.method === "tools/call")).toHaveLength(1);
  });
  it("does not dispatch a pause without explicit consent", async () => {
    const f = fixture(result);
    await expect(f.client.pausePlan!(token, { ...input, confirm: false } as never)).rejects.toMatchObject({ code: "conflict" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("Echo care MCP boundary", () => {
  it("reads and confirms a browser-rescheduled check-in, then reads a cancelled week after write gates close", async () => {
    const now = new Date("2026-09-11T15:00:00.000Z");
    const store = new InMemoryCareStore([task], () => now);
    let rescheduleEnabled = true;
    const options = { mcpAuthMode: "standard" as const,
      canonicalMcpUri: endpoint, authorizationServer: "https://kin.example",
      get rescheduleEnabled() { return rescheduleEnabled; },
      accessAuthorizer: { async authorize() { return { subject: "maya", claims: { iss: "https://kin.example" }, scopes: new Set(["mcp:tools"]) }; } },
      familyAccess: { circleId: "family", directory: { async find() { return { circleId: "family", memberId: "maya", name: "Maya", role: "caregiver", status: "active" }; } } },
    };
    let app = createHttpApp(store, undefined, options);
    const fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
      expect(String(_url)).toBe(endpoint);
      const outgoing = request(app).post("/mcp");
      new Headers(init.headers).forEach((value, name) => outgoing.set(name, value));
      const result = await outgoing.send(JSON.parse(String(init.body)));
      return new Response(result.status === 202 ? null : result.text, { status: result.status, headers: result.headers as Record<string, string> });
    };
    const client = createEchoCareClient(endpoint, { fetch });
    const moved = await request(app).post(`/api/tasks/${task.id}/change`).set("authorization", `Bearer ${token}`)
      .send({ action: "reschedule", dueAt: "2026-09-11T18:00:00.000Z", expected: { title: task.title, dueAt: task.dueAt },
        requestId: "browser-move-for-echo", confirm: true }).expect(200);
    // Disabling new writes must not make already-written replacement metadata unreadable.
    rescheduleEnabled = false;
    app = createHttpApp(store, undefined, options);
    const today = await client.today(token);
    expect(today.tasks).toHaveLength(1);
    const replacement = today.tasks[0]!;
    expect(replacement).toMatchObject({ id: moved.body.replacement.taskId, dueAt: "2026-09-11T18:00:00.000Z",
      rescheduledFrom: { taskId: task.id, dueAt: task.dueAt } });
    const saved = await client.confirm(token, { taskId: replacement.id, response: "done", actor: "Forged",
      requestId: "echo-confirm-moved", expected: taskReview(replacement) });
    expect(saved.task).toMatchObject({ state: "done", rescheduledFrom: replacement.rescheduledFrom });
    expect(saved.confirmation.actor).toBe("Maya");
    await store.scheduleTask({ id: "future-test", title: "A later check-in", dueAt: "2026-09-11T20:00:00.000Z" });
    const review = await client.reviewPlanPause!(token);
    expect(review.proposal!.tasks.map(item => item.id)).toEqual(["future-test"]);
    const proposal = review.proposal!;
    const paused = await client.pausePlan!(token, { startsAt: proposal.startsAt, endsAt: proposal.endsAt,
      reviewToken: proposal.reviewToken, requestId: "echo-cancel-week", confirm: true });
    expect(paused.cancelledTasks.map(item => item.id)).toEqual(["future-test"]);
    Object.defineProperty(store, "planPauseEnabled", { value: false });
    app = createHttpApp(store, undefined, options);
    const remaining = await client.today(token);
    expect(remaining.tasks).toEqual([saved.task]);
    expect(remaining.summary).toEqual({ total: 1, completed: 1, skipped: 0, remaining: 0 });
    const plan = await request(app).get("/api/plan").set("authorization", `Bearer ${token}`).expect(200);
    expect(plan.body.features).toMatchObject({ reschedule: false, planPause: false });
    expect(plan.body.planPause.pause.requestId).toBeTruthy();
    await expect(store.scheduleTask({ id: "blocked-new", title: "Must stay blocked", dueAt: "2026-09-11T21:00:00.000Z" }))
      .rejects.toMatchObject({ name: "PlanPauseConflict" });
  });
  it("sends a reviewed undo and validates the matching restored state receipt", async () => {
    const f = fixture(undoReceipt);
    expect(await f.client.undoCompletion!(token, undoInput)).toEqual(undoReceipt);
    expect(f.frames[2]).toMatchObject({ params: { name: "undo_care_completion", arguments: undoInput } });
  });
  it.each([{ requestId: "another-request" }, { confirmationRequestId: "another-completion" }, { taskId: "another-task" },
    { taskDueAt: "2026-09-12T16:00:00.000Z" }, { restored: { ...taskReview(task), lastResponse: "not_yet" } }])("rejects a mismatched undo receipt %j as an unknown outcome", async patch => {
    const f = fixture({ ...undoReceipt, undo: { ...undoReceipt.undo, ...patch } });
    await expect(f.client.undoCompletion!(token, undoInput)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.frames.filter(frame => frame.method === "tools/call")).toHaveLength(1);
  });
  it("rejects a self-consistent but unreviewed fresh not-yet restoration", async () => {
    const restored = { ...taskReview(task), lastResponse: "not_yet", confirmedAt: "2026-09-11T16:02:00.000Z", confirmedBy: "Maya" };
    const f = fixture({ ...undoReceipt, task: { ...task, ...restored }, undo: { ...undoReceipt.undo, restored } });
    await expect(f.client.undoCompletion!(token, undoInput)).rejects.toMatchObject({ code: "outcome_unknown" });
  });
  it("rejects undo without explicit consent before dispatch", async () => {
    const f = fixture(undoReceipt);
    await expect(f.client.undoCompletion!(token, { ...undoInput, confirm: false } as never)).rejects.toMatchObject({ code: "conflict" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("reads a validated snapshot over a real SDK connection and sends credentials only to the fixed POST endpoint", async () => {
    const f = fixture();
    const unownedFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unowned fetch is forbidden"));
    await expect(f.client.today(token)).resolves.toEqual(snapshot);
    expect(f.frames.map(frame => frame.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(f.frames[2]).toMatchObject({ params: { name: "show_today", arguments: {} } });
    for (const [, init] of f.fetch.mock.calls) {
      expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(init?.signal?.aborted).toBe(true);
    }
    expect(unownedFetch).not.toHaveBeenCalled();
  });
  it.each(["", "with space", "bad\r\nheader", "x".repeat(16385)])("rejects an invalid bearer token before fetching", async invalid => {
    const f = fixture();
    await expect(f.client.today(invalid)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["http://kin.example/mcp", "https://kin.example/api/today", "https://kin.example/mcp?", "https://kin.example/mcp#",
    "https://name:password@kin.example/mcp", "https://kin.example/a/../mcp", "https://kin.example:443/mcp", "https://KIN.example/mcp"]) (
    "rejects unsafe or noncanonical endpoint %s", url => {
      expect(() => createEchoCareClient(url, { fetch: vi.fn() })).toThrow(EchoCareError);
    });
  it("permits loopback only with both explicit test mode and injected fetch", () => {
    for (const options of [{}, { fetch: vi.fn() }, { allowLoopbackForTests: true }]) {
      expect(() => createEchoCareClient("http://127.0.0.1:1234/mcp", options)).toThrow();
    }
    expect(() => createEchoCareClient("http://127.0.0.1:1234/mcp", { allowLoopbackForTests: true, fetch: vi.fn() })).not.toThrow();
    expect(() => createEchoCareClient("http://foreign.example/mcp", { allowLoopbackForTests: true, fetch: vi.fn() })).toThrow();
  });
  it.each([99, 5001, 30000, 100.5, NaN, Infinity])("rejects unsafe timeout budget %s", timeoutMs => {
    expect(() => createEchoCareClient(endpoint, { timeoutMs })).toThrow();
  });
  it("accepts the approved five-second request budget", () => {
    expect(() => createEchoCareClient(endpoint, { timeoutMs: 5000 })).not.toThrow();
  });
  it.each([401, 403])("turns HTTP %s into a safe error without OAuth discovery or retries", async status => {
    const fetch = vi.fn(async () => new Response("PRIVATE SECRET", { status,
      headers: { "www-authenticate": 'Bearer resource_metadata="https://evil.example/metadata"' } }));
    const error = await createEchoCareClient(endpoint, { fetch }).today(token).catch(error => error);
    expect(error).toMatchObject({ code: status === 401 ? "unauthenticated" : "forbidden" });
    expect(String(error)).not.toMatch(/PRIVATE|SECRET|evil|synthetic/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a redirected response without making a request to its foreign location", async () => {
    const upstream = Response.json({});
    Object.defineProperties(upstream, { redirected: { value: true }, url: { value: "https://foreign.example/mcp" } });
    const fetch = vi.fn(async () => upstream);
    await expect(createEchoCareClient(endpoint, { fetch }).today(token)).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([endpoint, { redirect: "error" }]);
  });
  it.each([undefined, { ...snapshot, tasks: Array(501).fill(task) }, { ...snapshot, tasks: [task, task] },
    { ...snapshot, summary: { ...snapshot.summary, completed: 4 } }, { ...snapshot, tasks: [{ ...task, state: "invented" }] },
    { ...snapshot, tasks: [{ ...task, title: "x".repeat(121) }] }])("rejects an absent, malformed or inconsistent snapshot", async result => {
    const f = fixture(result === undefined ? null : result);
    await expect(f.client.today(token)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("validates a confirmation receipt and returns only its explicit contract", async () => {
    const f = fixture({ ...snapshot, ...receipt });
    await expect(f.client.confirm(token, input)).resolves.toEqual(receipt);
    expect(f.frames[2]).toMatchObject({ params: { name: "confirm_care_task", arguments: input } });
  });
  it.each([{ requestId: "wrong-request" }, { taskId: "other-task" }, { response: "skipped" },
    { taskDueAt: "2026-09-12T16:00:00.000Z" }, { taskDueAt: undefined }])("treats mismatched receipt %j as unknown, without replay", async patch => {
    const f = fixture({ ...receipt, confirmation: { ...receipt.confirmation, ...patch } });
    await expect(f.client.confirm(token, input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.frames.filter(frame => frame.method === "tools/call")).toHaveLength(1);
  });
  it.each([{ task: { ...receipt.task, id: "other-task" } }, { task: { ...receipt.task, dueAt: "2026-09-12T16:00:00.000Z" } },
    { refreshRequired: "false" }, { task: { ...receipt.task, state: "invented" } }])("rejects a malformed result %j as unknown", async patch => {
    await expect(fixture({ ...receipt, ...patch }).client.confirm(token, input)).rejects.toMatchObject({ code: "outcome_unknown" });
  });
  it("accepts a committed receipt when refresh fails or a later family update changed current task state", async () => {
    const result = { ...receipt, refreshRequired: true, task: { ...task, lastResponse: "not_yet", confirmedBy: "Theo", confirmedAt: "2026-09-11T16:02:00.000Z" } };
    await expect(fixture(result).client.confirm(token, input)).resolves.toEqual(result);
  });
  it.each([undefined, {}, { ...input.expected, title: "x".repeat(121) }])("rejects invalid local review without sending a write", async expected => {
    const f = fixture(receipt);
    await expect(f.client.confirm(token, { ...input, expected: expected as never })).rejects.toMatchObject({ code: "conflict" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["review_conflict", "task_not_found", "confirmation_conflict", "family_access_denied", "unknown"]) (
    "maps MCP error %s without leaking tool text or retrying", async code => {
      const f = fixture(), original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, init) => {
        const frame = JSON.parse(String(init?.body)) as Frame;
        return frame.method === "tools/call" ? Response.json({ jsonrpc: "2.0", id: frame.id,
          result: { isError: true, content: [{ type: "text", text: "PRIVATE SECRET" }], structuredContent: { code } } }) : original(url, init);
      });
      const error = await f.client.confirm(token, input).catch(error => error);
      expect(error).toMatchObject({ code: ["review_conflict", "task_not_found", "confirmation_conflict"].includes(code) ? "conflict" : "outcome_unknown" });
      expect(String(error)).not.toMatch(/PRIVATE|SECRET/);
      expect(f.fetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === "tools/call")).toHaveLength(1);
    });
  it("does not retry a dispatched write after a network error", async () => {
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (JSON.parse(String(init?.body)).method === "tools/call") throw new Error("PRIVATE network error");
      return original(url, init);
    });
    await expect(f.client.confirm(token, input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])("bounds a stalled operation even when injected fetch ignores abort (write dispatched: %s)", async write => {
    vi.useFakeTimers();
    const f = fixture(), original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const frame = JSON.parse(String(init?.body));
      return !write || frame.method === "tools/call" ? new Promise<Response>(() => {}) : original(url, init);
    });
    const client = createEchoCareClient(endpoint, { fetch: f.fetch, timeoutMs: 100 });
    const result = (write ? client.confirm(token, input) : client.today(token)).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ code: write ? "outcome_unknown" : "unavailable" });
    expect(f.fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });
  it("preserves a successful receipt even when SDK cleanup hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Client.prototype, "close").mockImplementation(async () => new Promise<void>(() => {}));
    const result = fixture(receipt).client.confirm(token, input);
    await vi.advanceTimersByTimeAsync(26);
    await expect(result).resolves.toEqual(receipt);
  });
  it("isolates concurrent linked-account tokens in request-owned connections", async () => {
    const f = fixture();
    await Promise.all([f.client.today("first-user"), f.client.today("second-user")]);
    expect(f.frames.filter(frame => frame.method === "initialize")).toHaveLength(2);
    expect(f.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")).sort())
      .toEqual([...Array(3).fill("Bearer first-user"), ...Array(3).fill("Bearer second-user")]);
  });
  it("rejects oversized upstream bodies without exposing their content", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(524289), { headers: { "content-type": "application/json" } }));
    await expect(createEchoCareClient(endpoint, { fetch }).today(token)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("runs real authenticated server reads, reviewed writes and idempotent retry with server-owned actor", async () => {
    const store = createDemoStore(() => new Date("2026-09-11T08:00:00.000Z"));
    const app = createHttpApp(store, undefined, { serveSimulator: false, mcpAuthMode: "standard", canonicalMcpUri: endpoint, authorizationServer: "https://kin.example",
      accessAuthorizer: { async authorize() { return { subject: "maya", claims: { iss: "https://kin.example" }, scopes: new Set(["mcp:tools"]) }; } },
      familyAccess: { circleId: "family", directory: { async find() { return { circleId: "family", memberId: "maya", name: "Maya", role: "caregiver", status: "active" }; } } } });
    const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
      const outgoing = request(app).post("/mcp");
      new Headers(init.headers).forEach((value, name) => outgoing.set(name, value));
      const result = await outgoing.send(JSON.parse(String(init.body)));
      return new Response(result.status === 202 ? null : result.text, { status: result.status, headers: result.headers as Record<string, string> });
    });
    const client = createEchoCareClient(endpoint, { fetch });
    const today = await client.today(token), reviewed = today.tasks[0]!;
    const write = { ...input, taskId: reviewed.id, expected: taskReview(reviewed), actor: "Forged actor" };
    const saved = await client.confirm(token, write);
    expect(saved.confirmation).toMatchObject({ actor: "Maya", taskId: reviewed.id, requestId: input.requestId });
    await expect(client.confirm(token, write)).resolves.toEqual(saved);
    expect((await store.today()).summary.completed).toBe(1);
  });
});
