import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// Only DOM and HTTP are boundaries; the actual workspace and request client run.
class Element {
  tagName: string; id = ""; className = ""; value = ""; type = ""; hidden = false; disabled = false; checked = false; open = false;
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
  parent: Element | null = null; children: Element[] = []; private ownText = "";
  classList = { add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void; submitter?: Element }) => unknown>>();
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = []; this.append(...children); }
  get childElementCount() { return this.children.length; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  addEventListener(name: string, listener: (event: { preventDefault(): void; submitter?: Element }) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  focus = vi.fn(); reportValidity() { return true; }
  async emit(name: string, fields: { submitter?: Element } = {}) {
    const event = { preventDefault: vi.fn(), ...fields };
    await Promise.all((this.listeners.get(name) ?? []).map(listener => listener(event)));
    return event;
  }
  async click() { if (!this.disabled) await this.emit("click"); }
}
const water = { id: "water", title: "Drink a glass of water", state: "scheduled", dueAt: "2026-09-08T15:00:00.000Z" };
let close: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { close?.(); close = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(tasks: Array<typeof water & { lastResponse?: string | null; confirmedBy?: string | null; confirmedAt?: string | null }> = [water], mcpConversation = false, naturalLanguage = false, initialHash = "#ask", loadMcpClient?: () => Promise<unknown>) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    const nested = elements.get("workspace-content")?.descendants().find(child => child.id === id);
    if (nested) return nested;
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const recognitionStart = vi.fn(), recognitionAbort = vi.fn();
  const windowListeners = new Map<string, Array<() => void>>();
  class Recognition { start = recognitionStart; stop() {} abort = recognitionAbort; }
  vi.stubGlobal("document", { getElementById: get, createElement: (tag: string) => new Element(tag), querySelector: () => get("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("window", { SpeechRecognition: Recognition, addEventListener(name: string, action: () => void) { windowListeners.set(name, [...windowListeners.get(name) ?? [], action]); } });
  const pageLocation = { hash: initialHash, origin: "http://localhost" };
  const replaceState = vi.fn((_data: unknown, _title: string, hash: string) => { pageLocation.hash = hash; });
  vi.stubGlobal("location", pageLocation);
  vi.stubGlobal("history", { replaceState });
  let clarify = false;
  const conversationResult = { ok: true, json: async () => clarify ? { action: "clarify", mode: "limited" }
    : ({ action: "confirm", mode: "limited", response: "done", task: water,
      expected: { title: water.title, dueAt: water.dueAt, state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null } }) };
  let heldConversation: Promise<typeof conversationResult> | undefined;
  let loseConfirmationResponse = false;
  const confirmationWrites: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (url: string, options?: { body?: string }) => {
    if (loseConfirmationResponse && url === `/api/tasks/${water.id}/confirm`) {
      const body = JSON.parse(options!.body!);
      confirmationWrites.push(body);
      tasks.find(task => task.id === water.id)!.state = "done";
      if (confirmationWrites.length === 1) throw new Error("Response lost after commit");
      return { ok: true, json: async () => ({ confirmation: { ...body, taskId: water.id }, replayed: true }) };
    }
    return url === "/api/conversation" ? heldConversation ?? conversationResult : ({ ok: true, json: async () => url === "/api/session"
      ? { name: "Evelyn", role: "care_recipient", mcpConversation, permissions: { confirm: true, manageDuty: false, invite: false },
        ...(naturalLanguage ? { conversation: { naturalLanguage: true, consentVersion: "bedrock-task-titles-v1" } } : {}) }
      : { tasks, summary: { total: tasks.length, completed: tasks.filter(task => task.state === "done").length }, escalations: [], date: "2026-09-08" } });
  });
  const onAccessLost = vi.fn();
  const workspace = createWorkspace({ request, onAccessLost, onInvite() {}, onLeaveInvite() {}, ...(loadMcpClient ? { loadMcpClient } : {}) }); close = workspace.reset;
  await workspace.open();
  const descendants = () => get("workspace-content").descendants();
  const button = (label: string) => descendants().find(child => child.tagName === "BUTTON" && child.textContent === label)!;
  return { get, descendants, request, button, recognitionStart, recognitionAbort, pageLocation, replaceState, onAccessLost, reopen: workspace.open, reset: workspace.reset,
    clarifyNextRequest() { clarify = true; },
    loseNextConfirmationResponse() { loseConfirmationResponse = true; return confirmationWrites; },
    navigate(hash: string) { pageLocation.hash = hash; windowListeners.get("hashchange")?.forEach(listener => listener()); },
    delayReview() {
      let release!: (value: typeof conversationResult) => void;
      heldConversation = new Promise(resolve => { release = resolve; });
      return () => release(conversationResult);
    },
    async submit() { await descendants().find(child => child.tagName === "FORM")!.emit("submit", { submitter: button("Review request") }); },
  };
}

describe("parent-first conversation", () => {
  it("clears private UI on uncertain MCP access loss while handing off only the original receipt reference", async () => {
    const confirm = vi.fn(async (input: { requestId: string }) => { throw Object.assign(new Error("Access changed"), {
      status: 403, definitiveRejection: false, outcomeUnknown: true, requestId: input.requestId,
    }); });
    const ui = await fixture([water], true, false, "#ask", async () => ({ createMcpCareClient: () => ({
      today: async () => ({ tasks: [{ ...water, lastResponse: null, confirmedAt: null, confirmedBy: null }] }), confirm,
    }) }));
    const input = ui.get("care-request"); input.value = "I had my water"; await input.emit("input");
    await ui.submit(); await ui.button("Confirm this check-in").click();
    await vi.waitFor(() => expect(ui.onAccessLost).toHaveBeenCalled());
    const requestId = confirm.mock.calls[0]![0].requestId;
    expect(ui.onAccessLost).toHaveBeenCalledExactlyOnceWith(403, { outcomeUnknown: true, requestId });
    expect(ui.get("workspace-content").childElementCount).toBe(0);
    expect(ui.get("workspace").hidden).toBe(true); expect(ui.get("workspace-nav").hidden).toBe(true);
    expect(ui.get("workspace-identity").textContent).toBe(""); expect(ui.get("workspace-retry-write").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(confirm).toHaveBeenCalledOnce();
  });
  it("offers simple replies without presenting them as unrestricted natural-language understanding", async () => {
    const ui = await fixture();
    expect(ui.get("care-request-hint").textContent).toContain("Simple replies");
    expect(ui.get("care-request-hint").textContent).toContain("match one check-in");
    expect(ui.get("care-request-hint").textContent).toContain("do not use a language model");
    const input = ui.get("care-request"); input.value = "I already had my water."; await input.emit("input");
    await ui.submit();
    expect(JSON.parse(ui.request.mock.calls.find(([url]) => url === "/api/conversation")![1]!.body!)).toEqual({ message: input.value });
    expect(ui.button("Confirm this check-in")).toBeDefined();
    expect(ui.request.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  });

  it("opens concrete check-in choices after clarification and preserves the user's words", async () => {
    const ui = await fixture(); ui.clarifyNextRequest();
    const input = ui.get("care-request"); input.value = "I think I had water"; await input.emit("input");
    await ui.submit();
    expect(ui.get("care-command-help").open).toBe(true);
    expect(ui.get("workspace-content").textContent).toContain("Choose a check-in below");
    expect(input.value).toBe("I think I had water");
    expect(ui.button("Confirm this check-in")).toBeUndefined();
    expect(ui.request.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  });

  it("keeps the chosen occurrence when repeated titles are drafted and only the response is edited", async () => {
    const later = { ...water, id: "water-evening", dueAt: "2026-09-08T23:00:00.000Z" };
    const ui = await fixture([water, later]);
    const displayedTime = new Date(later.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    await ui.button(`${later.title} · ${displayedTime}`).click();
    expect(ui.get("care-selected-task").textContent).toContain(displayedTime);
    expect(ui.request.mock.calls.some(([url]) => url === "/api/conversation")).toBe(false);
    // Replacing the response prefix takes several input events, not one paste.
    for (const prefix of ["", "N", "No", "Not", "Not ", "Not y", "Not ye", "Not yet"]) {
      ui.get("care-request").value = `${prefix}: ${later.title}`; await ui.get("care-request").emit("input");
    }
    await ui.submit();
    const call = ui.request.mock.calls.find(([url]) => url === "/api/conversation")!;
    expect(JSON.parse(call[1]!.body!)).toEqual({ message: `Not yet: ${later.title}`, selectedTaskId: later.id });
    expect(ui.request.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  });

  it("drops selected identity when a draft changes to another request", async () => {
    const ui = await fixture(); await ui.button("Done").click();
    expect(ui.get("care-selected-task").hidden).toBe(false);
    ui.get("care-request").value = "Show today"; await ui.get("care-request").emit("input");
    expect(ui.get("care-selected-task").hidden).toBe(true);
    await ui.submit();
    expect(JSON.parse(ui.request.mock.calls.find(([url]) => url === "/api/conversation")![1]!.body!)).toEqual({ message: "Show today" });
  });

  it("does not carry a shortcut selection into a separately consented model request", async () => {
    const ui = await fixture([water], false, true); await ui.button("Done").click();
    const consent = ui.get("care-transfer-consent"); consent.checked = true; await consent.emit("change");
    await ui.descendants().find(child => child.tagName === "FORM")!.emit("submit", { submitter: ui.button("Review with Bedrock") });
    expect(JSON.parse(ui.request.mock.calls.find(([url]) => url === "/api/conversation")![1]!.body!)).toEqual({
      message: `Done: ${water.title}`, mode: "bedrock", transferConsent: true, disclosureVersion: "bedrock-task-titles-v1",
    });
  });

  it("lets the parent select an occurrence beyond the first eight open check-ins", async () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({ ...water, id: `water-${index}`, dueAt: `2026-09-08T${String(index + 10).padStart(2, "0")}:00:00.000Z` }));
    const selected = tasks[9]!, ui = await fixture(tasks);
    const displayedTime = new Date(selected.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    await ui.button(`${selected.title} · ${displayedTime}`).click(); await ui.submit();
    expect(JSON.parse(ui.request.mock.calls.find(([url]) => url === "/api/conversation")![1]!.body!)).toEqual({ message: `Done: ${selected.title}`, selectedTaskId: selected.id });
  });

  it("does not retain a selected occurrence after the session closes", async () => {
    const ui = await fixture(); await ui.button("Done").click(); ui.reset(); await ui.reopen();
    expect(ui.get("care-request").value).toBe("");
    expect(ui.get("care-selected-task").hidden).toBe(true);
  });

  it("clears the old conversation draft and selection only after an uncertain check-in retry is acknowledged", async () => {
    const next = { ...water, id: "walk", title: "Take a walk", dueAt: "2026-09-08T20:00:00.000Z" };
    const ui = await fixture([{ ...water }, next]), writes = ui.loseNextConfirmationResponse();
    await ui.button("Done").click(); await ui.submit();
    await ui.button("Confirm this check-in").click();
    await vi.waitFor(() => expect(ui.get("workspace-retry-write").hidden).toBe(false));
    expect(ui.get("care-request").value).toBe(`Done: ${water.title}`);
    expect(ui.get("care-selected-task").hidden).toBe(false);
    expect(writes).toHaveLength(1);

    await ui.get("workspace-retry-write").click();
    await vi.waitFor(() => expect(ui.get("workspace-retry-write").hidden).toBe(true));
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
    expect(ui.get("care-current-task").textContent).toBe(next.title);
    expect(ui.get("care-request").value).toBe("");
    expect(ui.get("care-selected-task").hidden).toBe(true);
    expect(ui.get("workspace-status").textContent).toBe("Check-in recorded.");
  });

  it("shows a persisted not-yet reply with its actual reporting person and time", async () => {
    const confirmedAt = "2026-09-08T15:10:00.000Z";
    const ui = await fixture([{ ...water, lastResponse: "not_yet", confirmedBy: "Theo", confirmedAt }]);
    const recorded = ui.descendants().find(child => child.id === "care-last-response");
    const displayedTime = new Date(confirmedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(recorded?.textContent).toBe(`Last reply: not yet · Theo · ${displayedTime}`);
    expect(recorded?.textContent).not.toContain("Evelyn");
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
  });

  it("does not present an unanswered task as having a recorded reply", async () => {
    const ui = await fixture([{ ...water, lastResponse: null, confirmedBy: null, confirmedAt: null }]);
    expect(ui.descendants().some(child => child.id === "care-last-response")).toBe(false);
  });

  it("shows only the earliest open check-in as the main prompt, with task text never interpreted as markup", async () => {
    const title = '<img src=x onerror="alert(1)"> Take a short walk';
    const ui = await fixture([{ ...water, id: "later", dueAt: "2026-09-08T19:00:00.000Z" },
      { ...water, id: "earlier", title }, { ...water, id: "done", title: "Already done", state: "done", dueAt: "2026-09-08T12:00:00.000Z" }]);
    expect(ui.get("care-current-task").textContent).toBe(title);
    expect(ui.descendants().filter(child => child.id === "care-current-task")).toHaveLength(1);
    expect(ui.descendants().some(child => child.tagName === "IMG")).toBe(false);
  });

  it.each([["Done", "Done"], ["Not yet", "Not yet"], ["Skip today", "Skip"]])("makes %s a draft, never an automatic review or save", async (label, command) => {
    const ui = await fixture();
    await ui.button(label!).click();
    expect(ui.get("care-request").value).toBe(`${command}: Drink a glass of water`);
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
    expect(ui.button("Confirm this check-in")).toBeUndefined();
    await ui.submit();
    expect(ui.button("Confirm this check-in")).toBeDefined();
    expect(ui.request.mock.calls.filter(([url]) => url === "/api/conversation")).toHaveLength(1);
    expect(ui.request.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  });

  it("puts deliberate voice input before the typed fallback without starting recognition on entry", async () => {
    const ui = await fixture();
    expect(ui.recognitionStart).not.toHaveBeenCalled();
    const nodes = ui.descendants();
    expect(nodes.indexOf(ui.button("Use voice input"))).toBeLessThan(nodes.indexOf(ui.get("care-request")));
    expect(nodes.indexOf(ui.button("Use voice input"))).toBeLessThan(nodes.indexOf(ui.button("Done")));
    expect(ui.get("care-voice-disclosure").textContent).toContain("browser’s speech provider");
    expect(ui.button("Use voice input").attributes["aria-describedby"]).toContain("care-voice-disclosure");
    await ui.button("Use voice input").click();
    expect(ui.recognitionStart).toHaveBeenCalledOnce();
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
  });

  it.each(["Done", "Not yet", "Skip today"])("clears prior model consent when the %s shortcut replaces a draft", async label => {
    const ui = await fixture([water], false, true);
    const consent = ui.get("care-transfer-consent"), model = ui.button("Review with Bedrock");
    consent.checked = true; await consent.emit("change");
    expect(model.disabled).toBe(false);
    await ui.button(label).click();
    expect(consent.checked).toBe(false); expect(model.disabled).toBe(true);
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
  });

  it("ignores reply shortcut events while voice capture owns the draft", async () => {
    const ui = await fixture();
    ui.get("care-request").value = "Unfinished draft";
    await ui.get("care-request").emit("input");
    await ui.button("Use voice input").click();
    expect(ui.button("Done").disabled).toBe(true);
    // Exercise the handler guard, not just the browser's disabled-button behavior.
    await ui.button("Done").emit("click");
    expect(ui.get("care-request").value).toBe("Unfinished draft");
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
  });

  it.each([{ tasks: [] }, { tasks: [{ ...water, state: "skipped" }] }])("does not invent a next check-in when none remain", async ({ tasks }) => {
    const ui = await fixture(tasks);
    expect(ui.descendants().some(child => child.id === "care-current-task")).toBe(false);
    expect(ui.button("Done")).toBeUndefined();
    expect(ui.get("workspace-content").textContent).toContain(tasks.length ? "No open check-ins." : "Nothing scheduled today.");
    expect(ui.get("workspace-content").textContent).not.toContain("All done");
  });

  it.each([false, true])("labels real MCP only when the authenticated capability is %s", async supported => {
    const ui = await fixture([water], supported);
    const text = ui.get("workspace-content").textContent;
    expect(text.includes("Simulated Alexa+ experience · real MCP")).toBe(supported);
    expect(text.includes("Not connected to Alexa or an Echo device.")).toBe(supported);
    const help = ui.descendants().find(child => child.id === "care-command-help")!;
    expect(help.tagName).toBe("DETAILS"); expect(help.open).toBe(false);
  });
});

describe("skip-to-content anchor inside the hash workspace", () => {
  it.each(["signed in", "signed out"])("focuses main without replacing the Ask fragment while %s", async state => {
    const ui = await fixture();
    if (state === "signed out") ui.reset();
    const before = ui.request.mock.calls.length;
    const event = await ui.get("workspace-skip").emit("click");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(ui.get("workspace-main").focus).toHaveBeenCalledOnce();
    expect(ui.pageLocation.hash).toBe("#ask");
    expect(ui.request.mock.calls).toHaveLength(before);
  });

  it("initializes Today when the page first opens at the native content anchor", async () => {
    const ui = await fixture([water], false, false, "#workspace-main");
    expect(ui.get("workspace-content").textContent).toContain("A little care, shared.");
    expect(ui.get("workspace").hidden).toBe(false);
  });

  it("initializes a fresh session instead of retaining a closed Ask view at the content anchor", async () => {
    const ui = await fixture();
    ui.navigate("#workspace-main");
    await ui.reopen();
    expect(ui.get("workspace-content").textContent).toContain("A little care, shared.");
    expect(ui.get("workspace").hidden).toBe(false);
  });

  it("continues to send unknown fragments to Today, including names resembling the skip anchor", async () => {
    const ui = await fixture();
    ui.navigate("#workspace-main-extra");
    await vi.waitFor(() => expect(ui.get("workspace-content").textContent).toContain("A little care, shared."));
    expect(ui.descendants().some(child => child.id === "care-request")).toBe(false);
  });

  it("preserves the Ask view and draft without a data request, including later refresh", async () => {
    const ui = await fixture(), input = ui.get("care-request");
    input.value = "Not yet: Drink a glass of water"; await input.emit("input");
    const before = ui.request.mock.calls.length;
    ui.navigate("#workspace-main");
    expect(ui.get("care-request")).toBe(input);
    expect(ui.request.mock.calls).toHaveLength(before);
    expect(ui.pageLocation.hash).toBe("#workspace-main");
    await ui.get("workspace-refresh").click();
    await vi.waitFor(() => expect(ui.request.mock.calls).toHaveLength(before + 2));
    expect(ui.get("care-request")).toBe(input);
    expect(input.value).toBe("Not yet: Drink a glass of water");
  });

  it("leaves active voice capture alone when the native content anchor is used", async () => {
    const ui = await fixture(), input = ui.get("care-request");
    await ui.button("Use voice input").click();
    ui.navigate("#workspace-main");
    expect(ui.recognitionAbort).not.toHaveBeenCalled();
    expect(ui.get("care-request")).toBe(input);
    expect(input.disabled).toBe(true);
    expect(ui.pageLocation.hash).toBe("#workspace-main");
  });

  it("does not invoke the busy navigation guard or discard an in-flight review", async () => {
    const ui = await fixture(), release = ui.delayReview(), input = ui.get("care-request");
    input.value = "Done: Drink a glass of water";
    const reviewing = ui.submit();
    expect(input.disabled).toBe(true);
    ui.navigate("#workspace-main");
    expect(ui.replaceState).not.toHaveBeenCalled();
    expect(ui.pageLocation.hash).toBe("#workspace-main");
    expect(ui.get("care-request")).toBe(input);
    release(); await reviewing;
    expect(ui.button("Confirm this check-in")).toBeDefined();
    expect(ui.request.mock.calls.some(([url]) => url.endsWith("/confirm"))).toBe(false);
  });

  it("keeps an uncertain save and its retry visible without treating skip as a view change", async () => {
    const ui = await fixture();
    ui.get("care-request").value = "Done: Drink a glass of water"; await ui.submit();
    // The transport returns no matching receipt for this save, so it remains uncertain.
    await ui.button("Confirm this check-in").click();
    await vi.waitFor(() => expect(ui.get("workspace-retry-write").hidden).toBe(false));
    const input = ui.get("care-request"), before = ui.request.mock.calls.length;
    ui.navigate("#workspace-main");
    expect(ui.replaceState).not.toHaveBeenCalled();
    expect(ui.get("workspace-retry-write").hidden).toBe(false);
    expect(ui.get("care-request")).toBe(input); expect(input.disabled).toBe(true);
    expect(ui.request.mock.calls).toHaveLength(before);
  });
});
