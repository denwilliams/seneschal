import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in synthetic scheduling timezone evidence");
const out = resolve(process.cwd(), "../../docs/screenshots/scheduling-timezone");
for (const theme of ["light", "dark"] as const) {
  for (const [size, width, height] of [["desktop", 1180, 950], ["mobile", 390, 844]] as const) {
    test(`${theme} ${size} scheduling timezone`, async ({ page }) => {
      mkdirSync(out, { recursive: true });
      await page.request.post("__mock", { data: { reset: true } });
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      await page.goto("./#/admin");
      await page.getByRole("button", { name: "Basic settings", exact: true }).click();
      if (theme === "dark") {
        await page.getByLabel("Default scheduling timezone explicit override").check();
        await page.getByLabel("Default scheduling timezone", { exact: true }).fill("Australia/Sydney");
      }
      const section = page.getByRole("region", { name: "Scheduling defaults", exact: true });
      await section.evaluate(el => el.scrollIntoView({ block: "start" }));
      await expect(section).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByRole("region", { name: "Configuration administration" }).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page.getByTestId("connection")).toContainText("Connected");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: resolve(out, `${theme}-${size}.png`), scale: "css" });
    });
  }
}
