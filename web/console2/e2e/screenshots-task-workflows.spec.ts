import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in mock-fixture captures: SCREENSHOTS=1 npx playwright test e2e/screenshots-task-workflows.spec.ts
// From web/console2; light, dark and 390px, at 1x scale.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate task-workflow documentation screenshots");
const OUT = resolve("../../docs/screenshots/task-workflows");
mkdirSync(OUT, { recursive: true });
test.beforeEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true, taskWorkflows: true } }); });
test.afterEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true } }); });

for (const theme of ["light", "dark"] as const) test(`${theme}: list and open task detail`, async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 }); await page.emulateMedia({ colorScheme: theme });
  await page.goto("./#/c/C0GENERAL?tab=tasks&run=workflow_research");
  await expect(page.getByTestId("workflow-sheet").getByTestId("workflow-stage")).toHaveCount(3);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${theme}.png`, scale: "css" });
});
test("390px: open task detail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Open details panel" }).click();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await page.locator('[data-run-row="workflow_research"]').click();
  await expect(page.getByTestId("workflow-sheet")).toBeVisible(); await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${OUT}/mobile.png`, scale: "css" });
});
