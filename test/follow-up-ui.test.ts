import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodaySnapshot } from "../src/domain.js";

const { transport } = vi.hoisted(() => ({ transport: { today: vi.fn() } }));
vi.mock("../simulator/mcp-client.js", () => ({ createMcpCareClient: () => transport }));

// Only browser DOM and the transport boundary are synthetic; both shipped renderers run unchanged.
class Element {
  tagName: string;
  private ownText = "";
  id = ""; className = ""; hidden = false; disabled = false; value = ""; type = "";
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  children: Element[] = [];
  selectors = new Map<string, Element>();
  classList = { add: (name: string) => { this.className += ` ${name}`; }, remove() {}, toggle() {} };
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return [this.ownText, ...this.children.map(child => child.textContent)].filter(Boolean).join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.ownText = ""; this.children = children; }
  get childElementCount() { return this.children.length; }
  addEventListener() {} setAttribute() {} removeAttribute() {} focus() {}
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll() { return this.descendants().filter(child => ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(child.tagName)); }
  querySelector(selector: string) {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Element());
    return this.selectors.get(selector)!;
  }
}

let closeWorkspace: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); transport.today.mockReset(); });
afterEach(() => { closeWorkspace?.(); closeWorkspace = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function browser() {
  const elements = new Map<string, Element>();
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  vi.stubGlobal("document", { getElementById: (id: string) => get(`#${id}`), createElement: (tag: string) => new Element(tag),
    querySelector: get, querySelectorAll: () => [], addEventListener() {}, hidden: false, visibilityState: "visible" });
  vi.stubGlobal("window", { addEventListener() {}, setInterval });
  vi.stubGlobal("location", { hash: "#today", origin: "http://127.0.0.1" });
  vi.stubGlobal("history", { replaceState() {} });
  get("#week-view").hidden = true; get("#circle-view").hidden = true;
  return get;
}

function snapshot(): TodaySnapshot {
  return { date: "2026-09-08", tasks: [{ id: "water", title: "Drink a glass of water", state: "scheduled", dueAt: "2026-09-08T15:00:00.000Z",
    lastResponse: "not_yet", confirmedBy: "Evelyn", confirmedAt: "2026-09-08T15:20:00.000Z" }],
    onDuty: null, summary: { completed: 0, total: 1, remaining: 1, skipped: 0 }, escalations: [{ id: "follow-water", taskId: "water",
      dueAt: "2026-09-08T15:00:00.000Z", updatedAt: "2026-09-08T15:50:00.000Z", status: "sent", recipientMemberName: "Maya" }] };
}
const timestamp = (iso: string) => new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(iso));

async function workspace(data: TodaySnapshot) {
  const get = browser();
  const { createWorkspace } = await import(new URL("../simulator/workspace.js", import.meta.url).href);
  const request = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/api/session"
    ? { name: "Maya", role: "caregiver", permissions: { confirm: true, manageDuty: true, invite: false } } : data }));
  const ui = createWorkspace({ request, onAccessLost: vi.fn(), onInvite() {}, onLeaveInvite() {} });
  closeWorkspace = () => ui.reset(); await ui.open();
  return get("#workspace-content");
}
async function simulator(data: TodaySnapshot) {
  const get = browser(); transport.today.mockResolvedValue(data);
  await import(new URL("../simulator/app.js", import.meta.url).href);
  await vi.waitFor(() => expect(get("#sync-label").textContent).toContain("Checked just now"));
  return get;
}

