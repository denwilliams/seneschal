import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { rawEditor } from "./yaml-editor-helper";

// Opt-in mock-backed review captures, not part of the normal browser run.
// From web/console2: npm run shots:yaml-editor
// Optional: python3 scripts/shrink-pngs.py ../../docs/screenshots/yaml-editor
// Requires Pillow. Captures are 1x and contain only mock fixture configuration.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate YAML editor screenshots");
const OUT = resolve(process.cwd(), "../../docs/screenshots/yaml-editor");

for (const theme of ["light", "dark"] as const) test(`${theme}: highlighted YAML with a nested node folded`, async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1180, height: 1160 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto("./#/admin");
  await expect(rawEditor(page)).toBeVisible();
  await page.locator(".cm-line").filter({ hasText: /^\s*general:$/ }).click();
  await page.getByRole("button", { name: "Toggle current fold" }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await page.getByRole("region", { name: "Configuration administration" }).screenshot({ path: `${OUT}/${theme}.png`, scale: "css" });
});

test("390px: editor, outline and folding controls fit without sideways scrolling", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 1380 });
  await page.goto("./#/admin");
  await expect(rawEditor(page)).toBeVisible();
  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  await page.getByRole("navigation", { name: "Top-level YAML sections" }).getByRole("button", { name: "connectors", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("region", { name: "Configuration administration" }).evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${OUT}/mobile.png`, scale: "css" });
});
