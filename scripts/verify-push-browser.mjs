// Real local HTTP/UI, synthetic identities and browser push boundary. Never sends a notification.
import { mkdir } from "node:fs/promises";
import { createECDH } from "node:crypto";
import { chromium, expect } from "playwright/test";
import { createHttpApp } from "../src/http.ts";
import { createDemoStore } from "../src/domain.ts";
import { AccessDeniedError } from "../src/auth.ts";
import { subscriptionId } from "../src/web-push.ts";

const curve = createECDH("prime256v1"); curve.setPrivateKey(Buffer.alloc(32, 1));
const publicKey = curve.getPublicKey().toString("base64url");
const member = { memberId: "theo", circleId: "demo-family", name: "Theo", role: "caregiver", status: "active" };
let saved = null, writes = 0, removes = 0;
const app = createHttpApp(createDemoStore(), undefined, {
  serveFamilyWorkspace: true, serveSimulator: false,
  accessAuthorizer: { async authorize(header) {
    if (header !== "Bearer synthetic-browser-test") throw new AccessDeniedError(401, "invalid_token");
    return { subject: "synthetic-test", claims: { iss: "https://kin.example" }, scopes: new Set(["mcp:tools"]) };
  } },
  familyAccess: { circleId: member.circleId, directory: { find: async () => member } },
  browserAuth: { clientId: "kin-family-browser", issuer: "https://kin.example", redirectUri: "https://kin.example/invite.html", resource: "https://kin.example/mcp" },
  push: { publicKey, subscriptions: {
    status: async () => ({ state: saved ? "saved" : "none", id: saved ? subscriptionId(saved) : null }),
    enroll: async (_authorization, subscription) => { saved = subscription; writes++; },
    remove: async () => { saved = null; removes++; },
    forRecipient: async () => null, removeExpired: async () => {},
  } },
});
const server = await new Promise((resolve, reject) => { const running = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve(running)); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let dropPost = true, dropDelete = true;
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) throw new Error("External request blocked in synthetic test");
    if (url.pathname === "/notification-test") return route.fulfill({ contentType: "text/html", body:
      '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/invite.css"><link rel="stylesheet" href="/workspace.css"><body class="workspace-page"><main class="invite-page"><section id="workspace"><div id="workspace-content"><div id="push"></div></div></section></main>' });
    if (url.pathname === "/api/push/subscription" && ((request.method() === "POST" && dropPost) || (request.method() === "DELETE" && dropDelete))) {
      if (request.method() === "POST") dropPost = false; else dropDelete = false;
      const response = await route.fetch(); expect(response.status()).toBe(204);
      return route.abort("connectionreset"); // Save succeeded, but its response was lost.
    }
    return route.continue();
  });
  await page.addInitScript(({ publicKey }) => {
    const counts = window.pushCounts = { subscribe: 0, unsubscribe: 0, permission: 0 };
    let local = null;
    const subscription = { endpoint: "https://web.push.apple.com/synthetic-browser-test",
      toJSON: () => ({ endpoint: subscription.endpoint, expirationTime: null, keys: { p256dh: publicKey, auth: "AQEBAQEBAQEBAQEBAQEBAQ" } }),
      unsubscribe: async () => { counts.unsubscribe++; local = null; return true; } };
    const notification = { permission: "default", requestPermission: async () => { counts.permission++; notification.permission = "granted"; return "granted"; } };
    Object.defineProperty(window, "Notification", { value: notification });
    Object.defineProperty(window, "PushManager", { value: {} });
    Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager: {
      getSubscription: async () => local, subscribe: async () => { counts.subscribe++; local = subscription; return local; },
    } }) } });
  }, { publicKey });
  await page.goto(`${origin}/notification-test`);
  await page.evaluate(async publicKey => {
    const { createPushControls } = await import("/push-controls.js");
    window.pushConfig = { publicKey, consentVersion: "kin-on-duty-push-v1" };
    window.pushControls = createPushControls({ container: document.getElementById("push"), request: (url, options) => fetch(url, {
      ...options, headers: { ...options.headers, authorization: "Bearer synthetic-browser-test" },
    }) });
    await window.pushControls.open(window.pushConfig);
  }, publicKey);
  await page.getByText("On-duty notifications", { exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No phone is connected");
  await page.getByRole("button", { name: "Enable on this phone", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("could not verify");
  expect(await page.evaluate(() => window.pushCounts.unsubscribe)).toBe(0);
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("connected to this account");
  expect(writes).toBe(2); expect(await page.evaluate(() => window.pushCounts.subscribe)).toBe(1);
  await page.evaluate(() => window.pushControls.open(window.pushConfig));
  await page.getByText("On-duty notifications", { exact: true }).click();
  await expect(page.getByRole("status")).toContainText("connected to this account");
  await mkdir("/tmp/kin-push-browser", { recursive: true });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/kin-push-browser/${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Turn off on this phone", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("could not verify");
  expect(await page.evaluate(() => window.pushCounts.unsubscribe)).toBe(0);
  await page.getByRole("button", { name: "Turn off on this phone", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("off on this phone");
  expect(removes).toBe(2); expect(saved).toBeNull();
  expect(await page.evaluate(() => window.pushCounts.unsubscribe)).toBe(1);
  expect(errors).toEqual([]);
  console.log("Notification HTTP/browser lost-save, reopen, lost-disable, and three-width layout checks passed. Synthetic push boundary; zero notifications sent.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
