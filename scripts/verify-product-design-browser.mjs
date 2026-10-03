// Real local UI, synthetic identities only. No live accounts or care writes.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:3074';
const output = '/tmp/kin-product-design';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-invitations.ts', 'mcp-family', '3074'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const errors = [], external = [], writes = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Design fixture startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('Synthetic invitation preview')) { clearTimeout(timer); resolve(); } });
  });
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(?:tasks|duty|invitations|memberships)/.test(request.url())) writes.push(request.url());
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  for (const [name, url, ready] of [
    ['home', '/home.html', '.home-entries'],
    ['today', '/invite.html#today', '.care-today'],
    ['ask', '/invite.html#ask', '.care-conversation'],
    ['plan', '/invite.html#plan', '#plan-title'],
    ['turns', '/invite.html#turns', '.care-duty-week'],
    ['week', '/invite.html#week', '.care-brief-heading'],
    ['guide', '/how-kin-works.html', '.kin-start-steps'],
  ]) {
    await page.goto(origin + url);
    await expect(page.locator(ready)).toBeVisible();
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: overflow at ${width}`);
      const headings = await page.locator('main h1, main h2, main h3').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width).map(element => getComputedStyle(element).fontFamily));
      assert.ok(headings.every(font => !font.includes('Georgia')), `${name}: old display typography remains`);
      const clipped = await page.locator('main h1, main h2, main h3, main button, main input, main select').evaluateAll(elements => elements.filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map(element => element.textContent || element.id));
      assert.deepEqual(clipped, [], `${name}: clipped controls at ${width}`);
      if ([375, 1440].includes(width)) {
        // Capture the resting layout, separately from the keyboard-focus check.
        await page.mouse.click(1, 1);
        await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
      }
    }
  }
  await page.goto(origin + '/home.html');
  const entry = page.locator('.home-parent');
  await entry.focus();
  assert.notEqual(await entry.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await entry.hover();
  assert.equal(await entry.evaluate(element => getComputedStyle(element).transform), 'none');
  await page.goto(origin + '/invite.html#today');
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return ['--ink', '--muted', '--sage', '--coral', '--paper', '--card', '--sage-soft'].map(key => style.getPropertyValue(key).trim());
  });
  const luminance = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const [ink, muted, sage, coral, paper, card, soft] = colors;
  const contrast = { body: ratio(ink, paper), secondary: ratio(muted, paper), primary: ratio(card, sage), error: ratio(coral, paper), panel: ratio(sage, soft) };
  for (const [name, value] of Object.entries(contrast)) assert.ok(value >= 4.5, `${name}: contrast ${value}`);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
  console.log(JSON.stringify({ passed: true, widths: [320, 375, 768, 1024, 1440], screens: 7, contrast, output }));
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped;
  }
}
