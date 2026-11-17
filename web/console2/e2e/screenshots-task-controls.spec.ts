import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in: SCREENSHOTS=1 npx playwright test e2e/screenshots-task-controls.spec.ts
// Mock-only, 1x scale; deliberately excluded from ordinary test runs.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate task-control screenshots");
const OUT = resolve("../../docs/screenshots/task-controls");
mkdirSync(OUT, { recursive: true });
test.beforeEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true, taskWorkflows: true, stalledTask: true, actions: true } }); });
test.afterEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true } }); });
for (const name of ["light", "dark", "mobile"] as const) test(name + ": activity and stop confirmation", async ({ page }) => {
  await page.setViewportSize(name === "mobile" ? { width: 390, height: 844 } : { width: 1180, height: 900 });
  await page.emulateMedia({ colorScheme: name === "dark" ? "dark" : "light" });
  if (name === "mobile") {
    await page.goto("./#/c/C0GENERAL");
    await page.getByRole("button", { name: "Open details panel" }).click();
    await page.getByRole("tab", { name: "Tasks" }).click();
    await page.locator('[data-run-row="workflow_research"]').click();
  } else await page.goto("./#/c/C0GENERAL?tab=tasks&run=workflow_research");
  await expect(page.getByTestId("task-activity")).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: OUT + "/" + name + ".png", scale: "css" });
  await page.getByRole("button", { name: "Stop workflow" }).click();
  await expect(page.getByTestId("task-stop-dialog")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + "/" + name + "-confirm.png", scale: "css" });
});
