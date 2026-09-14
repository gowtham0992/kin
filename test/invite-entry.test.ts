import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

const workspace = vi.hoisted(() => ({ open: vi.fn(async () => {}), reset: vi.fn(),
  onAccessLost: undefined as ((status: number, pending?: { outcomeUnknown: boolean; requestId: string }) => void) | undefined }));
vi.mock("../simulator/workspace.js", () => ({ createWorkspace: (options: { onAccessLost: typeof workspace.onAccessLost }) => { workspace.onAccessLost = options.onAccessLost; return workspace; } }));
const { createBrowserAuth } = await import(new URL("../simulator/browser-auth.js", import.meta.url).href);
const origin = "https://kin.example";
const config = { clientId: "kin-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp` };

class Element {
  hidden = true; disabled = false; textContent = "";
  reset() {}
  listeners = new Map<string, () => Promise<void>>();
  addEventListener(name: string, listener: () => Promise<void>) { this.listeners.set(name, listener); }
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.spyOn(Date, "now").mockReturnValue(1_000_000); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(options: { view?: string; callback?: boolean; invalidState?: boolean; callbackHash?: string; tokenResponse?: Promise<Response> } = {}) {
  const data = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => data.set(key, value), getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => data.delete(key) };
  const cryptoApi = { subtle: webcrypto.subtle, getRandomValues: (array: Uint8Array) => array.fill(1) };
  let currentUrl = new URL(`${config.redirectUri}#${options.view ?? "today"}`);
  if (options.callback) {
    const outgoing = createBrowserAuth({ config, origin, storage, cryptoApi });
    const start = new URL(await outgoing.start(options.view));
    currentUrl = new URL(`${config.redirectUri}?code=synthetic-code&iss=${encodeURIComponent(origin)}&state=${options.invalidState ? "wrong-state" : start.searchParams.get("state")}${options.callbackHash ?? ""}`);
  }
  const ids = new Map<string, Element>();
  const element = (id: string) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id)!; };
  const location = {
    get href() { return currentUrl.href; }, get origin() { return currentUrl.origin; },
    get search() { return currentUrl.search; }, get hash() { return currentUrl.hash; },
    assign: vi.fn((value: string) => { currentUrl = new URL(value); }),
  };
  const replaceState = vi.fn((_data: unknown, _unused: string, path: string) => { currentUrl = new URL(path, origin); });
  const lifecycle = new Map<string, (event: { persisted: boolean }) => void>();
  vi.stubGlobal("document", { getElementById: element });
  vi.stubGlobal("window", { location, history: { replaceState }, sessionStorage: storage,
    addEventListener(name: string, action: (event: { persisted: boolean }) => void) { lifecycle.set(name, action); } });
  vi.stubGlobal("crypto", cryptoApi);
  const request = vi.fn(async (url: string) => {
    if (url === "/family-auth-config") return Response.json(config);
    if (url === "/token") return options.tokenResponse ?? Response.json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", request);
  const openedAt: string[] = [];
  workspace.open.mockImplementation(async () => { openedAt.push(currentUrl.href); });
  await import(new URL("../simulator/invite.js", import.meta.url).href);
  return { element, location, data, openedAt, request, replaceState, lifecycle,
    restoreUrl() { currentUrl = new URL(`${config.redirectUri}#${options.view ?? "today"}`); } };
}

describe("parent and family entry through sign-in", () => {
  it("preserves Turns through the existing Circle sign-in return contract", async () => {
    const ui = await fixture({ view: "turns" });
    await vi.waitFor(() => expect(ui.element("browser-signin").hidden).toBe(false));
    await ui.element("browser-signin").listeners.get("click")!();
    expect(JSON.parse(ui.data.get("kin.browser-login")!).returnView).toBe("circle");
  });
  it("opens Turns after a validated legacy Circle callback", async () => {
    const ui = await fixture({ view: "circle", callback: true });
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledOnce());
    expect(ui.openedAt).toEqual([`${config.redirectUri}#turns`]);
  });
  it("explains an access-lost pending save without claiming it failed or exposing care details", async () => {
    const ui = await fixture({ callback: true });
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledOnce());
    workspace.onAccessLost!(403, { outcomeUnknown: true, requestId: "access-loss-receipt-01" });
    expect(ui.element("invite-status").textContent).toContain("may have completed");
    expect(ui.element("invite-status").textContent).toContain("access-loss-receipt-01");
    expect(ui.element("invite-status").textContent).not.toMatch(/not saved|nothing changed|failed to save/i);
    expect(ui.element("browser-signin").hidden).toBe(false);
  });
  it("restores an enabled sign-in after returning from OAuth through browser history", async () => {
    const ui = await fixture({ view: "ask" });
    await vi.waitFor(() => expect(ui.element("browser-signin").hidden).toBe(false));
    await ui.element("browser-signin").listeners.get("click")!();
    expect(ui.element("browser-signin").disabled).toBe(true);
    ui.lifecycle.get("pagehide")!({ persisted: true }); ui.restoreUrl();
    ui.lifecycle.get("pageshow")!({ persisted: true });
    await vi.waitFor(() => expect(ui.element("browser-signin").disabled).toBe(false));
    expect(ui.element("browser-signin").hidden).toBe(false);
    expect(workspace.open).not.toHaveBeenCalled();
    await ui.element("browser-signin").listeners.get("click")!();
    expect(ui.location.assign).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ui.data.get("kin.browser-login")!).returnView).toBe("ask");
    expect(ui.request.mock.calls.every(([url]) => url === "/family-auth-config")).toBe(true);
  });
  it("ignores an old initialization failure after a newer restored entry succeeds", async () => {
    const ui = await fixture();
    await vi.waitFor(() => expect(ui.element("browser-signin").hidden).toBe(false));
    let reject!: (error: Error) => void;
    ui.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    ui.element("invite-reload").listeners.get("click")!();
    ui.lifecycle.get("pagehide")!({ persisted: true });
    ui.lifecycle.get("pageshow")!({ persisted: true });
    await vi.waitFor(() => expect(ui.request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(ui.element("browser-signin").disabled).toBe(false));
    await new Promise(resolve => setImmediate(resolve));
    const restoredStatus = ui.element("invite-status").textContent;
    reject(new Error("Obsolete configuration request"));
    await new Promise(resolve => setImmediate(resolve));
    expect(ui.element("invite-status").textContent).toBe(restoredStatus);
    expect(ui.element("browser-signin").disabled).toBe(false);
    expect(workspace.open).not.toHaveBeenCalled();
  });
  it("does not reopen an account from a late token response after history restoration", async () => {
    let finish!: (response: Response) => void;
    const tokenResponse = new Promise<Response>(resolve => { finish = resolve; });
    const ui = await fixture({ callback: true, tokenResponse });
    await vi.waitFor(() => expect(ui.request.mock.calls.some(([url]) => url === "/token")).toBe(true));
    ui.lifecycle.get("pagehide")!({ persisted: true }); ui.restoreUrl();
    ui.lifecycle.get("pageshow")!({ persisted: true });
    await vi.waitFor(() => expect(ui.element("browser-signin").disabled).toBe(false));
    const restoredStatus = ui.element("invite-status").textContent;
    finish(Response.json({ access_token: "late-synthetic-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:tools" }));
    await new Promise(resolve => setImmediate(resolve));
    expect(workspace.open).not.toHaveBeenCalled();
    expect(ui.element("browser-signin").hidden).toBe(false);
    expect(ui.element("browser-disconnect").hidden).toBe(true);
    expect(ui.element("invite-status").textContent).toBe(restoredStatus);
  });
  it.each(["ask", "today"])("keeps the %s entry until deliberate sign-in and stores it with PKCE", async view => {
    const ui = await fixture({ view });
    await vi.waitFor(() => expect(ui.element("browser-signin").hidden).toBe(false));
    expect(ui.request.mock.calls.map(([url]) => url)).toEqual(["/family-auth-config"]);
    expect(ui.location.href).toBe(`${config.redirectUri}#${view}`);
    expect(workspace.open).not.toHaveBeenCalled();
    expect(ui.location.assign).not.toHaveBeenCalled();
    await ui.element("browser-signin").listeners.get("click")!();
    expect(JSON.parse(ui.data.get("kin.browser-login")!).returnView).toBe(view);
    expect(ui.location.assign).toHaveBeenCalledOnce();
  });
  it.each(["ask", "today"])("opens the restored %s view only after a validated callback", async view => {
    const ui = await fixture({ view, callback: true, callbackHash: "#https://foreign.example" });
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledOnce());
    expect(ui.openedAt).toEqual([`${config.redirectUri}#${view}`]);
    expect(ui.location.href).toBe(`${config.redirectUri}#${view}`);
    expect(ui.data.size).toBe(0);
    expect(ui.request.mock.calls.map(([url]) => url)).toEqual(["/family-auth-config", "/token"]);
  });
  it("does not restore a view or open the workspace after a failed callback", async () => {
    const ui = await fixture({ view: "ask", callback: true, invalidState: true });
    await vi.waitFor(() => expect(ui.element("invite-status").textContent).toContain("could not complete sign-in"));
    expect(workspace.open).not.toHaveBeenCalled();
    expect(ui.location.href).toBe(config.redirectUri);
    expect(ui.request.mock.calls.map(([url]) => url)).toEqual(["/family-auth-config"]);
    expect(ui.data.size).toBe(0);
  });
});
