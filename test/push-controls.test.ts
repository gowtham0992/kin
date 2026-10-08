import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
const { createPushControls } = await import(new URL("../simulator/push-controls.js", import.meta.url).href);
class Element {
  private text = "";
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(" "); }
  set textContent(value: string) { this.text = value; this.children = []; }
  hidden = false; disabled = false; type = ""; className = ""; children: Element[] = [];
  listeners: Record<string, () => Promise<void>> = {};
  constructor(public tag: string) {}
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.text = ""; this.children = []; }
  setAttribute() {}
  addEventListener(name: string, cb: () => Promise<void>) { this.listeners[name] = cb; }
  async click() { if (!this.disabled) await this.listeners.click?.(); }
}
afterEach(() => vi.unstubAllGlobals());
const descendants = (element: Element): Element[] => [element, ...element.children.flatMap(descendants)];
const control = (container: Element, text: string) => descendants(container).find(e => e.tag === "button" && e.textContent === text)!;
const statusOf = (container: Element) => descendants(container).find(e => e.className === "kin-push-status")!;
function fixture(permission = "granted", processing = "unknown", onDuty = false) {
  const requestPermission = vi.fn(async () => permission), unsubscribe = vi.fn(async () => true);
  const json = { endpoint: "https://fcm.googleapis.com/fcm/send/synthetic", keys: { p256dh: "synthetic-key", auth: "synthetic-auth" } };
  const subscription = { endpoint: json.endpoint, unsubscribe, toJSON: () => json };
  const getSubscription = vi.fn(async () => null as typeof subscription | null);
  const subscribe = vi.fn(async () => { getSubscription.mockResolvedValue(subscription); return subscription; });
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("window", { PushManager: {}, Notification: {} });
  vi.stubGlobal("Notification", { requestPermission, permission: "default" });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) } });
  const savedId = createHash("sha256").update(JSON.stringify([json.endpoint, json.keys.p256dh, json.keys.auth])).digest("hex");
  let enrollment: { state: string; id: string | null } = { state: "none", id: null };
  const request = vi.fn(async (_url?: string, options?: any): Promise<any> => {
    if (options?.method === "POST") enrollment = { state: "saved", id: savedId };
    if (options?.method === "DELETE") enrollment = { state: "disabled", id: null };
    return { ok: true, json: async () => ({ enrollment, duty: { assigned: onDuty, onDuty }, delivery: "unverified", automaticFollowUps: { state: processing } }) };
  });
  const container = new Element("section");
  const controls = createPushControls({ container, request });
  const config = { publicKey: Buffer.alloc(65, 1).toString("base64url"), consentVersion: "test-version" };
  const ready = controls.open(config);
  return { controls, request, requestPermission, subscribe, unsubscribe, getSubscription, subscription,
    ready, config, savedId, setEnrollment: (value: typeof enrollment) => { enrollment = value; },
    enable: control(container, "Enable on this phone"), disable: control(container, "Turn off on this phone"), status: statusOf(container), container };
}
describe("explicit phone opt-in", () => {
  it.each(["off", "unknown", "configured"])("keeps %s processing separate from a connected on-duty phone", async state => {
    const ui = fixture("granted", state, true); await ui.ready;
    ui.getSubscription.mockResolvedValue(ui.subscription); ui.setEnrollment({ state: "saved", id: ui.savedId });
    await ui.controls.open(ui.config);
    const text = statusOf(ui.container).textContent;
    expect(text).toContain("This phone is connected to this account.");
    expect(text).toContain("You are on duty right now.");
    expect(text).toContain("Automatic delivery has not been verified.");
    expect(text).toContain(state === "off" ? "configured off" : state === "configured" ? "configured on" : "could not verify whether");
    expect(ui.request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    expect(ui.subscribe).not.toHaveBeenCalled();
    expect(ui.requestPermission).not.toHaveBeenCalled();
  });
  it("does nothing until the caregiver chooses Enable", async () => {
    const ui = fixture(); await ui.ready;
    expect(ui.requestPermission).not.toHaveBeenCalled();
    expect(ui.request.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    ui.request.mockClear();
    await ui.enable.click();
    expect(ui.requestPermission).toHaveBeenCalledOnce(); expect(ui.subscribe).toHaveBeenCalledOnce();
    const call = ui.request.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(call[1].body)).toMatchObject({ consent: true, consentVersion: "test-version" });
    expect(ui.status.textContent).toContain("No test notification was sent");
    expect(ui.unsubscribe).not.toHaveBeenCalled();
  });
  it("honors denied permission without saving or subscribing", async () => {
    const ui = fixture("denied"); await ui.ready; ui.request.mockClear(); await ui.enable.click();
    expect(ui.subscribe).not.toHaveBeenCalled(); expect(ui.request).not.toHaveBeenCalled();
    expect(ui.status.textContent).toContain("not enabled"); expect(ui.enable.disabled).toBe(false);
  });
  it("preserves a newly created subscription after an uncertain save and retries the same subscription", async () => {
    const ui = fixture(); await ui.ready;
    ui.request.mockRejectedValueOnce(new Error("response lost")); await ui.enable.click();
    expect(ui.unsubscribe).not.toHaveBeenCalled();
    expect(ui.status.textContent).toContain("could not verify");
    await ui.enable.click();
    expect(ui.subscribe).toHaveBeenCalledOnce();
    const bodies = ui.request.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => options.body);
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
  });
  it("reuses this account's working subscription instead of unsubscribing during re-enable", async () => {
    const ui = fixture(); await ui.ready;
    ui.getSubscription.mockResolvedValue(ui.subscription); ui.setEnrollment({ state: "saved", id: ui.savedId });
    await ui.controls.open(ui.config);
    ui.request.mockRejectedValueOnce(new Error("offline")); await control(ui.container, "Reconnect this phone").click();
    expect(ui.unsubscribe).not.toHaveBeenCalled(); expect(ui.subscribe).not.toHaveBeenCalled();
  });
  it("clears the retry state when readback verifies the pending connection", async () => {
    const ui = fixture(); await ui.ready;
    ui.request.mockRejectedValueOnce(new Error("lost save response")); await ui.enable.click();
    expect(ui.enable.textContent).toBe("Retry connection");
    ui.setEnrollment({ state: "saved", id: ui.savedId });
    ui.request.mockClear();
    await control(ui.container, "Check connection").click();
    expect(ui.status.textContent).toContain("This phone is connected");
    expect(ui.enable.textContent).toBe("Reconnect this phone");
    expect(ui.request.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
    expect(ui.unsubscribe).not.toHaveBeenCalled();
  });
  it("does not silently reuse or delete an existing connection that is not bound to this account", async () => {
    const ui = fixture(); await ui.ready;
    ui.getSubscription.mockResolvedValue(ui.subscription);
    await ui.controls.open(ui.config); await control(ui.container, "Enable on this phone").click();
    expect(ui.unsubscribe).not.toHaveBeenCalled(); expect(ui.subscribe).not.toHaveBeenCalled();
    expect(ui.request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(statusOf(ui.container).textContent).toContain("Turn off");
  });
  it("shows verified enrollment separately from missing duty and unknown automatic delivery", async () => {
    const ui = fixture(); await ui.ready;
    ui.getSubscription.mockResolvedValue(ui.subscription); ui.setEnrollment({ state: "saved", id: ui.savedId });
    await ui.controls.open(ui.config);
    const text = statusOf(ui.container).textContent;
    expect(text).toContain("connected to this account"); expect(text).toContain("No one is on duty");
    expect(text).toContain("Automatic delivery has not been verified");
    expect(descendants(statusOf(ui.container)).filter(e => e.tag === "dt").map(e => e.textContent)).toEqual(["This phone", "Your turn", "Automatic follow-ups", "Delivery"]);
    expect(ui.container.children[0]!.children[1]!.textContent).toContain("Connecting a phone does not activate automatic follow-ups");
    expect(ui.container.children[0]!.children[1]!.textContent).toContain("Check Today directly");
  });
  it("does not enroll after the account changes while permission is pending", async () => {
    const ui = fixture(); await ui.ready; ui.request.mockClear(); let resolve!: (value: string) => void;
    ui.requestPermission.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = ui.enable.click(); ui.controls.reset(); resolve("granted"); await pending;
    expect(ui.request).not.toHaveBeenCalled(); expect(ui.subscribe).not.toHaveBeenCalled();
    expect(ui.container.hidden).toBe(true);
  });
  it("removes the server destination and browser subscription only on explicit disable", async () => {
    const ui = fixture(); await ui.ready; ui.getSubscription.mockResolvedValue(ui.subscription); await ui.disable.click();
    expect(ui.requestPermission).not.toHaveBeenCalled();
    expect(ui.request).toHaveBeenCalledWith("/api/push/subscription", expect.objectContaining({ method: "DELETE" }));
    expect(ui.unsubscribe).toHaveBeenCalledOnce(); expect(ui.status.textContent).toContain("off on this phone");
  });
});

it("renders fixed notification copy and opens only the signed-in workspace, never a payload URL", async () => {
  const events: Record<string, (event: any) => void> = {}, showNotification = vi.fn(async (_title: string, _options: unknown) => {}), openWindow = vi.fn(async () => {});
  runInNewContext(readFileSync(new URL("../simulator/kin-sw.js", import.meta.url), "utf8"), {
    URL, self: { location: { origin: "https://kin.example" }, registration: { showNotification },
      clients: { matchAll: async () => [], openWindow }, addEventListener: (name: string, cb: (event: any) => void) => { events[name] = cb; } },
  });
  let pending!: Promise<void>;
  events.push!({ data: { json: () => ({ version: 1, tag: "a".repeat(32), title: "PRIVATE", body: "PRIVATE", url: "https://evil.example" }) }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
  await pending; expect(JSON.stringify(showNotification.mock.calls)).not.toMatch(/PRIVATE|evil/);
  expect(showNotification.mock.calls[0]![0]).toBe("Kin · Family follow-up");
  events.notificationclick!({ notification: { close() {}, data: { path: "https://evil.example" } }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
  await pending; expect(openWindow).toHaveBeenCalledExactlyOnceWith("https://kin.example/invite.html#today");
});
