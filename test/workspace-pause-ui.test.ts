import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { renderPlanPause, validPauseProposal } = await import(new URL("../simulator/plan-pause.js", import.meta.url).href);
class Element {
  tagName: string; children: Element[] = []; hidden = false; disabled = false; checked = false; type = ""; private own = "";
  listeners = new Map<string, (() => unknown)[]>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(text: string) { this.own = text; this.children = []; }
  get textContent(): string { return [this.own, ...this.children.map(child => child.textContent)].join(" "); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; this.own = ""; }
  setAttribute() {} focus() {}
  addEventListener(name: string, action: () => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], action]); }
  async click() { if (!this.disabled) await Promise.all((this.listeners.get("click") ?? []).map(action => action())); }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const now = Date.parse("2026-09-13T15:00:00.000Z");
const proposal = { startsAt: new Date(now).toISOString(), endsAt: "2026-09-20T15:00:00.000Z", expiresAt: "2026-09-13T15:05:00.000Z",
  durationHours: 168, timeZone: "America/Denver", reviewToken: "a".repeat(64), tasks: [{ id: "call", title: "A call <not markup>", dueAt: "2026-09-14T17:00:00.000Z" }], nextTask: null };
let destroy: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) }); });
afterEach(() => { destroy?.(); destroy = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(options: Record<string, unknown> = {}) {
  const propose = vi.fn(async () => ({ control: { version: 0 }, proposal })), onSave = vi.fn(), onError = vi.fn();
  const ui = renderPlanPause({ control: { version: 0 }, enabled: true, propose, onSave, onError, isLocked: () => false, ...options }); destroy = ui.destroy;
  const all = () => (ui.element as Element).descendants();
  const button = (text: string) => all().find(element => element.tagName === "BUTTON" && element.textContent.trim() === text)!;
  return { ui, propose, onSave, onError, all, button, consent: () => all().find(element => element.type === "checkbox")! };
}
describe("exact week-long pause review", () => {
  it("does not read or write automatically, then requires consent after showing exact dates, count, and reminder limits", async () => {
    const page = fixture(); expect(page.propose).not.toHaveBeenCalled(); expect(page.onSave).not.toHaveBeenCalled();
    await page.button("Review seven-day cancellation").click();
    const text = page.ui.element.textContent;
    expect(text).toContain("exactly 168 hours"); expect(text).toContain("America/Denver"); expect(text).toContain("Sep 13, 2026"); expect(text).toContain("Sep 20, 2026");
    expect(text).toContain("A call <not markup>"); expect(text).toContain("1 future unanswered check-in"); expect(text).toContain("No unanswered check-in remains");
    expect(text).toContain("nothing catches up or renews"); expect(text).toContain("does not retract queued caregiver alerts or create reminders");
    await page.button("Confirm seven-day cancellation").click(); expect(page.onSave).not.toHaveBeenCalled();
    page.consent().checked = true; await page.button("Confirm seven-day cancellation").click();
    expect(page.onSave).toHaveBeenCalledExactlyOnceWith(proposal); expect(page.consent().checked).toBe(false);
    await page.button("Confirm seven-day cancellation").click(); expect(page.onSave).toHaveBeenCalledOnce();
  });
  it("expires a review and needs a fresh proposal even when consent was checked", async () => {
    const page = fixture(); await page.button("Review seven-day cancellation").click(); page.consent().checked = true;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(page.consent().checked).toBe(false); expect(page.button("Confirm seven-day cancellation").disabled).toBe(true);
    expect(page.ui.element.textContent).toContain("review expired"); expect(page.onSave).not.toHaveBeenCalled();
  });
  it("discards a delayed proposal when its view is destroyed", async () => {
    let release!: (value: unknown) => void;
    const page = fixture({ propose: () => new Promise(resolve => { release = resolve; }) });
    const opening = page.button("Review seven-day cancellation").click(); expect(page.ui.loading).toBe(true); page.ui.destroy();
    release({ control: { version: 0 }, proposal }); await opening;
    expect(page.consent()).toBeUndefined(); expect(page.onSave).not.toHaveBeenCalled();
  });
  it("keeps the current pause visible with writes disabled and shows no new confirmation", () => {
    const page = fixture({ enabled: false, control: { version: 1, pause: { startsAt: proposal.startsAt, endsAt: proposal.endsAt } } });
    expect(page.ui.element.textContent).toContain("New check-ins are blocked from"); expect(page.button("Review seven-day cancellation")).toBeUndefined();
    expect(page.propose).not.toHaveBeenCalled();
  });
  it("offers no pause action when capability is absent", () => {
    const page = fixture({ enabled: false }); expect(page.button("Review seven-day cancellation")).toBeUndefined();
  });
  it("reviews an empty interval without pretending that check-ins were cancelled", async () => {
    const page = fixture({ propose: async () => ({ control: { version: 0 }, proposal: { ...proposal, tasks: [] } }) });
    await page.button("Review seven-day cancellation").click(); expect(page.ui.element.textContent).toContain("No existing check-ins will be cancelled");
  });
  it.each([409, 404, 503])("recovers proposal status %s with a retry action and no write", async status => {
    const page = fixture({ propose: async () => { throw Object.assign(new Error("No proposal"), { status }); } });
    await page.button("Review seven-day cancellation").click(); expect(page.button("Review seven-day cancellation").disabled).toBe(false);
    expect(page.consent()).toBeUndefined(); expect(page.onSave).not.toHaveBeenCalled();
  });
  it("leaves the plan unchanged when the user cancels a review", async () => {
    const page = fixture(); await page.button("Review seven-day cancellation").click(); page.consent().checked = true;
    await page.button("Keep the plan unchanged").click(); expect(page.consent()).toBeUndefined(); expect(page.onSave).not.toHaveBeenCalled();
  });
  it.each([{ tasks: [null] }, { tasks: [...proposal.tasks, ...proposal.tasks] }, { durationHours: 167 }, { timeZone: "Not/AZone" }])("rejects malformed review %j", patch => {
    expect(validPauseProposal({ ...proposal, ...patch })).toBe(false);
  });
});
