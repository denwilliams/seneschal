import { expect, test } from "@playwright/test";

const full = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Channels and threads" });
const rail = (page: import("@playwright/test").Page) => page.getByTestId("tree-rail");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("the workspace panel folds into a rail and comes back, and the rest takes the room", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL");
  await expect(full(page).getByText("#general")).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
  const before = await page.locator("main").boundingBox();

  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await expect(full(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "Expand workspace panel" })).toHaveAttribute("aria-expanded", "false");
  const after = await page.locator("main").boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width);
  // The channel you are in is marked in the rail, and every channel is still one click away.
  await expect(rail(page).getByRole("button", { name: "#general" })).toHaveAttribute("aria-current", "page");
  await expect(rail(page).getByRole("button", { name: "#project-x" })).toBeVisible();

  await rail(page).getByRole("button", { name: "Expand workspace panel" }).click();
  await expect(rail(page)).toHaveCount(0);
  await expect(full(page).getByText("#general")).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse workspace panel" })).toHaveAttribute("aria-expanded", "true");
});

test("a channel picked in the rail opens, the panel stays folded, and the choice survives a reload", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await rail(page).getByRole("button", { name: "#project-x" }).click();
  await expect(page).toHaveURL(/#\/c\/C0PROJECT/);
  await expect(rail(page).getByRole("button", { name: "#project-x" })).toHaveAttribute("aria-current", "page");
  await expect(rail(page)).toBeVisible();

  await page.reload();
  await expect(rail(page)).toBeVisible();
  await expect(full(page)).toHaveCount(0);
  await rail(page).getByRole("button", { name: "Expand workspace panel" }).click();
  await page.reload();
  await expect(full(page)).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
});

test("the toggle works from the keyboard, and a direct message shows as a lock, not its name", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL");
  const collapse = page.getByRole("button", { name: "Collapse workspace panel" });
  await collapse.focus();
  await page.keyboard.press("Enter");
  await expect(rail(page)).toBeVisible();
  const expand = rail(page).getByRole("button", { name: "Expand workspace panel" });
  await expand.focus();
  await page.keyboard.press("Space");
  await expect(full(page)).toBeVisible();
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await expect(rail(page).getByRole("button", { name: "dana" })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "dana" })).not.toContainText("D");
});

test("a tooltip names the channel on a rail button", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await rail(page).getByRole("button", { name: "#project-x" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("#project-x");
});

test("without storage the panel still folds and unfolds", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  });
  await page.goto("./#/c/C0GENERAL");
  await expect(full(page)).toBeVisible();
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await expect(rail(page)).toBeVisible();
  await rail(page).getByRole("button", { name: "Expand workspace panel" }).click();
  await expect(full(page)).toBeVisible();
});

test("on a narrow screen the drawer is unchanged: no collapse button, and a folded choice does not hide it", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL");
  await page.getByRole("button", { name: "Collapse workspace panel" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rail(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open workspace tree" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("#project-x")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Collapse workspace panel" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
