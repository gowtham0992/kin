// Real local HTTP, repository and UI; synthetic identity. No AWS or messages.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-close-unanswered-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3051";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3051"], {
  cwd: root, env: { ...process.env, KIN_PREVIEW_CLOSE_UNANSWERED: "true" }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
const errors = [], writes = [], blocked = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Closure preview startup timeout")), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 375, height: 900 }, timezoneId: "America/Denver" });
  await page.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked.push(route.request().url()); return route.abort(); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST") writes.push({ url: request.url(), body: request.postDataJSON() }); });
  await page.goto(`${origin}/invite.html#plan`);
  const editor = page.locator("#task-title-close-test").locator("xpath=ancestor::details");
  await editor.locator("summary").click();
  await expect(editor).toContainText("not as done or skipped");
  await expect(editor).toContainText("does not retract queued notifications");
  await editor.getByRole("button", { name: "Apply reviewed change" }).click();
  assert.equal(writes.length, 0);
  await editor.getByRole("checkbox").check();
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await editor.locator("summary").click();
  await expect(editor.getByRole("checkbox")).not.toBeChecked();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `close-review-${width}.png`), fullPage: true });
  }
  let dropped = false;
  await page.route(`${origin}/api/tasks/close-test/change`, async route => {
    if (dropped) return route.continue(); dropped = true;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    return route.abort("connectionreset");
  });
  await editor.getByRole("checkbox").check();
  await editor.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-content")).toContainText("Closed by Maya");
  await expect(page.locator("#workspace-content")).toContainText("No reply was recorded");
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0].body.action, "close_unanswered");
  const plan = await (await page.request.get(`${origin}/api/plan`)).json();
  const task = plan.tasks.find(task => task.id === "close-test");
  assert.equal(task.state, "closed_unanswered"); assert.equal(task.lastResponse, null);
  assert.equal(task.confirmedBy, null); assert.equal(task.confirmedAt, null);
  await page.reload(); await expect(page.locator("#workspace-content")).toContainText("Closed without a reply");
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: true, checks: ["yesterday-visible", "explicit-review", "navigation-clears-consent", "same-id-lost-receipt-retry", "no-care-reply", "attribution", "reload", "responsive"], output }));
} finally { await browser?.close(); child.kill("SIGTERM"); }
