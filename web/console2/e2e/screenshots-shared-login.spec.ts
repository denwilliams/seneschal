import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of an update written through the agent's own GitHub account (docs/screenshots/factory-shared-login/).
 * Not part of the normal run. From web/console2:  npm run shots:factory-shared-login
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:factory-shared-login) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/factory-shared-login");
mkdirSync(OUT, { recursive: true });

const sheet = (page: Page) => page.getByTestId("workflow-sheet");

async function open(page: Page) {
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await page.locator('[data-run-row="wf_info"]').click();
  await expect(sheet(page)).toBeVisible();
  await page.waitForTimeout(500); // the sheet slides in
}

test("sheet: the person's answer, written through the token's account, among the updates", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await open(page);
  await sheet(page).screenshot({ path: `${OUT}/1-sheet.png`, type: "png", scale: "css" });
});

test("dark theme: the same sheet", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await open(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await sheet(page).screenshot({ path: `${OUT}/2-dark-sheet.png`, type: "png", scale: "css" });
});

test("390px wide: the sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: /details/i }).first().click().catch(() => undefined);
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await page.locator('[data-run-row="wf_info"]').click();
  await expect(sheet(page)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/3-390px-sheet.png`, type: "png", scale: "css" });
});
