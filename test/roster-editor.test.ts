import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { createRosterDraft, renderRosterEditor } = await import(new URL("../simulator/roster-editor.js", import.meta.url).href);
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

// The DOM is an external boundary; the editor and its draft run unchanged.
class Element {
  tagName: string;
  id = ""; textContent = ""; value = ""; type = ""; className = ""; hidden = false; disabled = false; required = false; maxLength = 0;
  parent: Element | null = null;
  children: Element[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  append(...children: Element[]) { this.children.push(...children); for (const child of children) child.parent = this; }
  add(child: Element) { this.append(child); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  get childElementCount() { return this.children.length; }
  addEventListener(event: string, action: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), action]);
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  focus = vi.fn();
  reportValidity() { return true; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  async emit(event: string) { await Promise.all((this.listeners.get(event) ?? []).map(action => action({ preventDefault() {} }))); }
  async click() {
    if (this.disabled) return;
    await this.emit("click");
    if (this.type === "submit") {
      let form = this.parent; while (form && form.tagName !== "FORM") form = form.parent;
      await form?.emit("submit");
    }
  }
}

const members = [
  { id: "p1", name: "June", relationship: "parent", canReceiveAlerts: false, canRename: true },
  { id: "c1", name: "Maya", relationship: "caregiver", canReceiveAlerts: true, canRename: false },
];

let closeWorkspace: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { closeWorkspace?.(); closeWorkspace = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture(options: { members?: typeof members; limit?: number } = {}) {
  let root = new Element("div"), locked = false;
  const draft = createRosterDraft();
  const save = vi.fn(async (_input: unknown) => {}), message = vi.fn();
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => root.descendants().find(element => element.id === id) });
  vi.stubGlobal("Option", class extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } });
  let editor: ReturnType<typeof renderRosterEditor>;
  const rerender = () => {
    editor = renderRosterEditor({ data: { members: options.members ?? members, limit: options.limit ?? 50 }, draft,
      isLocked: () => locked, onSave: save, onMessage: message });
    root = editor.element;
  };
  rerender();
  const find = (predicate: (element: Element) => boolean) => {
    const found = root.descendants().find(predicate); if (!found) throw new Error("Missing element"); return found;
  };
  return { draft, save, message, rerender, all: () => root.descendants(),
    lock: (value: boolean) => { locked = value; }, clear: () => editor.clear(),
    id: (id: string) => find(element => element.id === id),
    button: (label: string) => find(element => element.tagName === "BUTTON" && element.textContent === label),
    async name(value: string) { const input = find(element => element.id === "roster-person-name"); input.value = value; await input.emit("input"); },
  };
}

