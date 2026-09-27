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

async function fixture(tasks = [single()], manageDuty = true, reschedule = false, closeUnanswered = false) {
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
  let loseNextSave = false, conflict = false, unavailable = false;
  const receipts = new Map<string, unknown>();
  const request = vi.fn(async (url: string, options: { body?: string } = {}) => {
    if (url === "/api/session") return { ok: true, json: async () => ({ name: "Maya", role: "caregiver", permissions: { confirm: true, manageDuty, closeUnanswered: manageDuty && closeUnanswered, invite: false } }) };
    if (url === "/api/plan") return { ok: true, json: async () => ({ tasks: structuredClone(tasks), features: { reschedule } }) };
    if (url === "/api/today") return { ok: true, json: async () => ({ date: "2026-09-08", tasks: [], summary: { total: 0, completed: 0 }, escalations: [], onDuty: null }) };
    const match = /^\/api\/(tasks|routines)\/([^/]+)\/change$/.exec(url);
    if (!match) throw new Error(`Unexpected request: ${url}`);
    if (conflict) return { ok: false, status: 409 };
    if (unavailable) return { ok: false, status: 422 };
    const body = JSON.parse(options.body!);
    if (!receipts.has(body.requestId)) {
      const selected = tasks.filter(task => match[1] === "tasks" ? task.id === decodeURIComponent(match[2]!) : task.routineId === decodeURIComponent(match[2]!));
      const replacement = body.action === "reschedule" ? { taskId: `care-${"a".repeat(40)}`, dueAt: body.dueAt } : undefined;
      for (const task of selected) {
        if (body.action !== "rename") task.state = body.action === "close_unanswered" ? "closed_unanswered" : "cancelled"; else task.title = body.title;
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
    unavailable: (value: boolean) => { unavailable = value; },
    bodies: () => request.mock.calls.filter(([url]) => url.endsWith("/change")).map(([, options]) => JSON.parse(options!.body!)),
    async submit(editor: { form: Element } = edit()) { await editor.form.emit("submit"); await settled(); },
    async navigate(tab: string) { location.hash = `#${tab}`; events.get("hashchange")?.(); await settled(); },
    async retry() { await root("workspace-retry-write").click(); await settled(); },
    async refresh() { const count = request.mock.calls.length; await root("workspace-refresh").click(); await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(count)); await settled(); },
  };
}

describe("reviewed one-time check-in editing", () => {
  it.each<Partial<CareTask>>([
    { state: "cancelled" }, { state: "done" }, { state: "skipped" },
    { state: "closed_unanswered" }, { dueAt: "2026-09-08T15:00:00.000Z" },
    { dueAt: "2026-09-07T15:00:00.000Z" },
  ])("retains moved history without inviting a reminder for an inactive occurrence: %j", async overrides => {
    const ui = await fixture([single("replacement", {
      ...overrides, rescheduledFrom: { taskId: "original", dueAt: "2026-09-06T15:00:00.000Z" },
    })]);
    const content = ui.element("workspace-content")!.textContent;
    expect(content).toContain("Moved from");
    expect(content).not.toContain("A new Alexa reminder requires a fresh request.");
    expect(ui.bodies()).toEqual([]);
  });

  it("keeps fresh reminder consent guidance for an upcoming moved check-in", async () => {
    const ui = await fixture([single("replacement", {
      rescheduledFrom: { taskId: "original", dueAt: "2026-09-09T14:00:00.000Z" },
    })]);
    expect(ui.element("workspace-content")!.textContent).toContain("A new Alexa reminder requires a fresh request.");
    expect(ui.bodies()).toEqual([]);
  });

  it.each(["1", "7"])("previews %s scheduled dates with readable minutes and the local time zone", async repeat => {
    const ui = await fixture([]), due = ui.element("plan-due")!, frequency = ui.element("plan-repeat")!;
    due.value = "2026-09-09T18:00"; frequency.value = repeat; await frequency.emit("change");
    const format = (value: string) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
    expect(ui.element("workspace-content")!.textContent).toContain(repeat === "1"
      ? `1 check-in · ${format(due.value)}`
      : `7 check-ins · ${format(due.value)} through ${format("2026-09-15T18:00")}. Stops after the last check-in; it does not renew.`);
    expect(ui.bodies()).toEqual([]);
  });

  it.each([false, true])("keeps essential scheduling guidance visible and moves optional editing help after Save (reschedule=%s)", async enabled => {
    const ui = await fixture([], true, enabled);
    const form = ui.element("workspace-content")!.descendants().find(el => el.tagName === "FORM")!;
    const save = form.children.find(el => el.tagName === "BUTTON" && el.type === "submit")!;
    const help = ui.element("plan-editing-help")!;
    expect(help?.tagName).toBe("DETAILS");
    expect(help.children[0]?.textContent).toBe("Changing a plan later");
    expect(form.children.indexOf(help)).toBeGreaterThan(form.children.indexOf(save));
    expect(help.textContent).toContain("future, untouched check-ins");
    expect(help.textContent).toContain(enabled ? "A one-time check-in can also move to a new time." : "To change a time, cancel the old check-in or routine");
    const alert = ui.element("plan-notification-note")!, draft = ui.element("plan-draft-note")!, limit = ui.element("plan-time-note")!;
    expect(form.children).toContain(alert); expect(form.children).toContain(draft); expect(form.children).toContain(limit);
    expect(alert.textContent).toBe("Missed check-ins may notify the caregiver on duty.");
    expect(form.children.indexOf(alert)).toBeLessThan(form.children.indexOf(save));
    expect(limit.textContent).toBe("Keep every check-in within the next 30 days.");
    expect(draft.textContent).toContain("Reloading this page or closing the session clears it.");
    expect(ui.bodies()).toEqual([]);
  });

  it("puts upcoming plans before earlier open check-ins and keeps outcomes in separate history", async () => {
    const tasks = [
      single("done", { title: "Recorded call", state: "done", dueAt: "2026-09-07T15:00:00.000Z" }),
      single("old", { title: "Earlier walk", dueAt: "2026-09-06T15:00:00.000Z" }),
      single("later", { title: "Later call", dueAt: "2026-09-10T15:00:00.000Z" }),
      single("next", { title: "Next call" }),
      single("now", { title: "Due now", dueAt: "2026-09-08T15:00:00.000Z", lastResponse: "not_yet" }),
    ];
    const ui = await fixture(tasks);
    const upcoming = ui.element("plan-upcoming")!, earlier = ui.element("plan-earlier")!, history = ui.element("plan-history")!;
    expect(upcoming?.textContent).toContain("Coming up · 2");
    expect(upcoming.descendants().filter(el => el.tagName === "H3").map(el => el.textContent)).toEqual(["Coming up · 2", "Next call", "Later call"]);
    expect(earlier?.textContent).toContain("Earlier, still open · 2");
    expect(earlier.descendants().filter(el => el.tagName === "H3").map(el => el.textContent)).toEqual(["Earlier, still open · 2", "Due now", "Earlier walk"]);
    expect(history?.tagName).toBe("DETAILS");
    expect(history?.textContent).toContain("Recorded outcomes · 1");
    expect(history?.textContent).toContain("Recorded call");
    const sections = ui.element("workspace-content")!.children;
    expect(sections.indexOf(upcoming)).toBeLessThan(sections.indexOf(earlier));
    expect(sections.indexOf(earlier)).toBeLessThan(sections.indexOf(history));
    expect(ui.tasks.map(task => task.id)).toEqual(["done", "old", "later", "next", "now"]);
    expect(ui.bodies()).toEqual([]);
  });

  it("keeps every terminal state out of the open plan, including future cancellations", async () => {
    const ui = await fixture(["done", "skipped", "cancelled", "closed_unanswered"].map((state, i) =>
      single(`outcome-${i}`, { state: state as CareTask["state"] })));
    expect(ui.element("plan-upcoming")?.textContent).toContain("No upcoming check-ins.");
    expect(ui.element("plan-earlier")).toBeNull();
    expect(ui.element("plan-history")?.textContent).toContain("Recorded outcomes · 4");
  });

  it.each([4, 10])("keeps the newest three of %s earlier open check-ins visible and every older record accessible", async count => {
    const tasks = Array.from({ length: count }, (_, i) => single(`earlier-${i}`, {
      title: `Open check-in ${i}`, dueAt: new Date(Date.UTC(2026, 8, 8, 14 - i)).toISOString(),
    })).reverse();
    const ui = await fixture(tasks, true, false, true);
    const earlier = ui.element("plan-earlier")!, more = ui.element("plan-earlier-more")!;
    expect(earlier.children.find(el => el.tagName === "UL")?.children.map(el => el.children[0]?.children[0]?.textContent))
      .toEqual(["Open check-in 0", "Open check-in 1", "Open check-in 2"]);
    expect(more?.tagName).toBe("DETAILS");
    expect(more.children[0]?.tagName).toBe("SUMMARY");
    expect(more.children[0]?.textContent).toBe(`Show ${count - 3} older open check-in${count === 4 ? "" : "s"}`);
    expect(more.descendants().filter(el => el.tagName === "H3").map(el => el.textContent))
      .toEqual(Array.from({ length: count - 3 }, (_, i) => `Open check-in ${i + 3}`));
    expect(earlier.textContent).toContain(`Showing the 3 most recent of ${count} open check-ins.`);
    expect(earlier.textContent).toContain("This does not tell you whether someone is safe.");
    for (const task of tasks) expect(ui.edit(task.id).action.value).toBe("close_unanswered");
    expect(ui.bodies()).toEqual([]);
    expect(ui.tasks.every(task => task.state === "scheduled")).toBe(true);
  });

  it.each([1, 3])("shows all %s earlier records directly without an empty disclosure", async count => {
    const ui = await fixture(Array.from({ length: count }, (_, i) => single(`old-${i}`, { dueAt: "2026-09-07T15:00:00.000Z" })));
    expect(ui.element("plan-earlier-more")).toBeNull();
    expect(ui.element("plan-earlier")!.children.find(el => el.tagName === "UL")?.children).toHaveLength(count);
    expect(ui.bodies()).toEqual([]);
  });

  it("requires a reviewed caregiver closure, retains its retry identity, and never submits a care reply", async () => {
    const overdue = single("overdue", { dueAt: "2026-09-08T14:00:00.000Z", routineId: "daily" });
    const ui = await fixture([overdue], true, false, true), editor = ui.edit("overdue");
    expect(editor.action.value).toBe("close_unanswered");
    expect(editor.action.children.map(option => option.value)).toEqual(["close_unanswered"]);
    expect(editor.form.textContent).toContain("not as done or skipped");
    await ui.submit(editor); expect(ui.bodies()).toHaveLength(0);
    editor.consent.checked = true; ui.loseNextSave(); await ui.submit(editor); await ui.retry();
    expect(ui.bodies()).toHaveLength(2); expect(ui.bodies()[1]).toEqual(ui.bodies()[0]);
    expect(ui.bodies()[0]).toMatchObject({ action: "close_unanswered", confirm: true, expected: { title: overdue.title, dueAt: overdue.dueAt } });
    expect(ui.bodies()[0]).not.toHaveProperty("response");
    expect(ui.tasks[0]!.state).toBe("closed_unanswered");
    expect(ui.element("task-title-overdue")).toBeNull();
  });

  it("hides overdue closure unless the server advertises caregiver permission", async () => {
    const ui = await fixture([single("overdue", { dueAt: "2026-09-08T14:00:00.000Z" })]);
    expect(ui.element("task-title-overdue")).toBeNull();
  });

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

  it("keeps a lost move locked through a disabled retry without reporting no change or allowing another save", async () => {
    const ui = await fixture([single()], true, true), editor = ui.edit();
    editor.action.value = "reschedule"; await editor.action.emit("change");
    editor.due.value = "2026-09-10T14:00"; await editor.due.emit("input"); editor.consent.checked = true;
    ui.loseNextSave(); await ui.submit(editor);
    ui.unavailable(true); await ui.retry();
    expect(ui.status()).toContain("Retry the same request");
    expect(ui.element("workspace-retry-write")!.hidden).toBe(false);
    expect(editor.due.disabled).toBe(true);
    await ui.navigate("today"); expect(location.hash).toBe("#plan");
    ui.unavailable(false); await ui.retry();
    expect(ui.bodies()).toHaveLength(3); expect(ui.bodies()[2]).toEqual(ui.bodies()[0]);
    expect(ui.tasks).toHaveLength(2);
    expect(ui.status()).toContain("fresh, explicit request on Alexa");
    expect(ui.element("workspace-retry-write")!.hidden).toBe(true);
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
