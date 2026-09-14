import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationFocus } from "../src/conversation-focus.js";
import { proposeConversation } from "../src/demo-conversation.js";
import type { TodaySnapshot } from "../src/domain.js";
const { createStoryPage } = await import(new URL("../simulator/story.js", import.meta.url).href);

// Exercise the shipped page and confirmation sender; DOM and transport are external boundaries.
class Element {
  tagName: string; id = ""; hidden = false; disabled = false; checked = false; type = ""; value = ""; className = "";
  dataset: Record<string, string> = {}; children: Element[] = []; private ownText = "";
  scrollTop = 0;
  get scrollHeight() { return this.children.length * 40; }
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  focused = false;
  focus = vi.fn(() => { if (!this.disabled) this.focused = true; });
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(item => ["BUTTON", "TEXTAREA", "INPUT"].includes(item.tagName)); }
  addEventListener(name: string, action: (event: { preventDefault(): void }) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  emit(name: string) { for (const action of this.listeners.get(name) ?? []) action({ preventDefault() {} }); }
  click() { if (!this.disabled) this.emit("click"); }
}
class Recognition {
  static instances: Recognition[] = [];
  onresult = (_event: unknown) => {}; onend = () => {}; onerror = (_event: unknown) => {};
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
  result(text: string) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); Recognition.instances = []; });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

function task() { return { id: "water", title: "Drink a glass of water", state: "scheduled", dueAt: "2026-09-08T15:00:00.000Z", lastResponse: null, confirmedAt: null, confirmedBy: null }; }
function fixture({ unavailable = false, model = false, voice = false }: { unavailable?: boolean; model?: boolean; voice?: boolean } = {}) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) { const node = new Element(id === "story-message" ? "textarea" : id === "story-model-consent" ? "input" : /story-(?:advance|refresh|confirm|cancel|submit|brief|retry|reconnect|voice-start|voice-stop|voice-cancel)$/.test(id) ? "button" : "div"); node.id = id; elements.set(id, node); } return elements.get(id)!; };
  const app = get("story-app");
  for (const id of ["story-advance", "story-message", "story-submit", "story-confirm", "story-cancel", "story-refresh", "story-brief", "story-retry", "story-suggestions", "story-alerts", "story-model-consent", "story-voice-start", "story-voice-stop", "story-voice-cancel"]) app.append(get(id));
  const chip = new Element("button"); chip.dataset.prompt = "Not yet: Drink a glass of water"; get("story-suggestions").append(chip);
  const lifecycle = new Element();
  const doc = { getElementById: get, createElement: (tag: string) => new Element(tag), visibilityState: "visible", addEventListener: lifecycle.addEventListener.bind(lifecycle), removeEventListener() {} };
  const currentTask: Record<string, unknown> = task();
  const data = { date: "2026-09-08", tasks: [currentTask], onDuty: { memberId: "theo", memberName: "Theo", endsAt: "2026-09-09T06:00:00.000Z" }, escalations: [] as Array<Record<string, unknown>>,
    summary: { total: 1, completed: 0, remaining: 1, skipped: 0 } };
  const story = { mode: "local-story", now: "2026-09-08T15:00:00.000Z", timeZone: "America/Denver", step: "check_in", graceMinutes: 30,
    notifications: [] as Array<Record<string, unknown>>, conversation: { mode: model ? "bedrock" : "limited", modelLimit: 20, modelRequests: 0 } };
  let trace!: (event: Record<string, unknown>) => void;
  const saves: Array<Record<string, unknown>> = [];
  let confirm: (input: Record<string, unknown>) => Promise<unknown> = async input => {
    saves.push(structuredClone(input)); currentTask.lastResponse = input.response; currentTask.confirmedBy = "Evelyn"; currentTask.confirmedAt = story.now;
    currentTask.state = input.response === "done" ? "done" : "scheduled";
    return { confirmation: { requestId: input.requestId }, snapshot: structuredClone(data) };
  };
  const mcp = { today: vi.fn(async () => structuredClone(data)), confirm: vi.fn((input: Record<string, unknown>) => confirm(input)), brief: vi.fn(async () => ({ generatedBy: "deterministic", headline: "The recorded week", overview: "Six days of synthetic history.", highlights: [], followUps: [], evidence: [], safetyNotice: "Not medical advice." })) };
  const makeMcp = vi.fn((observer: typeof trace) => { trace = observer; return mcp; });
  const route = async (url: string, options: { method?: string; body?: string } = {}): Promise<unknown> => {
    if (url === "/demo/story") return unavailable ? { ok: false, status: 404 } : { ok: true, json: async () => structuredClone(story) };
    if (url === "/api/today") return { ok: true, json: async () => structuredClone(data) };
    if (url === "/demo/story/conversation") return { ok: true, json: async () => ({ mode: JSON.parse(options.body ?? "{}").allowModel ? "bedrock" : "limited", modelRequests: story.conversation.modelRequests, contextToken: "a9568225-3222-4892-ae79-9ca2b3a76c77", action: "confirm", response: "not_yet", task: structuredClone(currentTask),
      expected: Object.fromEntries(["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"].map(key => [key, currentTask[key]])) }) };
    if (url === "/demo/story/advance") {
      story.now = "2026-09-08T15:31:00.000Z"; story.step = "after_grace";
      data.escalations = [{ id: "follow-water", taskId: "water", dueAt: currentTask.dueAt, status: "sent", recipientMemberName: "Theo" }];
      story.notifications = [{ id: "follow-water", recipientMemberName: "Theo", status: "simulated" }];
      return { ok: true, json: async () => structuredClone(story) };
    }
    if (url === "/api/escalations/follow-water/acknowledge") { data.escalations[0]!.acknowledgedBy = "Theo"; data.escalations[0]!.acknowledgedAt = story.now; return { ok: true, json: async () => ({}) }; }
    throw new Error(`Unexpected URL ${url}`);
  };
  const request = vi.fn(route);
  const page = createStoryPage({ doc, request, makeMcp, Recognition: voice ? Recognition : undefined, newRequestId: () => "story-test-receipt-0001" });
  stop = page.stop;
  const settled = async () => { await vi.waitFor(() => expect(get("story-refresh").disabled).toBe(false)); };
  return { page, get, chip, doc, story, data, currentTask, mcp, makeMcp, request, route, saves, lifecycle,
    bodies: () => request.mock.calls.filter(([url]) => url === "/demo/story/conversation").map(([, options]) => JSON.parse(options?.body ?? "{}")),
    trace: (event: Record<string, unknown>) => trace(event), setConfirm: (next: typeof confirm) => { confirm = next; },
    async review() { get("story-message").value = "Not yet: Drink a glass of water"; get("story-form").emit("submit"); await vi.waitFor(() => expect(get("story-confirm").disabled).toBe(false)); },
    settled,
  };
}

