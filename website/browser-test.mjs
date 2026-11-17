import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, pages, root } from './build.mjs';
import { preview } from './preview.mjs';

const { count } = await build();
const server = preview('/seneschal/');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/seneschal/`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const axe = await readFile(resolve(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 740]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`); });
    for (const file of pages) {
      await page.goto(base + file);
      await page.locator('main').waitFor();
      assert.equal(await page.locator('h1').count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}/${file}: horizontal overflow`);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
      await page.addScriptTag({ content: axe });
      const result = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } }));
      assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `${name}/${file}: accessibility`);
      // The public site deliberately works with no client-side JavaScript.
      console.log(`PASS ${name} ${file}: no overflow, keyboard skip navigation, axe WCAG 2.1 AA`);
    }
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Features' }).click();
    await page.getByRole('navigation', { name: 'Feature categories' }).getByRole('link', { name: 'Useful even between conversations' }).click();
    assert.equal(new URL(page.url()).hash, '#automation');
    assert.ok(await page.locator('#automation').evaluate(el => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight; }));
    assert.deepEqual(errors, []);
    if (process.argv.includes('--screenshots') && name !== 'narrow') {
      const folder = resolve(root, '../docs/screenshots/website');
      await mkdir(folder, { recursive: true });
      await page.screenshot({ path: resolve(folder, `features-${name}.png`) });
      await page.goto(base);
      await page.screenshot({ path: resolve(folder, `overview-${name}.png`) });
      console.log(`Captured actual ${name} overview and feature directory screenshots.`);
    }
    await context.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await noScript.newPage();
  await page.goto(base);
  await page.getByRole('link', { name: 'Explore the features' }).click();
  assert.match(page.url(), /features.html$/);
  assert.equal(await page.locator('.feature-card').count(), count);
  await noScript.close();
  console.log('PASS no-JavaScript navigation and full feature coverage under a project subpath');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