describe("circle roster editor", () => {
  it("reviews duty eligibility separately without assigning turns or opting in a phone", async () => {
    const ui = fixture({ members: [{ ...members[1]!, canReceiveAlerts: false, canEnableDuty: true } as typeof members[number]] });
    await ui.button("Set up for turns").click();
    expect(ui.save).not.toHaveBeenCalled();
    expect(ui.id("roster-person-name").hidden).toBe(true);
    expect(ui.all().some(e => e.textContent.includes("No shift is assigned, no phone notifications are enabled"))).toBe(true);
    ui.lock(true); await ui.button("Confirm eligibility").click(); expect(ui.save).not.toHaveBeenCalled();
    ui.lock(false); await ui.button("Confirm eligibility").click();
    expect(ui.save).toHaveBeenCalledExactlyOnceWith({ action: "enable_duty", memberId: "c1", name: "Maya", expectedName: "Maya", confirm: true });
  });
  it("connects an eligible entry only after explicit confirmation", async () => {
    const ui = fixture({ members: [{ ...members[0]!, name: "Gowtham", relationship: "caregiver", canConnectSelf: true } as typeof members[number]] });
    await ui.button("Connect to my account").click();
    expect(ui.save).not.toHaveBeenCalled();
    expect(ui.id("roster-person-name").hidden).toBe(true);
    expect(ui.all().some(e => e.textContent.includes("no shift is assigned and no notification is sent"))).toBe(true);
    await ui.button("Confirm account connection").click();
    expect(ui.save).toHaveBeenCalledExactlyOnceWith({ action: "connect_self", memberId: "p1", name: "Gowtham", expectedName: "Gowtham", confirm: true });
  });
  it("adds only after a separate review and confirmation, without account or alert fields", async () => {
    const ui = fixture();
    await ui.button("Add someone").click(); await ui.name("  Rosa  ");
    const role = ui.id("roster-person-role"); role.value = "parent"; await role.emit("change");
    await ui.button("Review addition").click();
    expect(ui.save).not.toHaveBeenCalled();
    expect(ui.id("roster-editor-review").hidden).toBe(false);
    expect(ui.button("Confirm addition").focus).toHaveBeenCalledOnce();
    expect(ui.all().some(element => element.textContent.includes("No account, invitation, duty shift, or alert subscription"))).toBe(true);
    await ui.button("Confirm addition").click();
    expect(ui.save).toHaveBeenCalledExactlyOnceWith({ action: "add", name: "Rosa", relationship: "parent", confirm: true });
  });

  it("sends the reviewed old name and stable member id when renaming", async () => {
    const ui = fixture();
    await ui.button("Edit name").click(); await ui.name("June Park"); await ui.button("Review name change").click();
    expect(ui.all().some(element => element.textContent === "June → June Park")).toBe(true);
    expect(ui.id("roster-person-role").hidden).toBe(true);
    await ui.button("Confirm name change").click();
    expect(ui.save).toHaveBeenCalledExactlyOnceWith({ action: "rename", memberId: "p1", expectedName: "June", name: "June Park", confirm: true });
  });

  it("does not expose renaming for linked account or invitation names", () => {
    const ui = fixture();
    expect(ui.all().filter(element => element.textContent === "Edit name")).toHaveLength(1);
    expect(ui.button("Edit name").attributes["aria-label"]).toBe("Edit name for June");
    expect(ui.all().some(element => element.textContent === "Linked to an account or invitation. This name cannot be changed here.")).toBe(true);
  });

  it("renders markup-looking names as text rather than DOM content", () => {
    const name = '<img src=x onerror="steal()">';
    const ui = fixture({ members: [{ ...members[0]!, name }] });
    expect(ui.all().find(element => element.tagName === "H4")?.textContent).toBe(name);
    expect(ui.all().some(element => element.tagName === "IMG")).toBe(false);
  });

  it("invalidates review on an edit and keeps the draft through a rerender", async () => {
    const ui = fixture();
    await ui.button("Add someone").click(); await ui.name("Rosa"); await ui.button("Review addition").click();
    await ui.name("Rosa Park");
    expect(ui.id("roster-editor-review").hidden).toBe(true);
    await ui.button("Confirm addition").emit("click"); // A stale or hidden button cannot submit an unreviewed draft.
    expect(ui.save).not.toHaveBeenCalled();
    ui.rerender();
    expect(ui.id("roster-person-name").value).toBe("Rosa Park");
    expect(ui.id("roster-editor-form").hidden).toBe(false);
    expect(ui.id("roster-editor-review").hidden).toBe(true);
  });

  it("returns focus and erases the draft on cancel", async () => {
    const ui = fixture();
    await ui.button("Edit name").click(); await ui.name("June Park"); await ui.button("Cancel").click();
    expect(ui.draft.read()).toBeNull(); expect(ui.id("roster-editor-form").hidden).toBe(true);
    expect(ui.button("Edit name").focus).toHaveBeenCalledOnce(); expect(ui.save).not.toHaveBeenCalled();
  });

  it("gives only the final confirmation primary emphasis during review", async () => {
    const ui = fixture(); await ui.button("Add someone").click(); await ui.name("Rosa");
    expect(ui.button("Review addition").className).toBe("primary");
    await ui.button("Review addition").click();
    expect(ui.button("Review addition").className).toBe("secondary"); expect(ui.button("Confirm addition").className).toBe("primary");
    await ui.button("Back to editing").click(); expect(ui.button("Review addition").className).toBe("primary");
    await ui.button("Review addition").click(); await ui.name("Rosa Park");
    expect(ui.button("Review addition").className).toBe("primary"); expect(ui.id("roster-editor-review").hidden).toBe(true);
  });

  it.each(["", " ", "a".repeat(81)])("rejects an invalid name before review (%j)", async name => {
    const ui = fixture(); await ui.button("Add someone").click(); await ui.name(name); await ui.button("Review addition").click();
    expect(ui.id("roster-person-error").textContent).toBe("Use a name between 1 and 80 characters.");
    expect(ui.id("roster-editor-review").hidden).toBe(true); expect(ui.save).not.toHaveBeenCalled();
  });

  it("keeps every roster control inactive while a write is unresolved", async () => {
    const ui = fixture(); await ui.button("Add someone").click(); await ui.name("Rosa"); await ui.button("Review addition").click();
    ui.lock(true);
    await ui.button("Confirm addition").click(); await ui.button("Cancel").click(); await ui.button("Edit name").click();
    expect(ui.save).not.toHaveBeenCalled(); expect(ui.draft.read()).toEqual({ action: "add", name: "Rosa", relationship: "caregiver", review: true });
  });

  it.each(["June\u0000", "\nJune", "\u202eJune", "June\u061c", "June\u200f"])("rejects control or directional characters before trimming (%j)", async name => {
    const ui = fixture(); await ui.button("Add someone").click(); await ui.name(name); await ui.button("Review addition").click();
    expect(ui.id("roster-person-error").textContent).toBe("Use a name without control or directional characters.");
    expect(ui.id("roster-editor-review").hidden).toBe(true); expect(ui.save).not.toHaveBeenCalled();
  });

  it("clears both memory and mounted review after an acknowledged save", async () => {
    const ui = fixture(); await ui.button("Add someone").click(); await ui.name("Rosa"); await ui.button("Review addition").click();
    ui.save.mockImplementation(async () => ui.clear()); await ui.button("Confirm addition").click();
    expect(ui.draft.read()).toBeNull(); expect(ui.id("roster-person-name").value).toBe("");
    expect(ui.id("roster-editor-form").hidden).toBe(true); expect(ui.id("roster-editor-review").hidden).toBe(true);
    ui.rerender(); expect(ui.id("roster-editor-form").hidden).toBe(true);
  });

  it("does not offer addition at the circle limit", async () => {
    const ui = fixture({ limit: 2 });
    expect(ui.button("Add someone").disabled).toBe(true); await ui.button("Add someone").click();
    expect(ui.id("roster-editor-form").hidden).toBe(true);
    expect(ui.all().some(element => element.textContent.includes("limit of 2 people"))).toBe(true);
  });
});

