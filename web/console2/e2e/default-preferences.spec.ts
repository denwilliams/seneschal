import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawText } from "./yaml-editor-helper";

const basic = (page: Page) => page.getByRole("button", { name: "Basic settings", exact: true }).click();
const raw = (page: Page) => page.getByRole("button", { name: "Raw YAML", exact: true }).click();
const preferences = (page: Page) => page.getByRole("textbox", { name: "Default preferences", exact: true });
async function save(page: Page) {
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
}
async function reload(page: Page, text: string) {
  await page.getByRole("button", { name: "Reload persisted config", exact: true }).click();
  await expect.poll(() => rawText(page)).toBe(text);
  await basic(page);
}
test.beforeEach(async ({ page }) => {
  await page.request.post("__mock", { data: { reset: true } });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
});

test("read and edit multiline default preferences, round-trip raw YAML, save and preserve channel overrides and fallback", async ({ page }) => {
  await basic(page);
  await expect(preferences(page)).toHaveValue("Be concise.");
  const channelPreferences = page.getByRole("textbox", { name: "Preferences", exact: true });
  await expect(channelPreferences).toHaveValue("Summarise decisions.");
  await page.getByLabel("Channel", { exact: true }).selectOption("project-x");
  await expect(channelPreferences).toBeDisabled();
  await expect(channelPreferences).toHaveAttribute("placeholder", "Be concise.");

  const value = "Use concise bullets.\n\nContext: keep # literal text.\n";
  await preferences(page).fill(value);
  await expect(channelPreferences).toHaveAttribute("placeholder", value);
  await raw(page);
  const patched = await rawText(page);
  const expected = parse(ADMIN_CONFIG);
  expected.defaults.preferences = value;
  expect(parse(patched)).toEqual(expected);
  expect(patched.slice(patched.indexOf("channels:"))).toBe(ADMIN_CONFIG.slice(ADMIN_CONFIG.indexOf("channels:")));
  await basic(page);
  await expect(preferences(page)).toHaveValue(value);
  await save(page);
  await reload(page, patched);
  await expect(preferences(page)).toHaveValue(value);

  // Raw YAML edits reappear in Basic settings and use the same save path.
  await raw(page);
  const rawDraft = patched.replace("Use concise bullets.", "Use short paragraphs.");
  await page.getByLabel("Raw configuration YAML").fill(rawDraft);
  await basic(page);
  await expect(preferences(page)).toHaveValue(value.replace("Use concise bullets.", "Use short paragraphs."));
  await page.getByLabel("Channel", { exact: true }).selectOption("general");
  await expect(channelPreferences).toHaveValue("Summarise decisions.");
  await save(page);
  await reload(page, rawDraft);
});

test("remove optional default preferences, add them back and keep explicit empty distinct from unset", async ({ page }) => {
  await basic(page);
  const override = page.getByLabel("Default preferences explicit override", { exact: true });
  await override.uncheck();
  await expect(preferences(page)).toBeDisabled();
  await page.getByLabel("Channel", { exact: true }).selectOption("project-x");
  await expect(page.getByRole("textbox", { name: "Preferences", exact: true })).not.toHaveAttribute("placeholder");
  await raw(page);
  const removed = await rawText(page);
  expect(removed).toBe(ADMIN_CONFIG.replace("  preferences: Be concise.\n", ""));
  await basic(page);
  await save(page);
  await reload(page, removed);
  await expect(override).not.toBeChecked();
  await override.check();
  await expect(preferences(page)).toHaveValue("");
  await save(page);
  await raw(page);
  const empty = await rawText(page);
  expect(parse(empty).defaults.preferences).toBe("");
  await reload(page, empty);
  await expect(override).toBeChecked();
  await expect(preferences(page)).toHaveValue("");
  await preferences(page).fill("New default\nSecond line");
  await save(page);
  await raw(page);
  const added = await rawText(page);
  expect(parse(added).defaults.preferences).toBe("New default\nSecond line");
  await reload(page, added);
  await expect(preferences(page)).toHaveValue("New default\nSecond line");
});
