import { expect, test, type Page } from "@playwright/test";

export async function openDetails(page: Page) {
  const button = page.getByRole("button", { name: "Open details panel" });
  if (await button.isVisible()) await button.click();
}

for (const [id, thread, mode, status] of [
  ["C0GENERAL", "1760000000.000100", "Docker", "Running"],
  ["C0PROJECT", "1760001000.000300", "Apple Containers", "Stopped"],
  ["C0ARCHIVE", undefined, "Outside channel sandboxes", "Not applicable"],
] as const) {
  test(`${mode}: configuration, current status, and mixed tools`, async ({ page }) => {
    await page.goto(`./#/c/${id}${thread ? `/t/${thread}` : ""}?tab=session`);
    await openDetails(page);
    const boundary = page.locator("section").filter({ has: page.getByRole("heading", { name: "Execution environment", exact: true }) });
    await expect(boundary.locator("div").filter({ has: page.locator("dt", { hasText: "Configured sandbox" }) }).first()).toContainText(mode);
    await expect(boundary.locator("div").filter({ has: page.locator("dt", { hasText: "Container status" }) }).first()).toContainText(status);
    await expect(boundary).toContainText("A channel sandbox applies only to bash");
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    const bash = page.locator("li").filter({ has: page.locator("code", { hasText: /^bash$/ }) });
    await expect(bash).toContainText(mode === "Outside channel sandboxes" ? "Outside sandbox" : mode);
    const read = page.locator("li").filter({ has: page.locator("code", { hasText: /^read$/ }) });
    await expect(read).toContainText("Outside sandbox");
    const connector = page.locator("li").filter({ has: page.locator("code", { hasText: /^linear__search$/ }) });
    await expect(connector).toContainText("Outside sandbox");
    await expect(page.getByText("Outside channel sandboxes: stdio servers run harness-side", { exact: false })).toBeVisible();
  });
}

test("configured Docker is not a running-container claim at channel level", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?tab=session");
  await openDetails(page);
  await expect(page.getByText("Unknown / unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Select a Slack thread to inspect", { exact: false })).toBeVisible();
});

test("unavailable execution evidence is shown rather than guessed", async ({ page }) => {
  await page.route("**/channels/C0GENERAL/session*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.execution;
    body.sandbox = "not-a-known-backend";
    await route.fulfill({ response, json: body });
  });
  await page.goto("./#/c/C0GENERAL?tab=session");
  await openDetails(page);
  await expect(page.getByText("Unknown / unavailable", { exact: true })).toHaveCount(2);
});
