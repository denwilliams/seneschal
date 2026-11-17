import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of console actions (docs/screenshots/console-actions/).
 * Not part of the normal run. From web/console2:  npm run shots:console-actions
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:console-actions) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/console-actions");
mkdirSync(OUT, { recursive: true });

const control = (page: Page, body: Record<string, unknown>) => page.request.post("__mock", { data: body });
const sheet = (page: Page) => page.getByTestId("workflow-sheet");
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, type: "png", scale: "css" });

test.beforeEach(async ({ page }) => { await control(page, { reset: true, actions: true }); });
test.afterEach(async ({ page }) => { await control(page, { reset: true }); });

async function open(page: Page, runId: string) {
  await page.goto(`./#/c/C0PROJECT?tab=tasks&run=${runId}`);
  await expect(sheet(page).getByTestId("workflow-actions")).toBeVisible();
  await page.waitForTimeout(500);
}

test("light: a failed stage offers Retry, Restart from and Abort; a run waiting for information offers the answer box", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_failed");
  await shot(page, "1-sheet-failed-stage");
  await open(page, "wf_info");
  await sheet(page).getByTestId("action-answer-text").fill("Accounts over 10k users, mostly the nightly export. Treat 1k as the small case.");
  await sheet(page).getByTestId("workflow-actions").scrollIntoViewIfNeeded();
  await shot(page, "2-sheet-waiting-for-information");
});

test("light: aborting asks first", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_failed");
  await sheet(page).getByTestId("action-abort").click();
  await expect(page.getByTestId("abort-dialog")).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, "3-confirm-abort");
});

test("light: start a run for an issue, and poll now", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("factory-actions")).toBeVisible();
  await page.getByTestId("action-start").click();
  await page.getByTestId("start-issue").fill("acme/web#42");
  await page.waitForTimeout(300);
  await shot(page, "4-start-a-run");
});

test("dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_failed");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await shot(page, "5-dark-sheet-failed-stage");
});

test("390px wide: the actions wrap with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await panel.locator('[data-run-row="wf_failed"]').click();
  await expect(sheet(page).getByTestId("workflow-actions")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await sheet(page).getByTestId("workflow-actions").scrollIntoViewIfNeeded();
  await shot(page, "6-mobile-sheet-failed-stage");
});

test("read-only: with actions off the same run says how to carry it on, with no buttons", async ({ page }) => {
  await control(page, { actions: false });
  await page.setViewportSize({ width: 1180, height: 900 });
  await open(page, "wf_failed");
  await sheet(page).getByTestId("workflow-actions").scrollIntoViewIfNeeded();
  await shot(page, "7-read-only");
});
