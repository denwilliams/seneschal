import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in: SCREENSHOTS=1 npx playwright test e2e/screenshots-transcript.spec.ts
// Uses the existing overflowing mock transcript, at 1x scale, without scrolling it by hand.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate transcript screenshots");
const out = resolve(process.cwd(), "../../docs/screenshots/transcript-follow");

for (const { name, width, height, colorScheme } of [
  { name: "light", width: 1280, height: 760, colorScheme: "light" },
  { name: "dark", width: 1280, height: 760, colorScheme: "dark" },
  { name: "mobile", width: 390, height: 844, colorScheme: "light" },
] as const) {
  test(`latest entries, ${name}`, async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height });
    await page.goto("./#/c/C0GENERAL/t/1759900000.000300");
    await expect(page.getByTestId("entry")).toHaveCount(60);
    await expect.poll(() => page.locator("main [data-radix-scroll-area-viewport]").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("entry").last()).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: `${out}/${name}.png`, type: "png", scale: "css" });
  });
}
