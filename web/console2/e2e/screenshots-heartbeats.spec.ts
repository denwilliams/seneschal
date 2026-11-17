import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in heartbeat screenshots (mock fixtures)");
const out = resolve(process.cwd(), "../../docs/screenshots/heartbeats");
for (const [name, theme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["mobile", "light", 390]] as const) {
  test(name + " heartbeat usage", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 1200 });
    await page.goto("./#/c/C0GENERAL?tab=session");
    const open = page.getByRole("button", { name: "Open details panel" });
    if (await open.isVisible()) await open.click();
    await expect(page.getByRole("cell", { name: "Heartbeats", exact: true })).toBeVisible();
    await page.getByText("Heartbeats are quiet recurring checks.", { exact: false }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: `${out}/usage-${name}.png`, scale: "css" });
    await page.getByRole("tab", { name: "Tasks", exact: true }).click();
    const cadence = page.getByText("heartbeat every 15 min (enabled)", { exact: false });
    await cadence.scrollIntoViewIfNeeded();
    await expect(cadence).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/schedule-${name}.png`, scale: "css" });
  });
}
