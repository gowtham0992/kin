// Local synthetic identity + real memory repository. No real accounts, cloud, or messages.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect } from "playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-undo-browser");
const origin = "http://127.0.0.1:3059";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3059"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const errors = [], blocked = [], undoWrites = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Undo preview startup timed out")), 10000);
    child.once("error", reject); child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Preview exited: ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timeout); resolve(); } });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 900 }, serviceWorkers: "block" });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/api\/tasks\/[^/]+\/undo$/.test(request.url())) undoWrites.push(request.postDataJSON()); });
  const row = () => page.locator(".care-plan li").filter({ has: page.getByRole("heading", { name: "Drink a glass of water", exact: true }) });
  const snapshot = async () => (await page.request.get(`${origin}/api/today`)).json();
  const currentTask = async () => (await snapshot()).tasks.find(task => task.id === "morning-water");
  const review = task => Object.fromEntries(["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"].map(key => [key, task[key]]));
  let sequence = 0;
  async function externalResponse(response) {
    const task = await currentTask();
    const result = await page.request.post(`${origin}/api/tasks/${task.id}/confirm`, { data: { response, actor: "Synthetic caregiver", requestId: `synthetic-review-${++sequence}`, expected: review(task) } });
    assert.equal(result.ok(), true); return result.json();
  }
  async function saveDone() {
    await row().getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review undo", exact: true })).toBeVisible();
  }
  await page.goto(`${origin}/invite.html#today`);
  await expect(page.getByRole("button", { name: "Review undo", exact: true })).toHaveCount(0);
  await row().getByRole("button", { name: "Not yet", exact: true }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Check-in recorded.");
  const previous = review(await currentTask());
  await saveDone();
  const open = page.getByRole("button", { name: "Review undo", exact: true });
  await open.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-undo-heading")).toBeFocused();
  await expect(page.locator(".care-undo-changes")).toContainText("Not yet");
  await expect(page.locator(".care-undo-review")).toContainText("Canceled reminders will not restart");
  await expect(page.locator(".care-undo-changes")).toContainText("via Maya’s Kin account");
  assert.equal(undoWrites.length, 0);
  const contrast = (foreground, background) => {
    const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const colors = await page.locator(".care-undo-review").evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
    note: getComputedStyle(element.querySelector(".care-note")).color, kicker: getComputedStyle(element.querySelector(".kicker")).color }));
  const ratios = { note: contrast(colors.note, colors.background), kicker: contrast(colors.kicker, colors.background) };
  assert.ok(ratios.note >= 4.5 && ratios.kicker >= 4.5, "Review text must meet AA contrast");
  await mkdir(output, { recursive: true });
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
    for (const button of await page.locator(".care-undo-review button").all()) {
      const box = await button.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44 && box.x >= 0 && box.x + box.width <= width);
    }
    await page.screenshot({ path: path.join(output, `review-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Keep completion", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(open).toBeFocused(); assert.equal(undoWrites.length, 0);
  await open.click();
  await page.getByRole("button", { name: "Confirm undo", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-status")).toContainText("Completion undone.");
  assert.deepEqual(review(await currentTask()), previous); assert.equal(undoWrites.length, 1);
  assert.deepEqual(undoWrites[0].restore, previous); assert.equal(undoWrites[0].confirm, true); assert.equal(undoWrites[0].actor, undefined);
  await expect(open).toHaveCount(0);

  // Commit succeeds, response is lost: all competing UI is locked, exact retry recovers.
  await saveDone(); await open.click();
  let lose = true, denyRetry = true;
  await page.route("**/api/tasks/*/undo", async route => {
    if (lose) { lose = false; const response = await route.fetch(); assert.equal(response.ok(), true); return route.abort("failed"); }
    if (denyRetry) { denyRetry = false; return route.fulfill({ status: 404, json: { error: "not_enabled" } }); }
    return route.continue();
  });
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry the same completion undo", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep completion", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Plan", exact: true }).click(); await expect(page).toHaveURL(`${origin}/invite.html#today`);
  await page.getByRole("button", { name: "Retry the same completion undo", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("not acknowledged");
  await expect(page.locator("#workspace-status")).not.toContainText("Nothing was undone");
  await expect(page.getByRole("button", { name: "Keep completion", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Plan", exact: true }).click(); await expect(page).toHaveURL(`${origin}/invite.html#today`);
  await page.getByRole("button", { name: "Retry the same completion undo", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("Completion undone.");
  assert.deepEqual(undoWrites[1], undoWrites[2]); assert.deepEqual(undoWrites[2], undoWrites[3]); assert.deepEqual(review(await currentTask()), previous);
  await page.unroute("**/api/tasks/*/undo");

  // A fresh read prevents stale reviews; a write-time conflict never claims success.
  await saveDone(); await externalResponse("skipped"); await open.click();
  await expect(page.locator("#workspace-status")).toContainText("completion changed"); assert.equal(undoWrites.length, 4);
  await externalResponse("not_yet"); await page.locator("#workspace-refresh").click(); await saveDone(); await open.click();
  await expect(page.locator("#workspace-undo-heading")).toBeVisible();
  await externalResponse("skipped"); await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("Nothing was undone by this request");
  assert.equal((await currentTask()).state, "skipped"); await expect(page.locator("#workspace-retry-write")).toBeHidden();

  // A malformed success cannot unlock competing writes or claim success.
  await externalResponse("not_yet"); await page.reload(); await saveDone(); await open.click();
  await expect(page.locator("#workspace-undo-heading")).toBeVisible();
  let corrupt = true;
  await page.route("**/api/tasks/*/undo", async route => {
    const response = await route.fetch(), data = await response.json();
    if (corrupt) { corrupt = false; data.undo.taskId = "wrong-task"; }
    await route.fulfill({ response, json: data });
  });
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("has not acknowledged this completion undo");
  await page.getByRole("button", { name: "Retry the same completion undo", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("Completion undone.");
  assert.deepEqual(undoWrites.at(-1), undoWrites.at(-2)); await page.unroute("**/api/tasks/*/undo");

  // Access may be revoked after commit. Close the workspace and keep only an opaque reference.
  await saveDone(); await open.click(); await expect(page.locator("#workspace-undo-heading")).toBeVisible();
  await page.route("**/api/tasks/*/undo", async route => { await route.fetch(); await route.fulfill({ status: 403, json: { error: "family_access_denied" } }); });
  await page.getByRole("button", { name: "Confirm undo", exact: true }).click();
  await expect(page.locator("#workspace")).toBeHidden(); await expect(page.locator("#workspace-content")).toBeEmpty();
  await expect(page.locator("#invite-status")).toContainText("pending change may have completed");
  await expect(page.locator("#invite-status")).not.toContainText("Drink a glass of water");
  await page.unroute("**/api/tasks/*/undo");

  // Direct replies also need the closed-session warning on their first attempt.
  for (const status of [401, 403]) {
    await externalResponse("not_yet"); await page.reload();
    const attempts = [];
    await page.route("**/api/tasks/*/confirm", async route => {
      attempts.push(route.request().postDataJSON());
      const response = await route.fetch(); assert.equal(response.ok(), true);
      await route.fulfill({ status, json: { error: "family_access_denied" } });
    });
    await row().getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("#workspace")).toBeHidden();
    await expect(page.locator("#workspace-content")).toBeEmpty();
    await expect(page.locator("#workspace-identity")).toBeEmpty();
    await expect(page.locator("#invite-status")).toContainText("pending change may have completed");
    await expect(page.locator("#invite-status")).toContainText(`Reference: ${attempts[0].requestId}`);
    await expect(page.locator("#invite-status")).not.toContainText("Drink a glass of water");
    assert.equal((await currentTask()).state, "done"); assert.equal(attempts.length, 1);
    await page.unroute("**/api/tasks/*/confirm");
  }

  // No action when the backend advertises no support; no offer after page/session reload.
  await externalResponse("not_yet"); await page.reload(); await saveDone(); await page.reload(); await expect(open).toHaveCount(0);
  await externalResponse("not_yet");
  await page.route("**/api/session", async route => { const response = await route.fetch(), data = await response.json(); delete data.features; await route.fulfill({ response, json: data }); });
  await page.reload(); await row().getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Check-in recorded."); await expect(open).toHaveCount(0);
  await page.unroute("**/api/session");

  await page.route("**/api/session", async route => { const response = await route.fetch(), data = await response.json();
    data.role = "viewer"; data.permissions = { confirm: false, manageDuty: false, invite: false }; delete data.features;
    await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.locator(".care-today > .care-plan")).toBeVisible(); await expect(open).toHaveCount(0);
  await expect(page.locator("#today-history")).toContainText("Drink a glass of water");
  await page.locator("#today-history > summary").press("Enter");
  await expect(row()).toBeVisible();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toHaveCount(0); await page.unroute("**/api/session");

  // Fake browser clock only: expiry disables the reviewed action without a write.
  await page.clock.install({ time: new Date() });
  await externalResponse("not_yet"); await page.reload(); await saveDone(); await open.click();
  await expect(page.locator("#workspace-undo-heading")).toBeVisible();
  const countBeforeExpiry = undoWrites.length;
  await page.clock.fastForward(90_001);
  await expect(page.getByRole("button", { name: "Confirm undo", exact: true })).toBeDisabled();
  await expect(page.locator(".care-undo-review")).toContainText("This review expired");
  assert.equal(undoWrites.length, countBeforeExpiry);
  await page.screenshot({ path: path.join(output, "expired.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ result: "pass", viewports: [320, 375, 768, 1280], undoRequests: undoWrites.length, contrast: ratios,
    assertions: ["keyboard", "account attribution", "exact not-yet restoration", "decline", "lost-response exact retry", "disabled-retry-keeps-undo-uncertain", "malformed receipt", "post-commit access loss", "first-reply-denial-clears-private-ui-with-save-reference", "competing controls lock", "stale review/write", "viewer/feature gate", "reload clears", "expiry"], errors, blocked, output }, null, 2));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); setTimeout(resolve, 3000).unref(); });
}
