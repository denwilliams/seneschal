import type { Page } from "@playwright/test";
/** Mock fixtures only: never talks to a real Keychain or retains submitted values. */
export async function keychainFixture(page: Page, available = true, acceptHostExecutionRisk = false) {
  await page.route("**/api/v1/secrets", async (route) => {
    if (route.request().method() === "POST") return available ? route.fulfill({ json: { saved: true, applied: false } }) : route.fallback();
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), scoped: {
      backends: [{ id: "macos-keychain", label: "macOS Keychain", enabled: available, canDelete: true, ...(acceptHostExecutionRisk ? { warning: "Keychain host-execution risk accepted (keychain.acceptHostExecutionRisk: true). Same-user host execution is trusted and may invoke the helper directly to access Keychain secrets outside configured channel scopes. Container channels do not isolate their secrets from the host. Scoped imports still apply, but are not an OS-enforced boundary against host execution." } : {}), ...(!available ? { unavailableReason: "Keychain is unavailable with host bash: it has the harness OS identity. Docker or Apple Containers (macos-container) is required for bash-enabled channels. You can keep using .env without container isolation; leave Keychain unconfigured." } : {}) }],
      channels: [{ id: "C0PROJECT", name: "project" }, { id: "C0TEAM", name: "team" }],
    } } });
  });
}
export async function openKeychain(page: Page) {
  await keychainFixture(page);
  await page.goto("./#/admin");
  await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
  await page.getByLabel("Storage backend").selectOption("macos-keychain");
}
