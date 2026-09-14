import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareTask } from "../src/domain.js";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// Only the DOM and HTTP response boundary are synthetic; workspace and request client are real.
class Element {
  tagName: string; id = ""; value = ""; type = ""; hidden = false; disabled = false; checked = false; required = false;
  dataset: Record<string, string> = {}; children: Element[] = []; private ownText = "";
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  classList = { add() {}, remove() {} };
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  add(option: Element) { this.append(option); if (this.children.length === 1) this.value = option.value; }
  get childElementCount() { return this.children.length; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  addEventListener(name: string, action: (event: { preventDefault(): void }) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  setAttribute() {} removeAttribute() {} focus() {}
  reportValidity() { return this.querySelectorAll().every(field => field.disabled || !field.required || (field.type === "checkbox" ? field.checked : !!field.value)); }
  async emit(name: string) { await Promise.all((this.listeners.get(name) ?? []).map(action => action({ preventDefault() {} }))); }
  click() { if (!this.disabled) return this.emit("click"); }
}

const single = (id = "single-task", overrides: Partial<CareTask> = {}): CareTask => ({ id, title: "A call together", dueAt: "2026-09-09T15:00:00.000Z", state: "scheduled", lastResponse: null, confirmedAt: null, confirmedBy: null, ...overrides });
let close: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z")); });
afterEach(() => { close?.(); close = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture(tasks = [single()], manageDuty = true, reschedule = false) {
  const ids = new Map<string, Element>();
  const root = (id: string) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id)!; };
  const element = (id: string) => root("workspace-content").descendants().find(child => child.id === id) ?? ids.get(id) ?? null;
  for (const id of ["main", "workspace", "workspace-navigation", "workspace-nav", "workspace-secondary", "workspace-management", "workspace-content", "workspace-status", "workspace-refresh", "workspace-retry-write", "workspace-identity", "workspace-ask-link", "workspace-invite-link", "workspace-access-link", "invite-status", "invite-reload", "invitation-area"]) root(id);
  const events = new Map<string, () => void>();
  vi.stubGlobal("document", { getElementById: element, createElement: (tag: string) => new Element(tag), querySelector: () => root("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("window", { addEventListener: (name: string, action: () => void) => events.set(name, action) });
  vi.stubGlobal("location", { hash: "#plan" });
  vi.stubGlobal("history", { replaceState: (_data: unknown, _unused: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("Option", class extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } });
  let loseNextSave = false, conflict = false;
  const receipts = new Map<string, unknown>();
  const request = vi.fn(async (url: string, options: { body?: string } = {}) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ name: "Maya", role: "caregiver", permissions: { confirm: true, manageDuty, invite: false } }) };
    if (url === "/api/plan") return { ok: true, json: async () => ({ tasks: structuredClone(tasks), features: { reschedule } }) };
    if (url === "/api/today") return { ok: true, json: async () => ({ date: "2026-09-08", tasks: [], summary: { total: 0, completed: 0 }, escalations: [], onDuty: null }) };
    const match = /^\/api\/(tasks|routines)\/([^/]+)\/change$/.exec(url);
    if (!match) throw new Error(`Unexpected request: ${url}`);
    if (conflict) return { ok: false, status: 409 };
    const body = JSON.parse(options.body!);
    if (!receipts.has(body.requestId)) {
      const selected = tasks.filter(task => match[1] === "tasks" ? task.id === decodeURIComponent(match[2]!) : task.routineId === decodeURIComponent(match[2]!));
      const replacement = body.action === "reschedule" ? { taskId: `care-${"a".repeat(40)}`, dueAt: body.dueAt } : undefined;
      for (const task of selected) {
        if (body.action !== "rename") task.state = "cancelled"; else task.title = body.title;
        if (replacement) { task.rescheduledTo = replacement; tasks.push(single(replacement.taskId, { title: task.title, dueAt: replacement.dueAt, rescheduledFrom: { taskId: task.id, dueAt: task.dueAt } })); }
      }
      receipts.set(body.requestId, { requestId: body.requestId, ...(match[1] === "tasks" ? { taskId: selected[0]!.id, action: body.action } : {}), changed: selected.length,
        ...(replacement ? { replacement } : {}) });
    }
    if (loseNextSave) { loseNextSave = false; throw new Error("Synthetic committed response loss"); }
    return { ok: true, json: async () => receipts.get(body.requestId) };
  });
  const page = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} }); close = page.reset;
  await page.open();
  const edit = (id = "single-task") => {
    const title = element(`task-title-${id}`)!;
    const form = root("workspace-content").descendants().find(child => child.tagName === "FORM" && child.descendants().includes(title))!;
    expect(form, `Missing editor for ${id}`).toBeDefined();
    return { form, title, action: element(`task-action-${id}`)!, due: element(`task-due-${id}`)!, consent: form.descendants().find(child => child.type === "checkbox")! };
  };
  const routineEdit = (id = "daily") => {
    const title = element(`routine-${id}`)!;
    const form = root("workspace-content").descendants().find(child => child.tagName === "FORM" && child.descendants().includes(title))!;
    expect(form, `Missing routine editor for ${id}`).toBeDefined();
    return { form, title, action: element(`action-${id}`)!, consent: form.descendants().find(child => child.type === "checkbox")! };
  };
  const settled = () => vi.waitFor(() => expect(root("workspace-status").textContent).not.toMatch(/Saving|Loading/));
  return { element, edit, routineEdit, request, tasks, status: () => root("workspace-status").textContent,
    loseNextSave: () => { loseNextSave = true; }, conflict: () => { conflict = true; },
    bodies: () => request.mock.calls.filter(([url]) => url.endsWith("/change")).map(([, options]) => JSON.parse(options!.body!)),
    async submit(editor: { form: Element } = edit()) { await editor.form.emit("submit"); await settled(); },
    async navigate(tab: string) { location.hash = `#${tab}`; events.get("hashchange")?.(); await settled(); },
    async retry() { await root("workspace-retry-write").click(); await settled(); },
    async refresh() { const count = request.mock.calls.length; await root("workspace-refresh").click(); await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(count)); await settled(); },
  };
}

