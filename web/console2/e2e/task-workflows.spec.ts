import { expect, test, type Page } from "@playwright/test";

const row = (page: Page) => page.locator('[data-run-row="workflow_research"]');
const sheet = (page: Page) => page.getByTestId("workflow-sheet");
test.beforeEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true, taskWorkflows: true } }); });
test.afterEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true } }); });

test("a non-factory channel lists task runs and opens ordered stage results in the shared side sheet", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?tab=tasks");
  await expect(row(page)).toContainText("Task workflow");
  await expect(row(page)).toContainText("Awaiting parent review");
  await expect(row(page).getByTestId("workflow-pip")).toHaveCount(3);
  await expect(row(page)).not.toContainText("#0");
  await row(page).focus(); await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/run=workflow_research/);
  const stages = sheet(page).getByTestId("workflow-stage");
  await expect(stages).toHaveCount(3);
  await expect(stages.nth(0)).toContainText("Approved");
  await expect(stages.nth(0)).toContainText("Compared three primary sources");
  await expect(stages.nth(1)).toContainText("Submitted — awaiting parent review");
  await expect(stages.nth(1)).toContainText("Include success criteria");
  await stages.nth(1).getByRole("button", { name: "Show all" }).click();
  await expect(stages.nth(1)).toContainText("Supporting evidence");
  await expect(stages.nth(2)).toContainText("No results yet.");
  await expect(sheet(page).getByTestId("workflow-merge")).toHaveCount(0);
  await expect(sheet(page).getByTestId("workflow-pr")).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: /Approve|Retry|Abort/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row(page)).toBeFocused(); await expect(page).not.toHaveURL(/run=/);
});

test("task detail direct links, literal hostile results, empty completed results, and refreshing progress", async ({ page }) => {
  let approved = false;
  await page.route("**/api/v1/channels/C0GENERAL/workflows/workflow_research", async (route) => {
    const response = await route.fetch(); const data = await response.json();
    data.run.stages[0].result.summary = "<img src=x onerror=window.injected=true>";
    data.run.stages[1].taskStatus = approved ? "approved" : "submitted";
    data.run.stages[1].status = approved ? "success" : "in_progress";
    data.run.stages[1].result = { available: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto("./#/c/C0GENERAL?tab=tasks&run=workflow_research");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText("<img src=x onerror=window.injected=true>");
  await expect(sheet(page).locator("img")).toHaveCount(0);
  approved = true; await page.reload();
  await expect(sheet(page)).toContainText("Completed — no recorded output.");
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
});

test("390px: the task run sheet stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Open details panel" }).click();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await row(page).click(); await expect(sheet(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});


test("stalled working state shows uncertainty, bump feedback and confirmed stop with revision boundaries", async ({ page, request }) => {
  await request.post("./__mock", { data: { reset: true, taskWorkflows: true, stalledTask: true, actions: true } });
  await page.goto("./#/c/C0GENERAL?tab=tasks&run=workflow_research");
  await expect(sheet(page).getByTestId("task-activity")).toContainText("The cause is unknown");
  await expect(sheet(page).getByTestId("task-activity")).toContainText("Last recorded activity");
  await expect(sheet(page)).not.toContainText("running for");
  await expect(sheet(page).getByRole("button", { name: /Retry|Approve/ })).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Bump workflow" }).click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("No step was retried");
  await sheet(page).getByRole("button", { name: "Stop workflow" }).click();
  const dialog = page.getByTestId("task-stop-dialog");
  await expect(dialog).toContainText("Already-completed external effects are not undone");
  await dialog.getByRole("button", { name: "Keep it running" }).click();
  let sent = await (await request.get("./__mock")).json();
  expect(sent.posted).toHaveLength(1); expect(sent.posted[0].body).toEqual({ revision: 5 });
  await sheet(page).getByRole("button", { name: "Stop workflow" }).click();
  await dialog.getByRole("button", { name: "Confirm stop" }).click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("authority invalidated");
  await expect(sheet(page).getByTestId("workflow-status")).toContainText("Aborted");
  await expect(sheet(page).getByRole("button", { name: "Bump workflow" })).toHaveCount(0);
  sent = await (await request.get("./__mock")).json();
  expect(sent.posted[1].body).toEqual({ revision: 6 });
});

test("task controls show a refusal and never automatically repeat a stale request", async ({ page, request }) => {
  await request.post("./__mock", { data: { reset: true, taskWorkflows: true, actions: true, failNext: "Stale workflow revision; check it again." } });
  await page.goto("./#/c/C0GENERAL?tab=tasks&run=workflow_research");
  await sheet(page).getByRole("button", { name: "Bump workflow" }).click();
  await expect(sheet(page).getByRole("alert")).toContainText("Stale workflow revision");
  expect((await (await request.get("./__mock")).json()).posted).toHaveLength(1);
});
