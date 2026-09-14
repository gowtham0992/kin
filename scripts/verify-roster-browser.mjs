// Synthetic, loopback-only end-to-end checks. No deployed account or AWS client is used.
// Set KIN_PLAYWRIGHT_MODULE to an installed playwright/test module when it is not local.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-roster-browser");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
const errors = [], servers = [];
async function preview(mode, port) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", mode, String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(child);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture startup timed out")), 10000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Fixture exited: ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timeout); resolve(); } });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/invite.html#circle`);
  await expect(page.getByRole("heading", { name: "The people in your circle" })).toBeVisible();
  return page;
}
async function addReview(page, name) {
  await page.getByRole("button", { name: "Add someone", exact: true }).click();
  await page.getByLabel("Name for this circle").fill(name);
  await page.getByRole("button", { name: "Review addition", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm addition", exact: true })).toBeFocused();
}
async function saveAddition(page) {
  await page.getByRole("button", { name: "Confirm addition", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("Circle updated");
  await expect(page.locator("#roster-editor-form")).toBeHidden();
}
try {
  const page = await preview("roster", 3031);
  const longName = "Alexandria Catherine Montgomery Wainwright";
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await addReview(page, longName);
    await expect(page.getByRole("button", { name: "Review addition", exact: true })).toHaveClass("secondary");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `circle-review-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add someone", exact: true })).toBeFocused();
  }
  await addReview(page, "Robin");
  await saveAddition(page);
  await expect(page.getByRole("heading", { name: "Robin", exact: true })).toBeVisible();
  assert.equal(await page.locator(".care-roster select option").filter({ hasText: "Robin" }).count(), 0);
  await page.getByRole("button", { name: "Edit name for Robin", exact: true }).click();
  await page.getByLabel("Name for this circle").fill("Robin Chen");
  await page.getByRole("button", { name: "Review name change", exact: true }).click();
  await page.getByRole("button", { name: "Back to editing", exact: true }).click();
  await expect(page.getByLabel("Name for this circle")).toBeFocused();
  await page.getByLabel("Name for this circle").press("Enter");
  await page.keyboard.press("Enter"); // The explicitly focused confirmation, not an automatic save.
  await expect(page.getByRole("heading", { name: "Robin Chen", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit name for Maya", exact: true })).toHaveCount(0);
  await addReview(page, "Robin Chen");
  await page.getByRole("button", { name: "Confirm addition", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("draft is still here");
  await expect(page.getByLabel("Name for this circle")).toHaveValue("Robin Chen");
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  await page.getByRole("button", { name: "Back to editing", exact: true }).click();
  await page.getByLabel("Name for this circle").fill("An unfinished name");
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Turns", exact: true }).click();
  await expect(page.getByLabel("Name for this circle")).toHaveValue("An unfinished name");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Name for this circle")).toHaveValue("An unfinished name");
  await page.reload();
  await expect(page.locator("#roster-editor-form")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Robin Chen", exact: true })).toBeVisible();
  // Isolate presentation of untrusted names from interpretation or script execution.
  await addReview(page, "<img src=x onerror=alert(1)>");
  await saveAddition(page);
  await expect(page.getByRole("heading", { name: "<img src=x onerror=alert(1)>", exact: true })).toBeVisible();
  assert.equal(await page.locator(".circle-people img").count(), 0);

  const uncertain = await preview("roster-uncertain", 3032), writes = [];
  uncertain.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/circle/people")) writes.push(request.postData()); });
  await addReview(uncertain, "Jordan");
  await uncertain.getByRole("button", { name: "Confirm addition", exact: true }).click();
  await expect(uncertain.locator("#workspace-retry-write")).toBeVisible();
  await expect(uncertain.getByLabel("Name for this circle")).toBeDisabled();
  await uncertain.locator("#workspace-retry-write").click();
  await expect(uncertain.locator("#workspace-status")).toContainText("Circle updated");
  assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
  await expect(uncertain.getByRole("heading", { name: "Jordan", exact: true })).toHaveCount(1);
  await expect(uncertain.locator("#roster-editor-form")).toBeHidden();

  const failedRefresh = await preview("roster-refresh-failure", 3033);
  await addReview(failedRefresh, "Casey");
  await saveAddition(failedRefresh);
  await expect(failedRefresh.locator("#workspace-status")).toContainText("could not be refreshed");
  await expect(failedRefresh.locator("#workspace-retry-write")).toBeHidden();

  const empty = await preview("roster-empty", 3034);
  await expect(empty.getByText("Start with the person receiving care", { exact: false })).toBeVisible();
  await addReview(empty, "Sam"); await saveAddition(empty);
  await expect(empty.getByRole("heading", { name: "Sam", exact: true })).toBeVisible();

  // A changed capability is fetched from the server; the draft and editor must disappear.
  await page.route("**/api/session", async route => {
    const response = await route.fetch(), identity = await response.json();
    identity.permissions.manageRoster = false;
    await route.fulfill({ response, json: identity });
  });
  await page.route("**/api/circle", route => route.fulfill({ status: 500, json: { error: "Synthetic failed read after capability loss" } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".circle-people")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [375, 768, 1280], checks: ["add", "rename", "keyboard", "cancel-focus", "no-duty-grant", "linked-lock", "duplicate-conflict", "draft-navigation", "draft-refresh", "reload-clears-draft", "text-only-names", "same-request-recovery", "saved-refresh-failure", "empty-circle", "capability-loss", "no-page-errors"], output }));
} finally {
  await browser.close();
  for (const server of servers) server.kill("SIGTERM");
}
