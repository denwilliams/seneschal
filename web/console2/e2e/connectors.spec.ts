import { test, expect, type Page } from "@playwright/test";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawEditor, rawText } from "./yaml-editor-helper";
async function open(page: Page, config = ADMIN_CONFIG) {
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  if (config !== ADMIN_CONFIG) await rawEditor(page).fill(config);
  await page.getByRole("button", { name: "Basic settings", exact: true }).click();
}
async function add(page: Page, name: string, transport: "stdio" | "http") {
  await page.getByLabel("New connector name", { exact: true }).fill(name);
  await page.getByLabel("New connector transport", { exact: true }).selectOption(transport);
  await page.getByRole("button", { name: "Add connector", exact: true }).click();
  await expect(page.getByLabel("Connector", { exact: true })).toHaveValue(name);
}
async function fullYaml(page: Page) {
  await page.getByRole("button", { name: "Raw YAML", exact: true }).click();
  return rawText(page);
}
test.beforeEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); });
test("add/edit both transports, preserve advanced settings, round-trip modes and save one shared draft", async ({ page }) => {
  const config = ADMIN_CONFIG + "    description: Advanced remote\n    allowTools: [read]\n    oauth:\n      redirectUrl: https://console.example.test/callback\n      clientSecret: ${GITHUB_TOKEN}\n";
  await open(page, config);
  await page.getByLabel("Connector URL").fill("https://new.example.test/mcp");
  await page.getByLabel("Headers value Authorization").fill("Token ${GITHUB_TOKEN}");
  await page.getByLabel("Headers new name").fill("X-Test");
  await page.getByLabel("Headers new value").fill("testing");
  await page.getByRole("button", { name: "Add headers entry" }).click();
  await page.getByRole("button", { name: "Connector YAML", exact: true }).click();
  const yaml = page.getByLabel("Connector definition YAML");
  await expect(yaml).toHaveValue(/clientSecret: \$\{GITHUB_TOKEN\}/);
  await yaml.fill((await yaml.inputValue()).replace("Advanced remote", "Edited via YAML") + "# keep raw comment\n");
  await page.getByRole("button", { name: "Connector form", exact: true }).click();
  await expect(page.getByLabel("Connector URL")).toHaveValue("https://new.example.test/mcp");
  await add(page, "local", "stdio");
  await page.getByLabel("Connector command").fill("node");
  await page.getByRole("button", { name: "Add argument", exact: true }).click();
  await page.getByLabel("Argument 1", { exact: true }).fill("server with spaces.js");
  await page.getByRole("button", { name: "Add argument", exact: true }).click();
  await page.getByLabel("Argument 2", { exact: true }).fill("--stdio");
  await page.getByLabel("Environment new name").fill("TOKEN");
  await page.getByLabel("Environment new value").fill("${GITHUB_TOKEN}");
  await page.getByRole("button", { name: "Add environment entry" }).click();
  await page.getByLabel("Environment value TOKEN").fill("prefix-${GITHUB_TOKEN}");
  await page.getByRole("button", { name: "Connector YAML", exact: true }).click();
  await expect(yaml).toHaveValue(/server with spaces.js/);
  await yaml.fill((await yaml.inputValue()).replace("node", "npx") + "description: Local server\nallowTools: [read]\n");
  await page.getByRole("button", { name: "Connector form", exact: true }).click();
  await expect(page.getByLabel("Connector command")).toHaveValue("npx");
  await page.getByRole("button", { name: "Remove argument 2", exact: true }).click();
  await add(page, "second-http", "http");
  await page.getByLabel("Connector URL").fill("https://second.example.test/mcp");
  const draft = await fullYaml(page);
  for (const text of ["# keep raw comment", "description: Edited via YAML", "oauth:", "allowTools:", "prefix-${GITHUB_TOKEN}", "description: Local server", "https://second.example.test/mcp"]) expect(draft).toContain(text);
  expect(draft.slice(0, draft.indexOf("connectors:"))).toBe(config.slice(0, config.indexOf("connectors:")));
  expect(draft).not.toContain("--stdio");
  // The merged full-config editor must keep form/connector-YAML edits through folding and navigation.
  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  await expect(page.locator(".cm-foldPlaceholder").first()).toBeVisible();
  await page.getByRole("navigation", { name: "Top-level YAML sections" }).getByRole("button", { name: "connectors", exact: true }).click();
  await expect(rawEditor(page)).toBeFocused();
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect.poll(() => rawText(page)).toBe(draft);
  await page.getByRole("button", { name: "Basic settings", exact: true }).click();
  await page.getByLabel("Connector", { exact: true }).selectOption("local");
  await expect(page.getByLabel("Connector command")).toHaveValue("npx");
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
  await page.getByRole("button", { name: "Reload persisted config" }).click();
  await expect.poll(() => rawText(page)).toBe(draft);
});

