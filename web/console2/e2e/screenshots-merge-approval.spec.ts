import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in: SCREENSHOTS=1 npx playwright test e2e/screenshots-merge-approval.spec.ts");
const OUT = resolve(process.cwd(), "../../docs/screenshots/merge-approval");
mkdirSync(OUT, { recursive: true });

for (const theme of ["light", "dark"] as const) test(`${theme}: verified controls and distinct review/merge states`, async ({ page }) => {
  await page.request.post("__mock", { data: { reset: true, actions: true, noRequiredChecks: true, verification: "verified" } });
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 1180, height: 1240 });
  await page.goto("./#/c/C0PROJECT?tab=tasks&run=wf_wait");
  const sheet = page.getByTestId("workflow-sheet");
  await expect(sheet.getByTestId("action-approve")).toBeVisible();
  await expect(sheet.getByTestId("workflow-verdict").last()).toHaveText("Review approved");
  await page.waitForTimeout(400);
  await sheet.screenshot({ path: `${OUT}/${theme}.png`, scale: "css" });
});

test("390px: verification restriction and wrapping controls", async ({ page }) => {
  await page.request.post("__mock", { data: { reset: true, actions: true, noRequiredChecks: true } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await panel.locator('[data-run-row="wf_wait"]').click();
  const sheet = page.getByTestId("workflow-sheet");
  await expect(sheet.getByTestId("action-verify_approver")).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await sheet.screenshot({ path: `${OUT}/mobile.png`, scale: "css" });
});

test.afterEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); });
