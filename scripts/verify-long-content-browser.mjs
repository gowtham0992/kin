// Synthetic, fixed-date family only. No AWS, audio, care writes or messages.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:3072';
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-invitations.ts', 'long-content', '3072'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Long-content fixture startup timed out')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('Synthetic invitation preview')) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (const view of ['today', 'plan', 'turns', 'week', 'ask']) {
    await page.goto(origin + '/invite.html#' + view);
    await expect(page.locator('#workspace-content h2').first()).toBeVisible();
    if (['today', 'plan'].includes(view)) {
      await expect(page.getByRole('heading', { name: 'CheckInWithoutAnySpaces'.repeat(5), exact: true })).toBeVisible();
    }
    if (view === 'ask') {
      await page.getByText('What can I say?', { exact: true }).click();
      await expect(page.getByRole('button', { name: 'CheckInWithoutAnySpaces'.repeat(5) })).toBeVisible();
    }
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      // Body overflow can be hidden by CSS. Also inspect individual text and
      // control bounds so clipping does not masquerade as a responsive pass.
      const clipped = await page.locator('#workspace-content h2, #workspace-content h3, #workspace-content p, #workspace-content button, #workspace-content select, .care-duty-summary-copy > *').evaluateAll(elements => elements.flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden') return [];
        const outside = rect.left < -1 || rect.right > innerWidth + 1;
        const textOverflow = (['H2', 'H3', 'P'].includes(element.tagName) || element.parentElement.classList.contains('care-duty-summary-copy')) && element.scrollWidth > element.clientWidth + 1;
        return outside || textOverflow ? [{ tag: element.tagName, text: element.textContent.slice(0, 100), outside, textOverflow }] : [];
      }));
      assert.deepEqual(clipped, [], `${view}: clipped content at ${width}px`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('Long-content text and controls fit five family views at four widths.');
} finally { await browser?.close(); child.kill('SIGTERM'); }
