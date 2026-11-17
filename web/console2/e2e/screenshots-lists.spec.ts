import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
test.skip(!process.env.SCREENSHOTS, "Opt-in channel list screenshots, mock fixtures only");
const out = resolve(process.cwd(), "../../docs/screenshots/channel-lists");
for (const [name, theme, width, height] of [["light", "light", 1180, 1080], ["dark", "dark", 1180, 1080], ["mobile", "light", 390, 1100]] as const) {
  test(name + " lists and editor", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.request.post("__mock", { data: { reset: true, actions: true } });
    await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height });
    await page.goto("./#/c/C0GENERAL?tab=state");
    const details = page.getByRole("button", { name: "Open details panel" }); if (await details.isVisible()) await details.click();
    await page.getByLabel("List", { exact: true }).selectOption("release_tasks");
    await page.locator("summary").filter({ hasText: "Review release notes" }).click();
    await expect(page.getByLabel(/^owner/)).toHaveValue("Ana");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.mouse.move(0, 0); await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/editor-${name}.png`, scale: "css" });
    await page.locator("summary").filter({ hasText: "Review release notes" }).click();
    await page.getByText("List settings and custom columns", { exact: true }).click();
    await page.getByLabel("New column name").scrollIntoViewIfNeeded();
    await expect(page.getByLabel("Column type")).toBeVisible();
    await page.mouse.move(0, 0); await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/settings-${name}.png`, scale: "css" });
    await page.request.post("__mock", { data: { reset: true } });
  });
}
