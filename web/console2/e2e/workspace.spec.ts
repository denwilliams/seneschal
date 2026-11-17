import { expect, test, type Page } from "@playwright/test";

async function openWorkspace(page: Page) {
  await page.goto("./#/c/C0PROJECT?tab=files");
  const details = page.getByRole("button", { name: "Open details panel" });
  if (await details.isVisible()) await details.click();
  await expect(page.getByRole("list", { name: "Workspace files" })).toBeVisible();
}

test("Files navigates a channel workspace and opens a paged, read-only SQLite browser", async ({ page }) => {
  await openWorkspace(page);
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("notes.md");
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("not followed");
  await page.getByRole("button", { name: "reports/", exact: true }).click();
  await page.getByRole("button", { name: "metrics.sqlite", exact: true }).click();
  await expect(page.getByLabel("Database table")).toBeVisible();
  await page.getByLabel("Database table").selectOption("daily_metrics");
  const contents = page.getByRole("region", { name: "Table contents" });
  await expect(contents).toContainText("1250");
  await page.getByText("Schema and columns", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("CREATE TABLE daily_metrics");
  await page.getByRole("button", { name: "Next rows", exact: true }).click();
  await expect(contents).toContainText("912");
  await expect(contents).toContainText("NULL");
  await expect(page.getByRole("button", { name: "Next rows", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous rows", exact: true }).click();
  await expect(contents).toContainText("1250");
  await page.getByRole("button", { name: "Back to files", exact: true }).click();
  await page.getByRole("button", { name: "Parent directory", exact: true }).click();
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("notes.md");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("390px database contents keep long cells inside their own scroll region", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/channels/C0PROJECT/database?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (data.table) {
      data.columns = Array.from({ length: 32 }, (_, i) => ({ name: `column${i}`, type: "TEXT", notNull: false, primaryKey: false }));
      data.rows = [Array.from({ length: 32 }, () => "longcell".repeat(32))];
    }
    await route.fulfill({ json: data });
  });
  await openWorkspace(page);
  await page.getByRole("button", { name: "reports/", exact: true }).click();
  await page.getByRole("button", { name: "metrics.sqlite", exact: true }).click();
  await page.getByLabel("Database table").selectOption("daily_metrics");
  const contents = page.getByRole("region", { name: "Table contents" });
  await expect(contents).toContainText("column31");
  expect(await contents.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await contents.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("Workspace resets on channel changes and displays bounded database errors with retry", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "reports/", exact: true }).click();
  await page.route("**/api/v1/channels/C0PROJECT/database?*", (route) => route.fulfill({ status: 422, json: { error: "The database snapshot could not be read." } }));
  await page.getByRole("button", { name: "metrics.sqlite", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The database snapshot could not be read.");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.goto("./#/c/C0GENERAL?tab=files");
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("notes.md");
  await expect(page.getByLabel("Database table")).toHaveCount(0);
});
