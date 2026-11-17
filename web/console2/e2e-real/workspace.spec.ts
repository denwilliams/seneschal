import { expect, test } from "@playwright/test";

test("workspace navigation and SQLite inspection work with the real API and CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => { if (/Content Security Policy|violates.*directive/i.test(msg.text())) violations.push(msg.text()); });
  await page.goto("/console2/#/c/CCHAN001?tab=files");
  await page.getByRole("button", { name: "reports/", exact: true }).click();
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("notes.txt");
  await page.getByRole("button", { name: "metrics.sqlite", exact: true }).click();
  await page.getByLabel("Database table").selectOption("metrics");
  await expect(page.getByRole("region", { name: "Table contents" })).toContainText("1250");
  await page.getByText("Schema and columns", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("CREATE TABLE metrics");
  await page.getByRole("button", { name: "Refresh database", exact: true }).click();
  await expect(page.getByRole("region", { name: "Table contents" })).toContainText("2026-10-28");
  await page.getByRole("button", { name: "Back to files", exact: true }).click();
  await page.getByRole("button", { name: "Workspace root", exact: true }).click();
  await expect(page.getByRole("list", { name: "Workspace files" })).toContainText("reports/");
  expect(violations).toEqual([]);
});
