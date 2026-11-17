import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Opt-in capture using the existing mock fixtures with one run represented as Jira work.
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture Jira workflow screenshots");
const out = resolve(process.cwd(), "../../docs/screenshots/jira-workflows");
test.beforeAll(() => { mkdirSync(out, { recursive: true }); });
async function jira(page: Page) {
  await page.route("**/api/v1/channels/C0PROJECT/workflows**", async route => {
    const response = await route.fetch();
    const data = await response.json();
    const patch = (run: Record<string, unknown>) => run.runId === "wf_wait" ? {
      ...run, issue: 10001, issueUrl: "https://example.atlassian.net/browse/HAR-123",
      workItem: { tracker: "jira", site: "example.atlassian.net", key: "HAR-123", url: "https://example.atlassian.net/browse/HAR-123" },
    } : run;
    if (data.actions) data.actions = { ...data.actions, source: "jira", repositories: ["acme/web"] };
    if (data.intake) {
      data.intake.source = "jira";
      data.intake.repos = [{ ...data.intake.repos[0], labels: undefined, counts: { held: 1, open: 1 }, mappings: [
        { issue: 10002, title: "Add SSO login", status: "held", reason: "matches multiple Jira factories; clarify component/project routing", url: "https://example.atlassian.net/browse/HAR-124", workItem: { tracker: "jira", site: "example.atlassian.net", key: "HAR-124", url: "https://example.atlassian.net/browse/HAR-124" } },
        { issue: 10001, title: "Login fails on empty password", status: "open", runId: "wf_wait", url: "https://example.atlassian.net/browse/HAR-123", workItem: { tracker: "jira", site: "example.atlassian.net", key: "HAR-123", url: "https://example.atlassian.net/browse/HAR-123" } },
      ] }];
    }
    if (data.runs) data.runs = data.runs.map(patch);
    if (data.run) data.run = patch(data.run);
    await route.fulfill({ response, json: data });
  });
}
for (const [name, width, height, dark] of [["light", 1180, 1050, false], ["dark", 1180, 1050, true], ["mobile", 390, 844, false]] as const) {
  test(`Jira workflow: ${name} list and open sheet`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    await page.request.post("__mock", { data: { reset: true, actions: true } });
    await jira(page);
    await page.goto("./#/c/C0PROJECT?tab=tasks");
    if (width === 390) {
      await page.getByRole("button", { name: "Open details panel" }).click();
      await page.getByRole("dialog").getByRole("tab", { name: "Tasks" }).click();
    }
    const row = page.locator('[data-run-row="wf_wait"]');
    await expect(row).toContainText("HAR-123");
    if (name === "light") {
      await page.getByRole("list", { name: "Workflow runs" }).screenshot({ path: `${out}/list.png`, scale: "css" });
      await page.getByTestId("intake").screenshot({ path: `${out}/intake.png`, scale: "css" });
    }
    await row.click();
    const sheet = page.getByTestId("workflow-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: /HAR-123 Login fails/ })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "HAR-123", exact: true })).toHaveAttribute("href", "https://example.atlassian.net/browse/HAR-123");
    await expect(sheet.getByTestId("workflow-pr")).toHaveAttribute("href", "https://github.com/acme/web/pull/12");
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await sheet.screenshot({ path: `${out}/${name}.png`, scale: "css" });
    await sheet.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("action-start").click();
    const dialog = page.getByTestId("start-dialog");
    await expect(dialog).toContainText("Name a Jira key");
    await expect(page.getByTestId("start-issue")).toHaveAttribute("placeholder", "HAR-123 or Jira browse URL");
    await page.getByTestId("start-issue").fill("HAR-123");
    await page.waitForTimeout(300);
    await dialog.screenshot({ path: `${out}/start-${name}.png`, scale: "css" });
    await page.request.post("__mock", { data: { reset: true } });
  });
}
