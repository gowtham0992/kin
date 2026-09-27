// Real local family APIs and memory store; synthetic auth. No AWS, real accounts, audio, or hardware printing.
// KIN_PLAYWRIGHT_MODULE may point to an existing playwright/test module; KIN_BROWSER_CHANNEL selects Chrome.
// Run with node --import tsx scripts/verify-week-browser.mjs [output-directory].
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { InMemoryCareStore } from "../src/domain.ts";
import { BedrockBriefGenerator, WeeklyBriefService } from "../src/weekly-brief.ts";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-week-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3041";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "success", "3041"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const errors = [], writes = [], blockedOrigins = [];
const at = new Date("2026-09-13T18:00:00.000Z");
const checkIn = (id, title, state, dueAt = at.toISOString(), lastResponse = null) => ({
  id, title, state, dueAt, lastResponse, confirmedAt: lastResponse ? at.toISOString() : null, confirmedBy: null,
});
const mixedStore = new InMemoryCareStore([
  checkIn("old-open", "Outside the seven-day window", "scheduled", "2026-09-06T18:00:00.000Z"),
  checkIn("completed", "Morning water", "done", "2026-09-13T15:00:00.000Z", "done"),
  checkIn("skipped", "Afternoon walk", "skipped", "2026-09-13T16:00:00.000Z", "skipped"),
  checkIn("open", "Call together", "scheduled"),
  checkIn("early", "Evening check-in", "scheduled", "2026-09-13T21:00:00.000Z", "not_yet"),
  checkIn("cancelled", "Canceled visit", "cancelled", "2026-09-13T22:00:00.000Z"),
  checkIn("future", "Untouched future check-in", "scheduled", "2026-09-13T23:00:00.000Z"),
], () => at);
const mixedActivity = mixedStore.activityBetween.bind(mixedStore);
mixedStore.activityBetween = async period => ({ ...await mixedActivity(period), escalations: [{
  id: "accepted", taskId: "completed", dueAt: "2026-09-13T15:00:00.000Z", updatedAt: "2026-09-13T15:20:00.000Z",
  status: "sent", recipientMemberId: "maya", recipientMemberName: "Maya", sentAt: "2026-09-13T15:05:00.000Z",
  acknowledgedAt: "2026-09-13T15:20:00.000Z",
}, {
  id: "pending-receipt", taskId: "open", dueAt: at.toISOString(), updatedAt: at.toISOString(),
  status: "receipt_pending", recipientMemberId: "theo", recipientMemberName: "Theo", sentAt: "2026-09-13T17:59:00.000Z",
}] });
const mixedBrief = await new WeeklyBriefService(mixedStore, new BedrockBriefGenerator({ modelId: "synthetic-model", client: {
  send: async () => { throw new Error("Synthetic model outage"); },
} })).create(at);
assert.equal(mixedBrief.generatedBy, "deterministic");
assert.deepEqual(mixedBrief.stats, { scheduled: 4, completed: 1, skipped: 1, stillOpen: 2, escalations: 2 });
assert.equal(mixedBrief.evidence.length, 8);
assert.equal(mixedBrief.responsibility.acknowledgment.withinWindow, 1);
assert.equal(mixedBrief.responsibility.acknowledgment.pending, 1);
assert.ok(!JSON.stringify(mixedBrief).includes("Untouched future check-in"));
assert.ok(!JSON.stringify(mixedBrief.overview).includes("Outside the seven-day window"));
assert.ok(mixedBrief.evidence.some(fact => fact.fact.includes("Prior comparison period") && fact.fact.includes("Outside the seven-day window")));
const selectedBrief = await new WeeklyBriefService(mixedStore, new BedrockBriefGenerator({ modelId: "synthetic-model", client: {
  send: async () => ({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 30 }, output: { message: { role: "assistant", content: [{ text: JSON.stringify({
    overviewEvidenceIds: mixedBrief.evidence.filter(fact => !fact.fact.startsWith("Prior comparison period:")).map(fact => fact.id),
    highlightEvidenceIds: ["task:open:2026-09-13T18:00:00.000Z", "escalation:pending-receipt"],
    followUps: [{ kind: "check_open_task", evidenceId: "task:open:2026-09-13T18:00:00.000Z" }],
  }) }] } } }),
} })).create(at);
assert.equal(selectedBrief.generatedBy, "bedrock");
assert.deepEqual(selectedBrief.evidence, mixedBrief.evidence);
assert.deepEqual(selectedBrief.stats, mixedBrief.stats);
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Synthetic Week preview startup timed out")), 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Synthetic Week preview exited: ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview")) { clearTimeout(timeout); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Denver", serviceWorkers: "block" });
  await context.route("**/*", route => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) return route.continue();
    blockedOrigins.push(requested.origin); return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.method() === "POST" && /\/api\/routines\/[^/]+\/change$/.test(request.url())) writes.push(request.postDataJSON()); });
  // A completed response is recorded activity even when this run precedes the seed's due time.
  const today = await (await page.request.get(`${origin}/api/today`)).json();
  const task = today.tasks[0]; assert.ok(task);
  const completed = await page.request.post(`${origin}/api/tasks/${encodeURIComponent(task.id)}/confirm`, {
    data: { response: "done", actor: "Maya", requestId: "week-browser-recorded-check-in", expected: {
      title: task.title, dueAt: task.dueAt, state: task.state, lastResponse: task.lastResponse, confirmedAt: task.confirmedAt, confirmedBy: task.confirmedBy,
    } },
  });
  assert.equal(completed.ok(), true);
  const brief = await (await page.request.get(`${origin}/api/weekly-brief`)).json();
  assert.ok(brief.evidence.length > 0, "The real local brief needs recorded source facts");
  await page.goto(`${origin}/invite.html#week`);
  await expect(page.getByRole("heading", { name: brief.headline, exact: true })).toBeVisible();
  const details = page.locator(".care-brief-evidence");
  await expect(details).not.toHaveAttribute("open", "");
  for (const group of await page.locator(".care-source-group").all()) {
    await expect(group).not.toHaveAttribute("open", "");
    await expect(group.locator(".care-source-link").first()).toBeHidden();
    await group.locator("summary").press("Enter");
    await expect(group).toHaveAttribute("open", "");
    await expect(group.locator(".care-source-link").first()).toBeVisible();
  }
  for (const [index, fact] of brief.evidence.entries()) {
    const source = page.locator(`#brief-source-${index + 1}`);
    await expect(source.locator("code")).toHaveText(fact.id);
    await expect(source).toContainText(fact.fact);
    const dueLabel = fact.kind === "care_task" ? "Check-in due" : "Related check-in due";
    await expect(source).toContainText(dueLabel);
    const visibleDate = await page.evaluate(value => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)), fact.occurredAt);
    await expect(source).toContainText(visibleDate);
  }
  for (const button of await page.locator(".care-source-link").all()) {
    const number = Number((await button.textContent()).replace("Source ", ""));
    await expect(button).toHaveAttribute("aria-controls", `brief-source-${number}`);
    await button.click();
    await expect(details).toHaveAttribute("open", "");
    await expect(page.locator(`#brief-source-${number}`)).toBeFocused();
    await expect(page).toHaveURL(`${origin}/invite.html#week`);
    await page.locator(`#brief-source-${number}`).getByRole("button", { name: "Back to summary", exact: true }).click();
    await expect(button).toBeFocused();
  }
  // Close before each keyboard print lifecycle; no print dialog or printer is invoked.
  const printState = async open => {
    const groups = await page.locator(".care-source-group").all();
    for (const [index, group] of groups.entries()) await group.evaluate((element, next) => { element.open = next; }, index % 2 === 1);
    await details.evaluate((element, next) => { element.open = next; }, open);
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await expect(details).toHaveAttribute("open", "");
    for (const group of groups) await expect(group).toHaveAttribute("open", "");
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#brief-source-1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Print visit notes" })).toBeHidden();
    for (const back of await page.locator(".care-source-return").all()) await expect(back).toBeHidden();
    await page.screenshot({ path: path.join(output, `week-print-${open ? "open" : "closed"}.png`), fullPage: true });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    assert.equal(await details.evaluate(element => element.open), open, "Restore the pre-print disclosure state");
    for (const [index, group] of groups.entries()) assert.equal(await group.evaluate(element => element.open), index % 2 === 1, "Restore each citation group's pre-print state");
  };
  await printState(false); await printState(true);
  await page.evaluate(() => { window.__kinPrintRequests = 0; window.print = () => { window.__kinPrintRequests += 1; }; });
  await page.getByRole("button", { name: "Print visit notes" }).click();
  assert.equal(await page.evaluate(() => window.__kinPrintRequests), 1, "The UI requests one print operation");

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await details.evaluate(element => { element.open = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Week overflow at ${width}px`);
    assert.equal(await page.locator(".care-source-link").evaluateAll(elements => elements.every(element => {
      const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1;
    })), true, `Source controls clipped at ${width}px`);
    await page.screenshot({ path: path.join(output, `week-${width}.png`), fullPage: true });
  }

  // The real routine API receives nothing after stale review consent; renewed review submits once.
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  const due = await page.evaluate(() => {
    const day = new Date(); day.setDate(day.getDate() + 1); day.setHours(9, 0, 0, 0);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T09:00`;
  });
  await page.locator("#plan-title").fill("A morning call together");
  await page.locator("#plan-due").fill(due); await page.locator("#plan-repeat").selectOption("7");
  await page.getByRole("button", { name: "Save care plan", exact: true }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Care plan saved.");
  const plan = await (await page.request.get(`${origin}/api/plan`)).json();
  const routineId = plan.tasks.find(task => task.title === "A morning call together")?.routineId;
  assert.ok(routineId);
  const form = page.locator(`#routine-${routineId}`).locator("xpath=ancestor::form");
  await form.locator("..").locator("summary").click();
  await form.getByRole("checkbox").check();
  await form.getByLabel("Check-in wording", { exact: true }).fill("A quiet morning call");
  await expect(form.getByRole("checkbox")).not.toBeChecked();
  await form.getByRole("button", { name: "Apply reviewed change" }).click();
  assert.equal(writes.length, 0, "Edited wording requires new review consent");
  await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(page.locator("#workspace-status")).toHaveText("Routine updated.");
  assert.equal(writes.length, 1); assert.equal(writes[0].title, "A quiet morning call");
  const changed = await (await page.request.get(`${origin}/api/plan`)).json();
  assert.equal(changed.tasks.filter(task => task.routineId === routineId && task.title === "A quiet morning call").length, 7);

  // Mixed, fixed-clock service fixture: real summary logic; synthetic repository/model boundary.
  await page.route(`${origin}/api/weekly-brief`, route => route.fulfill({ json: mixedBrief }));
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(page.getByRole("heading", { name: mixedBrief.headline, exact: true })).toBeVisible();
  await expect(page.locator(".care-count")).toHaveText("1 completed · 1 skipped · 2 still open");
  await expect(page.getByText("Prepared directly from recorded activity; no generated interpretation.")).toBeVisible();
  for (const [index, fact] of mixedBrief.evidence.entries()) {
    await expect(page.locator(`#brief-source-${index + 1} code`)).toHaveText(fact.id);
    await expect(page.locator(`#brief-source-${index + 1}`)).toContainText(fact.fact);
  }
  await expect(page.locator(".care-brief-evidence")).toContainText("Prior comparison period: Outside the seven-day window");
  await expect(page.getByRole("heading", { name: "Patterns in recorded replies" })).toBeVisible();
  await expect(page.locator("#workspace-content")).not.toContainText("Untouched future check-in");
  const mixedGroups = await page.locator(".care-source-group").all();
  assert.ok(mixedGroups.length > 0, "The mixed week exercises long citation groups");
  for (const group of mixedGroups) {
    await expect(group).not.toHaveAttribute("open", "");
    await group.locator("summary").press("Enter");
    await expect(group.locator(".care-source-link").first()).toBeVisible();
    await group.locator("summary").press("Enter");
  }
  await page.evaluate(() => {
    window.__kinActualPrintEvents = [];
    for (const name of ["beforeprint", "afterprint"]) window.addEventListener(name, () => window.__kinActualPrintEvents.push(name));
  });
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".workspace-secondary")).toBeHidden();
  await expect(page.locator("footer.kin-trust-link")).toBeHidden();
  await page.pdf({ path: path.join(output, "week-mixed-visit-notes.pdf"), format: "Letter", printBackground: true,
    margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" } });
  assert.deepEqual(await page.evaluate(() => window.__kinActualPrintEvents), ["beforeprint", "afterprint"]);
  await expect(details).not.toHaveAttribute("open", "");
  await page.emulateMedia({ media: "screen" });
  await details.locator("summary").click();
  await page.screenshot({ path: path.join(output, "week-mixed-sources.png"), fullPage: true });
  await writeFile(path.join(output, "week-mixed-synthetic-brief.json"), `${JSON.stringify(mixedBrief, null, 2)}\n`);
  await page.unroute(`${origin}/api/weekly-brief`);

  await page.route(`${origin}/api/weekly-brief`, route => route.fulfill({ json: selectedBrief }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Evidence selected with Amazon Bedrock; wording comes from recorded facts.")).toBeVisible();
  await expect(page.locator(".care-count")).toHaveText("1 completed · 1 skipped · 2 still open");
  await expect(page.locator("#workspace-content")).toContainText(selectedBrief.overview);
  await expect(page.getByText("Call together was still open.", { exact: true }).first()).toBeVisible();
  await page.unroute(`${origin}/api/weekly-brief`);

  // Malformed and empty source states use explicit browser-boundary fixtures only.
  await page.route(`${origin}/api/weekly-brief`, async route => {
    const data = structuredClone(brief); data.highlights = [{ text: "A synthetic point with an unavailable source.", evidenceIds: ["missing"] }];
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("A source for this point is unavailable.")).toBeVisible();
  await expect(page.locator('[aria-controls="missing"]')).toHaveCount(0);
  await page.unroute(`${origin}/api/weekly-brief`);
  await page.route(`${origin}/api/weekly-brief`, async route => {
    const data = { ...structuredClone(brief), headline: "No care activity recorded this week", overview: "No recorded activity.", evidence: [], overviewEvidenceIds: [], highlights: [], followUps: [], stats: { completed: 0, skipped: 0, stillOpen: 0 } };
    await route.fulfill({ json: data });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No care activity recorded this week", exact: true })).toBeVisible();
  await page.locator(".care-brief-evidence > summary").click();
  await expect(page.getByText("No source records were returned for this period.")).toBeVisible();
  await expect(page.locator(".care-source-link")).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "week-empty.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(blockedOrigins, []);
  console.log(JSON.stringify({ passed: true, viewports: [375, 768, 1280], checks: ["real-brief-api", "source-id-mapping", "due-dates", "source-focus", "hash-preserved", "print-events-expand-and-restore", "print-button-wired-no-printer", "actual-pdf-print-events", "mixed-counts-and-sources", "synthetic-model-outage-fallback", "synthetic-model-selection-label", "fresh-routine-review", "real-routine-save", "missing-source", "empty-source", "same-origin-only", "no-overflow", "no-page-errors"], output }));
} finally { await browser?.close(); child.kill("SIGTERM"); }
