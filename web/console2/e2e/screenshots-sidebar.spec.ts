import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Opt-in: regenerates the screenshots of the collapsible workspace panel (docs/screenshots/sidebar-collapse/).
 * Not part of the normal run. From web/console2:  npm run shots:sidebar-collapse
 * They come from the mock fixtures (mock/server.mjs), at 1x scale.
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 (npm run shots:sidebar-collapse) to regenerate the documentation screenshots");

const OUT = resolve(process.cwd(), "../../docs/screenshots/sidebar-collapse");
mkdirSync(OUT, { recursive: true });

const shoot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, type: "png", scale: "css" });
const ROUTE = "./#/c/C0GENERAL/t/1760000000.000100";

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto(ROUTE);
  await expect(page.getByTestId("fork-divider")).toBeVisible();
}

test("expanded: the workspace panel as it was", async ({ page }) => {
  await open(page);
  await shoot(page, "1-expanded");
});

test("collapsed: a slim rail, and the room goes to the conversation and details", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await expect(page.getByTestId("tree-rail")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "2-collapsed");
});

test("collapsed, with a channel's name in its tooltip", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await page.getByTestId("tree-rail").getByRole("button", { name: "#project-x" }).hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "3-collapsed-tooltip");
});

test("dark theme: collapsed", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await expect(page.getByTestId("tree-rail")).toBeVisible();
  await page.waitForTimeout(300);
  await shoot(page, "4-dark-collapsed");
});

test("390px wide: the drawer is unchanged and has no collapse button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Open workspace tree" }).click();
  await expect(page.getByRole("dialog").getByText("#project-x")).toBeVisible();
  await page.waitForTimeout(500);
  await shoot(page, "5-mobile-drawer");
});
