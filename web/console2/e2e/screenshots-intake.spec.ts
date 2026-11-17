import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of issue intake in the Tasks tab (docs/screenshots/factory-intake/).
 * Not part of the normal run. From web/console2:  npm run shots:factory-intake
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:factory-intake) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/factory-intake");
mkdirSync(OUT, { recursive: true });

const shoot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, type: "png", scale: "css" });
const sheet = (page: Page) => page.getByTestId("workflow-sheet");
const settle = (page: Page) => page.waitForTimeout(500); // the sheet slides in

async function tasks(page: Page) {
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await expect(page.getByTestId("intake")).toBeVisible();
}

test("the Intake block: held, queued and mapped issues, the last poll", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 1500 });
  await tasks(page);
  await page.getByTestId("intake").scrollIntoViewIfNeeded();
  await page.getByTestId("intake").screenshot({ path: `${OUT}/1-intake-block.png`, type: "png", scale: "css" });
});

test("the list: a run started by intake, with its updates counted", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await tasks(page);
  await shoot(page, "2-runs-list");
});

test("sheet: a run waiting for information, with the updates it received (trusted and not)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await tasks(page);
  await page.locator('[data-run-row="wf_info"]').click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await sheet(page).screenshot({ path: `${OUT}/3-sheet-waiting-for-information.png`, type: "png", scale: "css" });
});

test("dark theme: the sheet of the same run", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await tasks(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.locator('[data-run-row="wf_info"]').click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await sheet(page).screenshot({ path: `${OUT}/4-dark-sheet.png`, type: "png", scale: "css" });
});

test("390px wide: the intake block in the details panel, and the run's sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await expect(panel.getByTestId("intake")).toBeVisible();
  await panel.getByTestId("intake").scrollIntoViewIfNeeded();
  await settle(page);
  await shoot(page, "5-mobile-intake");
  await panel.getByTestId("workflow-run").filter({ hasText: "acme/web#12" }).click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await shoot(page, "6-mobile-sheet");
});