describe("reviewed one-time check-in editing", () => {
  it("hides moving unless the API explicitly advertises it", async () => {
    const ui = await fixture();
    expect(ui.edit().action.children.map(option => option.value)).toEqual(["rename", "cancel"]);
    expect(ui.edit().due.hidden).toBe(true); expect(ui.bodies()).toHaveLength(0);
  });

  it("preserves the new-time draft but requires fresh consent and never requests a reminder", async () => {
    const ui = await fixture([single()], true, true); let editor = ui.edit();
    editor.action.value = "reschedule"; await editor.action.emit("change");
    editor.due.value = "2026-09-10T14:00"; await editor.due.emit("input"); editor.consent.checked = true;
    expect(editor.title.disabled).toBe(true); expect(editor.form.textContent).toContain("fresh, explicit request on Alexa");
    await ui.navigate("today"); await ui.navigate("plan"); editor = ui.edit();
    expect(editor.action.value).toBe("reschedule"); expect(editor.due.value).toBe("2026-09-10T14:00"); expect(editor.consent.checked).toBe(false);
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(0);
    editor.consent.checked = true; editor.due.value = "2026-09-10T15:00"; await editor.due.emit("change");
    expect(editor.consent.checked).toBe(false); editor.consent.checked = true; await ui.submit(editor);
    expect(ui.bodies()).toEqual([{ action: "reschedule", dueAt: new Date("2026-09-10T15:00").toISOString(),
      expected: { title: single().title, dueAt: single().dueAt }, confirm: true, requestId: expect.any(String) }]);
    expect(ui.tasks).toHaveLength(2); expect(ui.tasks[0]!.state).toBe("cancelled");
    expect(ui.status()).toContain("none was created here"); expect(ui.element("task-title-single-task")).toBeNull();
    expect(ui.request.mock.calls.filter(([url]) => /reminder/.test(url))).toHaveLength(0);
  });

  it("retries the same reschedule after a lost receipt and preserves the fresh-reminder notice", async () => {
    const ui = await fixture([single()], true, true), editor = ui.edit();
    editor.action.value = "reschedule"; await editor.action.emit("change");
    editor.due.value = "2026-09-10T14:00"; await editor.due.emit("input"); editor.consent.checked = true;
    ui.loseNextSave(); await ui.submit(editor); await ui.retry();
    expect(ui.bodies()).toHaveLength(2); expect(ui.bodies()[1]).toEqual(ui.bodies()[0]);
    expect(ui.tasks).toHaveLength(2); expect(ui.status()).toContain("fresh, explicit request on Alexa");
  });

  it.each(["2026-09-07T12:00", "2026-10-10T12:00"])("rejects invalid new time %s without a POST", async due => {
    const ui = await fixture([single()], true, true), editor = ui.edit();
    editor.action.value = "reschedule"; await editor.action.emit("change");
    editor.due.value = due; await editor.due.emit("input"); editor.consent.checked = true;
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(0); expect(editor.consent.checked).toBe(false);
  });

  it("offers an editor only for a caregiver's future, untouched, standalone check-ins", async () => {
    const ui = await fixture([single(), single("routine", { routineId: "daily" }), single("answered", { lastResponse: "not_yet" }), single("due", { dueAt: "2026-09-08T15:00:00.000Z" }), single("cancelled", { state: "cancelled" }), single("completed", { state: "done" })]);
    expect(ui.element("task-title-single-task")).not.toBeNull();
    for (const id of ["routine", "answered", "due", "cancelled", "completed"]) expect(ui.element(`task-title-${id}`)).toBeNull();
    expect(ui.bodies()).toHaveLength(0);
  });

  it("does not expose single check-in writes to a view-only member", async () => {
    const ui = await fixture([single()], false);
    expect(ui.element("task-title-single-task")).toBeNull(); expect(ui.bodies()).toHaveLength(0);
  });

  it("requires fresh explicit consent after wording changes and sends the exact displayed review", async () => {
    const ui = await fixture(); const editor = ui.edit();
    editor.title.value = "An afternoon call"; await editor.title.emit("input");
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(0);
    editor.consent.checked = true;
    editor.title.value = "A call with Theo"; await editor.title.emit("input");
    expect(editor.consent.checked).toBe(false);
    editor.consent.checked = true; await ui.submit(editor);
    expect(ui.bodies()).toEqual([{ action: "rename", title: "A call with Theo", expected: { title: "A call together", dueAt: single().dueAt }, confirm: true, requestId: expect.any(String) }]);
    expect(ui.status()).toBe("Check-in updated.");
    expect(ui.edit().title.value).toBe("A call with Theo"); expect(ui.edit().consent.checked).toBe(false);
  });

  it("reviews cancellation separately, omits rename text, and retains the cancelled record", async () => {
    const ui = await fixture(); const editor = ui.edit(); editor.consent.checked = true;
    editor.action.value = "cancel"; await editor.action.emit("change");
    expect(editor.consent.checked).toBe(false); expect(editor.title.disabled).toBe(true);
    expect(editor.form.textContent).toContain("cannot be undone");
    editor.consent.checked = true; await ui.submit(editor);
    expect(ui.bodies()[0]).toMatchObject({ action: "cancel", expected: { title: "A call together", dueAt: single().dueAt }, confirm: true });
    expect(ui.bodies()[0]).not.toHaveProperty("title");
    expect(ui.tasks).toHaveLength(1); expect(ui.tasks[0]?.state).toBe("cancelled");
    expect(ui.element("workspace-content")!.textContent).toContain("cancelled"); expect(ui.element("task-title-single-task")).toBeNull();
  });

  it("keeps edited wording and action across Kin tabs, but never carries consent forward", async () => {
    const ui = await fixture(); const editor = ui.edit(); editor.title.value = "Keep this draft"; await editor.title.emit("input");
    editor.action.value = "cancel"; await editor.action.emit("change"); editor.consent.checked = true;
    await ui.navigate("today"); await ui.navigate("plan");
    expect(ui.edit().title.value).toBe("Keep this draft"); expect(ui.edit().action.value).toBe("cancel");
    expect(ui.edit().title.disabled).toBe(true); expect(ui.edit().consent.checked).toBe(false); expect(ui.bodies()).toHaveLength(0);
  });

  it("locks an ambiguous save and retries the same identity before accepting any new edits", async () => {
    const ui = await fixture(); const editor = ui.edit(); editor.title.value = "A call with Theo"; await editor.title.emit("input");
    editor.consent.checked = true; ui.loseNextSave(); await ui.submit(editor);
    expect(ui.element("workspace-retry-write")!.hidden).toBe(false); expect(editor.title.disabled).toBe(true);
    await ui.navigate("today"); expect(location.hash).toBe("#plan");
    await ui.retry(); expect(ui.bodies()).toHaveLength(2); expect(ui.bodies()[1]).toEqual(ui.bodies()[0]);
    expect(ui.status()).toBe("Check-in updated."); expect(ui.element("workspace-retry-write")!.hidden).toBe(true);
    ui.tasks[0]!.title = "A later family wording"; await ui.refresh();
    await vi.waitFor(() => expect(ui.edit().title.value).toBe("A later family wording"));
  });

  it("keeps the draft after a definitive stale rejection and requires a newly reviewed submission", async () => {
    const ui = await fixture(); const editor = ui.edit(); editor.title.value = "My wording"; await editor.title.emit("input");
    editor.consent.checked = true; ui.conflict(); await ui.submit(editor);
    expect(ui.status()).toContain("changed while you were reviewing"); expect(ui.element("workspace-retry-write")!.hidden).toBe(true);
    expect(editor.title.disabled).toBe(false); expect(editor.consent.checked).toBe(false); expect(editor.title.value).toBe("My wording");
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(1);
  });
});

