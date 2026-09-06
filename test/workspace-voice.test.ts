import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// DOM and microphone are external boundaries. The workspace and request client run unchanged.
class Element {
  tagName: string;
  id = ""; textContent = ""; value = ""; type = ""; hidden = false; disabled = false; checked = false;
  dataset: Record<string, string> = {};
  parent: Element | null = null;
  children: Element[] = [];
  listeners = new Map<string, Array<(event: { preventDefault(): void; submitter?: Element }) => unknown>>();
  classList = { add() {}, remove() {} };
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  append(...children: Element[]) { this.children.push(...children); for (const child of children) child.parent = this; }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  get childElementCount() { return this.children.length; }
  addEventListener(name: string, action: (event: { preventDefault(): void; submitter?: Element }) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), action]);
  }
  setAttribute() {} removeAttribute() {} focus() {} reportValidity() { return true; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  async emit(name: string, fields: { submitter?: Element } = {}) {
    await Promise.all((this.listeners.get(name) ?? []).map(action => action({ preventDefault() {}, ...fields })));
  }
  async click() {
    if (this.disabled) return;
    await this.emit("click");
    if (this.type === "submit") {
      let form = this.parent;
      while (form && form.tagName !== "FORM") form = form.parent;
      await form?.emit("submit", { submitter: this });
    }
  }
}

class Recognition {
  static instances: Recognition[] = [];
  onresult = (_event: unknown) => {}; onend = () => {}; onerror = (_event: unknown) => {};
  start = vi.fn(); stop = vi.fn(); abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
  result(text: string) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}

