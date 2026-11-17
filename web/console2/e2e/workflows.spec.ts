import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("e2e/screenshots", { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const tasks = async (page: Page, channel = "C0PROJECT") => {
  await page.goto(`./#/c/${channel}?tab=tasks`);
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
};
const row = (page: Page, runId: string) => page.locator(`[data-run-row="${runId}"]`);
const sheet = (page: Page) => page.getByTestId("workflow-sheet");

test("Workflow runs: the Tasks tab lists each run with its status in words, five stage pips, risk and round; waiting runs first", async ({ page }) => {
  await tasks(page);
  const rows = page.getByTestId("workflow-run");
  await expect(rows).toHaveCount(8);
  await expect(rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-status")))).resolves.toEqual(["waiting", "waiting", "needs_decision", "needs_decision", "running", "failed", "completed", "rejected"]);
  const wait = row(page, "wf_wait");
  await expect(wait).toContainText("acme/web#7");
  await expect(wait).toContainText("Login fails on empty password");
  await expect(wait.getByTestId("workflow-status")).toHaveText("Waiting for a person");
  await expect(wait.getByTestId("workflow-risk")).toHaveText("Risk 3");
  const pips = wait.getByTestId("workflow-pip");
  await expect(pips).toHaveCount(5);
  await expect(pips.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).resolves.toEqual([
    "triage: success", "implement: success", "review: success", "merge: in progress", "deploy: not started",
  ]);
  await expect(wait).toContainText("at merge");
  await expect(row(page, "wf_loop").getByTestId("workflow-round")).toHaveText("review round 2");
  await expect(row(page, "wf_loop").getByTestId("workflow-risk")).toHaveCount(0);
  await expect(row(page, "wf_done").getByTestId("workflow-status")).toHaveText("Completed");
  await expect(row(page, "wf_rej").getByTestId("workflow-status")).toHaveText("Rejected");
  await expect(row(page, "wf_decide").getByTestId("workflow-status")).toHaveText("Needs a decision");
  await expect(row(page, "wf_failed").getByTestId("workflow-status")).toHaveText("Stage failed");
  await shot(page, "30-workflows-list");
});

test("Workflow runs: only a factory channel, or one with runs, has the section", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?tab=tasks");
  await expect(page.getByText("Active tasks")).toBeVisible();
  await expect(page.getByText("Workflow runs")).toHaveCount(0);
});

test("Workflow runs: a row opens a sheet with the stage timeline, the merge risk and rule, the PR, and what the run waits for", async ({ page }) => {
  await tasks(page);
  await row(page, "wf_wait").click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/run=wf_wait/);
  await expect(dialog.getByRole("heading", { name: /acme\/web#7 Login fails on empty password/ })).toBeVisible();
  const waiting = dialog.getByTestId("workflow-waiting");
  await expect(waiting).toContainText("approve or decline the merge");
  await expect(waiting).toContainText("read-only");
  const stages = dialog.getByTestId("workflow-stage");
  await expect(stages).toHaveCount(5);
  await expect(stages.evaluateAll((els) => els.map((el) => `${el.getAttribute("data-stage")}:${el.getAttribute("data-status")}`))).resolves.toEqual([
    "triage:success", "implement:success", "review:success", "merge:in_progress", "deploy:not_started",
  ]);
  await expect(stages.nth(1)).toContainText("coder");
  const merge = dialog.getByTestId("workflow-merge");
  await expect(merge).toContainText("Risk 3");
  await expect(merge).toContainText("Changes validation in one module");
  await expect(dialog.getByTestId("workflow-rule")).toHaveText("Rule: may merge automatically at risk 2 or lower only when required checks and all other gates pass, squash; 2 approvers (set on the factory).");
  const pr = dialog.getByTestId("workflow-pr");
  await expect(pr).toHaveAttribute("href", "https://github.com/acme/web/pull/12");
  await expect(pr).toHaveAttribute("rel", /noopener/);
  await expect(dialog.getByTestId("workflow-reason")).toContainText("automatic limit of 2");
  await page.waitForTimeout(450); // the sheet slides in
  await shot(page, "31-workflows-sheet");
});

test("Workflow runs: a review loop keeps every attempt, each with its verdict and a link to that sub-agent's conversation", async ({ page }) => {
  await tasks(page);
  await row(page, "wf_loop").click();
  const dialog = sheet(page);
  const implement = dialog.getByTestId("workflow-stage").filter({ hasText: "implement" });
  await expect(implement.getByTestId("workflow-attempt")).toHaveCount(2);
  await expect(implement.getByTestId("workflow-attempt").nth(1)).toContainText("Attempt 2 of 2");
  const review = dialog.getByTestId("workflow-stage").filter({ hasText: "review" }).first();
  const attempts = review.getByTestId("workflow-attempt");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.nth(0).getByTestId("workflow-verdict")).toHaveText("changes requested");
  await expect(attempts.nth(0)).toContainText("the timeout is still 30s");
  await expect(attempts.nth(1)).toContainText("Running");
  const link = attempts.nth(0).getByTestId("workflow-subagent-link");
  await expect(link).toHaveAttribute("href", "#/c/C0PROJECT/t/sub-r2");
  await link.click();
  await expect(page).toHaveURL(/#\/c\/C0PROJECT\/t\/sub-r2/);
  await expect(page).not.toHaveURL(/run=/);
  await expect(sheet(page)).toHaveCount(0);
  await shot(page, "32-workflows-loop-followed");
});

test("Workflow runs: a rejected run says why, a run that needs a decision says what was interrupted, a completed one shows its skipped deploy", async ({ page }) => {
  await tasks(page);
  await row(page, "wf_rej").click();
  await expect(sheet(page).getByTestId("workflow-reason")).toContainText("needs more information");
  await expect(sheet(page).getByTestId("workflow-stage")).toHaveCount(5);
  await expect(sheet(page).getByTestId("workflow-stage").nth(1)).toHaveAttribute("data-status", "not_started");
  await page.keyboard.press("Escape");
  await row(page, "wf_decide").click();
  await expect(sheet(page).getByTestId("workflow-waiting")).toContainText("retry, skip or abort");
  await expect(sheet(page).getByTestId("workflow-attempt").filter({ hasText: "Interrupted" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await row(page, "wf_done").click();
  await expect(sheet(page).getByTestId("workflow-stage").last()).toHaveAttribute("data-status", "skipped");
  await expect(sheet(page).getByTestId("workflow-pr")).toContainText("(merged)");
});

test("Workflow runs: a link opens a run directly, and closing it removes it from the address", async ({ page }) => {
  await page.goto("./#/c/C0PROJECT?tab=tasks&run=wf_done");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Completed");
  await sheet(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/run=/);
  await page.goto("./#/c/C0PROJECT?tab=tasks&run=nope");
  await expect(sheet(page).getByRole("alert")).toContainText("This run is not available");
});

test("Workflow runs: the keyboard opens a run, keeps focus in the sheet, and Escape returns focus to the row", async ({ page }) => {
  await tasks(page);
  await row(page, "wf_done").focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  const inside = await page.evaluate(() => document.querySelector("[data-testid=workflow-sheet]")?.contains(document.activeElement) ?? false);
  expect(inside).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(row(page, "wf_done")).toBeFocused();
});

test("Workflow runs: a direct message shows the structure of a run and none of its words", async ({ page }) => {
  await tasks(page, "D0PRIVATE");
  await expect(page.getByTestId("workflows-hidden")).toBeVisible();
  const only = row(page, "wf_dm");
  await expect(only).toContainText("acme/web#2");
  await expect(only.getByTestId("workflow-pip")).toHaveCount(5);
  await only.click();
  await expect(sheet(page).getByTestId("workflow-hidden")).toBeVisible();
  await expect(sheet(page).getByTestId("workflow-stage")).toHaveCount(5);
  await expect(sheet(page).getByTestId("workflow-attempt").first()).toContainText("Done");
  await expect(page.locator("body")).not.toContainText("private words");
  await expect(page.locator("body")).not.toContainText("A private thing");
});

test("Workflow runs: dark theme, and a narrow screen with no sideways scrolling, the sheet using the whole width", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await tasks(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await row(page, "wf_wait").click();
  await expect(sheet(page)).toBeVisible();
  await page.waitForTimeout(450);
  await shot(page, "33-workflows-sheet-dark");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("./#/c/C0PROJECT");
  await page.reload();
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await expect(panel.getByTestId("workflow-run").first()).toBeVisible();
  await page.waitForTimeout(600);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "34-workflows-mobile-list");
  await panel.getByTestId("workflow-run").filter({ hasText: "acme/web#9" }).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  const width = await dialog.evaluate((el) => el.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(388);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "35-workflows-mobile-sheet");
});

test("Workflow runs: a stage that failed is a run waiting for a person: the row says which stage and attempt, and the sheet lists the answers that apply", async ({ page }) => {
  await tasks(page);
  const failed = row(page, "wf_failed");
  await expect(failed.getByTestId("workflow-status")).toHaveText("Stage failed");
  await expect(failed.getByTestId("workflow-recovery-line")).toHaveText("implement failed · attempt 2");
  await expect(failed.getByTestId("workflow-pip").nth(1)).toHaveAttribute("aria-label", "implement: failed");
  await failed.click();
  await expect(page).toHaveURL(/run=wf_failed/);
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("workflow-waiting")).toContainText("waiting, not over");
  await expect(dialog.getByTestId("workflow-waiting")).toContainText("read-only");
  const recovery = dialog.getByTestId("workflow-recovery");
  await expect(recovery.getByTestId("workflow-recovery-title")).toHaveText("implement failed · attempt 2");
  await expect(recovery.getByTestId("workflow-recovery-choice")).toHaveCount(3);
  await expect(recovery.getByTestId("workflow-recovery-choice").evaluateAll((els) => els.map((el) => el.getAttribute("data-answer")))).resolves.toEqual(["retry", "restart_from", "abort"]);
  await expect(recovery.getByTestId("workflow-recovery-choice").first()).toContainText("implement again as attempt 3");
  await expect(recovery).not.toContainText("Skip", { useInnerText: true });
  await expect(dialog.getByTestId("workflow-reason")).toContainText('stage "implement" failed: npm test: 3 failures');
  // Both attempts at the failed stage are on the record, and the stage is failed.
  const implement = dialog.getByTestId("workflow-stage").filter({ has: page.locator('[data-stage="implement"]') }).or(dialog.locator('[data-testid="workflow-stage"][data-stage="implement"]')).first();
  await expect(implement).toHaveAttribute("data-status", "failed");
  await expect(implement.getByTestId("workflow-attempt")).toHaveCount(2);
  await expect(implement.getByTestId("workflow-attempt").first()).toContainText("Failed");
  await page.waitForTimeout(450);
  await shot(page, "36-workflows-failed-stage-sheet");
});

test("Workflow runs: a run that ended failed offers retry alone, from the stage that failed", async ({ page }) => {
  await tasks(page);
  const ended = row(page, "wf_ended");
  await expect(ended.getByTestId("workflow-status")).toHaveText("Failed");
  await expect(ended.getByTestId("workflow-recovery-line")).toHaveText("review failed · attempt 1 · run ended");
  await ended.click();
  const recovery = sheet(page).getByTestId("workflow-recovery");
  await expect(recovery).toContainText("This run ended failed");
  await expect(recovery.getByTestId("workflow-recovery-choice")).toHaveCount(1);
  await expect(recovery.getByTestId("workflow-recovery-choice")).toContainText("Carries the run on from review, as attempt 2, on the same record");
  await expect(sheet(page).getByTestId("workflow-waiting")).toHaveCount(0);
});

test("Workflow runs: a run that is fine has no recovery block", async ({ page }) => {
  await tasks(page);
  await expect(row(page, "wf_wait").getByTestId("workflow-recovery-line")).toHaveCount(0);
  await row(page, "wf_wait").click();
  await expect(sheet(page).getByTestId("workflow-waiting")).toBeVisible();
  await expect(sheet(page).getByTestId("workflow-recovery")).toHaveCount(0);
});

test("Workflow runs: the sheet for a stage that failed opens from the keyboard and gives the focus back", async ({ page }) => {
  await tasks(page);
  await row(page, "wf_failed").focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page).getByTestId("workflow-recovery")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(row(page, "wf_failed")).toBeFocused();
});

test("Workflow runs: a stage that failed on a narrow screen and in the dark has no sideways scroll", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await panel.locator('[data-run-row="wf_failed"]').click();
  const dialog = sheet(page);
  await expect(dialog.getByTestId("workflow-recovery")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "37-workflows-failed-stage-mobile-dark");
});
