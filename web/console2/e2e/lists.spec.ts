import { expect, test, type Page } from "@playwright/test";
const setup = (page: Page, body: Record<string, unknown>) => page.request.post("__mock", { data: body });
const panel = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Channel lists", exact: true }) });
async function open(page: Page, channel = "C0GENERAL") {
  await page.goto(`./#/c/${channel}?tab=state`);
  const details = page.getByRole("button", { name: "Open details panel" });
  if (await details.isVisible()) await details.click();
  await expect(panel(page).getByRole("button", { name: "Refresh lists" })).toBeVisible();
}
test.beforeEach(async ({ page }) => { await setup(page, { reset: true }); });
test.afterEach(async ({ page }) => { await setup(page, { reset: true }); });

test("view lists read-only; edit standard and custom fields when actions are enabled", async ({ page }) => {
  await open(page); const lists = panel(page);
  await lists.getByLabel("List", { exact: true }).selectOption("release_tasks");
  await expect(lists.getByText("Review release notes", { exact: false }).first()).toBeVisible();
  await expect(lists.getByRole("button", { name: "Create list" })).toBeDisabled();
  await setup(page, { actions: true }); await lists.getByRole("button", { name: "Refresh lists" }).click();
  await expect(lists.getByRole("button", { name: "Create list" })).toBeEnabled();
  await lists.locator("summary").filter({ hasText: "Review release notes" }).click();
  await lists.getByLabel("title", { exact: true }).fill("Publish release notes");
  await lists.getByLabel("notes", { exact: true }).fill("Approved upgrade guide");
  await lists.getByLabel("completed", { exact: true }).selectOption("true");
  await lists.getByLabel(/^owner/).fill("Casey");
  await lists.getByLabel(/^priority/).fill("3");
  await lists.getByRole("button", { name: "Save item" }).click();
  await expect(lists.locator("summary").filter({ hasText: "Publish release notes" })).toContainText("✓");
  await lists.locator("summary").filter({ hasText: "Publish release notes" }).click();
  await expect(lists.getByLabel(/^owner/)).toHaveValue("Casey");
  await expect(lists.getByLabel(/^priority/)).toHaveValue("3");
  await expect(lists.getByText(/ID and timestamps are read-only/)).toBeVisible();
  await page.reload();
  await lists.getByLabel("List", { exact: true }).selectOption("release_tasks");
  await expect(lists.locator("summary").filter({ hasText: "Publish release notes" })).toBeVisible();
});

test("create/rename/delete lists, add/remove typed columns, add/delete items and preserve unrelated values", async ({ page }) => {
  await setup(page, { actions: true }); await open(page); const lists = panel(page);
  await lists.getByLabel("New list name").fill("team_todo"); await lists.getByRole("button", { name: "Create list" }).click();
  await lists.getByLabel("New item title").fill("New task"); await lists.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(lists.locator("summary").filter({ hasText: "New task" })).toBeVisible();
  await lists.getByText("List settings and custom columns", { exact: true }).click();
  await lists.getByLabel("New column name").fill("effort"); await lists.getByLabel("Column type").selectOption("real"); await lists.getByRole("button", { name: "Add column", exact: true }).click();
  await expect(lists.getByRole("button", { name: "Remove effort" })).toBeVisible();
  await lists.getByLabel("New column name").fill("blocked"); await lists.getByLabel("Column type").selectOption("boolean"); await lists.getByRole("button", { name: "Add column", exact: true }).click();
  await expect(lists.getByRole("button", { name: "Remove blocked" })).toBeVisible();
  await lists.locator("summary").filter({ hasText: "New task" }).click();
  await lists.getByLabel(/^effort/).fill("2.5"); await lists.getByLabel(/^blocked/).selectOption("true");
  await lists.getByRole("button", { name: "Save item" }).click(); await expect(lists.getByRole("status")).toContainText("Saved");
  page.once("dialog", (d) => d.dismiss()); await lists.getByRole("button", { name: "Remove effort" }).click();
  await expect(lists.getByRole("button", { name: "Remove effort" })).toBeVisible();
  page.once("dialog", (d) => d.accept()); await lists.getByRole("button", { name: "Remove effort" }).click();
  await expect(lists.getByRole("button", { name: "Remove effort" })).toHaveCount(0);
  await lists.locator("summary").filter({ hasText: "New task" }).click(); await expect(lists.getByLabel(/^blocked/)).toHaveValue("true");
  page.once("dialog", (d) => d.accept()); await lists.getByRole("button", { name: "Delete item", exact: true }).click();
  await expect(lists.getByText("No items yet.")).toBeVisible();
  await lists.getByLabel("Rename list").fill("team_tasks"); await lists.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(lists.getByLabel("List", { exact: true })).toHaveValue("team_tasks");
  await lists.getByText("List settings and custom columns", { exact: true }).click();
  page.once("dialog", (d) => d.accept()); await lists.getByRole("button", { name: "Delete list", exact: true }).click();
  await expect(lists.getByLabel("List", { exact: true }).locator("option", { hasText: "team_tasks" })).toHaveCount(0);
});

test("channel changes do not expose another channel's lists, DMs stay hidden, and save errors are visible", async ({ page }) => {
  await setup(page, { actions: true }); await open(page); const lists = panel(page);
  await lists.getByLabel("List", { exact: true }).selectOption("release_tasks");
  await lists.locator("summary").filter({ hasText: "Review release notes" }).click();
  await page.route("**/api/v1/channels/C0GENERAL/lists", async (route) => { if (route.request().method() === "POST") await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The item could not be saved." }) }); else await route.continue(); });
  await lists.getByRole("button", { name: "Save item" }).click(); await expect(lists.getByRole("alert")).toContainText("could not be saved");
  await page.goto("./#/c/C0PROJECT?tab=state"); await expect(lists.getByText("No lists yet.")).toBeVisible(); await expect(lists.getByText("Review release notes")).toHaveCount(0);
  await page.goto("./#/c/D0PRIVATE?tab=state"); await expect(lists.getByRole("alert")).toContainText("hidden for direct messages");
  await expect(lists.getByRole("button", { name: "Create list" })).toHaveCount(0);
});
