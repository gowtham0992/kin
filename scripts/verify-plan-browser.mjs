// Real family routes and memory store; synthetic local auth only. No live accounts or AWS clients.
// Set KIN_PLAYWRIGHT_MODULE to an installed playwright/test module, and optionally KIN_BROWSER_CHANNEL.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-plan-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3039";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3039"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const errors = [], writes = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Synthetic Plan preview startup timed out")), 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Synthetic Plan preview exited: ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timeout); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && /\/api\/tasks\/[^/]+\/change$/.test(request.url())) writes.push(request.postDataJSON()); });
  await page.goto(`${origin}/invite.html#plan`);
  await expect(page.getByRole("heading", { name: "Your family’s plan." })).toBeVisible();
  const due = await page.evaluate(() => {
    const day = new Date(); day.setDate(day.getDate() + 1); day.setHours(9, 0, 0, 0);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T09:00`;
  });
  await page.locator("#plan-title").fill("Call Theo after breakfast");
  await page.locator("#plan-due").fill(due);
  await page.locator("#plan-repeat").selectOption("1");
  await page.getByRole("button", { name: "Save care plan", exact: true }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Care plan saved.");
  const readTask = async () => {
    const response = await page.request.get(`${origin}/api/plan`); assert.equal(response.ok(), true);
    return (await response.json()).tasks.find(task => task.id === taskId);
  };
  const plan = await (await page.request.get(`${origin}/api/plan`)).json();
  const created = plan.tasks.find(task => task.title === "Call Theo after breakfast");
  assert.ok(created); assert.equal(created.routineId, undefined);
  const taskId = created.id, routePath = `${origin}/api/tasks/${encodeURIComponent(taskId)}/change`;
  const form = () => page.locator(`#task-title-${taskId}`).locator("xpath=ancestor::form");
  const openEditor = async () => {
    const details = form().locator("..");
    if (!(await details.evaluate(element => element.open))) await details.locator("summary").click();
  };
  await openEditor();
  await form().getByLabel("Check-in wording", { exact: true }).fill("Call Theo after the morning walk");
  await form().getByRole("button", { name: "Apply reviewed change" }).click();
  assert.equal(writes.length, 0, "No write without explicit review confirmation");
  await form().getByRole("checkbox").check();
  await form().getByLabel("Check-in wording", { exact: true }).fill("A call with Theo after breakfast");
  await expect(form().getByRole("checkbox")).not.toBeChecked();
  await page.keyboard.press("Escape");
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflow at ${width}px`);
    assert.equal(await form().evaluate(element => Array.from(element.querySelectorAll("input, select, button, label")).every(control => {
      const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1;
    })), true, `Clipped editor controls at ${width}px`);
    await page.screenshot({ path: path.join(output, `plan-edit-${width}.png`), fullPage: true });
  }
  await form().getByRole("checkbox").check();
  await form().getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Check-in updated.");
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].expected, { title: created.title, dueAt: created.dueAt });
  assert.equal((await readTask()).title, "A call with Theo after breakfast");

  // Drafts survive navigation, but the user's previous consent never does.
  await openEditor();
  await form().getByLabel("Check-in wording", { exact: true }).fill("A draft for later");
  await form().getByRole("checkbox").check();
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await openEditor();
  await expect(form().getByLabel("Check-in wording", { exact: true })).toHaveValue("A draft for later");
  await expect(form().getByRole("checkbox")).not.toBeChecked();

  // Another real request changes the task while this browser still holds the old review.
  const before = await readTask();
  const other = await page.request.post(routePath, { data: { action: "rename", title: "Theo has updated this plan", expected: { title: before.title, dueAt: before.dueAt }, requestId: "browser-other-caregiver-change", confirm: true } });
  assert.equal(other.ok(), true);
  await form().getByRole("checkbox").check();
  await form().getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-status")).toContainText("changed while you were reviewing");
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  await expect(form().getByLabel("Check-in wording", { exact: true })).toHaveValue("A draft for later");
  await expect(form().getByRole("checkbox")).not.toBeChecked();
  assert.equal((await readTask()).title, "Theo has updated this plan");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Theo has updated this plan", exact: true })).toBeVisible();
  await openEditor();

  // Commit cancellation, then lose only the response. The exact request must recover its receipt.
  let dropped = false;
  await page.route(routePath, async route => {
    if (dropped) return route.continue();
    dropped = true;
    const committed = await route.fetch(); assert.equal(committed.ok(), true);
    await route.abort("connectionreset");
  });
  await form().getByRole("checkbox").check();
  await form().getByLabel("Change", { exact: true }).selectOption("cancel");
  await expect(form().getByRole("checkbox")).not.toBeChecked();
  await expect(form().getByLabel("Check-in wording", { exact: true })).toBeDisabled();
  await form().getByRole("checkbox").check();
  await form().getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await expect(form().getByLabel("Change", { exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/invite.html#plan`);
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-status")).toHaveText("Check-in updated.");
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  const cancels = writes.filter(write => write.action === "cancel");
  assert.equal(cancels.length, 2); assert.deepEqual(cancels[0], cancels[1]); assert.equal("title" in cancels[0], false);
  assert.equal((await readTask()).state, "cancelled");
  await expect(page.locator(`#task-title-${taskId}`)).toHaveCount(0);
  await page.locator('#plan-history > summary').click();
  await expect(page.getByRole("heading", { name: "Theo has updated this plan", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, "plan-cancelled-1280.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [375, 768, 1280], checks: ["create-single", "rename-single", "explicit-review", "fresh-consent", "draft-navigation", "stale-review-rejected", "lost-response-same-id-retry", "cancel-retains-history", "no-overflow-or-clipped-controls", "no-page-errors"], output }));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
