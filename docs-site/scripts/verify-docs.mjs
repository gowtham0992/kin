import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = (await import('../docusaurus.config.js')).default;
const port = 3044;
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}${config.baseUrl}`;
const output = '/tmp/kin-docs-browser-20261021';
const routes = ['', 'quickstart/', 'family-workspace/', 'echo-and-mcp/', 'privacy-and-safety/', 'for-developers/'];
const widths = [375, 768, 1440];
const errors = [];
const blocked = [];
const server = spawn(process.execPath, ['node_modules/@docusaurus/core/bin/docusaurus.mjs', 'serve', '--host', '127.0.0.1', '--port', String(port)],
  {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
let browser;

function contrast(a, b) {
  const luminance = value => {
    const rgb = value.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number).map(v => v / 255);
    const linear = rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  };
  const l = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l[0] + .05) / (l[1] + .05);
}

try {
  await mkdir(output, {recursive: true});
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error(`Local docs server exited: ${serverOutput}`);
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, `Local docs server did not become ready: ${serverOutput}`);
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    blocked.push(url.origin);
    return route.abort();
  });
  const links = new Set();
  for (const width of widths) {
    await page.setViewportSize({width, height: 940});
    for (const route of routes) {
      const response = await page.goto(base + route, {waitUntil: 'networkidle'});
      assert.equal(response.status(), 200, `${width}: ${route}`);
      await page.locator('main h1').waitFor({state: 'visible'});
      assert(await page.locator('main').innerText(), 'Main content must not be empty');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: body overflow at ${route}`);
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
      for (const link of await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => a.href))) {
        if (link.startsWith(base)) links.add(new URL(link).pathname);
      }
      const routeName = route.replaceAll('/', '') || 'intro';
      await page.screenshot({path: path.join(output, `${routeName}-${width}.png`), fullPage: true});
    }
    if (width < 997) {
      await page.goto(base, {waitUntil: 'networkidle'});
      const toggle = page.getByRole('button', {name: 'Toggle navigation bar'});
      await toggle.click();
      const menu = page.locator('.navbar-sidebar');
      await page.waitForFunction(() => {
        const bounds = document.querySelector('.navbar-sidebar')?.getBoundingClientRect();
        return bounds && bounds.width > 0 && bounds.left >= -1;
      });
      const bounds = await menu.boundingBox();
      assert(bounds && bounds.x >= -1, 'Mobile navigation did not open into the viewport');
      await menu.locator('a[href$="/quickstart/"]').click();
      await page.waitForURL(base + 'quickstart/');
      await page.getByRole('heading', {level: 1, name: 'Try one complete care story', exact: true}).waitFor({state: 'visible'});
      assert.equal(await page.locator('main h1').innerText(), 'Try one complete care story');
      await page.goBack({waitUntil: 'networkidle'});
      await page.getByRole('heading', {level: 1, name: 'A little care, shared.', exact: true}).waitFor({state: 'visible'});
      await page.goForward({waitUntil: 'networkidle'});
      await page.getByRole('heading', {level: 1, name: 'Try one complete care story', exact: true}).waitFor({state: 'visible'});
    }
  }
  await page.setViewportSize({width: 1440, height: 940});
  await page.goto(base, {waitUntil: 'networkidle'});
  const card = page.locator('.kin-path').first();
  const cardBefore = await card.evaluate(element => getComputedStyle(element).backgroundColor);
  await card.hover();
  const cardAfter = await card.evaluate(element => getComputedStyle(element).backgroundColor);
  assert.notEqual(cardBefore, cardAfter, 'Guide card hover state must be visible');
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /Skip to main content/);
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  }), 'Keyboard focus must be visible');
  const colors = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const link = getComputedStyle(document.querySelector('main a'));
    let background = 'rgb(255, 255, 255)';
    for (let element = document.body; element; element = element.parentElement) {
      const value = getComputedStyle(element).backgroundColor;
      if (!value.startsWith('rgba(') || !value.endsWith(', 0)')) { background = value; break; }
    }
    return {body: body.color, background, link: link.color};
  });
  const measured = {body: contrast(colors.body, colors.background), link: contrast(colors.link, colors.background)};
  assert(measured.body >= 4.5 && measured.link >= 4.5, `Text contrast below AA: ${JSON.stringify(measured)}`);
  for (const pathname of links) {
    const response = await page.request.get(origin + pathname);
    assert.equal(response.status(), 200, `Broken internal route: ${pathname}`);
  }
  await page.reload({waitUntil: 'networkidle'});
  assert.equal(await page.locator('main h1').innerText(), 'A little care, shared.');
  await page.goto(base + 'not-a-kin-page/', {waitUntil: 'networkidle'});
  await page.getByRole('heading', {level: 1, name: 'Page Not Found', exact: true}).waitFor({state: 'visible'});
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.deepEqual(blocked, [], 'Documentation must not request third-party scripts, fonts or APIs');
  const report = {passed: true, routes: routes.length, viewports: widths, internalRoutes: links.size,
    screenshots: routes.length * widths.length, keyboard: true, mobileNavigation: true, refresh: true, backForward: true, hover: true, notFound: true,
    contrast: measured, colors, pageErrors: errors, thirdPartyRequests: blocked, output};
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
}
