import { expect, test, type Page } from "@playwright/test";

/**
 * Console actions (webConsole.actions): the controls appear only when the server says the console may act, they send what the
 * server expects, and they report what it answered. The mock mirrors the server's rules; the server's own tests hold the security ones.
 */

const control = (page: Page, body: Record<string, unknown>) => page.request.post("__mock", { data: body });
const posted = async (page: Page) => (await (await page.request.get("__mock")).json()).posted as { path: string; headers: Record<string, string>; body: Record<string, unknown> }[];
const sheet = (page: Page) => page.getByTestId("workflow-sheet");
const open = async (page: Page, runId: string) => {
  await page.goto(`./#/c/C0PROJECT?tab=tasks&run=${runId}`);
  await expect(sheet(page).getByTestId("workflow-actions")).toBeVisible();
};

test.afterEach(async ({ page }) => { await control(page, { reset: true }); });

test("with actions off the sheet says what the run waits for and how to carry it on, and has no buttons", async ({ page }) => {
  await open(page, "wf_failed");
  await expect(page.getByTestId("console-mode")).toHaveText("Monitoring");
  const panel = sheet(page).getByTestId("workflow-actions");
  await expect(panel).toContainText("What you can do");
  await expect(panel.getByTestId("workflow-elsewhere")).toContainText("Slack post");
  await expect(panel.getByTestId("workflow-actions-off")).toContainText("webConsole.actions");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("workflow-run").first()).toBeVisible();
  await expect(page.getByTestId("factory-actions")).toHaveCount(0);
});

test("the action-mode tooltip explains that merge approval requires Slack verification", async ({ page }) => {
  await control(page, { actions: true });
  await page.goto("./#/c/C0PROJECT");
  await page.getByTestId("console-mode").hover();
  await expect(page.getByRole("tooltip")).toContainText("run-scoped Slack approver verification");
  await expect(page.getByRole("tooltip")).toContainText("no direct merge action");
});

test("a failed stage: Retry sends the action with the header the server needs and the run carries on", async ({ page }) => {
  await control(page, { actions: true });
  await open(page, "wf_failed");
  await expect(page.getByTestId("console-mode")).toHaveText("Can act");
  const panel = sheet(page).getByTestId("workflow-actions");
  await expect(panel).toHaveAttribute("data-actions", "retry,restart_from,abort");
  await expect(panel.getByTestId("action-skip")).toHaveCount(0);
  await expect(panel.getByTestId("action-approve")).toHaveCount(0);
  await panel.getByTestId("action-retry").dblclick();
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Running");
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("Retrying.");
  const sent = await posted(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ path: "channels/C0PROJECT/workflows/wf_failed/actions/retry", headers: { "content-type": "application/json", "x-console-action": "1" }, body: {} });
});

test("Restart from names an earlier stage; Abort asks first, and Keep it running does nothing", async ({ page }) => {
  await control(page, { actions: true });
  await open(page, "wf_failed");
  const panel = sheet(page).getByTestId("workflow-actions");
  await expect(panel.getByTestId("action-restart-stage").locator("option")).toHaveText(["triage"]);
  await panel.getByTestId("action-abort").click();
  await expect(page.getByTestId("abort-dialog")).toContainText("Abort this run?");
  await page.getByTestId("abort-cancel").click();
  await expect(page.getByTestId("abort-dialog")).toHaveCount(0);
  expect(await posted(page)).toHaveLength(0);
  await panel.getByTestId("action-abort").click();
  await page.getByTestId("abort-confirm").click();
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Aborted");
  expect((await posted(page)).map((p) => p.path)).toEqual(["channels/C0PROJECT/workflows/wf_failed/actions/abort"]);
});

test("Restart from sends the stage that was chosen", async ({ page }) => {
  await control(page, { actions: true });
  await open(page, "wf_failed");
  await sheet(page).getByTestId("action-restart_from").click();
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Running");
  expect((await posted(page))[0]).toMatchObject({ path: "channels/C0PROJECT/workflows/wf_failed/actions/restart_from", body: { stage: "triage" } });
});

test("a run waiting for information: type the answer, send it, and it shows as answered in the console", async ({ page }) => {
  await control(page, { actions: true });
  await open(page, "wf_info");
  const panel = sheet(page).getByTestId("workflow-actions");
  await expect(panel).toHaveAttribute("data-actions", "answer,recheck,abort");
  const send = panel.getByTestId("action-answer");
  await expect(send).toBeDisabled();
  await panel.getByTestId("action-answer-text").fill("Accounts over 10k users");
  await expect(panel.getByTestId("action-answer-count")).toHaveText("23 / 4000");
  await send.click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("Answer recorded on the issue");
  await expect(sheet(page).getByTestId("workflow-update").last()).toContainText("Answered in the console");
  expect((await posted(page))[0]).toMatchObject({ path: "channels/C0PROJECT/workflows/wf_info/actions/answer", body: { text: "Accounts over 10k users" } });
});

test("Re-check the issue is offered for a run waiting on an answer", async ({ page }) => {
  await control(page, { actions: true });
  await open(page, "wf_info");
  await sheet(page).getByTestId("action-recheck").click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("Reading the issue again.");
});

