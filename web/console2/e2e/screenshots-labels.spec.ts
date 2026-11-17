import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of the factory labels line in the Intake block (docs/screenshots/factory-labels/).
 * Not part of the normal run. From web/console2:  npm run shots:factory-labels
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:factory-labels) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/factory-labels");
mkdirSync(OUT, { recursive: true });

async function tasks(page: Page) {
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await expect(page.getByTestId("intake-labels")).toHaveCount(2);
}
// The first repository's block and the second's, which has no issues of its own: that is where the failed check shows.
const repos = (page: Page) => page.getByTestId("intake").locator('[data-testid="intake-repo"]');

test("light: created in one repository, could not be checked in the other", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 1500 });
  await tasks(page);
  await page.getByTestId("intake").scrollIntoViewIfNeeded();
  await page.getByTestId("intake").screenshot({ path: `${OUT}/1-intake-labels.png`, type: "png", scale: "css" });
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1180, height: 1500 });
  await tasks(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByTestId("intake").screenshot({ path: `${OUT}/2-dark-intake-labels.png`, type: "png", scale: "css" });
});

test("390px wide: the labels lines in the details panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await expect(panel.getByTestId("intake")).toBeVisible();
  await repos(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/3-mobile-intake-labels.png`, type: "png", scale: "css" });
});
