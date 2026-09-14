// Real local story/MCP routes; only the model and browser speech service are
// synthetic. This never requests microphone permission or invokes AWS.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLocalStoryApp } from "../src/local-story.ts";

const { chromium, expect } = await import(process.env.KIN_PLAYWRIGHT_MODULE || "playwright/test");
const output = path.resolve(process.argv[2] || "/tmp/kin-story-inputs-browser");
await mkdir(output, { recursive: true });
const modelCalls = [];
const server = createLocalStoryApp({ intentGenerator: async (message, tasks, focusedTaskId) => {
  modelCalls.push({ message, tasks, focusedTaskId });
  return { action: "confirm", taskId: "morning-water", response: "not_yet" };
} }).listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [], interpretations = [], writes = [], contrasts = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.KIN_BROWSER_CHANNEL ? { channel: process.env.KIN_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.storyRecognitionSessions = [];
    class FakeRecognition {
      constructor() { window.storyRecognitionSessions.push(this); }
      start() { this.started = true; }
      stop() { this.stopped = true; }
      abort() { this.aborted = true; }
      deliver(text) { const result = [{ transcript: text }]; result.isFinal = true; this.onresult?.({ results: [result] }); this.onend?.(); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() !== "POST") return;
    if (request.url() === `${origin}/demo/story/conversation`) interpretations.push(request.postDataJSON());
    if (request.url() === `${origin}/mcp` && request.postDataJSON()?.params?.name === "confirm_care_task") writes.push(request.postDataJSON());
  });
  await page.goto(`${origin}/story.html`);
  await expect(page.locator("#story-app")).toBeVisible();
  await expect(page.locator("#story-model-options")).toBeVisible();
  await expect(page.locator("#story-model-consent")).not.toBeChecked();
  assert.equal(modelCalls.length, 0);
  assert.equal(await page.evaluate(() => window.storyRecognitionSessions.length), 0, "No automatic microphone start");

  await page.locator("#story-message").fill("Not yet:");
  await page.locator("#story-model-consent").check();
  await page.locator("#story-voice-start").click();
  await expect(page.locator("#story-model-consent")).not.toBeChecked();
  for (const id of ["story-message", "story-submit", "story-confirm", "story-advance", "story-model-consent"]) await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.locator("#story-voice-stop")).toBeEnabled();
  await expect(page.locator("#story-voice-cancel")).toBeEnabled();
  await page.locator("#story-voice-stop").click();
  await expect(page.locator("#story-voice-stop")).toBeDisabled();
  await expect(page.locator("#story-voice-cancel")).toBeEnabled();
  await page.evaluate(() => window.storyRecognitionSessions.at(-1).deliver("Drink a glass of water"));
  await expect(page.locator("#story-message")).toHaveValue("Not yet: Drink a glass of water");
  assert.equal(interpretations.length, 0); assert.equal(writes.length, 0);

  await page.locator("#story-message").fill("I have not had my glass of water yet");
  await page.locator("#story-model-consent").check();
  await page.locator("#story-message").fill("I haven't had my glass of water yet");
  await expect(page.locator("#story-model-consent")).not.toBeChecked();
  await page.locator("#story-model-consent").check();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    await page.locator("#story-model-options").screenshot({ path: path.join(output, `nova-consent-${width}.png`) });
    if (width === 375) {
      const targets = await page.locator("#story-app button:visible, .story-model-choice:visible").evaluateAll(elements => elements.map(element => ({
        text: element.textContent, height: element.getBoundingClientRect().height,
      })));
      assert.ok(targets.every(target => target.height >= 44), `Short touch targets: ${JSON.stringify(targets.filter(target => target.height < 44))}`);
    }
  }
  const colors = await page.locator("#story-root").evaluate(element => {
    const s = getComputedStyle(element);
    return Object.fromEntries(["ink", "muted", "paper", "card", "sage", "sage-soft"].map(name => [name, s.getPropertyValue(`--${name}`).trim()]));
  });
  function luminance(hex) {
    const rgb = hex.replace("#", "");
    const components = hex.startsWith("rgb") ? hex.match(/[\d.]+/g).slice(0, 3).map(Number) : [0, 2, 4].map(offset => parseInt(rgb.slice(offset, offset + 2), 16));
    const values = components.map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  }
  for (const [foreground, background] of [["ink", "card"], ["muted", "paper"], ["muted", "card"], ["sage", "sage-soft"], ["card", "sage"]]) {
    const a = luminance(colors[foreground]), b = luminance(colors[background]);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    contrasts.push({ foreground, background, ratio: Number(ratio.toFixed(2)) });
    assert.ok(ratio >= 4.5, `Insufficient body contrast ${foreground}/${background}: ${ratio}`);
  }

  await page.locator("#story-submit").click();
  await expect(page.locator("#story-confirm")).toBeEnabled();
  await expect(page.locator("#story-confirm")).toBeFocused();
  assert.equal(modelCalls.length, 1); assert.equal(interpretations[0].allowModel, true); assert.equal(writes.length, 0);
  for (const [foregroundSelector, backgroundSelector] of [[".story-review .story-note", ".story-review"], ['.story-transcript li[data-speaker="Evelyn"] strong', '.story-transcript li[data-speaker="Evelyn"]']]) {
    const foreground = await page.locator(foregroundSelector).first().evaluate(element => getComputedStyle(element).color);
    const background = await page.locator(backgroundSelector).first().evaluate(element => getComputedStyle(element).backgroundColor);
    const a = luminance(foreground), b = luminance(background);
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `Low rendered contrast: ${foregroundSelector}`);
  }
  await expect(page.locator("#story-model-consent")).not.toBeChecked();
  await expect(page.locator("#story-model-budget")).toContainText("1 of 20");
  await page.locator("#story-message").fill("I did it");
  await expect(page.locator("#story-review")).toBeHidden();
  await page.locator("#story-submit").click();
  await expect(page.locator("#story-proposal")).toContainText("as done");
  assert.ok(interpretations[1].contextToken); assert.equal(interpretations[1].allowModel, undefined);
  assert.equal(modelCalls.length, 1); assert.equal(writes.length, 0);
  await page.locator("#story-confirm").click();
  await expect(page.locator("#story-care-plan")).toContainText("Done");
  assert.equal(writes.length, 1);
  const parentNote = await page.locator(".story-parent-plan .story-note").first().evaluate(element => getComputedStyle(element).color);
  const parentBackground = await page.locator(".story-parent-plan").evaluate(element => getComputedStyle(element).backgroundColor);
  const parentA = luminance(parentNote), parentB = luminance(parentBackground);
  assert.ok((Math.max(parentA, parentB) + .05) / (Math.min(parentA, parentB) + .05) >= 4.5, "Low rendered parent-plan contrast");

  await page.locator("#story-message").fill("Keep this draft");
  await page.locator("#story-voice-start").click();
  await page.locator("#story-voice-cancel").click();
  await page.evaluate(() => window.storyRecognitionSessions.at(-1).deliver("discard this late result"));
  await expect(page.locator("#story-message")).toHaveValue("Keep this draft");
  await page.locator("#story-voice-start").click();
  await page.evaluate(() => window.storyRecognitionSessions.at(-1).onerror({ error: "not-allowed" }));
  await expect(page.locator("#story-voice-status")).toContainText("denied");
  await expect(page.locator("#story-message")).toBeEnabled();
  await page.locator("#story-message").fill("Show today");
  await page.locator("#story-submit").click();
  await expect(page.locator("#story-status")).toContainText("Read through the local MCP server");

  const unsupported = await browser.newPage();
  await unsupported.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await unsupported.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  unsupported.on("pageerror", error => errors.push(error.message));
  await unsupported.goto(`${origin}/story.html`);
  await expect(unsupported.locator("#story-message")).toBeEnabled();
  await expect(unsupported.locator("#story-voice-start")).toBeDisabled();
  await expect(unsupported.locator("#story-voice-status")).toContainText("unavailable");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, boundary: "Synthetic speech and model; real local HTTP/MCP. No audio capture or AWS.",
    checks: ["explicit-model-consent", "draft-only-voice", "stop-cancel-locks", "consent-invalidated-by-edit", "context-follow-up", "separate-save", "late-voice-ignored", "denied-voice-typed-fallback", "unsupported-voice", "mobile-touch-targets", "body-contrast", "no-overflow-or-page-errors"], contrasts, output }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
