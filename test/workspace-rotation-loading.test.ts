import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// DOM and HTTP are boundaries; the workspace, rotation editor/client, and care store run unchanged.
class Element {
  tagName: string; id = ""; hidden = false; disabled = false; type = ""; value = ""; className = "";
  children: Element[] = []; parent: Element | null = null; dataset: Record<string, string> = {}; private ownText = "";
  classList = { add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
  add(child: Element) { this.append(child); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = []; this.append(...children); }
  get childElementCount() { return this.children.length; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  addEventListener(name: string, action: (event: { preventDefault(): void }) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  setAttribute() {} removeAttribute() {} focus = vi.fn(); reportValidity() { return true; }
  async emit(name: string) { await Promise.all((this.listeners.get(name) ?? []).map(action => action({ preventDefault() {} }))); }
  async click() { if (!this.disabled) await this.emit("click"); }
}

let close: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { close?.(); close = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(timeZone = "UTC", legacy = false) {
  const store = createDemoStore(() => new Date("2026-09-08T15:00:00.000Z"), timeZone);
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  vi.stubGlobal("document", { getElementById: get, createElement: (tag: string) => new Element(tag), querySelector: () => get("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("window", { addEventListener() {} }); vi.stubGlobal("location", { hash: "#circle" }); vi.stubGlobal("history", { replaceState() {} });
  vi.stubGlobal("Option", class extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } });
  let resolveProposal!: () => void, rejectProposal!: () => void;
  const pendingProposal = new Promise<void>((resolve, reject) => { resolveProposal = resolve; rejectProposal = () => reject(new Error("Synthetic unavailable proposal")); });
  const request = vi.fn(async (url: string) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ name: "Maya", role: "caregiver", permissions: { confirm: true, manageDuty: true, manageRoster: false, invite: false } }) };
    if (url === "/api/circle") return { ok: true, json: async () => {
      const data = await store.circle();
      return legacy ? { ...data, timeZone: undefined } : data;
    } };
    if (url === "/api/circle/rotation") { await pendingProposal; return { ok: true, json: async () => store.proposeDutyRotation() }; }
    if (url === "/api/circle/duty") return { ok: false, status: 409 };
    throw new Error(`Unexpected request: ${url}`);
  });
  const page = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} }); close = page.reset;
  await page.open();
  const content = get("workspace-content"), firstForm = content.descendants().find(item => item.tagName === "FORM")!;
  firstForm.descendants().find(item => item.tagName === "SELECT")!.value = "maya";
  await firstForm.emit("submit");
  const button = (label: string) => content.descendants().find(item => item.tagName === "BUTTON" && item.textContent === label)!;
  return { get, request, button, resolveProposal, rejectProposal, firstForm, store,
    writes: () => request.mock.calls.filter(([url]) => url === "/api/circle/duty") };
}

describe("rotation proposal loading and workspace mutation locking", () => {
  it.each(["maya", "__clear__"])("shows the circle time zone before reviewing duty change %s without writing", async proposed => {
    const ui = await fixture("America/Denver");
    expect(ui.get("workspace-content").textContent).toContain("Duty dates use America/Denver");
    ui.firstForm.descendants().find(item => item.tagName === "SELECT")!.value = proposed;
    await ui.firstForm.emit("submit");
    const review = ui.firstForm.descendants().find(item => item.className.includes("duty-review"))!;
    expect(review.textContent).toContain("America/Denver");
    expect(ui.writes()).toHaveLength(0);
  });
  it("does not guess a circle time zone from the browser when an older API omits it", async () => {
    const ui = await fixture("America/Denver", true);
    expect(ui.get("workspace-content").textContent).toContain("Circle time zone unavailable");
    expect(ui.get("workspace-content").textContent).not.toContain("Duty dates use UTC");
    expect(ui.writes()).toHaveLength(0);
  });
  it.each(["maya", "__clear__"])("discarding duty proposal %s restores the saved choice without a write", async proposed => {
    const ui = await fixture();
    const select = ui.firstForm.descendants().find(item => item.tagName === "SELECT")!;
    const original = (await ui.store.circle()).assignments.find(day => `duty-${day.date}` === select.id)!.memberId;
    select.value = proposed;
    await ui.firstForm.emit("submit");
    await ui.button("Keep unchanged").click();
    expect(select.value).toBe(original);
    expect(select.focus).toHaveBeenCalled();
    expect(ui.firstForm.descendants().find(item => item.className.includes("duty-review"))!.hidden).toBe(true);
    expect(ui.writes()).toHaveLength(0);
  });
  it.each(["success", "failure"])("waits for a slow proposal %s before dispatching another save and keeps Propose usable afterward", async outcome => {
    const ui = await fixture(), propose = ui.button("Propose next week"), confirm = ui.button("Confirm duty assignment");
    const reading = propose.click();
    expect(propose.disabled).toBe(true);
    await confirm.click();
    expect(ui.writes()).toHaveLength(0);
    expect(ui.get("workspace-status").textContent).toContain("Wait for the rotation proposal");
    if (outcome === "success") ui.resolveProposal(); else ui.rejectProposal();
    await reading;
    expect(propose.disabled).toBe(false);
    await confirm.click();
    await vi.waitFor(() => expect(ui.get("workspace-status").textContent).toContain("duty roster changed"));
    expect(ui.writes()).toHaveLength(1);
    expect(propose.disabled).toBe(false);
    // An ordinary refresh with unchanged current-week data need not rerender.
    await ui.get("workspace-refresh").click();
    await vi.waitFor(() => expect(ui.get("workspace-status").textContent).toContain("Checked at"));
    expect(propose.disabled).toBe(false);
  });
});
