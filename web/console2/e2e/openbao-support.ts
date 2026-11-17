import type { Page } from "@playwright/test";
export async function scopedSecretsFixture(page: Page, warning?: string) {
  await page.route("**/api/v1/secrets", async (route) => {
    if (route.request().method() === "POST" && route.request().postDataJSON().operation.startsWith("backend-")) {
      await route.fulfill({ json: { saved: true, applied: false } }); return;
    }
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, scoped: {
      backends: [{ id: "openbao", label: "OpenBao", enabled: true, warning }, { id: "macos-keychain", label: "macOS Keychain", enabled: true, canDelete: true }],
      channels: [{ id: "C123ABC", name: "engineering" }, { id: "C456DEF", name: "support" }],
    } } });
  });
}
export async function openScopedSecrets(page: Page) {
  await page.goto("./#/admin");
  await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
  await page.getByLabel("Storage backend").selectOption("openbao");
}
