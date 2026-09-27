import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCareStore, type CareTask } from "../src/domain.js";
import { WeeklyBriefService } from "../src/weekly-brief.js";
const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);

class Element {
  tagName: string; id = ""; hidden = false; disabled = false; open = false; focused = false; scrolled = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>(); children: Element[] = []; private ownText = "";
  listeners = new Map<string, Array<() => unknown>>(); classList = { add() {}, remove() {} };
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  get childElementCount() { return this.children.length; }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  addEventListener(name: string, action: () => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  focus() { this.focused = true; } scrollIntoView() { this.scrolled = true; }
  async click() { if (!this.disabled) await Promise.all((this.listeners.get("click") ?? []).map(action => action())); }
}

let reset: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T17:00:00Z")); });
afterEach(() => { reset?.(); reset = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function brief() {
  return { period: { startDate: "2026-09-02", endDate: "2026-09-08" }, headline: "One recorded check-in",
    overview: "One check-in and one family follow-up.", overviewEvidenceIds: ["task:water:2026-09-08T15:00:00.000Z", "escalation:water"],
    stats: { completed: 1, skipped: 0, stillOpen: 0 }, generatedBy: "deterministic", safetyNotice: "Not medical advice.",
    highlights: [{ text: "The water check-in was completed.", evidenceIds: ["task:water:2026-09-08T15:00:00.000Z"] }],
    followUps: [{ text: "Ask a caregiver to acknowledge the follow-up.", evidenceIds: ["escalation:water"] }],
    evidence: [{ id: "task:water:2026-09-08T15:00:00.000Z", kind: "care_task", occurredAt: "2026-09-08T15:00:00.000Z", fact: "Drink a glass of water was completed." },
      { id: "escalation:water", kind: "escalation", occurredAt: "2026-09-08T15:00:00.000Z", fact: "A family follow-up was sent to the on-duty caregiver." }] };
}

async function fixture(data = brief()) {
  const ids = new Map<string, Element>();
  const root = (id: string) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id)!; };
  const content = root("workspace-content"), events = new Map<string, () => void>();
  const get = (id: string) => content.descendants().find(element => element.id === id) ?? root(id);
  vi.stubGlobal("document", { getElementById: get, createElement: (tag: string) => new Element(tag), querySelector: () => root("main"), querySelectorAll: () => [], addEventListener() {}, hidden: false });
  const print = vi.fn();
  vi.stubGlobal("window", { addEventListener: (name: string, action: () => void) => events.set(name, action), print });
  vi.stubGlobal("location", { hash: "#week" });
  const request = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/session"
    ? { name: "Theo", role: "caregiver", permissions: { confirm: true, manageDuty: true, invite: false } } : structuredClone(data) }));
  const workspace = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} }); reset = workspace.reset;
  await workspace.open();
  return { content, get, print, workspace, emit: (event: string) => events.get(event)?.(),
    details: () => content.descendants().find(element => element.tagName === "DETAILS" && element.children[0]?.textContent.startsWith("Based on "))!,
    sourceButtons: () => content.descendants().filter(element => element.tagName === "BUTTON" && element.textContent.startsWith("Source ")) };
}

it("includes unanswered closures in the visible weekly count line", async () => {
  const data = brief();
  Object.assign(data.stats, { closedUnanswered: 1 });
  const ui = await fixture(data);
  expect(ui.content.textContent).toContain("1 completed · 0 skipped · 0 still open · 1 closed without a reply");
});

