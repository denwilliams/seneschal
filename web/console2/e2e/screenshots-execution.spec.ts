import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in execution boundary screenshots (mock fixtures)");
const out = resolve(process.cwd(), "../../docs/screenshots/execution-boundaries");
for (const [name, theme, width, height, channel] of [
  ["light", "light", 1280, 1100, "C0GENERAL/t/1760000000.000100"],
  ["dark", "dark", 1280, 1100, "C0PROJECT/t/1760001000.000300"],
  ["mobile", "light", 390, 1100, "C0ARCHIVE"],
] as const) {
  test(name + " execution boundaries", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await page.goto(`./#/c/${channel}?tab=session`);
    const button = page.getByRole("button", { name: "Open details panel" });
    if (await button.isVisible()) await button.click();
    await expect(page.getByRole("heading", { name: "Execution environment", exact: true })).toBeVisible();
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${out}/session-${name}.png`, scale: "css" });
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    await expect(page.locator("li").filter({ has: page.locator("code", { hasText: /^bash$/ }) })).toBeVisible();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: `${out}/tools-${name}.png`, scale: "css" });
  });
}
