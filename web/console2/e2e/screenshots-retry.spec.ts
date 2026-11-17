import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of a failed workflow stage (docs/screenshots/factory-retry/).
 * Not part of the normal run. From web/console2:  npm run shots:factory-retry
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:factory-retry) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/factory-retry");
mkdirSync(OUT, { recursive: true });

const sheet = (page: Page) => page.getByTestId("workflow-sheet");

async function open(page: Page, runId: string) {
  await page.goto(`./#/c/C0PROJECT?tab=tasks&run=${runId}`);
  await expect(sheet(page).getByTestId("workflow-recovery")).toBeVisible();
  await page.waitForTimeout(500);
}

test("light: the list shows the stage that failed and its attempt; the sheet lists the answers", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await page.locator('[data-run-row="wf_failed"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/1-list-stage-failed.png`, type: "png", scale: "css" });
  await open(page, "wf_failed");
  await page.screenshot({ path: `${OUT}/2-sheet-stage-failed.png`, type: "png", scale: "css" });
});

test("a run that ended failed: retry alone, from the stage that failed", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_ended");
  await page.screenshot({ path: `${OUT}/3-sheet-ended-failed.png`, type: "png", scale: "css" });
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_failed");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({ path: `${OUT}/4-dark-sheet-stage-failed.png`, type: "png", scale: "css" });
});

test("390px wide: the sheet uses the whole width with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await panel.locator('[data-run-row="wf_failed"]').click();
  await expect(sheet(page).getByTestId("workflow-recovery")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${OUT}/5-mobile-sheet-stage-failed.png`, type: "png", scale: "css" });
});
