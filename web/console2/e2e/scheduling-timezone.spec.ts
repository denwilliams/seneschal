import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawText } from "./yaml-editor-helper";

const basic = (page: Page) => page.getByRole("button", { name: "Basic settings", exact: true }).click();
const raw = (page: Page) => page.getByRole("button", { name: "Raw YAML", exact: true }).click();
const zone = (page: Page) => page.getByLabel("Default scheduling timezone", { exact: true });
const override = (page: Page) => page.getByLabel("Default scheduling timezone explicit override", { exact: true });
async function save(page: Page) {
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toContainText("restart to rebind");
}
async function reopen(page: Page, text: string) {
  await page.getByRole("button", { name: "Reload persisted config", exact: true }).click();
  await expect.poll(() => rawText(page)).toBe(text);
  await basic(page);
}
test.beforeEach(async ({ page }) => {
  await page.request.post("__mock", { data: { reset: true } });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
});

test("default/explicit display, add/change/remove, mode retention, validation and save/reopen", async ({ page }) => {
  await basic(page);
  const section = page.getByRole("region", { name: "Scheduling defaults", exact: true });
  await expect(section).toContainText("does not rewrite existing tasks");
  await expect(section).toContainText("built-in default: UTC");
  await expect(override(page)).not.toBeChecked();
  await expect(zone(page)).toBeDisabled();
  await expect(zone(page)).toHaveAttribute("placeholder", "UTC");
  await override(page).check();
  await expect(zone(page)).toHaveValue("UTC");
  await zone(page).fill("Australia/Sydney");
  await raw(page);
  const added = await rawText(page);
  expect(parse(added)).toEqual({ ...parse(ADMIN_CONFIG), schedules: { timezone: "Australia/Sydney" } });
  expect(added).toContain(ADMIN_CONFIG.trimEnd());
  await basic(page);
  await expect(zone(page)).toHaveValue("Australia/Sydney");
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Nothing saved or applied" })).toBeVisible();
  expect((await (await page.request.get("api/v1/config")).json()).text).toBe(ADMIN_CONFIG);
  await save(page);
  await reopen(page, added);
  await expect(override(page)).toBeChecked();
  await expect(zone(page)).toHaveValue("Australia/Sydney");
  await zone(page).fill("UTC");
  await save(page);
  await raw(page);
  const explicit = await rawText(page);
  await reopen(page, explicit);
  await expect(zone(page)).toHaveValue("UTC");
  await expect(override(page)).toBeChecked();
  await override(page).uncheck();
  await save(page);
  await raw(page);
  const removed = await rawText(page);
  expect(parse(removed).schedules?.timezone).toBeUndefined();
  await reopen(page, removed);
  await expect(override(page)).not.toBeChecked();
  await expect(zone(page)).toBeDisabled();
  // Removing the final field leaves an empty block that remains editable.
  await override(page).check();
  await expect(zone(page)).toHaveValue("UTC");
  await save(page);
});

test("invalid values block patch/save and mode switching without losing the pending draft", async ({ page }) => {
  await basic(page);
  await override(page).check();
  for (const value of ["", " ", "Invalid/Zone", "${EXAMPLE_TIMEZONE}"]) {
    await zone(page).fill(value);
    await page.getByRole("button", { name: "Validate and save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("non-empty timezone accepted by the runtime");
    await expect(zone(page)).toHaveValue(value);
  }
  await raw(page);
  await expect(zone(page)).toHaveValue("${EXAMPLE_TIMEZONE}");
  expect((await (await page.request.get("api/v1/config")).json()).text).toBe(ADMIN_CONFIG);
  await zone(page).fill("Europe/London");
  await raw(page);
  expect(parse(await rawText(page)).schedules.timezone).toBe("Europe/London");
});

for (const schedules of ["  timezone: '${EXAMPLE_TIMEZONE}' # reference\n", "  timezone: [UTC]\n", "  timezone: &zone UTC\nother: *zone\n"]) {
  test(`unsupported timezone preserves unrelated edits: ${schedules.trim()}`, async ({ page }) => {
    const initial = ADMIN_CONFIG + "schedules:\n" + schedules;
    await page.getByLabel("Raw configuration YAML").fill(initial);
    await basic(page);
    await expect(page.getByRole("region", { name: "Scheduling defaults", exact: true })).toContainText("Raw YAML");
    await expect(zone(page)).toHaveCount(0);
    await page.getByLabel("Default preferences", { exact: true }).fill("Example guidance.");
    await raw(page);
    expect(await rawText(page)).toBe(initial.replace("Be concise.", "Example guidance."));
  });
}

test("stale revision refuses save, retains timezone draft and leaves persisted config alone", async ({ page }) => {
  await basic(page);
  await override(page).check();
  await zone(page).fill("America/New_York");
  const snapshot = await (await page.request.get("api/v1/config")).json();
  const external = snapshot.text + "# External operator change\n";
  const response = await page.request.post("api/v1/config", { data: { operation: "save", text: external, revision: snapshot.revision } });
  expect(response.ok()).toBe(true);
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed since you loaded");
  await expect(zone(page)).toHaveValue("America/New_York");
  await raw(page);
  expect(parse(await rawText(page)).schedules.timezone).toBe("America/New_York");
  expect((await (await page.request.get("api/v1/config")).json()).text).toBe(external);
});
