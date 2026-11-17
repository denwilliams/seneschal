import { expect, test } from "@playwright/test";
import { openScopedSecrets, scopedSecretsFixture } from "./openbao-support";
test.beforeEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); await scopedSecretsFixture(page); });
test("OpenBao adds in all scopes, clears values, and stores no value in the browser", async ({ page }) => {
  await openScopedSecrets(page);
  for (const kind of ["global-channel", "channel", "main-process"]) {
    await page.getByLabel("Secret scope").selectOption(kind);
    if (kind === "channel") await page.getByLabel("Secret channel").selectOption("C123ABC");
    await page.getByLabel("Environment name", { exact: true }).fill("NEW_TOKEN");
    await page.getByLabel("New secret value").fill("browser-scope-secret");
    await expect(page.getByRole("button", { name: "Save scoped secret" })).toBeDisabled();
    await page.getByLabel("I confirm replacement").check();
    const sent = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/secrets"));
    await page.getByRole("button", { name: "Save scoped secret" }).click();
    expect((await sent).postDataJSON()).toEqual({ operation: "backend-save", backend: "openbao", name: "NEW_TOKEN", value: "browser-scope-secret", overwrite: true, scope: kind === "channel" ? { kind, channel: "C123ABC" } : { kind } });
    await expect(page.getByLabel("New secret value")).toHaveValue("");
    await expect(page.getByRole("status").filter({ hasText: "Saved in the backend" })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("browser-scope-secret");
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("browser-scope-secret");
  }
});
test("one shared form switches backends, clears pending values and exposes only supported deletion", async ({ page }) => {
  await openScopedSecrets(page);
  await page.getByLabel("New secret value").fill("pending-private-value");
  await page.getByLabel("I confirm replacement").check();
  await expect(page.getByRole("button", { name: "Delete scoped secret" })).toHaveCount(0);
  await page.getByLabel("Storage backend").selectOption("macos-keychain");
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  await expect(page.getByLabel("I confirm replacement")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Delete scoped secret" })).toBeDisabled();
  await page.getByLabel("Secret scope").selectOption("main-process");
  await page.getByLabel("Environment name", { exact: true }).fill("TOKEN");
  await page.getByLabel("I confirm replacement").check();
  const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/secrets"));
  await page.getByRole("button", { name: "Delete scoped secret" }).click();
  expect((await sent).postDataJSON()).toEqual({ operation: "backend-delete", backend: "macos-keychain", scope: { kind: "main-process" }, name: "TOKEN", confirm: true });
  await expect(page.getByRole("status").filter({ hasText: "Scoped secret deleted" })).toBeVisible();
});
test("changing target clears a pending value; failed backend saves clear values too", async ({ page }) => {
  await openScopedSecrets(page);
  await page.getByLabel("New secret value").fill("unsent-secret");
  await page.getByLabel("Secret scope").selectOption("main-process");
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  await page.route("**/api/v1/secrets", async (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Backend secret write failed." } }) : route.fallback());
  await page.getByLabel("Environment name", { exact: true }).fill("TOKEN");
  await page.getByLabel("New secret value").fill("never-retain");
  await page.getByLabel("I confirm replacement").check();
  await page.getByRole("button", { name: "Save scoped secret" }).click();
  await expect(page.getByRole("alert")).toContainText("Backend secret write failed");
  await expect(page.getByLabel("New secret value")).toHaveValue("");
});
