import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openKeychain } from "./keychain-support";
test.skip(!process.env.SCREENSHOTS, "Opt-in Keychain documentation screenshots (mock fixtures only)");
const out = resolve(process.cwd(), "../../docs/screenshots/keychain");
for (const [name, theme, width, height] of [["light", "light", 1180, 1150], ["dark", "dark", 1180, 1150], ["mobile", "light", 390, 844]] as const) test(name + " Keychain scoped secrets", async ({ page }) => {
  mkdirSync(out, { recursive: true });
  await page.request.post("__mock", { data: { reset: true } });
  await page.emulateMedia({ colorScheme: theme }); await page.setViewportSize({ width, height });
  await openKeychain(page);
  await page.getByLabel("Secret channel").selectOption("C0PROJECT");
  await page.getByLabel("Environment name", { exact: true }).fill("GITHUB_TOKEN");
  await expect(page.getByRole("button", { name: "Save scoped secret" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (name === "mobile") await page.locator("form").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.mouse.move(0, 0); await page.waitForTimeout(250);
  await page.screenshot({ path: out + "/" + name + ".png", scale: "css", fullPage: true });
});
