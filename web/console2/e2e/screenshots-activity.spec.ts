import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in activity screenshots against mock fixtures");
const out = resolve(process.cwd(), "../../docs/screenshots/activity");
for (const [name, theme, width, height] of [
  ["light", "light", 1280, 960], ["dark", "dark", 1280, 960], ["mobile", "light", 390, 960],
] as const) {
  test(name + " activity", async ({ page, request }) => {
    await request.post("./__mock", { data: { reset: true } });
    mkdirSync(out, { recursive: true });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await page.goto("./#/");
    await expect(page.getByTestId("activity-entry")).toHaveCount(50);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${out}/${name}.png`, scale: "css" });
  });
}
