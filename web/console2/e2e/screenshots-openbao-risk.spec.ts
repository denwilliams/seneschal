import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { scopedSecretsFixture, openScopedSecrets } from "./openbao-support";

// Regenerate from web/console2: SCREENSHOTS=1 npx playwright test e2e/screenshots-openbao-risk.spec.ts
// Synthetic API fixture only. Never contacts OpenBao or changes deployment configuration.
test.skip(!process.env.SCREENSHOTS, "Opt-in accepted-OpenBao-risk documentation screenshots");
const out = resolve(process.cwd(), "../../docs/screenshots/openbao-risk");
const warning = "OpenBao host-execution risk accepted (openbao.acceptHostExecutionRisk: true). Same-user host execution is trusted and may read the token file or process memory, obtain backend credentials and access backend secrets outside configured channel scopes. Container channels do not isolate their secrets from the host. Scoped imports still apply, but are not an OS-enforced boundary against host execution.";
for (const [name, theme, width, height] of [["light", "light", 1180, 1150], ["dark", "dark", 1180, 1150], ["mobile", "light", 390, 844]] as const) {
  test(name + " accepted host execution risk", async ({ page }) => {
    mkdirSync(out, { recursive: true });
    await page.request.post("__mock", { data: { reset: true } });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await scopedSecretsFixture(page, warning);
    await openScopedSecrets(page);
    await page.getByLabel("Secret channel").selectOption("C123ABC");
    await page.getByLabel("Environment name", { exact: true }).fill("GITHUB_TOKEN");
    await expect(page.getByRole("alert")).toContainText("OpenBao host-execution risk accepted");
    await expect(page.getByRole("alert")).toContainText("token file or process memory");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    if (name === "mobile") await page.locator("form").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: out + "/" + name + ".png", scale: "css", fullPage: true });
  });
}
