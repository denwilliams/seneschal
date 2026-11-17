import { expect, test } from "@playwright/test";

test("channel usage distinguishes recurring heartbeat model calls", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?tab=session");
  const open = page.getByRole("button", { name: "Open details panel" });
  if (await open.isVisible()) await open.click();
  await expect(page.getByText("Usage by activity", { exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Heartbeats", exact: true }) });
  await expect(row).toContainText("52,300");
  await expect(row).toContainText("8");
  await expect(page.getByRole("cell", { name: "Scheduled tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Conversations", exact: true })).toBeVisible();
});