describe("isolated local story page", () => {
  it("resumes a suspended history entry without restarting speech or retaining a review", async () => {
    const ui = fixture({ model: true, voice: true }); await ui.page.start(); await ui.review();
    ui.get("story-model-consent").checked = true;
    ui.get("story-message").value = "Keep my draft";
    ui.get("story-voice-start").click();
    const recognition = Recognition.instances[0]!; recognition.result("discarded words");
    ui.page.suspend();
    expect(ui.get("story-message").disabled).toBe(true);
    await ui.page.resume();
    expect(ui.get("story-message").disabled).toBe(false);
    expect(ui.get("story-message").value).toBe("Keep my draft");
    expect(ui.get("story-review").hidden).toBe(true);
    expect(ui.get("story-model-consent").checked).toBe(false);
    expect(Recognition.instances).toHaveLength(1); expect(recognition.abort).toHaveBeenCalledOnce();
    recognition.result("late words"); recognition.onend();
    expect(ui.get("story-message").value).toBe("Keep my draft");
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("keeps an uncertain check-in and its exact receipt through suspension without resending", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    ui.setConfirm(async () => { throw new Error("Lost response"); });
    ui.get("story-confirm").click();
    await vi.waitFor(() => expect(ui.get("story-retry").hidden).toBe(false));
    const original = structuredClone(ui.mcp.confirm.mock.calls[0]![0]);
    ui.page.suspend(); await ui.page.resume();
    expect(ui.mcp.confirm).toHaveBeenCalledOnce();
    expect(ui.get("story-retry").hidden).toBe(false); expect(ui.get("story-retry").disabled).toBe(false);
    expect(ui.get("story-message").disabled).toBe(true);
    ui.setConfirm(async input => ({ confirmation: { requestId: input.requestId } }));
    ui.get("story-retry").click(); await ui.settled();
    expect(ui.mcp.confirm).toHaveBeenCalledTimes(2);
    expect(ui.mcp.confirm.mock.calls[1]![0]).toEqual(original);
    expect(ui.get("story-retry").hidden).toBe(true);
  });

  it("retains an in-flight write as uncertain when its reply arrives while suspended", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    let finish!: (value: unknown) => void;
    ui.setConfirm(() => new Promise(resolve => { finish = resolve; }));
    ui.get("story-confirm").click();
    await vi.waitFor(() => expect(ui.mcp.confirm).toHaveBeenCalledOnce());
    ui.page.suspend();
    const resumed = ui.page.resume();
    finish({ confirmation: { requestId: "story-test-receipt-0001" } });
    await resumed;
    expect(ui.mcp.confirm).toHaveBeenCalledOnce();
    expect(ui.get("story-retry").hidden).toBe(false); expect(ui.get("story-retry").disabled).toBe(false);
    expect(ui.get("story-transcript").textContent).not.toContain("Your reply is saved");
  });

  it.each(["advance", "acknowledgment"])("preserves an uncertain %s until an explicit identical retry after restoration", async kind => {
    const ui = fixture(); await ui.page.start();
    if (kind === "acknowledgment") { ui.get("story-advance").click(); await ui.settled(); }
    const url = kind === "advance" ? "/demo/story/advance" : "/api/escalations/follow-water/acknowledge";
    let drop = true;
    ui.request.mockImplementation(async (path, options) => {
      const result = await ui.route(path, options);
      if (path === url && drop) { drop = false; throw new Error("Committed, response lost"); }
      return result;
    });
    if (kind === "advance") ui.get("story-advance").click();
    else ui.get("story-alerts").descendants().find(item => item.tagName === "BUTTON")!.click();
    await vi.waitFor(() => expect(ui.get("story-retry").hidden).toBe(false));
    const original = ui.request.mock.calls.filter(([path]) => path === url).at(-1)![1];
    const count = ui.request.mock.calls.filter(([path]) => path === url).length;
    ui.page.suspend(); await ui.page.resume();
    expect(ui.request.mock.calls.filter(([path]) => path === url)).toHaveLength(count);
    expect(ui.get("story-retry").disabled).toBe(false);
    ui.get("story-retry").click(); await ui.settled();
    const requests = ui.request.mock.calls.filter(([path]) => path === url);
    expect(requests).toHaveLength(count + 1); expect(requests.at(-1)![1]!.body).toBe(original!.body);
    expect(ui.get("story-retry").hidden).toBe(true);
  });

  it("discards a late interpretation and never reuses its review or model consent after resuming", async () => {
    const ui = fixture({ model: true }); await ui.page.start();
    let finish!: (value: unknown) => void;
    ui.request.mockImplementation(async (url, options) => url === "/demo/story/conversation"
      ? new Promise(resolve => { finish = resolve; }) : ui.route(url, options));
    ui.get("story-message").value = "I had the water"; ui.get("story-model-consent").checked = true;
    ui.get("story-form").emit("submit");
    await vi.waitFor(() => expect(ui.bodies()).toHaveLength(1));
    ui.page.suspend(); const resumed = ui.page.resume();
    finish(await ui.route("/demo/story/conversation", { body: JSON.stringify({ allowModel: true }) }));
    await resumed;
    expect(ui.get("story-review").hidden).toBe(true);
    expect(ui.get("story-message").value).toBe("I had the water");
    expect(ui.get("story-model-consent").checked).toBe(false);
    expect(ui.bodies()).toHaveLength(1); expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("keeps permanent disposal distinct from a resumable history entry", async () => {
    const ui = fixture(); await ui.page.start(); ui.request.mockClear();
    ui.page.stop(); await ui.page.resume(); await ui.page.start();
    expect(ui.request).not.toHaveBeenCalled(); expect(ui.get("story-message").disabled).toBe(true);
  });

  it("does not close a healthy newer view when an obsolete background gate fails", async () => {
    const ui = fixture(); await ui.page.start();
    let reject!: (error: Error) => void;
    ui.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(5000);
    ui.get("story-refresh").click(); await ui.settled();
    expect(ui.get("story-app").hidden).toBe(false);
    reject(new Error("Old poll failed")); await vi.advanceTimersByTimeAsync(0);
    expect(ui.get("story-app").hidden).toBe(false);
    expect(ui.get("story-refresh").disabled).toBe(false);
    expect(ui.get("story-status").textContent).toContain("up to date");
  });

  it("does not revive an old polling loop or transport trace after resuming", async () => {
    const ui = fixture(); await ui.page.start();
    const oldTrace = ui.makeMcp.mock.calls[0]![0];
    let finish!: (value: unknown) => void;
    ui.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    ui.page.suspend(); await ui.page.resume();
    finish(await ui.route("/demo/story")); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    oldTrace({ tool: "show_today", phase: "result", rpcId: "old-page" });
    expect(ui.get("story-evidence-list").textContent).not.toContain("old-page");
    ui.trace({ tool: "show_today", phase: "result", rpcId: "current-page" });
    expect(ui.get("story-evidence-list").textContent).toContain("current-page");
  });
  it("explains simple local replies without claiming an unrestricted conversation", async () => {
    const ui = fixture(); await ui.page.start();
    expect(ui.get("story-dialogue-mode").textContent).toContain("Simple check-in replies");
    expect(ui.get("story-dialogue-mode").textContent).toContain("uncertain wording needs clarification");
    expect(ui.get("story-dialogue-mode").textContent).toContain("No language model");
  });

  it("labels a provider-accepted receipt as an operator concern without claiming phone delivery", async () => {
    const ui = fixture();
    ui.data.escalations.push({ id: "receipt-review", taskId: "water", dueAt: ui.currentTask.dueAt, status: "receipt_pending" });
    await ui.page.start();
    expect(ui.get("story-alerts").textContent).toContain("Provider accepted; receipt needs review");
    expect(ui.get("story-alerts").textContent).toContain("Operator reconciliation is required; no automatic resend");
    expect(ui.get("story-alerts").textContent).toContain("does not prove phone delivery");
    expect(ui.get("story-alerts").textContent).not.toContain("No SMS was sent");
  });

  it("does not create an MCP client or read care data when the story endpoint is unavailable", async () => {
    const ui = fixture({ unavailable: true }); await ui.page.start();
    expect(ui.request.mock.calls.map(([url]) => url)).toEqual(["/demo/story"]);
    expect(ui.makeMcp).not.toHaveBeenCalled();
    expect(ui.get("story-unavailable-heading").textContent).toBe("Start local story server");
    expect(ui.get("story-app").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(ui.request).toHaveBeenCalledOnce();
  });

  it("keeps example prompts as drafts and saves only after an explicit reviewed confirmation", async () => {
    const ui = fixture(); await ui.page.start(); ui.request.mockClear();
    ui.chip.click();
    expect(ui.get("story-message").value).toBe("Not yet: Drink a glass of water");
    expect(ui.request).not.toHaveBeenCalled(); expect(ui.mcp.confirm).not.toHaveBeenCalled();
    await ui.review();
    expect(ui.mcp.confirm).not.toHaveBeenCalled(); expect(ui.get("story-review").hidden).toBe(false);
    const expected = structuredClone(ui.currentTask); delete expected.id;
    ui.get("story-confirm").click(); await ui.settled();
    expect(ui.mcp.confirm).toHaveBeenCalledExactlyOnceWith({ taskId: "water", response: "not_yet", actor: "Evelyn", expected, requestId: "story-test-receipt-0001" });
    expect(ui.get("story-care-plan").textContent).toContain("Not yet");
    expect(ui.request.mock.calls.some(([url]) => url === "/api/today")).toBe(true);
    expect(ui.get("story-message").value).toBe("");
  });

  it("rejects a stale proposal before sending a care mutation", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    ui.currentTask.confirmedBy = "Theo"; ui.currentTask.confirmedAt = "2026-09-08T15:01:00.000Z"; ui.currentTask.lastResponse = "not_yet";
    ui.get("story-confirm").click(); await ui.settled();
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
    expect(ui.get("story-review").hidden).toBe(true);
    expect(ui.get("story-status").textContent).toContain("out of date");
  });

  it("moves keyboard focus to the enabled confirmation after review completes", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    expect(ui.get("story-confirm").disabled).toBe(false);
    expect(ui.get("story-confirm").focused).toBe(true);
  });

  it("shows the latest conversation message inside its transcript container", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    expect(ui.get("story-transcript").scrollHeight).toBeGreaterThan(0);
    expect(ui.get("story-transcript").scrollTop).toBe(ui.get("story-transcript").scrollHeight);
  });

  it("preserves a review when the pre-save state read fails, without claiming rejection", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    ui.mcp.today.mockRejectedValueOnce(new Error("Synthetic unavailable read"));
    ui.get("story-confirm").click(); await ui.settled();
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
    expect(ui.get("story-review").hidden).toBe(false);
    expect(ui.get("story-message").value).toBe("Not yet: Drink a glass of water");
    expect(ui.get("story-status").textContent).toContain("No save was attempted");
    expect(ui.get("story-status").textContent).not.toContain("rejected");
  });

  it("locks other actions after an ambiguous save and retries the identical request only", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    ui.setConfirm(async input => { ui.saves.push(structuredClone(input)); throw new Error("Synthetic lost response"); });
    ui.get("story-confirm").click();
    await vi.waitFor(() => expect(ui.get("story-retry").hidden).toBe(false));
    await vi.waitFor(() => expect(ui.get("story-retry").disabled).toBe(false));
    expect(ui.get("story-message").disabled).toBe(true); expect(ui.get("story-advance").disabled).toBe(true);
    ui.get("story-form").emit("submit"); ui.get("story-advance").click();
    expect(ui.mcp.confirm).toHaveBeenCalledOnce();
    ui.setConfirm(async input => { ui.saves.push(structuredClone(input)); return { confirmation: { requestId: input.requestId } }; });
    ui.get("story-retry").click(); await ui.settled();
    expect(ui.saves).toHaveLength(2); expect(ui.saves[1]).toEqual(ui.saves[0]);
    expect(ui.get("story-retry").hidden).toBe(true);
  });

  it("does not submit a second reply while a first confirmation is in flight", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    let finish!: () => void;
    ui.setConfirm(() => new Promise(resolve => { finish = () => resolve({ confirmation: { requestId: "story-test-receipt-0001" } }); }));
    ui.get("story-confirm").click();
    await vi.waitFor(() => expect(ui.mcp.confirm).toHaveBeenCalledOnce());
    ui.get("story-confirm").emit("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.mcp.confirm).toHaveBeenCalledOnce();
    finish(); await ui.settled();
  });

  it("advances only on request and keeps caregiver acknowledgment distinct from task completion", async () => {
    const ui = fixture(); await ui.page.start();
    expect(ui.request.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
    ui.get("story-advance").click(); await ui.settled();
    const advance = ui.request.mock.calls.find(([url]) => url === "/demo/story/advance")!;
    expect(JSON.parse(advance[1]!.body!)).toEqual({ step: "after_grace", confirm: true });
    expect(ui.get("story-alerts").textContent).toContain("Simulated notification for Theo. No SMS was sent.");
    const ack = ui.get("story-alerts").descendants().find(item => item.tagName === "BUTTON")!;
    ack.click(); await ui.settled();
    expect(ui.get("story-alerts").textContent).toContain("Theo acknowledged the follow-up");
    expect(ui.currentTask.state).toBe("scheduled"); expect(ui.mcp.confirm).not.toHaveBeenCalled();
    expect(ui.get("story-advance").disabled).toBe(true);
  });

  it("polls the caregiver REST view only when visible and never synthesizes evidence", async () => {
    const ui = fixture(); await ui.page.start();
    expect(ui.get("story-evidence-list").children).toHaveLength(0);
    const parentReads = ui.mcp.today.mock.calls.length;
    ui.request.mockClear(); ui.doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(5000); expect(ui.request).not.toHaveBeenCalled();
    ui.doc.visibilityState = "visible"; await vi.advanceTimersByTimeAsync(5000);
    expect(ui.request.mock.calls.map(([url]) => url)).toEqual(["/demo/story", "/api/today"]);
    expect(ui.mcp.today).toHaveBeenCalledTimes(parentReads);
    for (let index = 0; index < 15; index += 1) ui.trace({ tool: "show_today", phase: "result", rpcId: index, durationMs: index + 1, result: { completed: 0, total: 1 } });
    expect(ui.get("story-evidence-list").children).toHaveLength(12);
    expect(ui.get("story-evidence-list").textContent).not.toContain("RPC 0 ·");
    expect(ui.get("story-evidence-list").textContent).toContain("RPC 14 · 15 ms local round trip");
  });

  it("preserves a typed draft when interpretation fails and renders it only as text", async () => {
    const ui = fixture(); await ui.page.start();
    ui.request.mockImplementation(async (url, options) => url === "/demo/story/conversation" ? { ok: false, status: 503 } : ui.route(url, options));
    const draft = '<img src=x onerror=alert(1)>';
    ui.get("story-message").value = draft; ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.get("story-message").value).toBe(draft);
    expect(ui.get("story-transcript").textContent).toContain(draft);
    expect(ui.get("story-transcript").descendants().some(item => item.tagName === "IMG")).toBe(false);
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });
});

