import { expect, test } from "@playwright/test";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawEditor, rawText } from "./yaml-editor-helper";

const configApi = "**/api/v1/config";
const outline = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Top-level YAML sections" });
test.beforeEach(async ({ page }) => { await page.request.post("__mock", { data: { reset: true } }); });

test("highlighting, nested folds and section jumps never edit or post the draft", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/config") && r.method() === "POST") posts.push(r.postData()!); });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  await expect(outline(page).getByRole("button")).toHaveText(["name", "defaults", "channels", "webConsole", "connectors"]);
  const colors = await page.locator(".yaml-editor").evaluate((el) => [".yaml-key", ".yaml-value", ".yaml-comment"].map((selector) => getComputedStyle(el.querySelector(selector)!).color));
  expect(new Set(colors).size).toBe(3);

  await outline(page).getByRole("button", { name: "connectors", exact: true }).click();
  await page.locator(".cm-line").filter({ hasText: /^\s*github:$/ }).click();
  await rawEditor(page).press("Control+Shift+BracketLeft");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await page.getByRole("button", { name: "Toggle current fold" }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);

  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  const count = await page.locator(".cm-foldPlaceholder").count();
  expect(count).toBeGreaterThan(1);
  await outline(page).getByRole("button", { name: "connectors", exact: true }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(count - 1);
  await expect(page.locator(".cm-line").filter({ hasText: /Authorization: Bearer/ })).toBeVisible();
  await expect(rawEditor(page)).toBeFocused();
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  await expect(page.getByText("No unsaved edits", { exact: true })).toBeVisible();
  expect(posts).toEqual([]);

  await rawEditor(page).fill(ADMIN_CONFIG.replace("connectors:", "renamedConnectors:"));
  await expect(outline(page).getByRole("button", { name: "connectors", exact: true })).toHaveCount(0);
  await expect(outline(page).getByRole("button", { name: "renamedConnectors", exact: true })).toBeVisible();
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
});

test("large YAML stays virtualized, navigable and byte-for-byte unchanged through save", async ({ page }) => {
  const large = ADMIN_CONFIG.replace("webConsole:", Array.from({ length: 3000 }, (_, n) => `  generated-${n}:\n    description: Mock channel ${n}\n`).join("") + "webConsole:");
  await page.route(configApi, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { text: large, revision: "large" } });
    return route.fulfill({ json: { saved: true, applied: true, revision: "saved", warnings: [] } });
  });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(large);
  expect(await page.locator(".cm-line").count()).toBeLessThan(500);
  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  await outline(page).getByRole("button", { name: "connectors", exact: true }).click();
  await expect(page.locator(".cm-line").filter({ hasText: /Authorization: Bearer/ })).toBeVisible();
  await expect(page.locator(".yaml-key").filter({ hasText: /^connectors$/ })).toBeVisible();
  await expect.poll(() => rawText(page)).toBe(large);
  await expect(page.getByText("No unsaved edits", { exact: true })).toBeVisible();
  const request = page.waitForRequest((r) => r.url().endsWith("/config") && r.method() === "POST");
  await page.getByRole("button", { name: "Validate and save" }).click();
  expect((await request).postDataJSON()).toEqual({ operation: "save", text: large, revision: "large" });
  await expect(page.getByRole("status").filter({ hasText: "Saved. Reload completed" })).toBeVisible();
});

