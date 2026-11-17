import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of the Workflow runs UI that the pull request shows (docs/screenshots/factory-runs/).
 * Not part of the normal run. From web/console2:  npm run shots:factory-runs
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:factory-runs) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/factory-runs");
mkdirSync(OUT, { recursive: true });

const shoot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, type: "png", scale: "css" });
/** Just the sheet: it is what these shots are about, and it keeps the files small. */
const shootSheet = (page: Page, name: string) => sheet(page).screenshot({ path: `${OUT}/${name}.png`, type: "png", scale: "css" });
const row = (page: Page, runId: string) => page.locator(`[data-run-row="${runId}"]`);
const sheet = (page: Page) => page.getByTestId("workflow-sheet");
const settle = (page: Page) => page.waitForTimeout(500); // the sheet slides in

async function list(page: Page) {
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
}

test("workflow runs list", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await list(page);
  await shoot(page, "1-list");
});

test("sheet: a run waiting at the merge gate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1180 });
  await list(page);
  await row(page, "wf_wait").click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await shootSheet(page, "2-sheet-waiting-merge-gate");
});

test("sheet: a review loop with two attempts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1180 });
  await list(page);
  await row(page, "wf_loop").click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await shootSheet(page, "3-sheet-review-loop");
});

test("dark theme: list and a waiting run's sheet", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 1180 });
  await list(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await row(page, "wf_wait").click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await shootSheet(page, "4-dark-sheet");
});

test("390px wide: the list in the details panel, and a run's sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await expect(panel.getByTestId("workflow-run").first()).toBeVisible();
  await settle(page);
  await shoot(page, "5-mobile-list");
  await panel.getByTestId("workflow-run").filter({ hasText: "acme/web#9" }).click();
  await expect(sheet(page)).toBeVisible();
  await settle(page);
  await shoot(page, "6-mobile-sheet-review-loop");
});