describe("story request privacy and dictation", () => {
  it("keeps the default path model-free and hides unavailable model controls", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    expect(ui.get("story-model-options").hidden).toBe(true);
    expect(ui.get("story-voice-start").disabled).toBe(true);
    expect(ui.get("story-voice-status").textContent).toContain("type");
    expect(ui.bodies()).toEqual([{ message: "Not yet: Drink a glass of water" }]);
    expect(ui.get("story-message").disabled).toBe(false);
  });

  it("sends one opted-in model request, shows its budget, and still requires a separate save", async () => {
    const ui = fixture({ model: true }); await ui.page.start();
    expect(ui.get("story-model-options").hidden).toBe(false);
    expect(ui.get("story-model-consent").checked).toBe(false);
    ui.get("story-message").value = "I haven't had the water yet";
    ui.get("story-model-consent").checked = true; ui.get("story-model-consent").emit("change");
    ui.story.conversation.modelRequests = 1;
    ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.bodies()).toEqual([{ message: "I haven't had the water yet", allowModel: true }]);
    expect(ui.get("story-model-consent").checked).toBe(false);
    expect(ui.get("story-model-budget").textContent).toContain("1 of 20");
    expect(ui.get("story-review").hidden).toBe(false);
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
    expect(ui.get("story-transcript").textContent).toContain("Nothing has been saved");
  });

  it.each(["typing", "shortcut", "voice"])("clears one-request model consent and invalidates review on %s", async change => {
    const ui = fixture({ model: true, voice: true }); await ui.page.start(); await ui.review();
    const consent = ui.get("story-model-consent"); consent.checked = true; consent.emit("change");
    if (change === "typing") { ui.get("story-message").value = "Actually, done"; ui.get("story-message").emit("input"); }
    else if (change === "shortcut") ui.chip.click();
    else ui.get("story-voice-start").click();
    expect(consent.checked).toBe(false);
    expect(ui.get("story-review").hidden).toBe(true);
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("passes only the server-issued context into a follow-up and never interprets yes as an automatic save", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    ui.get("story-message").value = "yes"; ui.get("story-message").emit("input"); ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.bodies()[1]).toEqual({ message: "yes", contextToken: "a9568225-3222-4892-ae79-9ca2b3a76c77" });
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
    ui.get("story-cancel").click(); ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.bodies()[2]).toEqual({ message: "yes" });
  });

  it.each(["Show today", "Weekly brief", "An unclear request"])("forgets the previous task after the non-task reply to %s", async interlude => {
    const ui = fixture();
    const snapshot: TodaySnapshot = { date: "2026-09-08", tasks: [{ ...task(), state: "scheduled" }],
      onDuty: null, escalations: [], summary: { total: 1, completed: 0, remaining: 1, skipped: 0 } };
    const focus = createConversationFocus();
    // Use the real proposal grammar and server-owned focus so a leaked pointer
    // demonstrably revives the old task rather than just appearing in a mock call.
    ui.request.mockImplementation(async (url, options) => {
      if (url !== "/demo/story/conversation") return ui.route(url, options);
      const body = JSON.parse(options?.body ?? "{}");
      const result = await proposeConversation(body.message, snapshot, undefined, focus.resolve(body.contextToken, snapshot));
      return { ok: true, json: async () => ({ ...result, modelRequests: 0, ...(result.action === "confirm"
        ? { contextToken: focus.remember(result.task.id, result.expected) } : {}) }) };
    });
    await ui.page.start(); await ui.review();
    ui.get("story-message").value = interlude; ui.get("story-message").emit("input");
    ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.get("story-review").hidden).toBe(true);

    ui.get("story-message").value = "I did it"; ui.get("story-message").emit("input");
    ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.bodies()[2]).toEqual({ message: "I did it" });
    expect(ui.get("story-review").hidden).toBe(true);
    expect(ui.get("story-confirm").disabled).toBe(true);
    expect(ui.get("story-status").textContent).toContain("Review a specific check-in");
    expect(ui.get("story-message").value).toBe("I did it");
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
    expect(snapshot.tasks[0]!.state).toBe("scheduled");
  });

  it("records speech only after a click and keeps it as a draft through stop, review, and cancel", async () => {
    const ui = fixture({ voice: true }); await ui.page.start(); ui.request.mockClear();
    expect(Recognition.instances).toHaveLength(0);
    ui.get("story-message").value = "Not yet:"; ui.get("story-voice-start").click();
    const recognition = Recognition.instances[0]!;
    expect(recognition.start).toHaveBeenCalledOnce();
    expect(ui.get("story-message").disabled).toBe(true); expect(ui.get("story-advance").disabled).toBe(true);
    expect(ui.get("story-submit").disabled).toBe(true); expect(ui.get("story-confirm").disabled).toBe(true);
    expect(ui.get("story-voice-stop").disabled).toBe(false); expect(ui.get("story-voice-cancel").disabled).toBe(false);
    ui.get("story-form").emit("submit"); expect(ui.bodies()).toEqual([]);
    recognition.result("Drink a glass of water"); ui.get("story-voice-stop").click();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(ui.get("story-voice-stop").disabled).toBe(true); expect(ui.get("story-voice-cancel").disabled).toBe(false);
    expect(ui.get("story-message").value).toBe("Not yet:");
    recognition.onend();
    expect(ui.get("story-message").value).toBe("Not yet: Drink a glass of water");
    expect(ui.request).not.toHaveBeenCalled(); expect(ui.mcp.confirm).not.toHaveBeenCalled();
    ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.get("story-review").hidden).toBe(false); expect(ui.mcp.confirm).not.toHaveBeenCalled();
    ui.get("story-cancel").click();
    expect(ui.get("story-review").hidden).toBe(true); expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it.each(["cancel", "hidden", "dispose"])("discards unfinished speech and ignores late callbacks after %s", async finish => {
    const ui = fixture({ voice: true }); await ui.page.start();
    ui.get("story-message").value = "Keep my draft"; ui.get("story-voice-start").click();
    const recognition = Recognition.instances[0]!; recognition.result("unwanted words");
    if (finish === "cancel") ui.get("story-voice-cancel").click();
    else if (finish === "hidden") { ui.doc.visibilityState = "hidden"; ui.lifecycle.emit("visibilitychange"); }
    else ui.page.stop();
    recognition.result("late words"); recognition.onend();
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(ui.get("story-message").value).toBe("Keep my draft");
    expect(ui.bodies()).toEqual([]); expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("keeps the typed draft when combined dictation exceeds 800 characters", async () => {
    const ui = fixture({ voice: true }); await ui.page.start();
    const draft = "x".repeat(799); ui.get("story-message").value = draft; ui.get("story-voice-start").click();
    const recognition = Recognition.instances[0]!; recognition.result("long"); recognition.onend();
    expect(ui.get("story-message").value).toBe(draft);
    expect(ui.get("story-voice-status").textContent).toContain("too long");
    expect(ui.bodies()).toEqual([]); expect(ui.get("story-message").disabled).toBe(false);
  });

  it("preserves the draft when microphone permission is denied without any request", async () => {
    const ui = fixture({ voice: true }); await ui.page.start();
    ui.get("story-message").value = "Typed fallback"; ui.get("story-voice-start").click();
    Recognition.instances[0]!.onerror({ error: "not-allowed" });
    expect(ui.get("story-voice-status").textContent).toContain("denied");
    expect(ui.get("story-message").value).toBe("Typed fallback");
    expect(ui.bodies()).toEqual([]); expect(ui.get("story-submit").disabled).toBe(false);
  });

  it.each([
    { status: 409, error: "story_model_unavailable", expected: "not enabled" },
    { status: 429, error: "story_conversation_busy", expected: "already being reviewed" },
    { status: 429, error: "story_model_limit", expected: "limit" },
    { status: 503, error: "story_conversation_unavailable", expected: "could not finish" },
  ])("retains the draft after $error and never retries a model call automatically", async ({ status, error, expected }) => {
    const ui = fixture({ model: true }); await ui.page.start();
    ui.request.mockImplementation(async (url, options) => url === "/demo/story/conversation"
      ? { ok: false, status, json: async () => ({ error, modelRequests: 20 }) } : ui.route(url, options));
    ui.get("story-message").value = "I drank the water"; ui.get("story-model-consent").checked = true;
    ui.get("story-form").emit("submit"); await ui.settled();
    expect(ui.get("story-message").value).toBe("I drank the water");
    expect(ui.get("story-model-consent").checked).toBe(false);
    expect(ui.get("story-status").textContent).toContain(expected);
    expect(ui.get("story-model-budget").textContent).toContain("20 of 20");
    expect(ui.get("story-model-consent").disabled).toBe(true);
    expect(ui.get("story-retry").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui.bodies()).toHaveLength(1); expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("locks voice and model input while a reviewed save is unresolved", async () => {
    const ui = fixture({ model: true, voice: true }); await ui.page.start(); await ui.review();
    ui.setConfirm(async () => { throw new Error("Lost acknowledgement"); });
    ui.get("story-confirm").click(); await vi.waitFor(() => expect(ui.get("story-retry").disabled).toBe(false));
    expect(ui.get("story-voice-start").disabled).toBe(true); expect(ui.get("story-model-consent").disabled).toBe(true);
    ui.get("story-voice-start").emit("click");
    expect(Recognition.instances).toHaveLength(0); expect(ui.bodies()).toHaveLength(1);
  });

  it("consumes model consent before waiting and blocks a duplicate review or dictation", async () => {
    const ui = fixture({ model: true, voice: true }); await ui.page.start();
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    ui.request.mockImplementation(async (url, options) => url === "/demo/story/conversation" ? response : ui.route(url, options));
    ui.get("story-message").value = "I drank the water"; ui.get("story-model-consent").checked = true;
    ui.get("story-form").emit("submit");
    expect(ui.get("story-model-consent").checked).toBe(false);
    await vi.waitFor(() => expect(ui.bodies()).toHaveLength(1));
    expect(ui.get("story-submit").disabled).toBe(true); expect(ui.get("story-voice-start").disabled).toBe(true);
    ui.get("story-form").emit("submit"); ui.get("story-voice-start").emit("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.bodies()).toHaveLength(1); expect(Recognition.instances).toHaveLength(0);
    finish({ ok: true, json: async () => ({ action: "clarify", mode: "bedrock", modelRequests: 1 }) });
    await ui.settled();
    expect(ui.get("story-model-consent").checked).toBe(false);
    expect(ui.get("story-message").value).toBe("I drank the water");
    expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("keeps exact commands usable when the session model budget is exhausted", async () => {
    const ui = fixture({ model: true }); ui.story.conversation.modelRequests = 20; await ui.page.start();
    expect(ui.get("story-model-consent").disabled).toBe(true);
    await ui.review();
    expect(ui.bodies()).toEqual([{ message: "Not yet: Drink a glass of water" }]);
    expect(ui.get("story-review").hidden).toBe(false);
    ui.get("story-model-consent").checked = true; ui.get("story-form").emit("submit");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.bodies()).toHaveLength(1);
    expect(ui.get("story-status").textContent).toContain("model limit");
  });

  it("rejects an oversized typed draft before any interpretation request", async () => {
    const ui = fixture({ model: true }); await ui.page.start();
    ui.get("story-message").value = "x".repeat(801); ui.get("story-model-consent").checked = true;
    ui.get("story-form").emit("submit");
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.bodies()).toEqual([]);
    expect(ui.get("story-status").textContent).toContain("1–800 characters");
  });

  it("does not deliver a late model review after the page was closed", async () => {
    const ui = fixture({ model: true }); await ui.page.start();
    let finish!: (value: unknown) => void;
    const response = new Promise(resolve => { finish = resolve; });
    ui.request.mockImplementation(async (url, options) => url === "/demo/story/conversation" ? response : ui.route(url, options));
    ui.get("story-message").value = "Not yet: Drink a glass of water"; ui.get("story-model-consent").checked = true;
    ui.get("story-form").emit("submit"); await vi.waitFor(() => expect(ui.bodies()).toHaveLength(1));
    ui.page.stop();
    const transcript = ui.get("story-transcript").textContent;
    finish(await ui.route("/demo/story/conversation", { body: JSON.stringify({ allowModel: true }) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.get("story-transcript").textContent).toBe(transcript);
    expect(ui.get("story-review").hidden).toBe(true); expect(ui.mcp.confirm).not.toHaveBeenCalled();
  });

  it("does not send a save when the pre-save read finishes after the page was closed", async () => {
    const ui = fixture(); await ui.page.start(); await ui.review();
    let finish!: (value: typeof ui.data) => void;
    ui.mcp.today.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    ui.get("story-confirm").click(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    ui.page.stop(); finish(structuredClone(ui.data));
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.mcp.confirm).not.toHaveBeenCalled(); expect(ui.get("story-message").value).toBe("Not yet: Drink a glass of water");
  });
});
