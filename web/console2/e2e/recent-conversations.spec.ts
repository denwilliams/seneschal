import { test, expect, type Page } from "@playwright/test";
import { parse } from "yaml";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawText } from "./yaml-editor-helper";

const basic = (page: Page) => page.getByRole("button", { name: "Basic settings", exact: true }).click();
const raw = (page: Page) => page.getByRole("button", { name: "Raw YAML", exact: true }).click();
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const override = (page: Page, label: string) => field(page, label + " explicit override");
const names = ["summaries enabled", "summary debounce", "summary thread limit", "summary model", "summary transcript limit"];
async function save(page: Page) {
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "restart to rebind" })).toBeVisible();
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

test("global values distinguish built-ins, edit all fields, retain drafts across channels/modes and save/reopen", async ({ page }) => {
  await basic(page);
  const defaults = page.getByRole("region", { name: "Default recent conversations", exact: true });
  await expect(defaults).toContainText("not durable memory");
  for (const name of names) {
    await expect(override(page, "Default " + name)).not.toBeChecked();
    await expect(field(page, "Default " + name)).toBeDisabled();
    await override(page, "Default " + name).check();
  }
  await field(page, "Default summaries enabled").selectOption("false");
  for (const [name, value] of [["summary debounce", "120"], ["summary thread limit", "7"], ["summary model", "example/summary"], ["summary transcript limit", "9000"]] as const) {
    await field(page, "Default " + name).fill(value);
  }
  await field(page, "Channel").selectOption("project-x");
  await expect(page.getByRole("region", { name: "Channel recent conversations", exact: true })).toContainText("Inherited global default: false");
  await raw(page);
  const patched = await rawText(page);
  const expected = parse(ADMIN_CONFIG);
  expected.defaults.recentConversations = { enabled: false, debounceSeconds: 120, maxThreads: 7, model: "example/summary", maxTranscriptChars: 9000 };
  expect(parse(patched)).toEqual(expected);
  expect(patched.slice(patched.indexOf("channels:"))).toBe(ADMIN_CONFIG.slice(ADMIN_CONFIG.indexOf("channels:")));
  await basic(page);
  await expect(field(page, "Default summaries enabled")).toHaveValue("false");
  await expect(field(page, "Default summary debounce")).toHaveValue("120");
  await save(page);
  await reopen(page, patched);
  await expect(override(page, "Default summaries enabled")).toBeChecked();
  await expect(field(page, "Default summaries enabled")).toHaveValue("false");
  for (const name of names) await override(page, "Default " + name).uncheck();
  await save(page);
  await raw(page);
  const removed = await rawText(page);
  expect(parse(removed).defaults.recentConversations).toBeNull();
  await reopen(page, removed);
  await expect(defaults).toContainText("Inherited built-in default: true");
  await override(page, "Default summary thread limit").check();
  await expect(field(page, "Default summary thread limit")).toHaveValue("10");
});

test("per-channel partial overrides preserve explicit false and remove only one sibling back to inheritance", async ({ page }) => {
  const initial = ADMIN_CONFIG.replace("  preferences: Be concise.\n", "  preferences: Be concise.\n  recentConversations: {enabled: true, maxThreads: 15}\n");
  await field(page, "Raw configuration YAML").fill(initial);
  await basic(page);
  for (const name of names) await override(page, "Channel " + name).check();
  await field(page, "Channel summaries enabled").selectOption("false");
  for (const [name, value] of [["summary debounce", "30"], ["summary thread limit", "3"], ["summary model", "example/channel-summary"], ["summary transcript limit", "4000"]] as const) {
    await field(page, "Channel " + name).fill(value);
  }
  await field(page, "Channel").selectOption("project-x");
  await expect(override(page, "Channel summaries enabled")).not.toBeChecked();
  await expect(field(page, "Channel summary thread limit")).toHaveAttribute("placeholder", "15");
  await field(page, "Channel").selectOption("general");
  await expect(field(page, "Channel summaries enabled")).toHaveValue("false");
  await expect(field(page, "Channel summary debounce")).toHaveValue("30");
  await save(page);
  await raw(page);
  const patched = await rawText(page);
  const expected = parse(initial);
  expected.channels.general.recentConversations = { enabled: false, debounceSeconds: 30, maxThreads: 3, model: "example/channel-summary", maxTranscriptChars: 4000 };
  expect(parse(patched)).toEqual(expected);
  await reopen(page, patched);
  await override(page, "Channel summary thread limit").uncheck();
  await expect(field(page, "Channel summary thread limit")).toHaveAttribute("placeholder", "15");
  await raw(page);
  const removed = await rawText(page);
  delete expected.channels.general.recentConversations.maxThreads;
  expect(parse(removed)).toEqual(expected);
  await basic(page);
  await save(page);
  await reopen(page, removed);
  await expect(override(page, "Channel summaries enabled")).toBeChecked();
  await expect(field(page, "Channel summaries enabled")).toHaveValue("false");
  // A Raw YAML edit reappears in the form, with siblings untouched.
  await raw(page);
  await field(page, "Raw configuration YAML").fill(removed.replace("debounceSeconds: 30", "debounceSeconds: 45"));
  await basic(page);
  await expect(field(page, "Channel summary debounce")).toHaveValue("45");
});

