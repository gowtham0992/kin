// Actual rendered MCP workspace, synthetic identity/data; no voice or writes.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:3071';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-invitations.ts', 'mcp-family', '3071'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('MCP layout fixture startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('Synthetic invitation preview')) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/invite.html#ask');
  await expect(page.getByText('Not connected to Alexa or an Echo device.', { exact: true })).toBeVisible();
  await expect(page.locator('.care-conversation-heading .care-author-note')).toBeVisible();
  for (const width of [375, 768, 901, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await page.locator('.care-conversation-heading > .care-note').evaluateAll(elements => elements.map(element => {
      const { top, right, bottom, left } = element.getBoundingClientRect(); return { top, right, bottom, left };
    }));
    assert.equal(boxes.length, 2);
    const [connection, attribution] = boxes;
    assert.ok(connection.bottom <= attribution.top || attribution.bottom <= connection.top || connection.right <= attribution.left || attribution.right <= connection.left, `Connection and attribution overlap at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
  }
  console.log('MCP conversation boundary text is separate at five viewport widths.');
  await page.goto(origin + '/how-kin-works.html');
  await expect(page.getByRole('heading', { name: 'Start with one small check-in.' })).toBeVisible();
  for (const [name, fragment] of [['Plan', 'plan'], ['Turns', 'turns'], ['Ask Kin', 'ask'], ['Today', 'today']]) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', '/invite.html#' + fragment);
  }
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Family guide overflow at ${width}px`);
  }
  console.log('Family first-use guide links and responsive widths verified.');
} finally { await browser?.close(); child.kill('SIGTERM'); }
