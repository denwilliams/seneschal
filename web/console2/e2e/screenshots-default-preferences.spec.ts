import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(!process.env.SCREENSHOTS, "Opt-in synthetic default preferences evidence");
const out = resolve(process.cwd(), "../../docs/screenshots/default-preferences");
for (const theme of ["light", "dark"] as const) {
  for (const [size, width, height] of [["desktop", 1180, 950], ["mobile", 390, 844]] as const) {
    test(`${theme} ${size} global preferences`, async ({ page }) => {
      mkdirSync(out, { recursive: true });
      await page.request.post("__mock", { data: { reset: true } });
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height });
      await page.goto("./#/admin");
      await page.getByRole("button", { name: "Basic settings", exact: true }).click();
      await page.getByRole("textbox", { name: "Default preferences", exact: true }).fill("Use concise bullets.\nState assumptions before recommendations.");
      await page.getByLabel("Channel", { exact: true }).selectOption("project-x");
      const section = page.getByRole("region", { name: "Configuration administration" });
      await page.getByRole("heading", { name: "Global defaults", exact: true }).evaluate(el => el.scrollIntoView({ block: "start" }));
      await expect(page.getByRole("textbox", { name: "Default preferences", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page.getByTestId("connection")).toContainText("Connected");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: resolve(out, `${theme}-${size}.png`), scale: "css" });
    });
  }
}
