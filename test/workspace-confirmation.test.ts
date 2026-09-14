import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoStore } from "../src/domain.js";
import { taskReview, TaskReviewConflict } from "../src/task-review.js";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// The DOM and HTTP transport are boundaries; the workspace, request client and care store are real.
class Element {
  tagName: string; id = ""; hidden = false; disabled = false; type = ""; value = ""; className = "";
  children: Element[] = []; dataset: Record<string, string> = {}; private ownText = "";
  classList = { add() {}, remove() {} };
  listeners = new Map<string, Array<() => void>>();
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  get childElementCount() { return this.children.length; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  addEventListener(name: string, action: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  setAttribute() {} removeAttribute() {} focus() {}
  click() { if (!this.disabled) for (const action of this.listeners.get("click") ?? []) action(); }
}

let close: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { close?.(); close = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture() {
  const store = createDemoStore(() => new Date("2026-09-08T15:00:00.000Z"));
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  vi.stubGlobal("document", { getElementById: get, createElement: (tag: string) => new Element(tag), querySelector: () => get("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("window", { addEventListener() {} }); vi.stubGlobal("location", { hash: "#today" }); vi.stubGlobal("history", { replaceState() {} });
  let loseNextSave = false;
  const request = vi.fn(async (url: string, options: { body?: string } = {}) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ name: "Maya", role: "caregiver", permissions: { confirm: true, manageDuty: true, invite: false } }) };
    if (url === "/api/today") return { ok: true, json: async () => store.today() };
    const match = /^\/api\/tasks\/([^/]+)\/confirm$/.exec(url);
    if (!match) throw new Error(`Unexpected request: ${url}`);
    let result;
    try { result = await store.confirm({ ...JSON.parse(options.body!), taskId: match[1], actor: "Maya" }); }
    catch (error) { if (error instanceof TaskReviewConflict) return { ok: false, status: 409, json: async () => ({ error: "review_conflict" }) }; throw error; }
    if (loseNextSave) { loseNextSave = false; throw new Error("Synthetic lost committed response"); }
    return { ok: true, json: async () => result };
  });
  const page = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} }); close = page.reset;
  await page.open();
  const firstRow = () => get("workspace-content").descendants().find(item => item.tagName === "LI")!;
  return { store, get, request, loseNextSave: () => { loseNextSave = true; },
    button: (label: string) => firstRow().descendants().find(item => item.tagName === "BUTTON" && item.textContent === label)!,
    bodies: () => request.mock.calls.filter(([url]) => url.endsWith("/confirm")).map(([, options]) => JSON.parse(options!.body!)),
    async settled() { await vi.waitFor(() => expect(get("workspace-status").textContent).not.toBe("Saving…")); },
  };
}

describe("reviewed direct Today confirmations", () => {
  it.each([["Done", "done"], ["Not yet", "not_yet"], ["Skip today", "skipped"]])("binds %s to every displayed task field", async (label, response) => {
    const ui = await fixture();
    const displayed = (await ui.store.today()).tasks[0]!;
    ui.button(label!).click(); await ui.settled();
    expect(ui.bodies()).toHaveLength(1);
    expect(ui.bodies()[0]).toMatchObject({ response, expected: taskReview(displayed) });
  });

  it.each(["Done", "Not yet", "Skip today"])("rejects a stale %s click without overwriting another person’s completion", async label => {
    const ui = await fixture(); const displayed = (await ui.store.today()).tasks[0]!;
    await ui.store.confirm({ taskId: displayed.id, response: "done", actor: "Evelyn", requestId: "parent-completion-before-stale-click", expected: taskReview(displayed) });
    ui.button(label).click(); await ui.settled();
    expect((await ui.store.today()).tasks[0]).toMatchObject({ state: "done", lastResponse: "done", confirmedBy: "Evelyn" });
    expect(ui.get("workspace-status").textContent).toContain("changed while you were reviewing");
    expect(ui.get("workspace-retry-write").hidden).toBe(true);
  });

  it("retains the original reviewed fields and identity when retrying a committed response loss", async () => {
    const ui = await fixture(); const displayed = (await ui.store.today()).tasks[0]!;
    ui.loseNextSave(); ui.button("Not yet").click(); await ui.settled();
    expect(ui.get("workspace-retry-write").hidden).toBe(false);
    ui.get("workspace-retry-write").click(); await ui.settled();
    expect(ui.bodies()).toHaveLength(2); expect(ui.bodies()[1]).toEqual(ui.bodies()[0]);
    expect(ui.bodies()[1].expected).toEqual(taskReview(displayed));
    expect((await ui.store.today()).tasks[0]).toMatchObject({ state: "scheduled", lastResponse: "not_yet", confirmedBy: "Maya" });
    expect(ui.get("workspace-retry-write").hidden).toBe(true);
  });
});
