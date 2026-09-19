// Real local parent authorization, HTTP, memory store and UI. No external services.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-pause-browser"); await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3050";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "coverage-empty", "3050"], {
  cwd: root, env: { ...process.env, KIN_PREVIEW_ROLE: "care_recipient", KIN_PREVIEW_PAUSE_FIXTURE: "true" }, stdio: ["ignore", "pipe", "pipe"] });
let browser; const errors = [], writes = [], blocked = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Pause preview startup timeout")), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Preview exited ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Denver" });
  await page.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); blocked.push(route.request().url()); return route.abort(); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST") writes.push({ url: request.url(), body: request.postDataJSON() }); });
  await page.goto(`${origin}/invite.html#plan`);
  await expect(page.getByRole("button", { name: "Review seven-day cancellation" })).toBeVisible();
  await expect(page.locator("#plan-title")).toHaveCount(0);
  const session = await (await page.request.get(`${origin}/api/session`)).json();
  assert.equal(session.role, "care_recipient"); assert.equal(session.permissions.pausePlan, true); assert.equal(session.permissions.manageDuty, false);
  await page.getByRole("button", { name: "Review seven-day cancellation" }).click();
  const section = page.locator(".care-plan-pause");
  await expect(section.getByRole("heading", { name: "Review this cancellation" })).toBeVisible();
  await expect(section).toContainText("exactly 168 hours"); await expect(section).toContainText("2 future unanswered check-ins");
  await expect(section).toContainText("Synthetic next week"); await expect(section).toContainText("does not retract queued caregiver alerts or create reminders");
  await section.getByRole("button", { name: "Confirm seven-day cancellation" }).click(); assert.equal(writes.length, 0);
  await section.getByRole("checkbox").check();
  await page.getByRole("link", { name: "Today", exact: true }).click(); await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(section.getByRole("checkbox")).toHaveCount(0); assert.equal(writes.length, 0);
  await page.getByRole("button", { name: "Review seven-day cancellation" }).click();
  await expect(section.getByRole("checkbox")).not.toBeChecked();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `pause-review-${width}.png`), fullPage: true });
  }
  let dropped = false;
  await page.route(`${origin}/api/plan/pause`, async route => {
    if (route.request().method() !== "POST" || dropped) return route.continue(); dropped = true;
    const committed = await route.fetch(); assert.equal(committed.status(), 201); return route.abort("connectionreset");
  });
  await section.getByRole("checkbox").check(); await section.getByRole("button", { name: "Confirm seven-day cancellation" }).click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await page.getByRole("link", { name: "Today", exact: true }).click(); await expect(page).toHaveURL(`${origin}/invite.html#plan`);
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-status")).toContainText("The reviewed check-ins were cancelled");
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  const plan = await (await page.request.get(`${origin}/api/plan`)).json();
  assert.equal(Date.parse(plan.planPause.pause.endsAt) - Date.parse(plan.planPause.pause.startsAt), 168 * 3_600_000);
  assert.deepEqual(plan.tasks.filter(task => task.state === "cancelled").map(task => task.id).sort(), ["pause-call", "pause-walk"]);
  assert.equal(plan.tasks.find(task => task.id === "after-pause").state, "scheduled");
  await expect(section).toContainText("New check-ins are blocked from"); await expect(section.getByRole("button", { name: "Review seven-day cancellation" })).toHaveCount(0);
  await page.reload(); await expect(section).toContainText("New check-ins are blocked from");
  await page.screenshot({ path: path.join(output, "pause-active-1280.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: true, checks: ["parent-narrow-permission", "review-exact-168h-and-list", "fresh-consent", "navigation-drops-review", "same-id-lost-response-retry", "cancel-reviewed-only", "later-date-unchanged", "active-after-reload", "no-message-or-reminder-writes", "responsive-375-768-1280"], output }));
} finally { await browser?.close(); child.kill("SIGTERM"); }