async function workspaceFixture(options: { manageRoster?: boolean; view?: string } = {}) {
  const ids = new Map<string, Element>(), events = new Map<string, () => unknown>();
  const element = (id: string): Element => {
    const nested = ids.get("workspace-content")?.descendants().find(child => child.id === id); if (nested) return nested;
    if (!ids.has(id)) ids.set(id, new Element("div")); return ids.get(id)!;
  };
  vi.stubGlobal("document", { getElementById: element, createElement: (tag: string) => new Element(tag),
    querySelector: () => element("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  vi.stubGlobal("Option", class extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } });
  vi.stubGlobal("window", { addEventListener: (event: string, action: () => unknown) => events.set(event, action) });
  vi.stubGlobal("location", { hash: `#${options.view ?? "circle"}` }); vi.stubGlobal("history", { replaceState() {} });
  const identity = { name: "Maya", permissions: { confirm: true, manageDuty: true, invite: true, manageRoster: options.manageRoster ?? true } };
  let added = false, writeStatus = 200, circleReadStatus = 200;
  const request = vi.fn(async (url: string, requestOptions: { body?: string; method?: string } = {}) => {
    if (url === "/api/session") return { ok: true, json: async () => structuredClone(identity) };
    if (url === "/api/circle/people" && requestOptions.method === "POST") {
      const input = JSON.parse(requestOptions.body!);
      if (writeStatus !== 200) return { ok: false, status: writeStatus };
      added = true;
      return { ok: true, json: async () => ({ requestId: input.requestId, action: input.action,
        person: { id: `person-${"a".repeat(40)}`, name: input.name, relationship: input.relationship, canReceiveAlerts: false, canRename: true } }) };
    }
    const currentMembers = [...members, ...(added ? [{ id: `person-${"a".repeat(40)}`, name: "Rosa", relationship: "caregiver", canReceiveAlerts: false, canRename: true }] : [])];
    if (url === "/api/circle/people") return { ok: true, json: async () => ({ members: currentMembers, limit: 50 }) };
    if (url === "/api/circle" && circleReadStatus !== 200) return { ok: false, status: circleReadStatus };
    if (url === "/api/circle") return { ok: true, json: async () => ({ members: currentMembers, startDate: "2026-09-06", endDate: "2026-09-12",
      assignments: [{ date: "2026-09-06", memberId: "c1", memberName: "Old Maya name" }] }) };
    return { ok: true, json: async () => ({ tasks: [], escalations: [], date: "2026-09-06", summary: { total: 0, completed: 0 } }) };
  });
  const workspace = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} });
  closeWorkspace = () => workspace.reset(); await workspace.open();
  const controls = () => element("workspace-content").descendants();
  const button = (label: string) => { const found = controls().find(child => child.tagName === "BUTTON" && child.textContent === label); if (!found) throw new Error(`Missing ${label}`); return found; };
  const refresh = async () => {
    await element("workspace-refresh").click();
    await vi.waitFor(() => expect(element("workspace-status").textContent).toMatch(/Checked at/));
  };
  return { identity, request, element, button, controls, refresh, reset: () => workspace.reset(),
    setWriteStatus: (status: number) => { writeStatus = status; },
    setCircleReadStatus: (status: number) => { circleReadStatus = status; },
    posts: () => request.mock.calls.filter(([url, options]) => url === "/api/circle/people" && options?.method === "POST"),
    async navigate(view: string) { location.hash = `#${view}`; events.get("hashchange")?.(); await vi.waitFor(() => expect(element("workspace-status").textContent).toMatch(/Checked at/)); },
    async reviewAddition() { await button("Add someone").click(); element("roster-person-name").value = "Rosa";
      await element("roster-person-name").emit("input"); await button("Review addition").click(); },
  };
}

