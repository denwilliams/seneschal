import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { keychainFixture } from "./keychain-support";

// Regenerate from web/console2: SCREENSHOTS=1 npx playwright test e2e/screenshots-keychain-risk.spec.ts
// Mock fixtures only; never contacts Keychain. Kept out of normal E2E runs.
test.skip(!process.env.SCREENSHOTS, "Opt-in accepted-Keychain-risk documentation screenshots");
const out = resolve(process.cwd(), "../../docs/screenshots/keychain-risk");
for (const [name, theme, width, height] of [["light", "light", 1180, 1150], ["dark", "dark", 1180, 1150], ["mobile", "light", 390, 844]] as const) {
  test(name + " accepted host execution risk", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.request.post("__mock", { data: { reset: true } });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await keychainFixture(page, true, true);
    await page.goto("./#/admin");
    await page.getByRole("button", { name: "Secrets and restart", exact: true }).click();
    await page.getByLabel("Storage backend").selectOption("macos-keychain");
    await page.getByLabel("Secret channel").selectOption("C0PROJECT");
    await page.getByLabel("Environment name", { exact: true }).fill("GITHUB_TOKEN");
    await expect(page.getByRole("alert")).toContainText("host-execution risk accepted");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (name === "mobile") await page.locator("form").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: out + "/" + name + ".png", scale: "css", fullPage: true });
  });
}
