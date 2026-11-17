import { expect, test } from "@playwright/test";
import { keychainFixture, openKeychain } from "./keychain-support";

test.beforeEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); });
test("host bash warns that Keychain is unavailable while environment remains usable", async ({ page }) => {
  await keychainFixture(page, false);
  await page.goto("./#/admin");
  await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
  await expect(page.getByLabel("Storage backend")).toHaveValue("environment");
  await expect(page.getByRole("option", { name: "macOS Keychain (unavailable)" })).toHaveJSProperty("disabled", true);
  const warning = page.getByRole("note").filter({ hasText: "macOS Keychain unavailable" });
  await expect(warning).toContainText("host bash");
  await expect(warning).toContainText("Docker or Apple Containers");
  await expect(warning).toContainText("keep using .env without container isolation");
  await expect(page.getByText("Environment selection does not override configured Keychain imports", { exact: false })).toBeVisible();
  await page.getByLabel("Environment name", { exact: true }).fill("HOST_BASH_KEY");
  await page.getByLabel("New secret value").fill("env-secret-sentinel");
  const sent = page.waitForRequest((r) => r.url().endsWith("/secrets") && r.method() === "POST");
  await page.getByRole("button", { name: "Save secret for restart" }).click();
  expect((await sent).postDataJSON()).toEqual({ operation: "save", name: "HOST_BASH_KEY", value: "env-secret-sentinel", overwrite: false });
  await expect(page.getByRole("status").filter({ hasText: "Saved for next startup" })).toBeVisible();
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  await expect(page.getByLabel("Storage backend")).toHaveValue("environment");
});
test("accepted host risk stays visible with environment or Keychain selected without disabling scoped writes", async ({ page }) => {
  await keychainFixture(page, true, true);
  await page.goto("./#/admin");
  await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
  const warning = page.getByRole("alert").filter({ hasText: "macOS Keychain security warning" });
  await expect(page.getByLabel("Storage backend")).toHaveValue("environment");
  await expect(warning).toContainText("host-execution risk accepted");
  await expect(warning).toContainText("outside configured channel scopes");
  await expect(warning).toContainText("Container channels do not isolate their secrets from the host");
  await expect(page.getByRole("option", { name: "macOS Keychain", exact: true })).toHaveJSProperty("disabled", false);
  await page.getByLabel("Storage backend").selectOption("macos-keychain");
  await expect(page.getByText("macOS Keychain unavailable.", { exact: true })).toHaveCount(0);
  await page.getByLabel("Secret channel").selectOption("C0PROJECT");
  await page.getByLabel("Environment name", { exact: true }).fill("TOKEN");
  await page.getByLabel("New secret value").fill("accepted-risk-sentinel");
  await page.getByLabel("I confirm replacement").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/secrets") && r.method() === "POST");
  await page.getByRole("button", { name: "Save scoped secret" }).click();
  expect((await sent).postDataJSON()).toEqual({ operation: "backend-save", backend: "macos-keychain", scope: { kind: "channel", channel: "C0PROJECT" }, name: "TOKEN", value: "accepted-risk-sentinel", overwrite: true });
  await expect(page.getByLabel("New secret value")).toHaveValue("");
  await expect(warning).toBeVisible();
});

test("shared form submits exact scoped writes, clears values and never persists or reads them back", async ({ page }) => {
  await openKeychain(page);
  await page.getByLabel("Environment name", { exact: true }).fill("TOKEN");
  for (const scope of ["channel", "global-channel", "main-process"]) {
    await page.getByLabel("Secret scope").selectOption(scope);
    if (scope === "channel") await page.getByLabel("Secret channel").selectOption("C0PROJECT");
    await page.getByLabel("New secret value").fill("browser-secret-sentinel");
    await expect(page.getByRole("button", { name: "Save scoped secret" })).toBeDisabled();
    await page.getByLabel("I confirm replacement").check();
    const sent = page.waitForRequest((r) => r.url().endsWith("/secrets") && r.method() === "POST");
    await page.getByRole("button", { name: "Save scoped secret" }).click();
    expect((await sent).postDataJSON()).toEqual({ operation: "backend-save", backend: "macos-keychain", scope: scope === "channel" ? { kind: scope, channel: "C0PROJECT" } : { kind: scope }, name: "TOKEN", value: "browser-secret-sentinel", overwrite: true });
    await expect(page.getByRole("status").filter({ hasText: "lookup cache invalidated" })).toBeVisible();
    await expect(page.getByLabel("New secret value")).toHaveValue("");
    expect(await page.locator("body").innerText()).not.toContain("browser-secret-sentinel");
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("browser-secret-sentinel");
  }
});
test("failed writes clear values and deletes require explicit confirmation", async ({ page }) => {
  await openKeychain(page);
  await page.getByLabel("Secret scope").selectOption("main-process");
  await page.getByLabel("Environment name", { exact: true }).fill("TOKEN");
  await expect(page.getByRole("button", { name: "Delete scoped secret" })).toBeDisabled();
  await page.getByLabel("I confirm replacement").check();
  const sent = page.waitForRequest((r) => r.url().endsWith("/secrets") && r.method() === "POST");
  await page.getByRole("button", { name: "Delete scoped secret" }).click();
  expect((await sent).postDataJSON()).toEqual({ operation: "backend-delete", backend: "macos-keychain", scope: { kind: "main-process" }, name: "TOKEN", confirm: true });
  await expect(page.getByRole("status").filter({ hasText: "Scoped secret deleted" })).toBeVisible();
  await page.route("**/api/v1/secrets", async (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Keychain is locked or access was denied." } }) : route.fallback());
  await page.getByLabel("I confirm replacement").check();
  await page.getByLabel("New secret value").fill("clear-on-failure");
  await page.getByRole("button", { name: "Save scoped secret" }).click();
  await expect(page.getByRole("alert")).toContainText("locked");
  await expect(page.getByLabel("New secret value")).toHaveValue("");
});