for (const mapping of ["'${SUMMARY_MAPPING}'", "[unsupported, mapping]"]) {
  test(`unsupported global mapping ${mapping} seeds built-ins, never warning text, into channel overrides`, async ({ page }) => {
    const initial = ADMIN_CONFIG.replace("  preferences: Be concise.\n", `  preferences: Be concise.\n  recentConversations: ${mapping}\n`);
    await field(page, "Raw configuration YAML").fill(initial);
    await basic(page);
    const channel = page.getByRole("region", { name: "Channel recent conversations", exact: true });
    await expect(channel).toContainText("Inherited global default: Unsupported global mapping — see Raw YAML");
    await expect(field(page, "Channel summary model")).toHaveAttribute("placeholder", "Unsupported global mapping — see Raw YAML");
    for (const [name, value] of [["summaries enabled", "true"], ["summary debounce", "60"], ["summary thread limit", "10"], ["summary model", "deepseek-flash"], ["summary transcript limit", "8000"]] as const) {
      await override(page, "Channel " + name).check();
      await expect(field(page, "Channel " + name)).toHaveValue(value);
    }
    await raw(page);
    const draft = await rawText(page);
    const expectedChannel = { enabled: true, debounceSeconds: 60, maxThreads: 10, model: "deepseek-flash", maxTranscriptChars: 8000 };
    expect(parse(draft).defaults.recentConversations).toEqual(parse(initial).defaults.recentConversations);
    expect(parse(draft).channels.general.recentConversations).toEqual(expectedChannel);
    expect(draft).not.toContain("Unsupported global mapping");
    // Repair the global representation; the already-added channel model must stay a real model value.
    const repaired = draft.replace(`recentConversations: ${mapping}`, "recentConversations: {model: example/repaired-global}");
    expect(repaired).not.toBe(draft);
    await field(page, "Raw configuration YAML").fill(repaired);
    await basic(page);
    await expect(field(page, "Channel summary model")).toHaveValue("deepseek-flash");
    await save(page);
    const persisted = await page.request.get("api/v1/config");
    expect(parse((await persisted.json()).text).channels.general.recentConversations).toEqual(expectedChannel);
    await reopen(page, repaired);
    await expect(field(page, "Channel summary model")).toHaveValue("deepseek-flash");
  });
}

test("invalid integer drafts are rejected without coercion, persistence or draft loss", async ({ page }) => {
  await basic(page);
  await override(page, "Default summary debounce").check();
  for (const value of ["0", "-1", "1.5", "malformed", "1e2", "", "9007199254740992"]) {
    await field(page, "Default summary debounce").fill(value);
    await page.getByRole("button", { name: "Validate and save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("must be a positive integer");
    await expect(field(page, "Default summary debounce")).toHaveValue(value);
  }
  await raw(page);
  await expect(field(page, "Default summary debounce")).toHaveValue("9007199254740992");
  await field(page, "Channel").selectOption("project-x");
  await expect(field(page, "Default summary debounce")).toHaveValue("9007199254740992");
  const persisted = await page.request.get("api/v1/config");
  expect((await persisted.json()).text).toBe(ADMIN_CONFIG);
  await field(page, "Default summary debounce").fill("2");
  await raw(page);
  expect(parse(await rawText(page)).defaults.recentConversations.debounceSeconds).toBe(2);
});

test("unexpanded references and unsupported representations survive viewing and unrelated form edits", async ({ page }) => {
  const initial = ADMIN_CONFIG.replace("  preferences: Be concise.\n", "  preferences: Be concise.\n  recentConversations: {enabled: '${SUMMARY_FLAG}', debounceSeconds: [1, 2], model: '${SUMMARY_MODEL}'}\n")
    .replace("    description: Software factory", "    recentConversations: '${SUMMARY_MAPPING}'\n    description: Software factory");
  await field(page, "Raw configuration YAML").fill(initial);
  await basic(page);
  await expect(field(page, "Default summaries enabled")).toHaveValue("${SUMMARY_FLAG}");
  await expect(field(page, "Default summaries enabled")).toBeDisabled();
  await expect(field(page, "Default summary debounce")).toBeDisabled();
  await expect(field(page, "Default summary model")).toHaveValue("${SUMMARY_MODEL}");
  await field(page, "Channel").selectOption("project-x");
  await expect(page.getByRole("region", { name: "Channel recent conversations", exact: true })).toContainText("unsupported representation");
  await raw(page);
  expect(await rawText(page)).toBe(initial);
  await basic(page);
  await field(page, "Default preferences").fill("Example guidance.");
  await raw(page);
  expect(await rawText(page)).toBe(initial.replace("Be concise.", "Example guidance."));
});