describe("reviewed daily routine editing", () => {
  const routine = () => [single("first", { routineId: "daily" }), single("second", { routineId: "daily", dueAt: "2026-09-10T15:00:00.000Z" })];

  it.each(["input", "change"])("requires fresh consent after a routine wording %s event", async event => {
    const ui = await fixture(routine()), editor = ui.routineEdit();
    editor.consent.checked = true; editor.title.value = "A new family agreement"; await editor.title.emit(event);
    expect(editor.consent.checked).toBe(false);
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(0);
    editor.consent.checked = true; await ui.submit(editor);
    expect(ui.bodies()).toEqual([{ action: "rename", title: "A new family agreement", expected: routine().map(({ id, title, dueAt }) => ({ id, title, dueAt })), confirm: true, requestId: expect.any(String) }]);
    expect(ui.tasks.map(task => task.title)).toEqual(["A new family agreement", "A new family agreement"]);
    expect(ui.status()).toBe("Routine updated.");
  });

  it("consumes routine review consent on a definitive stale rejection while retaining the wording", async () => {
    const ui = await fixture(routine()), editor = ui.routineEdit();
    editor.title.value = "Keep my wording"; await editor.title.emit("input"); editor.consent.checked = true;
    ui.conflict(); await ui.submit(editor);
    expect(ui.status()).toContain("changed while you were reviewing");
    expect(editor.title.value).toBe("Keep my wording"); expect(editor.consent.checked).toBe(false);
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(1);
  });
});
