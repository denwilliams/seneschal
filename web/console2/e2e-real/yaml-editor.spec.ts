import { expect, test } from "@playwright/test";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawEditor, rawText } from "../e2e/yaml-editor-helper";

// Keep the real HTML, assets and security policy; only the config API needs a
// mock because the real-server fixture intentionally has no admin config store.
test("the locally bundled YAML editor works under the real server's CSP", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" || /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text()); });
  page.on("pageerror", (error) => problems.push(String(error)));
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: { text: ADMIN_CONFIG, revision: "fixture" } }));
  const response = await page.goto("/console2/#/admin");
  expect(response!.headers()["content-security-policy"]).toBeTruthy();
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  await expect(page.locator(".yaml-key").filter({ hasText: /^defaults$/ })).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCSS("display", "flex");
  await expect(page.locator(".cm-gutters")).toHaveCSS("display", "flex");
  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  await page.getByRole("navigation", { name: "Top-level YAML sections" }).getByRole("button", { name: "connectors", exact: true }).click();
  await expect(page.locator(".cm-line").filter({ hasText: /Authorization: Bearer/ })).toBeVisible();
  await rawEditor(page).press("Control+End");
  await rawEditor(page).press("#");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG + "#");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload persisted config" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Persisted configuration loaded" })).toBeVisible();
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  // An inspect response is all the basic-settings mode needs to unmount and
  // remount the raw editor; keep checking CSP when the stylesheet is reused.
  await page.route("**/api/v1/config", (route) => route.fulfill({ json: {
    defaults: { recentConversations: { basic: true, values: {}, unsupported: [] } }, channels: [], connectors: [],
    recentConversationDefaults: { enabled: true, debounceSeconds: 60, maxThreads: 10, model: "deepseek-flash", maxTranscriptChars: 8000 },
  } }));
  await page.getByRole("button", { name: "Basic settings", exact: true }).click();
  await expect(rawEditor(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Default recent conversations", exact: true })).toContainText("Inherited built-in default: 60");
  await page.getByRole("button", { name: "Raw YAML", exact: true }).click();
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  await expect(page.locator(".cm-editor")).toHaveCSS("display", "flex");
  expect(problems).toEqual([]);
});
