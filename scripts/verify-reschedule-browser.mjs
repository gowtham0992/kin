// Real local HTTP/store/UI; synthetic authentication. No model, cloud, or reminder writes.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-reschedule-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3049";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3049"], {
  cwd: root, env: { ...process.env, KIN_PREVIEW_RESCHEDULE: "true" }, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const errors = [], writes = [], blocked = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reschedule preview startup timeout")), 10000);
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
  await expect(page.locator("#plan-title")).toBeVisible();
  const dates = await page.evaluate(() => {
    const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0);
    const local = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}T${String(value.getHours()).padStart(2, "0")}:00`;
    const old = local(date); date.setHours(14); return { old, next: local(date), nextIso: date.toISOString() };
  });
  await page.locator("#plan-title").fill("Synthetic afternoon call"); await page.locator("#plan-due").fill(dates.old);
  await page.getByRole("button", { name: "Save care plan", exact: true }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Care plan saved.");
  const read = async () => (await (await page.request.get(`${origin}/api/plan`)).json()).tasks;
  const old = (await read()).find(task => task.title === "Synthetic afternoon call"); assert.ok(old);
  const form = page.locator(`#task-title-${old.id}`).locator("xpath=ancestor::form");
  const open = async () => { const details = form.locator(".."); if (!(await details.evaluate(element => element.open))) await details.locator("summary").click(); };
  await open(); await form.getByLabel("Change", { exact: true }).selectOption("reschedule");
  await form.locator('input[type="datetime-local"]').fill(dates.next);
  await expect(form).toContainText("fresh, explicit request on Alexa");
  await form.getByRole("button", { name: "Apply reviewed change" }).click();
  assert.equal(writes.length, 1, "No move without explicit consent");
  await form.getByRole("checkbox").check();
  await page.getByRole("link", { name: "Today", exact: true }).click(); await page.getByRole("link", { name: "Plan", exact: true }).click(); await open();
  await expect(form.locator('input[type="datetime-local"]')).toHaveValue(dates.next); await expect(form.getByRole("checkbox")).not.toBeChecked();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `reschedule-review-${width}.png`), fullPage: true });
  }
  let dropped = false, deniedRetry = false;
  await page.route(`${origin}/api/tasks/${old.id}/change`, async route => {
    if (dropped) {
      if (!deniedRetry) { deniedRetry = true; return route.fulfill({ status: 422, json: { error: "reschedule_unavailable" } }); }
      return route.continue();
    }
    dropped = true;
    const committed = await route.fetch(); assert.equal(committed.ok(), true); return route.abort("connectionreset");
  });
  await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-status")).toContainText("Retry the same request");
  await expect(form.locator('input[type="datetime-local"]')).toBeDisabled();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await page.getByRole("link", { name: "Today", exact: true }).click(); await expect(page).toHaveURL(`${origin}/invite.html#plan`);
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-status")).toContainText("none was created here");
  const moves = writes.filter(write => write.body.action === "reschedule"); assert.equal(moves.length, 3); assert.deepEqual(moves[0], moves[1]); assert.deepEqual(moves[0], moves[2]);
  const history = (await read()).filter(task => task.title === old.title); assert.equal(history.length, 2);
  const cancelled = history.find(task => task.id === old.id), replacement = history.find(task => task.id !== old.id);
  assert.equal(cancelled.state, "cancelled"); assert.equal(replacement.dueAt, dates.nextIso);
  assert.deepEqual(cancelled.rescheduledTo, { taskId: replacement.id, dueAt: replacement.dueAt });
  assert.deepEqual(replacement.rescheduledFrom, { taskId: old.id, dueAt: old.dueAt });
  assert.equal(writes.length, 4, "Only creation plus original move, denied retry and exact receipt retry; no reminder POST");
  await page.screenshot({ path: path.join(output, "reschedule-receipt-1280.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: true, checks: ["create", "review-old-and-new", "fresh-consent", "retained-draft", "same-id-lost-response-retry", "disabled-retry-stays-locked", "atomic-cancel-new", "history-links", "no-reminder-post", "responsive-375-768-1280"], output }));
} finally { await browser?.close(); child.kill("SIGTERM"); }
