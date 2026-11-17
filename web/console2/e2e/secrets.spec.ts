import { expect, test, type Page } from "@playwright/test";
async function open(page: Page) {
  await page.goto("./#/admin");
  await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
  await expect(page.getByRole("list", { name: "Environment variable names" })).toContainText("SLACK_BOT_TOKEN");
}
test.beforeEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); });
test("names only, write-only submission, replacement confirmation, and no browser persistence", async ({ page }) => {
  await open(page);
  const secret = "browser-only-secret-sentinel";
  await page.getByLabel("Environment name", { exact: true }).fill("EXAMPLE_API_KEY");
  await page.getByLabel("New secret value").fill(secret);
  await expect(page.getByRole("button", { name: "Save secret for restart" })).toBeDisabled();
  await page.getByLabel("I confirm replacement").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/secrets") && r.method() === "POST");
  await page.getByRole("button", { name: "Save secret for restart" }).click();
  expect((await sent).postDataJSON()).toEqual({ operation: "save", name: "EXAMPLE_API_KEY", value: secret, overwrite: true });
  await expect(page.getByRole("status").filter({ hasText: "Saved for next startup" })).toBeVisible();
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  expect(await page.locator("body").innerText()).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(secret);
  await expect(page.getByRole("list", { name: "Environment variable names" })).toContainText("Pending restart");
});
test("failed submissions clear values and hiding Admin clears an unsubmitted secret", async ({ page }) => {
  await open(page);
  await page.route("**/api/v1/secrets", async (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Private storage unavailable." } }) : route.continue());
  await page.getByLabel("Environment name", { exact: true }).fill("NEW_API_KEY");
  await page.getByLabel("New secret value").fill("never-retain-this");
  await page.getByRole("button", { name: "Save secret for restart" }).click();
  await expect(page.getByRole("alert")).toContainText("Private storage unavailable");
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  await page.getByLabel("New secret value").fill("unsubmitted-secret");
  await page.getByRole("link", { name: "Back to console" }).click();
  await page.getByRole("button", { name: "Admin configuration" }).click();
  await expect(page.getByLabel("New secret value")).toHaveValue("");
});
test("restart requires interruption confirmation, acknowledges without claiming completion", async ({ page }) => {
  await open(page);
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/secrets")) posts.push(r.postData() ?? ""); });
  await page.getByRole("button", { name: "Restart harness…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("interrupted");
  await expect(dialog.getByRole("button", { name: "Confirm restart" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(posts).toHaveLength(0);
  await page.getByRole("button", { name: "Restart harness…", exact: true }).click();
  await page.getByLabel("I understand that running work will be interrupted.").check();
  await page.getByRole("button", { name: "Confirm restart" }).click();
  await expect(page.getByRole("status").filter({ hasText: "NOT yet verified" })).toBeVisible();
  expect(posts).toEqual([JSON.stringify({ operation: "restart", confirm: true })]);
  await page.getByRole("button", { name: "Check service return" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Still the same process" })).toBeVisible();
  await page.route("**/api/v1/secrets", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, instance: "new-process", restart: { available: true, pending: false } } });
  });
  await page.getByRole("button", { name: "Check service return" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Harness returned with a new process" })).toBeVisible();
});
test("unsupervised restart and unconfigured storage are visibly unavailable", async ({ page }) => {
  await page.route("**/api/v1/secrets", (route) => route.fulfill({ json: { enabled: false, instance: "no-supervisor", variables: [{ name: "SLACK_BOT_TOKEN", set: true, source: "inherited", pendingRestart: false, protected: false }], restart: { available: false, pending: false } } }));
  await open(page);
  await expect(page.getByRole("button", { name: "Restart harness…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save secret for restart" })).toBeDisabled();
});
