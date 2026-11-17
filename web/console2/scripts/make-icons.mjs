// Renders the icon SVGs in public/ to the PNGs the manifest and the page link to. A dev tool, not part of the build: run it
// when an SVG changes (`node scripts/make-icons.mjs`) and commit the PNGs it writes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const targets = [
  // Rounded corners, transparent outside them.
  { svg: "icon.svg", size: 192, out: "icon-192.png", transparent: true },
  { svg: "icon.svg", size: 512, out: "icon-512.png", transparent: true },
  { svg: "icon.svg", size: 32, out: "favicon-32.png", transparent: true },
  // Full bleed for platforms that apply their own mask. iOS also applies its own corners and has no transparency.
  { svg: "icon-maskable.svg", size: 512, out: "icon-maskable-512.png", transparent: false },
  { svg: "icon-maskable.svg", size: 180, out: "apple-touch-icon.png", transparent: false },
];

const browser = await chromium.launch();
try {
  for (const { svg, size, out, transparent } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const data = Buffer.from(readFileSync(join(pub, svg))).toString("base64");
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${data}"></body>`);
    await page.locator("img").evaluate((img) => img.decode());
    await page.screenshot({ path: join(pub, out), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`wrote public/${out} (${size}x${size})`);
  }
} finally {
  await browser.close();
}
