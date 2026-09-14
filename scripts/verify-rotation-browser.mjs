// Synthetic family APIs only. No AWS, real identities, notifications, or package installation.
// Use an existing playwright/test module via KIN_PLAYWRIGHT_MODULE when necessary.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-rotation-browser");
await mkdir(output, { recursive: true });
const children = [], contexts = [], errors = [], blockedOrigins = [], checks = [];
let browser;
async function preview(port) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "coverage-empty", String(port)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Synthetic rotation fixture timed out: ${stderr}`)), 10000);
    child.stderr.on("data", data => { stderr += String(data); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Synthetic fixture exited ${code}: ${stderr}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timeout); resolve(); } });
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Denver", serviceWorkers: "block" });
  contexts.push(context);
  await context.route("**/*", route => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) return route.continue();
    blockedOrigins.push(requested.origin); return route.abort();
  });
  const page = await context.newPage(), writes = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && request.url() === `${origin}/api/circle/rotation`) writes.push(request.postDataJSON());
  });
  await page.goto(`${origin}/invite.html#circle`);
  await expect(page.getByRole("button", { name: "Propose next week", exact: true })).toBeVisible();
  const read = async route => {
    assert.ok(route.startsWith("/api/"));
    const response = await page.request.get(`${origin}${route}`, { maxRedirects: 0 });
    assert.equal(response.status(), 200); return response.json();
  };
  return { page, origin, writes, read };
}
async function propose(page) {
  await page.getByRole("button", { name: "Propose next week", exact: true }).click();
  await expect(page.locator(".care-rotation h4")).toBeVisible();
  await expect(page.locator(".care-rotation h4")).toBeFocused();
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const { page, origin, writes, read } = await preview(3051);
  const initial = await read("/api/circle/rotation");
  assert.equal(initial.proposedDays, 7); assert.equal(initial.uncoveredDays, 0);
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await propose(page);
    await expect(page.locator(".care-rotation-days li")).toHaveCount(7);
    await expect(page.locator(".care-rotation-balance tbody tr")).toHaveCount(initial.members.length);
    await expect(page.locator(".care-rotation-balance").getByRole("columnheader", { name: "14-day basis", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm 7 new days", exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    const targets = await page.locator(".care-rotation button").evaluateAll(buttons => buttons.filter(button => button.getClientRects().length).map(button => {
      const box = button.getBoundingClientRect(); return { label: button.textContent, width: box.width, height: box.height, left: box.left, right: box.right };
    }));
    assert.ok(targets.every(box => box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= width + 1), `Clipped or undersized rotation control at ${width}px: ${JSON.stringify(targets)}`);
    await page.screenshot({ path: path.join(output, `circle-rotation-${width}.png`), fullPage: true });
    await page.locator(".care-rotation").screenshot({ path: path.join(output, `rotation-review-${width}.png`) });
    await page.getByRole("button", { name: "Keep unchanged", exact: true }).click();
    await expect(page.getByRole("button", { name: "Propose next week", exact: true })).toBeFocused();
    await expect(page.locator(".care-rotation h4")).toHaveCount(0);

    // The explanatory page is a public, script-free document, not a new app session.
    const trustLink = page.getByRole("link", { name: "How Kin works (opens in a new tab)", exact: true });
    await expect(trustLink).toHaveAttribute("href", "/how-kin-works.html");
    await expect(trustLink).toHaveAttribute("rel", "noopener noreferrer");
    const popup = page.waitForEvent("popup");
    await trustLink.click();
    const trust = await popup;
    trust.on("pageerror", error => errors.push(error.message));
    await trust.setViewportSize({ width, height: 900 });
    await expect(trust).toHaveURL(`${origin}/how-kin-works.html`);
    await expect(trust.getByRole("heading", { level: 1 })).toHaveText("A little care.Clear expectations.");
    await expect(trust.locator("main section")).toHaveCount(6);
    await expect(trust.locator("script")).toHaveCount(0);
    await expect(trust.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", /script-src 'none'/);
    await expect(trust.locator(".kin-trust-boundary")).toContainText("not emergency monitoring");
    assert.equal(await trust.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Trust page overflow at ${width}px`);
    const paragraphs = await trust.locator("main p").evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return { size: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), left: box.left, right: box.right };
    }));
    assert.ok(paragraphs.filter(p => p.size >= 16).length >= 10, "Trust page body copy must remain readable");
    assert.ok(paragraphs.every(p => p.lineHeight >= p.size * 1.4 && p.left >= 0 && p.right <= width + 1), `Clipped or tight trust page copy at ${width}px`);
    await trust.screenshot({ path: path.join(output, `how-kin-works-${width}.png`), fullPage: true });
    await trust.getByRole("link", { name: "Family workspace", exact: true }).click();
    await expect(trust).toHaveURL(`${origin}/invite.html`);
    await expect(trust.locator("#workspace")).toBeVisible();
    await trust.close();
    await expect(page).toHaveURL(`${origin}/invite.html#circle`);
  }
  assert.equal(writes.length, 0, "Opening/canceling proposals must not write");
  assert.deepEqual(await read("/api/circle/rotation"), initial);
  checks.push("read-only proposal", "375/768/1280 layout", "44px targets", "cancel restores focus",
    "14-day basis label", "trust-page new-tab link preserves workspace", "script-free trust page and return link",
    "375/768/1280 trust-page readable copy without overflow");

  // A real current-day handoff changes the proposal basis, not the proposed week.
  await propose(page);
  const circle = await read("/api/circle");
  const handoff = await page.request.put(`${origin}/api/circle/duty`, { maxRedirects: 0,
    data: { date: circle.startDate, memberId: "theo", expectedMemberId: null, requestId: "rotation-browser-basis-change" } });
  assert.equal(handoff.status(), 200);
  const staleResponse = page.waitForResponse(response => response.url() === `${origin}/api/circle/rotation` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Confirm 7 new days", exact: true }).click();
  assert.equal((await staleResponse).status(), 409);
  await expect(page.locator("#workspace-status")).toContainText("duty roster changed");
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  const changed = await read("/api/circle/rotation");
  assert.equal(changed.proposedDays, 7); assert.ok(changed.days.every(day => day.source === "proposed"));
  assert.notEqual(changed.reviewToken, initial.reviewToken);
  checks.push("stale review rejected 409", "no partial next-week assignment");
  await page.getByRole("button", { name: "Keep unchanged", exact: true }).click();
  await propose(page);
  const savedResponse = page.waitForResponse(response => response.url() === `${origin}/api/circle/rotation` && response.request().method() === "POST");
  await page.getByRole("button", { name: "Confirm 7 new days", exact: true }).click();
  const saved = await savedResponse;
  assert.equal(saved.status(), 200);
  const receipt = await saved.json();
  assert.equal(receipt.assigned, 7); assert.equal(receipt.replayed, false);
  assert.equal(receipt.requestId, writes.at(-1).requestId);
  await expect(page.locator("#workspace-status")).toHaveText("Next week’s rotation saved.");
  assert.equal(writes.length, 2, "One rejected write and one explicitly confirmed write");
  await page.reload();
  await propose(page);
  await expect(page.getByRole("button", { name: "Confirm 0 new days", exact: true })).toBeDisabled();
  await expect(page.locator(".care-rotation")).toContainText("Next week is already covered. Nothing needs to change.");
  const covered = await read("/api/circle/rotation");
  assert.equal(covered.proposedDays, 0); assert.ok(covered.days.every(day => day.source === "existing"));
  checks.push("explicit confirmation receipt", "reload sees covered week");

  await page.getByRole("button", { name: "Keep unchanged", exact: true }).click();
  await page.route(`${origin}/api/circle/rotation`, route => route.abort("failed"));
  await page.getByRole("button", { name: "Propose next week", exact: true }).click();
  await expect(page.locator(".care-rotation")).toContainText("Could not prepare the rotation");
  await expect(page.getByRole("button", { name: "Propose next week", exact: true })).toBeEnabled();
  assert.equal(writes.length, 2);
  await page.unroute(`${origin}/api/circle/rotation`);
  await propose(page);
  checks.push("proposal network failure and retry");

  // Preserve a real committed response behind a dropped browser acknowledgment.
  const uncertain = await preview(3052); let first = true;
  await uncertain.page.route(`${uncertain.origin}/api/circle/rotation`, async route => {
    if (route.request().method() !== "POST" || !first) return route.continue();
    first = false;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    assert.equal((await response.json()).assigned, 7);
    return route.abort("failed");
  });
  await propose(uncertain.page);
  await uncertain.page.getByRole("button", { name: "Confirm 7 new days", exact: true }).click();
  await expect(uncertain.page.locator("#workspace-retry-write")).toBeVisible();
  await expect(uncertain.page.getByRole("button", { name: "Propose next week", exact: true })).toBeDisabled();
  await uncertain.page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(uncertain.page).toHaveURL(`${uncertain.origin}/invite.html#circle`);
  const retryResponse = uncertain.page.waitForResponse(response => response.url() === `${uncertain.origin}/api/circle/rotation` && response.request().method() === "POST");
  await uncertain.page.locator("#workspace-retry-write").click();
  assert.equal((await (await retryResponse).json()).replayed, true);
  await expect(uncertain.page.locator("#workspace-status")).toHaveText("Next week’s rotation saved.");
  assert.equal(uncertain.writes.length, 2); assert.deepEqual(uncertain.writes[0], uncertain.writes[1]);
  const afterRetry = await uncertain.read("/api/circle/rotation");
  assert.equal(afterRetry.proposedDays, 0); assert.equal(afterRetry.days.length, 7);
  checks.push("lost acknowledgment identical retry", "pending write blocks navigation");

  // Capabilities are server facts. Remove controls even when the next data read fails.
  await uncertain.page.route(`${uncertain.origin}/api/session`, async route => {
    const response = await route.fetch(), identity = await response.json();
    identity.permissions.manageDuty = false;
    return route.fulfill({ response, json: identity });
  });
  await uncertain.page.route(`${uncertain.origin}/api/circle`, route => route.fulfill({ status: 500, json: { error: "Synthetic read failure after role loss" } }));
  await uncertain.page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(uncertain.page.locator(".care-rotation")).toHaveCount(0);
  checks.push("role loss hides rotation before failed data read");

  await page.route(`${origin}/api/session`, route => route.fulfill({ status: 401, json: { error: "Synthetic expired session" } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator(".care-rotation")).toHaveCount(0);
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  checks.push("session loss clears proposal and controls");
  assert.deepEqual(errors, [], "No JavaScript page errors");
  assert.deepEqual(blockedOrigins, [], "The local journey must not attempt external requests");
  console.log(JSON.stringify({ passed: true, viewports: [375, 768, 1280], checks, output,
    acceptedAssignments: receipt.assigned, pageErrors: errors, blockedOrigins,
    boundary: "Actual local memory repository and HTTP routes; synthetic identity; request interception only for failures and capability/session loss." }, null, 2));
} finally {
  for (const context of contexts) await context.close();
  if (browser) await browser.close();
  for (const child of children) child.kill("SIGTERM");
}
