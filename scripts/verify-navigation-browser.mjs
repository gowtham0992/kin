// Local memory APIs and synthetic identities only. No live accounts, AWS, audio, or messages.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect } from "playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-navigation-browser");
const origin = "http://127.0.0.1:3057";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3057"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const errors = [], blocked = [], writes = [];
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Navigation preview startup timed out")), 10000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Preview exited: ${code}`)); });
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
  page.on("request", request => { if (/\/api\/tasks\/[^/]+\/confirm$/.test(request.url())) writes.push(request.postDataJSON()); });
  await page.goto(`${origin}/invite.html#today`);
  const primary = page.getByRole("navigation", { name: "Family workspace", exact: true });
  await expect(primary).toBeVisible();
  assert.deepEqual(await primary.getByRole("link").allTextContents(), ["Today", "Plan", "Turns", "Week"]);
  await expect(page.locator("#workspace-secondary")).toBeVisible();
  await expect(page.locator("#workspace-management")).not.toHaveAttribute("open", "");
  await expect(page.locator("#workspace-content")).toContainText("Updates are recorded via Maya’s Kin account");
  const contrast = (foreground, background) => {
    const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const colors = await page.evaluate(() => {
    const active = getComputedStyle(document.querySelector('#workspace-nav a[aria-current]'));
    const inactive = getComputedStyle(document.querySelector('#workspace-nav a:not([aria-current])'));
    return { active: active.color, activeBackground: active.backgroundColor, inactive: inactive.color, background: getComputedStyle(document.body).backgroundColor };
  });
  const ratios = { active: contrast(colors.active, colors.activeBackground), inactive: contrast(colors.inactive, colors.background) };
  assert.ok(ratios.active >= 4.5 && ratios.inactive >= 4.5, "Navigation text meets AA contrast");

  await mkdir(output, { recursive: true });
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    const boxes = [];
    for (const link of await primary.getByRole("link").all()) {
      const box = await link.boundingBox(); boxes.push(box);
      assert.ok(box.width >= 44 && box.height >= 44, `Small navigation target at ${width}px`);
      assert.ok(box.x >= 0 && box.x + box.width <= width, `Clipped navigation target at ${width}px`);
    }
    assert.equal(new Set(boxes.map(box => box.y)).size, 1, `Primary navigation wraps at ${width}px`);
    await page.screenshot({ path: path.join(output, `today-${width}.png`), fullPage: true });
  }
  await primary.getByRole("link", { name: "Plan", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-content")).toBeFocused();
  await expect(primary.getByRole("link", { name: "Plan", exact: true })).toHaveAttribute("aria-current", "page");
  const planForm = page.getByRole("form", { name: "Schedule a check-in" });
  const planHelp = page.locator("#plan-editing-help"), planSummary = planHelp.locator("summary");
  await expect(planHelp).not.toHaveAttribute("open", "");
  await expect(planHelp.locator("p")).not.toBeVisible();
  await expect(page.locator("#plan-notification-note")).toBeVisible();
  await expect(page.locator("#plan-draft-note")).toBeVisible();
  await expect(page.locator("#plan-due")).toHaveAttribute("aria-describedby", "plan-time-note");
  assert.equal(await planForm.evaluate(form => {
    const save = form.querySelector('button[type="submit"]');
    return !!(save.compareDocumentPosition(form.querySelector('#plan-editing-help')) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, "Optional management help follows Save");
  await planSummary.focus(); await page.keyboard.press("Enter");
  await expect(planHelp).toHaveAttribute("open", "");
  await expect(planHelp.locator("p")).toContainText("future, untouched check-ins");
  assert.equal(await planSummary.evaluate(el => getComputedStyle(el).outlineStyle !== "none"), true, "Keyboard focus is visible");
  await page.keyboard.press("Enter"); await expect(planHelp).not.toHaveAttribute("open", "");
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await planForm.evaluate(form => {
      const controls = [...form.querySelectorAll('input, select, button, summary')];
      return controls.map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right }; });
    });
    assert.ok(dimensions.every(r => r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= width), `Plan controls fit at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator("#plan-title").fill("A draft for our next call");
  await primary.getByRole("link", { name: "Turns", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Who’s taking the next turn?" })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/invite.html#turns`);
  const dutyDays = page.locator('.care-duty-day');
  await expect(dutyDays).toHaveCount(7);
  await expect(dutyDays.locator('select').first()).not.toBeVisible();
  const firstDay = dutyDays.first(), firstSummary = firstDay.locator('summary');
  await firstSummary.focus(); await page.keyboard.press('Enter');
  await expect(firstDay.locator('select')).toBeVisible();
  assert.equal(await firstSummary.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), true);
  const originalDuty = await firstDay.locator('select').inputValue();
  await firstDay.locator('select').selectOption('__clear__');
  await firstDay.getByRole('button', {name:'Review handoff',exact:true}).click();
  await expect(firstDay.getByRole('heading',{name:'Clear this assignment?',exact:true})).toBeVisible();
  await expect(firstDay.getByRole('button',{name:'Confirm clear assignment',exact:true})).toBeFocused();
  await firstDay.getByRole('button',{name:'Keep unchanged',exact:true}).click();
  await expect(firstDay.locator('select')).toHaveValue(originalDuty);
  await expect(firstDay.locator('select')).toBeFocused();
  await firstSummary.focus();
  await page.keyboard.press('Enter');
  await expect(firstDay.locator('select')).not.toBeVisible();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({width, height:900});
    const bounds = await dutyDays.locator('summary').evaluateAll(items => items.map(el => { const r=el.getBoundingClientRect(); return {height:r.height,left:r.left,right:r.right}; }));
    assert.ok(bounds.every(r=>r.height>=44 && r.left>=0 && r.right<=width));
    const overviewHeight = await page.locator('.care-duty-week').evaluate(el=>el.getBoundingClientRect().height);
    assert.ok(overviewHeight < 650, 'The ordinary seven-day overview stays compact without disclosure margins');
    await page.screenshot({path:path.join(output, `turns-overview-${width}.png`),fullPage:true});
  }
  // Exercise expanded layouts too; hiding controls must not hide layout defects.
  for (const summary of await dutyDays.locator('summary').all()) await summary.click();
  for (const width of [320, 375, 620, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = await page.locator('.care-duty-week .care-roster-row').evaluateAll(rows => rows.map(row => {
      const r = row.getBoundingClientRect(), s = row.querySelector('select').getBoundingClientRect();
      const label = row.querySelector('label').getBoundingClientRect(), button = row.querySelector('button').getBoundingClientRect();
      return { rowWidth: r.width, selectWidth: s.width, selectHeight: s.height, left: s.left, right: s.right,
        belowLabel: s.top >= label.bottom, buttonBelow: button.top >= s.bottom, buttonHeight: button.height };
    }));
    assert.equal(rows.length, 7);
    assert.ok(rows.every(r => r.selectHeight >= 44 && r.buttonHeight >= 44 && r.left >= 0 && r.right <= width), `Duty controls fit at ${width}px`);
    if (width <= 620) assert.ok(rows.every(r => Math.abs(r.selectWidth - r.rowWidth) < 1 && r.belowLabel && r.buttonBelow), `Phone duty rows use full-width choices at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.goBack();
  await expect(page.locator("#plan-title")).toHaveValue("A draft for our next call");
  await page.goto(`${origin}/invite.html#circle`);
  await expect(page.getByRole("heading", { name: "Who’s taking the next turn?" })).toBeVisible();
  await expect(primary.getByRole("link", { name: "Turns", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(`${origin}/invite.html#circle`);
  await page.reload();
  await expect(primary.getByRole("link", { name: "Turns", exact: true })).toHaveAttribute("aria-current", "page");
  await primary.getByRole("link", { name: "Week", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(primary.getByRole("link", { name: "Week", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#workspace-content h2")).toBeVisible();
  await expect(page.locator("#workspace-content")).toBeFocused();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator("#workspace-management summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-invite-link")).toBeVisible();
  await expect(page.locator("#workspace-access-link")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Expanded organizer menu fits a narrow phone");

  await page.locator("#workspace-ask-link").click();
  await page.locator("#care-request").fill("Not yet: Drink a glass of water");
  await primary.getByRole("link", { name: "Today", exact: true }).click();
  await page.locator("#workspace-ask-link").click();
  await expect(page.locator("#care-request")).toHaveValue("Not yet: Drink a glass of water");
  await expect(page.locator("#workspace-content")).toContainText("Updates are recorded via Maya’s Kin account");

  // A failed new-view read remains recoverable from that view, with keyboard focus.
  let releaseRead;
  const heldRead = new Promise(resolve => { releaseRead = resolve; });
  await page.route("**/api/plan", async route => { await heldRead; return route.fulfill({ status: 503, json: { error: "unavailable" } }); });
  await primary.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page.locator("#workspace-content")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#workspace-content")).toContainText("Loading Plan");
  await expect(page.locator("#care-request")).toHaveCount(0);
  await expect(page.locator(".care-loading-lines")).toHaveAttribute("aria-hidden", "true");
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Loading overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `loading-${width}.png`), fullPage: true });
  }
  releaseRead();
  await expect(page.locator("#workspace-status")).toContainText("Could not refresh");
  await expect(page.locator("#workspace-content")).not.toHaveAttribute("aria-busy");
  await expect(page.locator("#workspace-content")).toContainText("Plan is temporarily unavailable");
  await expect(page.locator("#workspace-content")).toBeFocused();
  await page.unroute("**/api/plan");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#plan-title")).toBeVisible();

  // Keep an uncertain save bound to its current view and exact retry body.
  await primary.getByRole("link", { name: "Today", exact: true }).click();
  let lost = false;
  await page.route("**/api/tasks/*/confirm", async route => {
    if (lost) return route.continue();
    lost = true; const response = await route.fetch(); assert.ok(response.ok());
    return route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Done", exact: true }).first().click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await primary.getByRole("link", { name: "Turns", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/invite.html#today`);
  await expect(primary.getByRole("link", { name: "Today", exact: true })).toHaveAttribute("aria-current", "page");
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(writes[0].actor, "Maya");

  // Exercise the UI with server-provided role capabilities; API enforcement has separate integration tests.
  for (const role of ["caregiver", "care_recipient", "viewer"]) {
    await page.route("**/api/session", async route => {
      const response = await route.fetch(); const session = await response.json();
      return route.fulfill({ json: { ...session, role, permissions: { confirm: role !== "viewer", manageDuty: role === "caregiver", manageRoster: false, invite: false } } });
    });
    await page.goto(`${origin}/invite.html#turns`);
    await expect(primary).toBeVisible();
    await expect(page.locator("#workspace-management")).toBeHidden();
    await expect(page.locator("#workspace-ask-link"))[role === "viewer" ? "toBeHidden" : "toBeVisible"]();
    if (role !== "caregiver") await expect(page.locator(".care-roster select").first()).toBeDisabled();
    await page.goto(`${origin}/invite.html#ask`);
    if (role === "viewer") await expect(page.locator("#care-request")).toHaveCount(0);
    else await expect(page.locator("#care-request")).toBeVisible();
    await page.unroute("**/api/session");
  }
  // Fresh access loss clears both navigation levels and private content.
  await page.goto(`${origin}/invite.html#today`);
  await expect(primary).toBeVisible();
  await page.route("**/api/session", route => route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(primary).toBeHidden();
  await expect(page.locator("#workspace-secondary")).toBeHidden();
  await expect(page.locator("#workspace-content")).toBeEmpty();
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log(JSON.stringify({ passed: true, widths: [320, 375, 768, 1280], contrast: ratios, checks: ["primary-navigation", "secondary-controls", "keyboard-focus", "back-refresh-legacy-circle", "plan-and-conversation-drafts", "read-error-recovery", "uncertain-save-retry", "role-controls", "signed-in-author", "access-loss-clears-content"], output }));
} finally { await browser?.close(); child.kill("SIGTERM"); }