describe("weekly source evidence and visit notes", () => {
  it("puts conversation follow-ups before retrospective highlights without losing their evidence", async () => {
    const ui = await fixture();
    const sections = ui.content.descendants().filter(element => element.tagName === "SECTION" && element.children[0]?.tagName === "H3");
    expect(sections.slice(0, 2).map(section => section.children[0]!.textContent))
      .toEqual(["For your next conversation", "What stood out"]);
    expect(sections[0]!.textContent).toContain("Ask a caregiver to acknowledge the follow-up.");
    const citation = sections[0]!.descendants().find(element => element.tagName === "BUTTON" && element.textContent === "Source 2")!;
    await citation.click();
    expect(ui.get("brief-source-2").focused).toBe(true);
    expect(ui.details().open).toBe(true);
  });

  it("returns to the exact citation most recently followed, including repeated references to the same source", async () => {
    const ui = await fixture();
    const links = ui.sourceButtons().filter(link => link.textContent === "Source 1");
    expect(links).toHaveLength(2);
    for (const link of links) {
      for (const other of links) { other.focused = false; other.scrolled = false; }
      await link.click();
      const back = ui.get("brief-source-1").descendants().find(element => element.tagName === "BUTTON" && element.textContent === "Back to summary");
      expect(back).toBeDefined(); await back!.click();
      expect(link.focused).toBe(true); expect(link.scrolled).toBe(true);
      expect(links.filter(other => other !== link).every(other => !other.focused)).toBe(true);
      expect(ui.details().open).toBe(true);
      expect(location.hash).toBe("#week");
    }
  });
  it("returns to the weekly heading when evidence was opened without following a citation", async () => {
    const ui = await fixture(); ui.details().open = true;
    const heading = ui.content.descendants().find(element => element.tagName === "H2")!;
    const back = ui.get("brief-source-2").descendants().find(element => element.tagName === "BUTTON" && element.textContent === "Back to summary");
    expect(back).toBeDefined(); await back!.click();
    expect(heading.attributes.get("tabindex")).toBe("-1");
    expect(heading.focused).toBe(true); expect(heading.scrolled).toBe(true);
  });

  it("groups long citation lists without losing, duplicating or inventing sources", async () => {
    const data = brief();
    data.evidence = Array.from({ length: 5 }, (_, index) => ({ ...data.evidence[0]!, id: `record-${index}`, fact: `Recorded fact ${index}` }));
    data.overviewEvidenceIds = [...data.evidence.map(fact => fact.id), "record-0", "missing"];
    data.highlights = []; data.followUps = [];
    const ui = await fixture(data);
    const group = ui.content.descendants().find(element => element.tagName === "DETAILS" && element.children[0]?.textContent === "View 5 sources");
    expect(group).toBeDefined(); expect(group!.open).toBe(false);
    expect(group!.descendants().filter(element => element.tagName === "BUTTON").map(element => element.textContent))
      .toEqual(["Source 1", "Source 2", "Source 3", "Source 4", "Source 5"]);
    expect(group!.textContent).not.toContain("unavailable");
    expect(ui.content.textContent).toContain("A source for this point is unavailable.");
    await ui.sourceButtons()[4]!.click();
    expect(ui.details().open).toBe(true); expect(ui.get("brief-source-5").focused).toBe(true);
  });

  it("expands every citation group for printing and restores each reader choice afterward and on reset", async () => {
    const data = brief();
    data.evidence = Array.from({ length: 4 }, (_, index) => ({ ...data.evidence[0]!, id: `record-${index}` }));
    data.overviewEvidenceIds = data.evidence.map(fact => fact.id);
    data.highlights[0]!.evidenceIds = [...data.overviewEvidenceIds]; data.followUps = [];
    const ui = await fixture(data);
    const groups = ui.content.descendants().filter(element => element.tagName === "DETAILS" && element.children[0]?.textContent === "View 4 sources");
    expect(groups).toHaveLength(2); groups[1]!.open = true;
    ui.emit("beforeprint"); ui.emit("beforeprint");
    expect(groups.map(group => group.open)).toEqual([true, true]); expect(ui.details().open).toBe(true);
    ui.emit("afterprint"); expect(groups.map(group => group.open)).toEqual([false, true]); expect(ui.details().open).toBe(false);
    ui.emit("beforeprint"); ui.workspace.reset(); ui.emit("afterprint");
    expect(groups.map(group => group.open)).toEqual([false, true]); expect(ui.content.childElementCount).toBe(0);
  });

  it("keeps short citation lists directly available without another disclosure", async () => {
    const ui = await fixture();
    expect(ui.content.descendants().filter(element => element.tagName === "DETAILS")).toEqual([ui.details()]);
    expect(ui.sourceButtons()).toHaveLength(4);
  });
  it("renders complete overview and completion citations from the real service when only the ninth task is done", async () => {
    const asOf = new Date("2026-09-08T17:00:00.000Z");
    const tasks: CareTask[] = Array.from({ length: 9 }, (_, index) => ({
      id: `synthetic-check-in-${index + 1}`, title: `Synthetic check-in ${index + 1}`,
      dueAt: `2026-09-08T08:${String(index).padStart(2, "0")}:00.000Z`,
      state: index === 8 ? "done" : "scheduled", lastResponse: index === 8 ? "done" : null,
      confirmedAt: index === 8 ? asOf.toISOString() : null,
      confirmedBy: index === 8 ? "Synthetic account" : null,
    }));
    const data = await new WeeklyBriefService(new InMemoryCareStore(tasks, () => asOf)).create(asOf);
    const ui = await fixture(data);
    const overview = ui.content.children.find(element => element.textContent.includes(data.overview));
    const completion = ui.content.descendants().find(element => element.tagName === "LI" &&
      element.textContent.startsWith("1 of 9 recorded care tasks were completed."));
    expect(overview).toBeDefined(); expect(completion).toBeDefined();
    expect(ui.content.textContent).toContain("1 completed, 8 still open");
    expect(ui.details().children[0]?.textContent).toBe("Based on 9 recorded events");

    for (const group of [overview!, completion!]) {
      const buttons = group.descendants().filter(element => element.tagName === "BUTTON" && element.attributes.has("aria-controls"));
      expect(buttons.map(button => button.textContent)).toEqual(tasks.map((_, index) => `Source ${index + 1}`));
      for (const [index, button] of buttons.entries()) {
        const target = `brief-source-${index + 1}`, record = tasks[index]!;
        const source = ui.get(target);
        expect(button.attributes.get("aria-controls")).toBe(target);
        expect(source.children.find(element => element.tagName === "CODE")?.textContent).toBe(`task:${record.id}:${record.dueAt}`);
        expect(source.textContent).toContain(`${record.title} was ${index === 8 ? "completed" : "still open"}.`);
        for (const sourceIndex of tasks.keys()) {
          ui.get(`brief-source-${sourceIndex + 1}`).focused = false;
          ui.get(`brief-source-${sourceIndex + 1}`).scrolled = false;
        }
        ui.details().open = false;
        await button.click();
        expect(ui.details().open).toBe(true); expect(source.focused).toBe(true); expect(source.scrolled).toBe(true);
        expect(location.hash).toBe("#week");
      }
    }
  });

  it("renders source-linked responsibility facts without computing a delivery or effort score", async () => {
    const data = Object.assign(brief(), { responsibility: { points: [{ text: "Follow-ups routed: Theo 1.", evidenceIds: ["escalation:water"] }],
      notice: "Routing does not confirm delivery or measure caregiving effort." } });
    const ui = await fixture(data);
    expect(ui.content.textContent).toContain("Sharing the follow-up");
    expect(ui.content.textContent).toContain("Follow-ups routed: Theo 1.");
    expect(ui.content.textContent).toContain(data.responsibility.notice);
    expect(ui.sourceButtons()).toHaveLength(5);
  });
  it("uses correct number agreement for zero, one, and multiple source records", async () => {
    for (const count of [0, 1, 2]) {
      const data = brief(); data.evidence = data.evidence.slice(0, count);
      const ui = await fixture(data);
      expect(ui.details().textContent).toContain(`Based on ${count} recorded ${count === 1 ? "event" : "events"}`);
      expect(ui.details().children[0]?.textContent).toBe(`Based on ${count} recorded ${count === 1 ? "event" : "events"}`);
      ui.workspace.reset();
    }
  });

  it("maps every displayed observation to its real evidence and associated due date", async () => {
    const ui = await fixture();
    expect(ui.sourceButtons().map(button => button.textContent)).toEqual(["Source 1", "Source 2", "Source 2", "Source 1"]);
    const source = ui.get("brief-source-1");
    expect(source.textContent).toContain("Drink a glass of water was completed.");
    expect(source.textContent).toContain("task:water:2026-09-08T15:00:00.000Z");
    expect(source.textContent).toContain(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date("2026-09-08T15:00:00.000Z")));
    expect(source.textContent).toContain("Check-in due");
    expect(ui.get("brief-source-2").textContent).toContain("Related check-in due");
  });

  it("opens and focuses the referenced source without leaving the Week view", async () => {
    const ui = await fixture(); const link = ui.sourceButtons()[1]; expect(link).toBeDefined();
    await link!.click();
    expect(ui.details().open).toBe(true); expect(ui.get("brief-source-2").focused).toBe(true);
    expect(ui.get("brief-source-2").scrolled).toBe(true); expect(location.hash).toBe("#week");
    expect(link!.attributes.get("aria-controls")).toBe("brief-source-2");
  });

  it("includes closed evidence in browser printing and restores the collapsed view afterward", async () => {
    const ui = await fixture(); expect(ui.details().open).toBe(false);
    ui.emit("beforeprint"); expect(ui.details().open).toBe(true);
    ui.emit("beforeprint"); ui.emit("afterprint"); expect(ui.details().open).toBe(false);
    const printButton = ui.content.descendants().find(element => element.textContent === "Print visit notes")!;
    await printButton.click(); expect(ui.print).toHaveBeenCalledOnce();
  });

  it("keeps an intentionally expanded source list open after printing", async () => {
    const ui = await fixture(); ui.details().open = true;
    ui.emit("beforeprint"); ui.emit("afterprint"); expect(ui.details().open).toBe(true);
    ui.details().open = false; ui.emit("beforeprint"); expect(ui.details().open).toBe(true);
    ui.emit("afterprint"); expect(ui.details().open).toBe(false);
  });

  it("clears print references on session closure so old family evidence cannot reappear", async () => {
    const ui = await fixture(), evidence = ui.details(); ui.emit("beforeprint"); expect(evidence.open).toBe(true);
    ui.workspace.reset(); expect(evidence.open).toBe(false); expect(ui.content.childElementCount).toBe(0);
    ui.emit("beforeprint"); ui.emit("afterprint"); expect(ui.content.childElementCount).toBe(0); expect(evidence.open).toBe(false);
  });

  it("does not invent destinations for unknown evidence IDs", async () => {
    const data = brief(); data.highlights[0]!.evidenceIds = ["missing-source"];
    const ui = await fixture(data);
    expect(ui.sourceButtons()).toHaveLength(3);
    expect(ui.content.textContent).toContain("A source for this point is unavailable.");
  });

  it("explains an empty source list without fabricated observations", async () => {
    const data = brief(); data.evidence = []; data.highlights = []; data.followUps = []; data.overviewEvidenceIds = [];
    const ui = await fixture(data); expect(ui.sourceButtons()).toHaveLength(0);
    expect(ui.details().textContent).toContain("No source records were returned for this period.");
  });
});
