// Real loopback MCP and REST; synthetic care data only. No AWS or notification provider.
// Build first. KIN_PLAYWRIGHT_MODULE may point to an existing playwright/test module.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-story-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3038";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-local-story.ts"], {
  cwd: root, env: { ...process.env, PORT: "3038" }, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
const errors = [], calls = [], reads = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Story startup timed out")), 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Story exited: ${code}`)); });
    child.stdout.on("data", chunk => { if (String(chunk).includes("Kin local story:")) { clearTimeout(timeout); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url() === `${origin}/api/today`) reads.push(request.method());
    if (request.url() !== `${origin}/mcp` || request.method() !== "POST") return;
    const frame = request.postDataJSON();
    if (frame?.method === "tools/call") calls.push(frame);
  });
  await page.goto(`${origin}/story.html`);
  await expect(page.locator("#story-app")).toBeVisible();
  await expect(page.locator("#story-message")).toBeEnabled();
  await expect(page.locator("#story-care-plan")).toContainText("Drink a glass of water");

  // Exercise the shipped persisted-page handlers. Headless Chromium may disable
  // native BFCache; synthetic lifecycle events still use the actual page wiring.
  const restoreHistoryEntry = async () => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("#story-message")).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  };
  await page.locator("#story-message").fill("Keep this draft when returning");
  await restoreHistoryEntry();
  await expect(page.locator("#story-message")).toBeEnabled();
  await expect(page.locator("#story-message")).toHaveValue("Keep this draft when returning");
  assert.equal(calls.filter(call => call.params.name === "confirm_care_task").length, 0);

  // A prompt chip only drafts; review only proposes. The write is a separate action.
  await page.locator('[data-prompt="Not yet: Drink a glass of water"]').click();
  await expect(page.locator("#story-message")).toHaveValue("Not yet: Drink a glass of water");
  assert.equal(calls.filter(call => call.params.name === "confirm_care_task").length, 0);
  // Plain reports work without enabling a model, but questions do not become replies.
  await page.locator("#story-message").fill("I think I had my water");
  await page.locator("#story-submit").click();
  await expect(page.locator("#story-review")).toBeHidden();
  await expect(page.locator("#story-message")).toHaveValue("I think I had my water");
  assert.equal(calls.filter(call => call.params.name === "confirm_care_task").length, 0);
  await page.locator("#story-message").fill("I haven't had my water yet.");
  await page.locator("#story-submit").click();
  await expect(page.locator("#story-confirm")).toBeEnabled();
  await expect(page.locator("#story-confirm")).toBeFocused();
  assert.equal(calls.filter(call => call.params.name === "confirm_care_task").length, 0);
  await page.locator("#story-confirm").click();
  await expect(page.locator("#story-review")).toBeHidden();
  await page.locator("#story-refresh").click();
  await expect(page.locator("#story-care-plan")).toContainText("Not yet");
  assert.equal((await (await fetch(`${origin}/demo/story`)).json()).notifications.length, 0);

  await page.locator("#story-advance").click();
  await expect(page.locator("#story-clock")).toContainText("9:31");
  await expect(page.locator("#story-alerts button")).toBeVisible();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `story-follow-up-${width}.png`), fullPage: true });
  }
  await page.locator("#story-alerts button").click();
  await expect(page.locator("#story-alerts")).toContainText("Theo acknowledged the follow-up");
  const acknowledged = await (await fetch(`${origin}/api/today`)).json();
  assert.equal(acknowledged.summary.completed, 0, "Acknowledgment must not complete the check-in");
  assert.equal(acknowledged.escalations[0].acknowledgedBy, "Theo");

  // Commit a real MCP Done call, then lose only its response. Retry must reuse the receipt ID.
  let dropped = false;
  const loseResponse = async route => {
    const request = route.request();
    const frame = request.method() === "POST" ? request.postDataJSON() : null;
    if (!dropped && frame?.method === "tools/call" && frame.params.name === "confirm_care_task" && frame.params.arguments.response === "done") {
      dropped = true;
      const committed = await route.fetch();
      assert.equal(committed.ok(), true);
      await route.abort("connectionreset");
    } else await route.continue();
  };
  await page.route("**/mcp", loseResponse);
  await page.locator('[data-prompt="Done: Drink a glass of water"]').click();
  await page.locator("#story-message").fill("I already had my water.");
  await page.locator("#story-submit").click();
  await expect(page.locator("#story-confirm")).toBeEnabled();
  await page.locator("#story-confirm").click();
  await expect(page.locator("#story-retry")).toBeVisible();
  await expect(page.locator("#story-message")).toBeDisabled();
  await page.unroute("**/mcp", loseResponse);
  const writesBeforeRestore = calls.filter(call => call.params.name === "confirm_care_task").length;
  await restoreHistoryEntry();
  await expect(page.locator("#story-retry")).toBeEnabled();
  await expect(page.locator("#story-message")).toBeDisabled();
  assert.equal(calls.filter(call => call.params.name === "confirm_care_task").length, writesBeforeRestore, "Restoration must not resend an uncertain write");
  await page.locator("#story-retry").click();
  await expect(page.locator("#story-retry")).toBeHidden();
  assert.equal(await page.locator("#story-transcript").evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2), true, "Latest reply should remain visible within the transcript");
  await page.locator("#story-refresh").click();
  await expect(page.locator("#story-care-plan")).toContainText("Done");
  const doneCalls = calls.filter(call => call.params.name === "confirm_care_task" && call.params.arguments.response === "done");
  assert.equal(doneCalls.length, 2);
  assert.deepEqual(doneCalls[0].params.arguments, doneCalls[1].params.arguments);
  const final = await (await fetch(`${origin}/api/today`)).json();
  assert.equal(final.summary.completed, 1);
  assert.equal(final.escalations.length, 1);
  assert.equal((await (await fetch(`${origin}/demo/story`)).json()).notifications.length, 1);

  await page.locator("#story-brief").click();
  await expect(page.locator("#story-brief-result")).toContainText("7");
  assert.ok(calls.some(call => call.params.name === "show_weekly_brief"));
  assert.ok(reads.length >= 2, "Caregiver view needs independent REST reads");
  await page.locator(".story-evidence > summary").click();
  await expect(page.locator("#story-evidence-list")).toContainText("confirm_care_task");
  assert.ok(await page.locator("#story-evidence-list > li").count() <= 12);
  await page.screenshot({ path: path.join(output, "story-complete-1280.png"), fullPage: true });

  // An ordinary runtime is not a substitute: the page must stop before any care calls.
  const unavailable = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const forbiddenReads = [];
  unavailable.on("pageerror", error => errors.push(error.message));
  unavailable.on("request", request => {
    if (/^(?:\/mcp$|\/api\/)/.test(new URL(request.url()).pathname)) forbiddenReads.push(request.url());
  });
  await unavailable.route("**/demo/story", route => route.fulfill({ status: 404, json: { error: "not_found" } }));
  await unavailable.goto(`${origin}/story.html`);
  await expect(unavailable.locator("#story-app")).toBeHidden();
  await expect(unavailable.locator("#story-unavailable")).toContainText("local story server");
  assert.deepEqual(forbiddenReads, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [375, 768, 1280], checks: ["explicit-review", "real-mcp", "separate-rest", "fixed-clock", "simulated-follow-up", "ack-does-not-complete", "lost-response-same-id-retry", "persisted-page-draft-restoration", "persisted-page-no-auto-resend", "grounded-brief", "bounded-evidence", "missing-story-fails-closed", "no-overflow", "no-page-errors"], output }));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