describe("workspace circle editing integration", () => {
  it.each([{ manageRoster: false, view: "circle" }, { manageRoster: true, view: "today" }])("does not fetch roster editor data outside its authorized Circle view (%j)", async options => {
    const ui = await workspaceFixture(options);
    expect(ui.request.mock.calls.some(([url]) => url === "/api/circle/people")).toBe(false);
    expect(ui.controls().some(element => element.id === "roster-editor-form")).toBe(false);
  });

  it("uses the current member name for duty display without rewriting the assignment", async () => {
    const ui = await workspaceFixture();
    expect(ui.controls().some(element => element.textContent === "Assigned to Maya")).toBe(true);
    expect(ui.controls().some(element => element.textContent === "Assigned to Old Maya name")).toBe(false);
    expect(ui.posts()).toEqual([]);
  });

  it("keeps an uncertain write locked, then clears its draft after same-request retry", async () => {
    const ui = await workspaceFixture(); ui.setWriteStatus(503); await ui.reviewAddition(); await ui.button("Confirm addition").click();
    expect(ui.posts()).toHaveLength(1); expect(ui.element("roster-person-name").disabled).toBe(true);
    expect(ui.element("workspace-retry-write").hidden).toBe(false);
    expect(ui.element("workspace-retry-write").textContent).toBe("Retry the same circle change");
    const firstBody = ui.posts()[0]![1]?.body;
    await ui.button("Confirm addition").click(); expect(ui.posts()).toHaveLength(1);
    ui.setWriteStatus(200); await ui.element("workspace-retry-write").click();
    await vi.waitFor(() => expect(ui.element("workspace-status").textContent).toMatch(/Circle updated/));
    expect(ui.posts()).toHaveLength(2); expect(ui.posts()[1]![1]?.body).toBe(firstBody);
    expect(ui.element("roster-editor-form").hidden).toBe(true); expect(ui.element("roster-person-name").value).toBe("");
    expect(ui.element("workspace-retry-write").hidden).toBe(true);
  });

  it("preserves a rejected duplicate-name draft and keeps the conflict specific to the circle", async () => {
    const ui = await workspaceFixture(); ui.setWriteStatus(409); await ui.reviewAddition(); await ui.button("Confirm addition").click();
    expect(ui.element("workspace-status").textContent).toMatch(/name may already be in the circle/);
    expect(ui.element("roster-person-name").value).toBe("Rosa"); expect(ui.element("roster-person-name").disabled).toBe(false);
    expect(ui.element("workspace-retry-write").hidden).toBe(true);
  });

  it("explains server validation failure without discarding the name draft", async () => {
    const ui = await workspaceFixture(); ui.setWriteStatus(400); await ui.reviewAddition(); await ui.button("Confirm addition").click();
    expect(ui.element("workspace-status").textContent).toBe("Use a name of 1–80 characters without control or directional characters. Your draft is still here.");
    expect(ui.element("roster-person-name").value).toBe("Rosa"); expect(ui.element("roster-person-name").disabled).toBe(false);
    expect(ui.element("workspace-retry-write").hidden).toBe(true);
  });

  it("retains a draft across navigation but clears it when the capability is removed", async () => {
    const ui = await workspaceFixture(); await ui.reviewAddition();
    await ui.navigate("today"); await ui.navigate("circle");
    await vi.waitFor(() => expect(ui.element("roster-person-name").value).toBe("Rosa"));
    ui.identity.permissions.manageRoster = false; await ui.refresh();
    await vi.waitFor(() => expect(ui.controls().some(element => element.id === "roster-editor-form")).toBe(false));
    ui.identity.permissions.manageRoster = true; await ui.refresh();
    await vi.waitFor(() => expect(ui.controls().some(element => element.id === "roster-editor-form")).toBe(true));
    expect(ui.element("roster-editor-form").hidden).toBe(true); expect(ui.element("roster-person-name").value).toBe("");
  });

  it("removes a revoked roster capability even if the next circle read fails", async () => {
    const ui = await workspaceFixture(); await ui.reviewAddition();
    ui.identity.permissions.manageRoster = false; ui.setCircleReadStatus(503);
    await ui.element("workspace-refresh").click();
    await vi.waitFor(() => expect(ui.element("workspace-status").textContent).toMatch(/Could not refresh/));
    expect(ui.controls().some(element => element.id === "roster-editor-form")).toBe(false);
    expect(ui.posts()).toEqual([]);
    ui.identity.permissions.manageRoster = true; ui.setCircleReadStatus(200); await ui.refresh();
    await vi.waitFor(() => expect(ui.controls().some(element => element.id === "roster-editor-form")).toBe(true));
    expect(ui.element("roster-editor-form").hidden).toBe(true);
  });
});