test("merge authorization requires verifying the matching browser, then offers the actual decision controls", async ({ page }) => {
  await control(page, { actions: true, noRequiredChecks: true });
  await open(page, "wf_wait");
  const panel = sheet(page).getByTestId("workflow-actions");
  await expect(panel).toHaveAttribute("data-actions", "verify_approver,abort");
  await expect(panel.getByRole("button", { name: "Approve merge" })).toBeDisabled();
  await expect(panel.getByTestId("merge-authorization")).toContainText("console access alone is not merge authorization");
  await expect(sheet(page).getByTestId("workflow-waiting")).not.toContainText("Use Approve merge");
  await panel.getByTestId("action-verify_approver").click();
  await expect(panel.getByTestId("merge-authorization")).toContainText("Match challenge a1b2c3d4e5f6");
  await expect(panel.getByRole("button", { name: "Approve merge" })).toBeDisabled();
  await control(page, { verification: "verified" }); // The mock's equivalent of the authenticated Slack callback.
  await expect(panel.getByTestId("action-approve")).toBeEnabled();
  await expect(panel.getByTestId("action-decline")).toBeEnabled();
  await panel.getByTestId("action-approve").click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText("Merge authorized for the reviewed commit");
  expect((await posted(page)).map((p) => p.path)).toEqual(["channels/C0PROJECT/workflows/wf_wait/actions/verify_approver", "channels/C0PROJECT/workflows/wf_wait/actions/approve"]);
});

for (const decision of ["approve", "decline"]) test("a verified console user can " + decision + " with no required checks, and review approval is clearly distinct", async ({ page }) => {
  await control(page, { actions: true, noRequiredChecks: true, verification: "verified" });
  await open(page, "wf_wait");
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Waiting for a person");
  await expect(sheet(page).getByTestId("workflow-reason")).toContainText("no required checks");
  await expect(sheet(page).getByTestId("workflow-verdict").last()).toHaveText("Review approved");
  await expect(sheet(page).locator('[data-testid="workflow-stage"][data-stage="merge"]')).toContainText("Awaiting merge authorization");
  await expect(sheet(page).getByTestId("workflow-rule")).toContainText("only when required checks and all other gates pass");
  await sheet(page).getByTestId("action-" + decision).click();
  await expect(sheet(page).getByTestId("action-outcome")).toContainText(decision === "approve" ? "Merge authorized" : "Merge declined");
});

test("an unavailable verifier explains the restriction instead of promising approval buttons", async ({ page }) => {
  await control(page, { actions: true, verification: "unavailable" });
  await open(page, "wf_wait");
  await expect(sheet(page).getByTestId("merge-authorization")).toContainText("verification is unavailable");
  await expect(sheet(page).getByRole("button", { name: "Approve merge" })).toBeDisabled();
  await expect(sheet(page).getByTestId("workflow-waiting")).not.toContainText("Use Approve merge");
});

test("a refusal from the server is shown as it was said, and the buttons work again", async ({ page }) => {
  await control(page, { actions: true, failNext: "Run wf_failed has already finished (completed)." });
  await open(page, "wf_failed");
  const panel = sheet(page).getByTestId("workflow-actions");
  await panel.getByTestId("action-retry").click();
  const outcome = sheet(page).getByTestId("action-outcome");
  await expect(outcome).toHaveAttribute("data-tone", "bad");
  await expect(outcome).toContainText("already finished");
  await expect(panel.getByTestId("action-retry")).toBeEnabled();
});

test("start a run for an issue, and poll GitHub now", async ({ page }) => {
  await control(page, { actions: true });
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await expect(page.getByTestId("factory-actions")).toBeVisible();
  await page.getByTestId("action-poll").click();
  await expect(page.getByTestId("action-outcome")).toContainText("Polling now.");
  await page.getByTestId("action-start").click();
  const dialog = page.getByTestId("start-dialog");
  await expect(dialog).toContainText("acme/web, acme/api");
  await expect(dialog.getByTestId("start-submit")).toBeDisabled();
  await dialog.getByTestId("start-issue").fill("acme/web#42");
  await dialog.getByTestId("start-notes").fill("Start with the export");
  await dialog.getByTestId("start-submit").click();
  await expect(page).toHaveURL(/run=wf_new1/);
  await expect(sheet(page).getByTestId("workflow-status")).toHaveText("Running");
  const sent = await posted(page);
  expect(sent.map((p) => p.path)).toEqual(["channels/C0PROJECT/factory/poll", "channels/C0PROJECT/factory/start"]);
  expect(sent[1]!.body).toEqual({ issue: "acme/web#42", notes: "Start with the export" });
});

test("a start the server refuses stays in the dialog with its reason", async ({ page }) => {
  await control(page, { actions: true });
  await page.goto("./#/c/C0PROJECT?tab=tasks");
  await page.getByTestId("action-start").click();
  const dialog = page.getByTestId("start-dialog");
  await dialog.getByTestId("start-issue").fill("#7");
  await dialog.getByTestId("start-submit").click();
  await expect(dialog.getByTestId("action-outcome")).toContainText("already has a live run");
  await expect(dialog).toBeVisible();
});

test("390px wide: the actions wrap and the page does not scroll sideways", async ({ page }) => {
  await control(page, { actions: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0PROJECT");
  await page.getByRole("button", { name: "Open details panel" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("tab", { name: "Tasks" }).click();
  await panel.locator('[data-run-row="wf_failed"]').click();
  await expect(sheet(page).getByTestId("workflow-actions")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await expect(sheet(page).getByTestId("action-retry")).toBeVisible();
});
