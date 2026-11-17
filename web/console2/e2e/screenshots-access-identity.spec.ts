import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
test.skip(!process.env.SCREENSHOTS, "Opt-in Access identity screenshots against mock fixtures");
const out = resolve(process.cwd(), "../../docs/screenshots/cloudflare-access");
for (const [name, theme, width, height] of [["light", "light", 1180, 820], ["dark", "dark", 1180, 820], ["mobile", "light", 390, 844]] as const) test(name + " signed-in identity", async ({ page }) => {
  mkdirSync(out, { recursive: true });
  await page.route("**/api/v1/identity", (route) => route.fulfill({ json: { identity: { subject: "user-1", email: "operator@example.test" } } }));
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height });
  await page.goto("./#/c/C0GENERAL");
  await expect(page.getByTestId("signed-in-identity")).toContainText("operator@example.test");
  await expect(page.getByTestId("connection")).toContainText("Connected");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.mouse.move(0, 0); await page.waitForTimeout(300);
  await page.screenshot({ path: out + "/" + name + ".png", scale: "css", fullPage: true });
});