for (const newline of ["\n", "\r\n", "mixed"]) test(`reload, edit, undo and save preserve ${JSON.stringify(newline)} and literal references`, async ({ page }) => {
  let index = 0;
  const original = ADMIN_CONFIG.replace(/\n/g, () => newline === "mixed" ? (++index % 2 ? "\r\n" : "\n") : newline);
  const normalized = (text: string) => text.replace(/\r\n?|\n/g, "\n");
  let persisted = original;
  await page.route(configApi, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { text: persisted, revision: "revision" } });
    const body = route.request().postDataJSON();
    if (body.operation === "save") persisted = body.text;
    return route.fulfill({ json: { saved: true, applied: true, revision: "revision", warnings: [] } });
  });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(normalized(original));
  await rawEditor(page).press("Control+Home");
  await rawEditor(page).press("End");
  await rawEditor(page).press("x");
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
  await rawEditor(page).press("Control+z");
  await expect.poll(() => rawText(page)).toBe(normalized(original));
  await rawEditor(page).press("Control+End");
  await rawEditor(page).press("#");
  await rawEditor(page).press("Enter");
  const draft = original + "#" + (original.match(/\r\n?|\n/)?.[0] ?? "\n");
  await expect.poll(() => rawText(page)).toBe(normalized(draft));
  await page.getByRole("button", { name: "Validate and save" }).click();
  await expect(page.getByText("No unsaved edits", { exact: true })).toBeVisible();
  expect(persisted).toBe(draft);
  await page.getByRole("button", { name: "Reload persisted config" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Persisted configuration loaded" })).toBeVisible();
  await expect(rawEditor(page)).toHaveAttribute("contenteditable", "true");
  await expect.poll(() => rawText(page)).toBe(normalized(draft));

  await rawEditor(page).press("x");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Reload persisted config" }).click();
  await expect(page.getByText("Unsaved draft", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload persisted config" }).click();
  await expect.poll(() => rawText(page)).toBe(normalized(draft));
  await expect(page.getByText("No unsaved edits", { exact: true })).toBeVisible();
});

test("editor cannot change while validation is in flight; failed validation keeps the draft", async ({ page }) => {
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  await rawEditor(page).fill(ADMIN_CONFIG + "# unsaved\n");
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(configApi, async (route) => {
    await waiting;
    await route.fulfill({ status: 400, json: { error: "Invalid test draft" } });
  });
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(rawEditor(page)).toHaveAttribute("contenteditable", "false");
  await expect(outline(page).getByRole("button", { name: "defaults", exact: true })).toBeDisabled();
  finish();
  await expect(page.getByRole("alert")).toContainText("Invalid test draft");
  await expect(rawEditor(page)).toHaveAttribute("contenteditable", "true");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG + "# unsaved\n");
});

test("section jumps reveal a folded root flow mapping and treat hostile keys as literal text", async ({ page }) => {
  const flow = '{\n  defaults: {model: test},\n  connectors: {github: {enabled: true}}\n}';
  await page.route(configApi, (route) => route.fulfill({ json: { text: flow, revision: "flow" } }));
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(flow);
  await page.getByRole("button", { name: "Fold all", exact: true }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await outline(page).getByRole("button", { name: "connectors", exact: true }).click();
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect.poll(() => rawText(page)).toBe(flow);

  const hostile = '\"<img src=x onerror=alert(1)>\": {}\ndefaults: [\n';
  await rawEditor(page).fill(hostile);
  await expect(outline(page).getByRole("button")).toHaveText(['\"<img src=x onerror=alert(1)>\"', "defaults"]);
  await expect(outline(page).locator("img")).toHaveCount(0);
  await expect.poll(() => rawText(page)).toBe(hostile);
});

test("390px in both themes: long YAML wraps and folding controls remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#/admin");
  await expect.poll(() => rawText(page)).toBe(ADMIN_CONFIG);
  const long = ADMIN_CONFIG + 'longSectionName' + 'x'.repeat(120) + ': ' + 'value'.repeat(200) + '\n';
  await rawEditor(page).fill(long);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole("button", { name: "Fold all", exact: true }).click();
    await outline(page).getByRole("button", { name: "connectors", exact: true }).click();
    await expect(page.locator(".cm-line").filter({ hasText: /Authorization: Bearer/ })).toBeVisible();
    await page.getByRole("button", { name: "Expand all" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator(".cm-scroller").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => rawText(page)).toBe(long);
  }
});