let closeWorkspace: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); Recognition.instances = []; });
afterEach(() => { closeWorkspace?.(); closeWorkspace = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(options: { naturalLanguage?: boolean; tasks?: Array<Record<string, unknown>> } = {}) {
  const ids = new Map<string, Element>();
  const element = (id: string): Element => {
    const nested = ids.get("workspace-content")?.descendants().find(child => child.id === id);
    if (nested) return nested;
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id)!;
  };
  vi.stubGlobal("document", { getElementById: element, createElement: (tag: string) => new Element(tag),
    querySelector: () => element("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("window", { SpeechRecognition: Recognition, addEventListener() {} });
  vi.stubGlobal("location", { hash: "#ask" });
  vi.stubGlobal("history", { replaceState() {} });
  const identity = { name: "Maya", permissions: { confirm: true, manageDuty: true, invite: true },
    ...(options.naturalLanguage ? { conversation: { naturalLanguage: true, consentVersion: "bedrock-task-titles-v1" } } : {}) };
  let nextRead: Promise<unknown> | undefined;
  let conversationResponse: (body: Record<string, unknown>) => Promise<unknown> = async body => ({ ok: true, json: async () => ({ action: "clarify", mode: body.mode === "bedrock" ? "bedrock" : "limited" }) });
  const request = vi.fn(async (url: string, requestOptions: { body?: string } = {}): Promise<unknown> => {
    if (url === "/api/session") return { ok: true, json: async () => identity };
    if (url === "/api/conversation") return conversationResponse(JSON.parse(requestOptions.body ?? "{}"));
    if (nextRead) { const pending = nextRead; nextRead = undefined; return pending; }
    return { ok: true, json: async () => ({ tasks: options.tasks ?? [] }) };
  });
  const accessLost = vi.fn();
  const workspace = createWorkspace({ request, onAccessLost: accessLost, onInvite() {}, onLeaveInvite() {} });
  closeWorkspace = () => workspace.reset();
  await workspace.open();
  return { element, request, accessLost,
    setConversationResponse(response: typeof conversationResponse) { conversationResponse = response; },
    conversationBodies() { return request.mock.calls.filter(([url]) => url === "/api/conversation").map(([, options]) => JSON.parse(options?.body ?? "{}")); },
    async submit(submitter?: Element) {
      const form = element("workspace-content").descendants().find(child => child.tagName === "FORM")!;
      await form.emit("submit", { submitter });
    },
    async startDelayedRefresh() {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>(done => { resolve = done; });
      const deferred = { promise, resolve };
      nextRead = deferred.promise;
      const previousReads = request.mock.calls.filter(([url]) => url === "/api/today").length;
      element("workspace-refresh").click();
      await vi.waitFor(() => expect(request.mock.calls.filter(([url]) => url === "/api/today")).toHaveLength(previousReads + 1));
      return deferred;
    },
    button(label: string) {
      const found = element("workspace-content").querySelectorAll().find(child => child.textContent === label);
      if (!found) throw new Error(`Missing button: ${label}`);
      return found;
    },
  };
}

describe("workspace dictation during refresh", () => {
  it.each(["listening", "finishing"])("keeps %s capture when an older refresh resolves", async phase => {
    const ui = await fixture();
    const read = await ui.startDelayedRefresh();
    ui.button("Use voice input").click();
    const recognition = Recognition.instances[0]!;
    if (phase === "finishing") ui.button("Stop listening").click();
    const decode = vi.fn(async () => ({ tasks: [], updated: true }));
    read.resolve({ ok: true, json: decode });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    // Flush the client's body validation and the workspace's post-await render decision.
    await Promise.resolve(); await Promise.resolve();
    expect(recognition.abort).not.toHaveBeenCalled();
    expect(ui.element("care-request").disabled).toBe(true);
    recognition.result("Done: Drink a glass of water"); recognition.onend();
    expect(ui.element("care-request").value).toBe("Done: Drink a glass of water");
    expect(ui.element("care-request").disabled).toBe(false);
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today"].includes(url))).toBe(true);
  });

  it("still discards capture and closes the workspace if the refresh denies family access", async () => {
    const ui = await fixture();
    const read = await ui.startDelayedRefresh();
    ui.button("Use voice input").click();
    const recognition = Recognition.instances[0]!;
    recognition.result("Private unfinished draft");
    read.resolve({ ok: false, status: 403 });
    await vi.waitFor(() => expect(ui.accessLost).toHaveBeenCalledWith(403));
    expect(recognition.abort).toHaveBeenCalledOnce();
    recognition.onend();
    expect(ui.element("workspace").hidden).toBe(true);
    expect(ui.element("workspace-content").childElementCount).toBe(0);
  });
});

describe("optional family Bedrock consent", () => {
  it("omits model controls when the authenticated capability is absent", async () => {
    const ui = await fixture();
    const controls = ui.element("workspace-content").querySelectorAll();
    expect(controls.some(control => control.id === "care-transfer-consent")).toBe(false);
    expect(controls.some(control => control.textContent === "Review with Bedrock")).toBe(false);
    ui.element("care-request").value = "Show today";
    await ui.submit(ui.button("Review request"));
    expect(ui.conversationBodies()).toEqual([{ message: "Show today" }]);
  });

  it("requires a newly checked transfer checkbox before a model request", async () => {
    const ui = await fixture({ naturalLanguage: true });
    ui.element("care-request").value = "I drank the water";
    const consent = ui.element("care-transfer-consent"), model = ui.button("Review with Bedrock");
    expect(consent.checked).toBe(false); expect(model.disabled).toBe(true);
    await ui.submit(model); // Exercise the handler's guard as well as the disabled button.
    expect(ui.conversationBodies()).toEqual([]);
    consent.checked = true; await consent.emit("change");
    expect(model.disabled).toBe(false);
    await ui.submit(model);
    expect(ui.conversationBodies()).toEqual([{ message: "I drank the water", mode: "bedrock", transferConsent: true, disclosureVersion: "bedrock-task-titles-v1" }]);
    expect(consent.checked).toBe(false); expect(model.disabled).toBe(true);
  });

  it.each(["typing", "example", "voice"])("clears transfer consent when %s changes the draft", async change => {
    const ui = await fixture({ naturalLanguage: true, tasks: [{ id: "water", title: "Drink a glass of water", state: "scheduled" }] });
    const input = ui.element("care-request"), consent = ui.element("care-transfer-consent");
    input.value = "Not yet:"; await input.emit("input");
    consent.checked = true; await consent.emit("change");
    if (change === "typing") { input.value = "I drank the water"; await input.emit("input"); }
    else if (change === "example") await ui.button("Drink a glass of water").click();
    else {
      await ui.button("Use voice input").click();
      expect(consent.checked).toBe(false); // Microphone permission cannot carry model consent.
      const recognition = Recognition.instances[0]!;
      recognition.result("Drink a glass of water"); recognition.onend();
      expect(input.value).toBe("Not yet: Drink a glass of water");
    }
    expect(consent.checked).toBe(false); expect(ui.button("Review with Bedrock").disabled).toBe(true);
    await ui.submit(ui.button("Review with Bedrock"));
    expect(ui.conversationBodies()).toEqual([]);
  });

  it("consumes consent once, blocks duplicate submits, and preserves the draft after provider failure", async () => {
    const ui = await fixture({ naturalLanguage: true });
    let finish!: (response: unknown) => void;
    const delayed = new Promise<unknown>(resolve => { finish = resolve; });
    ui.setConversationResponse(async () => delayed);
    const input = ui.element("care-request"), consent = ui.element("care-transfer-consent"), model = ui.button("Review with Bedrock");
    input.value = "I drank the water"; await input.emit("input");
    consent.checked = true; await consent.emit("change");
    const first = ui.submit(model);
    expect(ui.conversationBodies()).toHaveLength(1);
    expect(consent.checked).toBe(false); expect(model.disabled).toBe(true);
    await ui.submit(model);
    expect(ui.conversationBodies()).toHaveLength(1);
    finish({ ok: false, status: 503 }); await first;
    expect(input.value).toBe("I drank the water"); expect(input.disabled).toBe(false);
    expect(consent.checked).toBe(false); expect(model.disabled).toBe(true);
    expect(ui.element("workspace-retry-write").hidden).toBe(true);
    await model.click(); await ui.submit(model);
    expect(ui.conversationBodies()).toHaveLength(1);
    ui.setConversationResponse(async () => ({ ok: true, json: async () => ({ action: "clarify", mode: "bedrock" }) }));
    consent.checked = true; await consent.emit("change"); await ui.submit(model);
    expect(ui.conversationBodies()).toHaveLength(2);
    expect(consent.checked).toBe(false);
  });

  it.each(["button", "enter"])("keeps the explicit %s path model-free even when consent was checked", async submitMethod => {
    const ui = await fixture({ naturalLanguage: true });
    const input = ui.element("care-request"), consent = ui.element("care-transfer-consent");
    input.value = "Done: Drink a glass of water"; await input.emit("input");
    consent.checked = true; await consent.emit("change");
    await ui.submit(submitMethod === "button" ? ui.button("Review request") : undefined);
    expect(ui.conversationBodies()).toEqual([{ message: "Done: Drink a glass of water" }]);
    expect(consent.checked).toBe(false); expect(ui.button("Review with Bedrock").disabled).toBe(true);
  });

  it("shows a model suggestion for separate review without sending a save request", async () => {
    const ui = await fixture({ naturalLanguage: true });
    ui.setConversationResponse(async () => ({ ok: true, json: async () => ({ action: "confirm", mode: "bedrock", response: "done",
      task: { id: "water", title: "Drink a glass of water", dueAt: "2026-09-06T15:00:00Z" }, expected: { state: "scheduled" } }) }));
    ui.element("care-request").value = "I drank the water";
    const consent = ui.element("care-transfer-consent"); consent.checked = true; await consent.emit("change");
    await ui.submit(ui.button("Review with Bedrock"));
    expect(ui.button("Confirm this check-in").disabled).toBe(false);
    await ui.button("Leave unchanged").click();
    expect(ui.request.mock.calls.every(([url]) => ["/api/session", "/api/today", "/api/conversation"].includes(url))).toBe(true);
    expect(ui.conversationBodies()).toHaveLength(1);
  });
});