describe("family follow-up UI", () => {
  it("distinguishes provider acceptance needing operator review from delivery or retry", async () => {
    const data = snapshot(); Object.assign(data.escalations[0]!, { status: "receipt_pending" });
    const content = await workspace(data);
    expect(content.textContent).toContain("Provider accepted; receipt needs review");
    expect(content.textContent).toContain("operator needs to reconcile");
    expect(content.textContent).toContain("does not prove phone delivery");
    expect(content.textContent).toContain("will not automatically resend");
    expect(content.textContent).not.toContain("Notification not confirmed");
  });

  it("keeps a parent's Not yet separate from an absent caregiver acknowledgment", async () => {
    const content = await workspace(snapshot());
    expect(content.textContent).toContain("Not yet");
    expect(content.textContent).toContain("No caregiver acknowledgment recorded.");
    expect(content.textContent).not.toContain("someone has responded");
    expect(content.textContent.toLowerCase()).not.toContain("missed");
  });

  it("shows a prior-day unresolved alert's due date and time without inventing a task response", async () => {
    const data = snapshot(); data.escalations[0]!.taskId = "older-task"; data.escalations[0]!.dueAt = "2026-09-07T23:30:00.000Z";
    const content = await workspace(data);
    expect(content.textContent).toContain(`Check-in · Due ${timestamp(data.escalations[0]!.dueAt)}`);
    expect(content.textContent).toContain("Acknowledge follow-up");
    expect(content.textContent).not.toContain("Missed check-in");
  });

  it("states an existing caregiver acknowledgment without changing the parent's Not yet", async () => {
    const data = snapshot(); Object.assign(data.escalations[0]!, { acknowledgedBy: "Theo", acknowledgedAt: "2026-09-08T16:00:00.000Z" });
    const content = await workspace(data);
    expect(content.textContent).toContain(`Theo acknowledged the follow-up at ${timestamp("2026-09-08T16:00:00.000Z")}`);
    expect(content.textContent).toContain("Not yet");
    expect(content.textContent).toContain("The check-in itself is unchanged.");
    expect(content.textContent).not.toContain("No caregiver acknowledgment recorded.");
    expect(content.descendants().some(child => child.tagName === "BUTTON" && child.textContent === "Acknowledge follow-up")).toBe(false);
  });
});

describe("simulator follow-up UI", () => {
  it("holds a known accepted alert for receipt review without promising an automatic resend", async () => {
    const data = snapshot(); data.escalations[0]!.status = "receipt_pending";
    const get = await simulator(data);
    const text = get("#escalation-card").querySelector("strong").textContent;
    expect(text).toContain("receipt needs review");
    expect(text).toContain("not automatically resend");
    expect(text).not.toContain("Kin will retry");
  });
  it.each(["blocked", "failed", "sent"] as const)("keeps a Not yet check-in actionable after a %s follow-up", async status => {
    const data = snapshot(); data.escalations[0]!.status = status;
    const get = await simulator(data);
    expect(get("#echo-actions").hidden).toBe(false);
    expect(get("#echo-actions").dataset.taskId).toBe("water");
    expect(get("#echo-task").textContent).toContain("Reply: Not yet · Due");
    expect(get("#echo-task").textContent).toContain("Drink a glass of water");
    expect(get("#echo-task").textContent).not.toContain("All done");
    expect(get("#echo-task").textContent).not.toContain("Coming up");
  });

  it("does not present an empty plan as completed care", async () => {
    const data = snapshot(); data.tasks = []; data.escalations = []; data.summary = { completed: 0, total: 0, remaining: 0, skipped: 0 };
    const get = await simulator(data);
    expect(get("#echo-task").textContent).toContain("No check-ins scheduled");
    expect(get("#echo-task").textContent).not.toContain("All done");
    expect(get("#echo-actions").hidden).toBe(true);
    expect(get("#voice-line").textContent).toContain("There are no check-ins in today’s shared plan.");
  });

  it("does not replace a parent's Not yet with missed when a follow-up exists", async () => {
    const get = await simulator(snapshot());
    expect(get("#phone-tasks").textContent).toContain("Not yet");
    expect(get("#phone-tasks").textContent.toLowerCase()).not.toContain("missed");
    expect(get("#escalation-card").querySelector("p").textContent).toContain(`Due ${timestamp(snapshot().escalations[0]!.dueAt)}`);
    expect(get("#escalation-card").querySelector("strong").textContent).toContain("No caregiver acknowledgment recorded.");
  });

  it("labels an earlier alert explicitly and reports a recorded acknowledgment truthfully", async () => {
    const data = snapshot(); Object.assign(data.escalations[0]!, { taskId: "older-task", dueAt: "2026-09-07T23:30:00.000Z", acknowledgedBy: "Theo", acknowledgedAt: "2026-09-08T16:00:00.000Z" });
    const get = await simulator(data);
    expect(get("#escalation-card").querySelector("p").textContent).toContain(timestamp("2026-09-07T23:30:00.000Z"));
    expect(get("#escalation-card").querySelector("strong").textContent).toContain("Theo acknowledged the follow-up.");
    expect(get("#escalation-card").querySelector("strong").textContent).not.toContain("No caregiver acknowledgment recorded.");
  });
});
