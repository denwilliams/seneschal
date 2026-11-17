import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in workspace browser screenshots, mock fixtures only");
const out = resolve(process.cwd(), "../../docs/screenshots/workspace-browser");
for (const [name, theme, width, height] of [["light", "light", 1180, 1100], ["dark", "dark", 1180, 1100], ["mobile", "light", 390, 844]] as const) {
  test(name + " workspace and SQLite browser", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await page.goto("./#/c/C0PROJECT?tab=files");
    const details = page.getByRole("button", { name: "Open details panel" });
    if (await details.isVisible()) await details.click();
    await expect(page.getByRole("list", { name: "Workspace files" })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300); // Let the narrow-screen sheet finish opening before capture.
    await page.screenshot({ path: `${out}/files-${name}.png`, scale: "css" });
    await page.getByRole("button", { name: "reports/", exact: true }).click();
    await page.getByRole("button", { name: "metrics.sqlite", exact: true }).click();
    await page.getByLabel("Database table").selectOption("daily_metrics");
    await expect(page.getByRole("region", { name: "Table contents" })).toContainText("1250");
    await page.getByText("Schema and columns", { exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/database-${name}.png`, scale: "css" });
  });
}
