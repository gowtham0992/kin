// Real local HTTP/MCP and the actual family workspace, with a synthetic account
// proxy. This is not OAuth, Alexa, device, microphone, Bedrock, or AWS evidence.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] || "/tmp/kin-family-mcp-browser");
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:3043";
const maya = "Bearer synthetic-family-mcp-maya", theo = "Bearer synthetic-family-mcp-theo";
const child = spawn(process.execPath, ["--import", "tsx", "scripts/preview-invitations.ts", "mcp-family", "3043"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
});
let browser;
const errors = [], rpc = [], mcpRequests = [], restWrites = [], forbidden = [], checks = [];
const safeRoute = handler => async route => {
  try { await handler(route); }
  catch (error) { errors.push(error.message); await route.abort().catch(() => {}); }
};
const api = async (pathname, options = {}) => {
  const result = await fetch(`${origin}${pathname}`, { ...options, headers: { authorization: maya, ...options.headers } });
  assert.ok(result.ok, `Synthetic ${pathname} returned ${result.status}`);
  return result.json();
};
const externalConfirm = async (taskId, response, requestId) => {
  const task = (await api("/api/today")).tasks.find(task => task.id === taskId);
  const expected = Object.fromEntries(["title", "dueAt", "state", "lastResponse", "confirmedAt", "confirmedBy"].map(key => [key, task[key]]));
  return api(`/api/tasks/${taskId}/confirm`, { method: "POST", headers: { "content-type": "application/json", authorization: theo },
    body: JSON.stringify({ response, requestId, expected, actor: "Untrusted synthetic name" }) });
};
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Family MCP fixture startup timed out")), 10000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Family MCP fixture exited: ${code}`)); });
    child.stdout.on("data", data => { if (String(data).includes("Synthetic invitation preview (mcp-family)")) { clearTimeout(timeout); resolve(); } });
  });
  assert.equal((await fetch(`${origin}/api/session`)).status, 401);
  assert.equal((await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) })).status, 401);
  checks.push("synthetic-auth-required");
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== origin) forbidden.push(url.origin);
    if (/\/api\/tasks\/[^/]+\/confirm$/.test(url.pathname)) restWrites.push(request.postData());
    if (url.pathname !== "/mcp") return;
    mcpRequests.push({ method: request.method(), authorization: request.headers().authorization });
    if (request.method() !== "POST") return;
    const frame = request.postDataJSON();
    if (frame?.method === "tools/call") rpc.push({ frame, authorization: request.headers().authorization });
  });
  await page.goto(`${origin}/invite.html#ask`);
  await expect(page.locator(".care-mcp-badge")).toContainText("Simulated Alexa+ experience · real MCP");
  await expect(page.locator("#workspace-identity")).toContainText("Maya");
  const review = async message => {
    await page.locator("#care-request").fill(message);
    await page.getByRole("button", { name: "Review request", exact: true }).click();
  };
  await review("Show today");
  await expect(page.getByRole("heading", { name: "Today’s shared plan", exact: true })).toBeVisible();
  assert.ok(rpc.some(call => call.frame.params.name === "show_today"));
  assert.ok(rpc.every(call => call.authorization === maya));
  await page.locator(".care-mcp-trace > summary").click();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `family-mcp-read-${width}.png`), fullPage: true });
  }
  checks.push("actual-authenticated-show-today", "three-responsive-viewports");

  await review("Not yet: Drink a glass of water");
  await expect(page.getByRole("heading", { name: "Review this check-in", exact: true })).toBeVisible();
  assert.equal(rpc.filter(call => call.frame.params.name === "confirm_care_task").length, 0);
  await page.getByRole("button", { name: "Confirm this check-in", exact: true }).click();
  await expect(page.locator("#workspace-status")).toContainText("Check-in recorded.");
  const notYet = rpc.find(call => call.frame.params.name === "confirm_care_task");
  assert.equal(notYet.frame.params.arguments.response, "not_yet");
  assert.equal(restWrites.length, 0, "Ask Kin must save via MCP, not REST confirmation");
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.locator(".care-today > .care-plan")).toContainText("Not yet");
  assert.equal((await api("/api/today")).tasks.find(task => task.id === "morning-water").lastResponse, "not_yet");
  checks.push("separate-review-before-mcp-write", "independent-today-persists-result");

  await page.getByRole("link", { name: "Ask Kin", exact: true }).click();
  let dropped = false;
  const loseResponse = safeRoute(async route => {
    const request = route.request(), frame = request.method() === "POST" ? request.postDataJSON() : null;
    if (!dropped && frame?.method === "tools/call" && frame.params.name === "confirm_care_task" && frame.params.arguments.response === "done") {
      dropped = true;
      const committed = await route.fetch(); assert.ok(committed.ok());
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.route("**/mcp", loseResponse);
  await review("Done: Drink a glass of water");
  await expect(page.getByRole("button", { name: "Confirm this check-in", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm this check-in", exact: true }).click();
  await expect(page.locator("#workspace-retry-write")).toBeVisible();
  await expect(page.locator("#care-request")).toBeDisabled();
  await page.unroute("**/mcp", loseResponse);
  await page.locator("#workspace-retry-write").click();
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  await expect(page.locator("#workspace-status")).toContainText("Check-in recorded.");
  const doneCalls = rpc.filter(call => call.frame.params.name === "confirm_care_task" && call.frame.params.arguments.taskId === "morning-water" && call.frame.params.arguments.response === "done");
  assert.equal(doneCalls.length, 2);
  assert.deepEqual(doneCalls[0].frame.params.arguments, doneCalls[1].frame.params.arguments);
  assert.equal((await api("/api/today")).summary.completed, 1);
  checks.push("committed-response-loss-identical-id-retry");

  // The MCP read and REST interpreter must describe the same reviewed task.
  let racedRead = false;
  const staleInterpretation = safeRoute(async route => {
    if (!racedRead) { racedRead = true; await externalConfirm("afternoon-walk", "not_yet", "external-stale-read-01"); }
    await route.continue();
  });
  await page.route("**/api/conversation", staleInterpretation);
  const writesBeforeMismatch = rpc.filter(call => call.frame.params.name === "confirm_care_task").length;
  await review("Done: Take the afternoon walk");
  await expect(page.locator(".care-conversation").locator("..")).toContainText("shared check-in changed while you were reviewing");
  await expect(page.getByRole("button", { name: "Confirm this check-in", exact: true })).toHaveCount(0);
  assert.equal(rpc.filter(call => call.frame.params.name === "confirm_care_task").length, writesBeforeMismatch);
  await page.unroute("**/api/conversation", staleInterpretation);

  await review("Done: Take the afternoon walk");
  await expect(page.getByRole("button", { name: "Confirm this check-in", exact: true })).toBeVisible();
  await externalConfirm("afternoon-walk", "done", "external-stale-write-01");
  const beforeStaleWrite = rpc.filter(call => call.frame.params.name === "confirm_care_task").length;
  await page.getByRole("button", { name: "Confirm this check-in", exact: true }).click();
  await expect(page.locator("#workspace-status")).not.toContainText("Saving…");
  await expect(page.locator("#workspace-retry-write")).toBeHidden();
  assert.equal(rpc.filter(call => call.frame.params.name === "confirm_care_task").length, beforeStaleWrite + 1);
  await expect(page.locator(".care-mcp-trace")).toContainText("confirm_care_task · error");
  const walk = (await api("/api/today")).tasks.find(task => task.id === "afternoon-walk");
  assert.equal(walk.confirmedBy, "Theo", "Stale MCP write must not overwrite another account's response");
  assert.equal(walk.state, "done");
  checks.push("mcp-rest-snapshot-conflict", "stale-mcp-write-preserves-other-account");

  await review("Weekly brief");
  await expect(page.locator(".care-mcp-trace")).toContainText("show_weekly_brief");
  const trace = await page.locator(".care-mcp-trace").textContent();
  assert.ok(rpc.some(call => trace.includes(`RPC ${call.frame.id}`)), "Trace must reflect actual emitted RPC IDs");
  for (const privateValue of [maya, theo, "morning-water", "afternoon-walk", "Drink a glass of water", "Take the afternoon walk", ...rpc.map(call => call.frame.params.arguments.requestId).filter(Boolean)]) {
    assert.ok(!trace.includes(privateValue), "Trace must not show tokens, task IDs, task text, or confirmation request IDs");
  }
  checks.push("actual-bounded-redacted-trace", "mcp-weekly-brief");
  for (let index = 0; index < 21; index += 1) {
    await review("Show today");
    await expect(page.locator("#care-request")).toBeEnabled();
  }
  await expect(page.locator(".care-mcp-trace li")).toHaveCount(40);

  // Hold an old session's MCP read, close it, open another synthetic account,
  // then release the old response. It must not issue a new-account continuation.
  let releaseOld, held;
  const oldHeld = new Promise(resolve => { held = resolve; });
  const pauseOld = safeRoute(async route => {
    const request = route.request(), frame = request.method() === "POST" ? request.postDataJSON() : null;
    if (frame?.method === "tools/call" && frame.params.name === "show_today") {
      held(); await new Promise(resolve => { releaseOld = resolve; });
    }
    await route.continue();
  });
  await page.route("**/mcp", pauseOld);
  await review("Show today"); await oldHeld;
  await page.locator(".workspace-account > summary").click();
  await page.getByRole("button", { name: "Close synthetic workspace", exact: true }).click();
  await expect(page.locator("#workspace")).toBeHidden();
  await expect(page.locator(".care-mcp-trace")).toHaveCount(0);
  await page.getByRole("button", { name: "Open synthetic Theo session", exact: true }).click();
  await expect(page.locator("#workspace-identity")).toContainText("Theo");
  await expect(page.locator(".care-mcp-trace > summary")).toContainText("0 events");
  const afterClosure = mcpRequests.length;
  const oldResponse = page.waitForResponse(response => response.url() === `${origin}/mcp` && response.request().postDataJSON()?.params?.name === "show_today");
  releaseOld(); await oldResponse;
  await page.unroute("**/mcp", pauseOld);
  await expect(page.locator(".care-mcp-trace > summary")).toContainText("0 events");
  assert.equal(mcpRequests.length, afterClosure, "Old-session continuation must not create another MCP request");
  await review("Show today");
  await expect(page.getByRole("heading", { name: "Today’s shared plan", exact: true })).toBeVisible();
  assert.equal(rpc.at(-1).authorization, theo);
  assert.ok(mcpRequests.every(request => request.authorization === maya || request.authorization === theo));
  assert.equal(restWrites.length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  checks.push("session-close-clears-trace", "old-session-no-new-identity-continuation", "fresh-identity-authenticated-read", "no-rest-save", "no-external-network", "no-page-errors");
  await page.screenshot({ path: path.join(output, "family-mcp-complete-1280.png"), fullPage: true });
  console.log(JSON.stringify({ passed: true, evidence: "synthetic authenticated request proxy; real local HTTP/MCP, not OAuth or Alexa", viewports: [375, 768, 1280], checks, output }));
} finally {
  await browser?.close();
  child.kill("SIGTERM");
}
