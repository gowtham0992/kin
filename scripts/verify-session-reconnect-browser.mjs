// Synthetic local API and browser session only; never contacts AWS or a real account.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect } from "playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = "http://127.0.0.1:3069", origin = "https://kin.test";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3069"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Preview startup timed out")), 10000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(Error("Preview exited")); });
    child.stdout.on("data", bytes => { if (String(bytes).includes("Synthetic invitation preview")) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 375, height: 900 } });
  const errors = [], writes = [], renewals = [];
  let expired = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, "No external browser requests allowed");
    if (url.pathname === "/family-auth-config") return route.fulfill({ json: {
      clientId: "kin-family-browser", issuer: origin, redirectUri: `${origin}/invite.html`, resource: `${origin}/mcp`, sessionMode: "cookie",
    } });
    if (url.pathname === "/browser-session") {
      assert.equal(request.method(), "GET", "Renewal must not revoke or overwrite the browser session");
      return route.fulfill({ json: { expiresAt: Date.now() + 3600000, binding: "a".repeat(64) } });
    }
    if (url.pathname === "/auth") {
      renewals.push(url);
      return route.fulfill({ contentType: "text/html", body: "<h1>Synthetic provider renewal</h1>" });
    }
    if (request.method() !== "GET") writes.push({ path: url.pathname, method: request.method() });
    if (expired && url.pathname.startsWith("/api/")) return route.fulfill({ status: 401, json: { error: "invalid_token" } });
    const response = await fetch(`${local}${url.pathname}${url.search}`);
    return route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "text/plain", body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(`${origin}/invite.html#today`);
  await expect(page.locator("#workspace-nav")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
  expired = true;
  // Let the real workspace poll observe expiry, avoiding a race between its
  // access-loss handler hiding Refresh and the browser trying to click it.
  await expect(page.locator("#invite-status")).toContainText("session ended", { timeout: 15000 });
  assert.equal(renewals.length, 0, "No automatic redirect on expiry");
  await page.locator("#browser-signin").click();
  await expect(page.getByRole("heading", { name: "Synthetic provider renewal" })).toBeVisible();
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].searchParams.get("prompt"), "none");
  assert.equal(renewals[0].searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ["active-page-expiry", "click-required", "fresh-pkce", "no-session-revoke", "no-care-writes", "no-page-errors"] }));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
