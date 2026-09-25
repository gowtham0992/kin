import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../src/http.js";
import { createDemoStore } from "../src/domain.js";
const { setupInstall } = await import(new URL("../simulator/install.js", import.meta.url).href);
const read = (file: string) => readFileSync(new URL(`../simulator/${file}`, import.meta.url), "utf8");

describe("caregiver app installation", () => {
  it.each([false, true])("does not confuse installation with launching the app (during prompt: %s)", async duringPrompt => {
    const events: Record<string, (event?: unknown) => unknown> = {};
    const button = { hidden: false, disabled: false, addEventListener: (name: string, cb: () => unknown) => { events[name] = cb; } };
    const status = { textContent: "" };
    setupInstall({ window: { isSecureContext: false, matchMedia: () => ({ matches: false }), addEventListener: (name: string, cb: () => unknown) => { events[name] = cb; } }, navigator: {}, button, status });
    if (duringPrompt) {
      events.beforeinstallprompt!({ preventDefault() {}, prompt: async () => { events.appinstalled!(); }, userChoice: Promise.resolve({ outcome: "accepted" }) });
      await events.click!();
    } else events.appinstalled!();
    expect(status.textContent).toContain("Kin is installed");
    expect(status.textContent).toContain("open the Kin icon");
    expect(status.textContent).not.toContain("open as an app");
    expect(button.hidden).toBe(true);
  });

  it.each([false, true])("reports the actual standalone state (%s) without requesting permission", standalone => {
    const status = { textContent: "" }, button = { hidden: false, addEventListener: vi.fn() };
    setupInstall({ window: { matchMedia: () => ({ matches: standalone }), addEventListener: vi.fn(), isSecureContext: false }, navigator: {}, button, status });
    expect(status.textContent).toContain(standalone ? "Kin is open as an app" : "Kin is open in a browser tab");
    if (!standalone) expect(status.textContent).toContain("keep using it here");
    expect(button.hidden).toBe(true);
  });

  it("serves only public app assets with no-store and a stable token-free start URL", async () => {
    const app = createHttpApp(createDemoStore(), undefined, {
      serveSimulator: false, serveFamilyWorkspace: true,
      accessAuthorizer: { async authorize() { throw new Error("No family requests in this asset test"); } },
      familyAccess: { circleId: "family-a", directory: { async find() { return undefined; } } },
      browserAuth: { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" },
    });
    const manifest = await request(app).get("/kin.webmanifest").expect(200);
    expect(manifest.headers["content-type"]).toContain("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(manifest.text)).toMatchObject({ id: "/invite.html", start_url: "/invite.html", display: "standalone", scope: "/" });
    for (const name of ["kin-sw.js", "install.js", "kin-icon.svg"]) await request(app).get(`/${name}`).expect(200);
    const page = await request(app).get("/invite.html").expect(200);
    expect(page.text).toContain('rel="manifest"');
    expect(page.text).toContain("Installation does not turn on notifications");
    expect(page.text).toContain("Share → Add to Home Screen");
    expect(page.text).toContain("check Today directly until delivery is verified");
  });

  it("does not intercept API, OAuth callbacks, other origins, or mutations", () => {
    let handle!: (event: unknown) => void;
    runInNewContext(read("kin-sw.js"), { self: { location: { origin: "https://kin.example" }, addEventListener: (name: string, cb: typeof handle) => { if (name === "fetch") handle = cb; } }, URL });
    for (const [url, mode, method] of [
      ["https://kin.example/api/today", "cors", "GET"],
      ["https://kin.example/invite.html?code=private&state=private", "navigate", "GET"],
      ["https://kin.example/auth/callback", "navigate", "GET"],
      ["https://other.example/invite.html", "navigate", "GET"],
      ["https://kin.example/invite.html", "navigate", "POST"],
    ]) {
      const respondWith = vi.fn(); handle({ request: { url, mode, method }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it("uses the network and a data-free fallback without creating persistent caches", async () => {
    let handle!: (event: unknown) => void;
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"));
    runInNewContext(read("kin-sw.js"), { self: { location: { origin: "https://kin.example" }, addEventListener: (name: string, cb: typeof handle) => { if (name === "fetch") handle = cb; } }, URL, Response, fetch });
    let pending!: Promise<Response>;
    const event = { request: { url: "https://kin.example/invite.html", mode: "navigate", method: "GET" }, respondWith: (value: Promise<Response>) => { pending = value; } };
    handle(event);
    const offline = await pending;
    expect(offline.status).toBe(503); expect(offline.headers.get("cache-control")).toBe("no-store");
    expect(await offline.text()).toContain("Your family plan is not available offline");
    const online = new Response("fresh document"); fetch.mockResolvedValueOnce(online);
    handle(event); expect(await pending).toBe(online);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requests installation only on a click and never requests notification permission", async () => {
    const events: Record<string, (event?: unknown) => unknown> = {};
    const button = { hidden: false, disabled: false, addEventListener: (name: string, cb: () => unknown) => { events[name] = cb; } };
    const status = { textContent: "" };
    const register = vi.fn(async () => ({}));
    setupInstall({ window: { isSecureContext: true, matchMedia: () => ({ matches: false }), addEventListener: (name: string, cb: () => unknown) => { events[name] = cb; } }, navigator: { serviceWorker: { register } }, button, status });
    const prompt = vi.fn(async () => {});
    events.beforeinstallprompt!({ preventDefault() {}, prompt, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    expect(prompt).not.toHaveBeenCalled(); expect(button.hidden).toBe(false);
    await events.click!();
    expect(prompt).toHaveBeenCalledOnce(); expect(button.hidden).toBe(true);
    expect(status.textContent).toBe("You can keep using Kin in this browser.");
    await events.click!(); expect(prompt).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith("/kin-sw.js", { scope: "/", updateViaCache: "none" });
  });
});
