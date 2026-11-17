import { expect, test } from "@playwright/test";

test("shows verified email as text, with subject fallback and no identity in disabled mode", async ({ page }) => {
  await page.route("**/api/v1/identity", (route) => route.fulfill({ json: { identity: { subject: "user-1", email: "operator@example.test" } } }));
  await page.goto("./");
  await expect(page.getByTestId("signed-in-identity")).toHaveText("Signed in asoperator@example.test");
  await page.unroute("**/api/v1/identity");
  await page.route("**/api/v1/identity", (route) => route.fulfill({ json: { identity: { subject: "<img src=x onerror=alert(1)>" } } }));
  await page.reload();
  await expect(page.getByTestId("signed-in-identity")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.getByTestId("signed-in-identity").locator("img")).toHaveCount(0);
  await page.unroute("**/api/v1/identity");
  await page.reload();
  await expect(page.getByTestId("connection")).toContainText("Connected");
  await expect(page.getByTestId("signed-in-identity")).toHaveCount(0);
});

test("long verified identity fits at 390px without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/identity", (route) => route.fulfill({ json: { identity: { subject: "user-1", email: "very-long-operator-identity-".repeat(10) + "@example.test" } } }));
  await page.goto("./#/c/C0GENERAL");
  await expect(page.getByTestId("signed-in-identity")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
