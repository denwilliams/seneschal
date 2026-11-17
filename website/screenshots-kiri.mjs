// Opt-in rendered evidence for the changed Kiri inventory and setup copy.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, root } from './build.mjs';
import { preview } from './preview.mjs';
await build();
const server = preview('/seneschal/');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const folder = resolve(root, '../docs/screenshots/kiri');
  await mkdir(folder, { recursive: true });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const base = `http://127.0.0.1:${server.address().port}/seneschal/`;
    await page.goto(base + 'features.html#sandboxes');
    await page.locator('#sandboxes').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(folder, `website-features-${name}.png`) });
    await page.goto(base + 'getting-started.html');
    await page.getByRole('heading', { name: 'Choose your host' }).evaluate(el => el.parentElement.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: resolve(folder, `website-setup-${name}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
