// Opt-in evidence capture: node website/screenshots-actions-deploy.mjs
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, root } from './build.mjs';
import { preview } from './preview.mjs';

await build();
const server = preview('/seneschal/');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const folder = resolve(root, '../docs/screenshots/website');
  await mkdir(folder, { recursive: true });
  for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/seneschal/features.html#factory`);
    await page.locator('#factory').screenshot({ path: resolve(folder, `actions-deploy-${name}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
