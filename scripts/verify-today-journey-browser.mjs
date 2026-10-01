// Real local API/store/UI, synthetic accounts only. Never contacts AWS or phones.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium, expect } from 'playwright/test';
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:3073';
const output = '/tmp/kin-today-journey';
await mkdir(output, { recursive: true });
for (const mode of ['alerts', 'today-empty', 'today-history']) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview-invitations.ts', mode, '3073'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Today fixture startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Fixture exited ${code}`)); });
      child.stdout.on('data', data => { if (String(data).includes('Synthetic invitation preview')) { clearTimeout(timer); resolve(); } });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (mode === 'alerts') {
      await page.goto(origin + '/home.html');
      await expect(page.locator('.home-description')).toContainText('Keep the calls.');
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `${output}/home-${width}.png`, fullPage: true });
      }
    }
    await page.goto(origin + '/invite.html#today');
    await expect(page.locator('.care-today')).toBeVisible();
    if (mode === 'alerts') {
      await expect(page.locator('.care-attention')).toHaveText('1 follow-up needs acknowledgment');
      await expect(page.locator('.care-follow-up')).toContainText('No reply recorded');
      // Native disclosure works by keyboard; no false handset-delivery claim.
      const disclosure = page.getByText('Notification details', { exact: true });
      await disclosure.focus(); await page.keyboard.press('Enter');
      await expect(page.getByText('Notification not confirmed. Phone receipt is not verified by this status.', { exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
    } else if (mode === 'today-empty') {
      await expect(page.locator('.care-start-guide')).toContainText('A turn does not switch on phone alerts');
      await expect(page.getByRole('link', { name: 'Schedule a check-in', exact: true })).toHaveAttribute('href', '#plan');
      await expect(page.getByRole('link', { name: 'How to get started', exact: true })).toHaveAttribute('href', '/how-kin-works.html');
    } else {
      await expect(page.locator('.care-today > .care-plan > li')).toHaveCount(2);
      await expect(page.locator('.care-today > .care-plan > li').first()).toContainText('Water — synthetic');
      await expect(page.getByRole('heading', { name: 'Morning call — synthetic', exact: true })).not.toBeVisible();
      const summary = page.getByText('Today’s history · 1', { exact: true });
      await summary.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Morning call — synthetic', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.locator('#today-history')).toHaveAttribute('open', '');
      await expect(page.locator('#today-history')).toContainText('Via Maya');
    }
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const clipped = await page.locator('.care-today h2, .care-today h3, .care-today h4, .care-today p, .care-today button').evaluateAll(elements => elements.flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return [];
        return rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1 ? [element.textContent] : [];
      }));
      assert.deepEqual(clipped, [], `Clipped ${mode} at ${width}`);
      if (mode === 'alerts') {
        const alert = await page.locator('#today-follow-ups').boundingBox();
        const plan = await page.locator('.care-today > .care-plan').boundingBox();
        assert.ok(alert.y + alert.height <= plan.y, 'Follow-up must precede the plan visually');
      }
      await page.screenshot({ path: `${output}/${mode}-${width}.png`, fullPage: true });
    }
    assert.equal(writes.length, 0, 'Reading Today must not mutate care');
    if (mode === 'alerts') {
      const before = await (await page.request.get(origin + '/api/today')).json();
      await page.getByRole('button', { name: 'Acknowledge follow-up', exact: true }).click();
      await expect(page.locator('.care-follow-up')).toContainText('Seen by Maya');
      await expect(page.locator('.care-attention')).toHaveCount(0);
      await expect(page.locator('.care-follow-up')).toContainText('No reply recorded');
      const after = await (await page.request.get(origin + '/api/today')).json();
      assert.deepEqual(after.tasks, before.tasks, 'Acknowledgment must leave check-ins untouched');
      assert.equal(writes.length, 1);
      assert.ok(writes[0].endsWith('/acknowledge'));
      await page.reload();
      await expect(page.locator('.care-follow-up')).toContainText('Seen by Maya');
      await page.getByRole('link', { name: 'Ask Kin', exact: true }).click();
      await expect(page.locator('.care-conversation-prompt h3')).toHaveCount(1);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.locator('#care-request')).toHaveValue('Done: Drink a glass of water');
      assert.equal(writes.length, 1, 'Choosing a parent reply must only draft it, not record it');
    }
    assert.deepEqual(errors, []);
    console.log(`${mode}: responsive journey, read-only setup, and acknowledgment boundaries passed.`);
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await stopped;
    }
  }
}