for (const transport of ["http", "stdio"] as const) {
  test(`numeric ${transport} connector retains comments across form, connector YAML, full YAML and save`, async ({ page }) => {
    const field = transport === "http" ? "url" : "command";
    const label = transport === "http" ? "Connector URL" : "Connector command";
    const initial = transport === "http" ? "https://example.test/mcp" : "node";
    const formValue = transport === "http" ? "https://form.test/mcp" : "npx";
    const yamlValue = transport === "http" ? "https://yaml.test/mcp" : "python3";
    const config = ADMIN_CONFIG.slice(0, ADMIN_CONFIG.indexOf("connectors:")) +
      `connectors:\n  123: # numeric connector\n    # transport comment\n    transport: ${transport}\n    ${field}: ${initial} # field comment\n    description: Retain advanced settings\n    allowTools: [read]\n`;
    await open(page, config);
    await expect(page.getByLabel("Connector", { exact: true })).toHaveValue("123");
    await page.getByLabel(label).fill(formValue);
    await page.getByRole("button", { name: "Connector YAML", exact: true }).click();
    const yaml = page.getByLabel("Connector definition YAML");
    await expect(yaml).toHaveValue(/# transport comment/);
    await expect(yaml).toHaveValue(/# field comment/);
    await yaml.fill((await yaml.inputValue()).replace(formValue, yamlValue) + "# connector YAML edit\n");
    await page.getByRole("button", { name: "Connector form", exact: true }).click();
    await expect(page.getByLabel(label)).toHaveValue(yamlValue);
    let draft = await fullYaml(page);
    for (const comment of ["# numeric connector", "# transport comment", "# field comment", "# connector YAML edit"]) expect(draft).toContain(comment);
    expect(draft).toContain("description: Retain advanced settings");
    expect(draft).toContain("allowTools: [ read ]");
    await expect(page.getByRole("navigation", { name: "Top-level YAML sections" }).getByRole("button", { name: "connectors", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Fold all", exact: true }).click();
    await expect(page.locator(".cm-foldPlaceholder")).not.toHaveCount(0);
    expect(await rawText(page)).toBe(draft);
    await page.getByRole("button", { name: "Expand all", exact: true }).click();
    await rawEditor(page).fill(draft.replace("name: Mock harness", "name: Full YAML edit"));
    await page.getByRole("button", { name: "Basic settings", exact: true }).click();
    await expect(page.getByLabel(label)).toHaveValue(yamlValue);
    await page.getByRole("button", { name: "Connector YAML", exact: true }).click();
    await yaml.fill((await yaml.inputValue()).replace(yamlValue, formValue));
    // Saving directly from connector YAML must flush the same numeric-key draft too.
    await page.getByRole("button", { name: "Validate and save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
    draft = (await (await page.request.get("api/v1/config")).json()).text;
    expect(draft).toContain("name: Full YAML edit");
    expect(draft).toContain(formValue);
    for (const comment of ["# numeric connector", "# transport comment", "# field comment", "# connector YAML edit"]) expect(draft).toContain(comment);
    await page.getByRole("button", { name: "Reload persisted config" }).click();
    await expect.poll(() => rawText(page)).toBe(draft);
  });
}

test("invalid connector YAML blocks transitions and save without applying any pending edits", async ({ page }) => {
  await open(page);
  await page.getByLabel("Default model", { exact: true }).fill("unsaved-model");
  await page.getByRole("button", { name: "Connector YAML", exact: true }).click();
  const yaml = page.getByLabel("Connector definition YAML");
  await yaml.fill("transport: [");
  for (const name of ["Connector form", "Raw YAML", "Validate and save"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("draft has not been discarded");
    await expect(yaml).toHaveValue("transport: [");
  }
  await yaml.fill("[]");
  await page.getByRole("button", { name: "Connector form", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("must be a mapping");
  await yaml.fill("transport: http\nurl: not-a-url\n");
  await page.getByRole("button", { name: "Connector form", exact: true }).click();
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("connectors.github.url");
  expect(await fullYaml(page)).toContain("unsaved-model");
  await expect.poll(() => rawText(page)).toContain("not-a-url");
  // Failed saves leave persisted config unchanged.
  expect((await (await page.request.get("api/v1/config")).json()).text).toBe(ADMIN_CONFIG);
});

test("duplicate/empty names cannot overwrite; remove confirms and keeps channel references unchanged", async ({ page }) => {
  const config = ADMIN_CONFIG.replace("description: Team assistant", "description: Team assistant\n    share: {connectors: [github]}");
  await open(page, config);
  const addButton = page.getByRole("button", { name: "Add connector", exact: true });
  await expect(addButton).toBeDisabled();
  await page.getByLabel("New connector name", { exact: true }).fill("github");
  await expect(addButton).toBeDisabled();
  await expect(page.getByText("A connector with that name already exists.")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Remove connector", exact: true }).click();
  await expect(page.getByLabel("Connector", { exact: true })).toHaveValue("github");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove connector", exact: true }).click();
  await expect(page.getByText("No connector definitions yet.")).toBeVisible();
  const draft = await fullYaml(page);
  expect(draft).toContain("share: {connectors: [github]}");
  expect(draft).not.toContain("transport: http");
  await page.getByRole("button", { name: "Validate and save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
  await page.getByRole("button", { name: "Basic settings", exact: true }).click();
  await add(page, "replacement", "stdio");
  await page.getByLabel("Connector command").fill("node");
  await page.getByRole("button", { name: "Add argument", exact: true }).click();
  await page.getByLabel("Argument 1", { exact: true }).fill("server.js");
  await page.getByLabel("Environment new name").fill("REMOVE_ME");
  await page.getByLabel("Environment new value").fill("value");
  await page.getByRole("button", { name: "Add environment entry" }).click();
  await page.getByRole("button", { name: "Remove Environment REMOVE_ME", exact: true }).click();
  expect(await fullYaml(page)).not.toContain("REMOVE_ME");
});
