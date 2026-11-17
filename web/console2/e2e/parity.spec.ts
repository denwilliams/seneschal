import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("e2e/screenshots", { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false });
const THREAD_A = "1760000000.000100";
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ---------------------------------------------------------------- Files

test("Files tab: lists the published files with links that open in a new tab, human sizes and relative times", async ({ page }) => {
  await page.goto(`./#/c/C0GENERAL/t/${THREAD_A}?tab=files`);
  const panel = page.getByRole("tabpanel");
  const files = panel.getByTestId("artifact");
  await expect(files).toHaveCount(4);
  const chart = files.filter({ hasText: "charts/q3/revenue.png" });
  const link = chart.getByRole("link");
  await expect(link).toHaveAttribute("href", "/proxy/harness/artifacts/C0GENERAL/charts/q3/revenue.png");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("rel", /noreferrer/);
  await expect(chart).toContainText("1.4 MB");
  await expect(chart).toContainText("2h ago");
  await expect(files.filter({ hasText: "report.html" })).toContainText("47.1 KB");
  await expect(files.filter({ hasText: "standup notes.md" }).getByRole("link")).toHaveAttribute("href", "/proxy/harness/artifacts/C0GENERAL/notes/standup%20notes.md");
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=files/);
  await shot(page, "20-files");
});

test("Files tab: an empty channel says so, a channel without hosting says why, and a truncated list says it stopped", async ({ page }) => {
  await page.goto("./#/c/C0PROJECT?tab=files");
  await expect(page.getByRole("tabpanel").getByText("No files have been published yet.")).toBeVisible();
  await page.goto("./#/c/D0PRIVATE?tab=files");
  await expect(page.getByTestId("files-disabled")).toHaveText("Artifact hosting is not turned on for this channel.");
  await expect(page.getByTestId("artifact")).toHaveCount(0);
  await page.goto("./#/c/C0ARCHIVE?tab=files");
  await expect(page.getByTestId("artifact")).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toContainText("stops at a fixed limit");
});

// ---------------------------------------------------------------- Timeline

test("Timeline: rows newest first, each with a graph cell, a summary, dashed dead branch and status rings", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?view=timeline");
  const rows = page.getByTestId("timeline-row");
  await expect(rows).toHaveCount(19);
  await expect(page.getByTestId("view-timeline")).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first()).toContainText("a1b2c19");
  await expect(rows.first()).toContainText("gh_pr_list");
  await expect(rows.first().getByTestId("timeline-status")).toHaveText("error");
  await expect(rows.last()).toContainText("a1b2c01");

  const graphs = page.getByTestId("timeline-graph");
  await expect(graphs).toHaveCount(19);
  await expect(graphs.first()).toHaveAttribute("aria-hidden", "true");
  expect(await page.locator("svg[data-testid=timeline-graph] circle").count()).toBe(19);
  expect(await page.locator("svg[data-testid=timeline-graph] path").count()).toBeGreaterThan(19);
  // One dead branch (tester never reported back and is long quiet): drawn dashed, its dot faded.
  await expect(page.locator("[data-dashed=true]")).toHaveCount(1);
  await expect(rows.filter({ hasText: "a1b2c06" })).toHaveAttribute("data-dead", "true");
  // Red ring: failed run, two tool errors. Amber ring: the blocked approval.
  await expect(page.locator('circle[data-ring="#d1495b"]')).toHaveCount(3);
  await expect(page.locator('circle[data-ring="#c9a227"]')).toHaveCount(1);

  // Statuses are words and an icon; a tool's ordinary "ok" is not repeated on its row.
  await expect(rows.filter({ hasText: "a1b2c11" }).getByTestId("timeline-status")).toHaveText("failed");
  await expect(rows.filter({ hasText: "a1b2c07" }).getByTestId("timeline-status")).toHaveText("blocked");
  await expect(rows.filter({ hasText: "a1b2c02" }).getByTestId("timeline-status")).toHaveCount(0);
  await expect(rows.filter({ hasText: "a1b2c08" })).toContainText("next: merge");
  await expect(rows.filter({ hasText: "a1b2c08" })).toContainText("6 steps");
  await expect(rows.filter({ hasText: "a1b2c08" })).toContainText("6m 40s");
  await expect(rows.filter({ hasText: "a1b2c08" })).toContainText("$0.04");
  await expect(rows.filter({ hasText: "a1b2c18" })).toContainText("The nightly build is green again.");

  const summary = page.getByTestId("timeline-summary");
  await expect(summary).toContainText("3 branches");
  await expect(summary).toContainText("7 tool calls");
  await expect(summary).toContainText("$0.1677");
  await expect(summary.getByTestId("timeline-status").filter({ hasText: "done" })).toBeVisible();
  await expect(summary.getByTestId("timeline-status").filter({ hasText: "failed" })).toBeVisible();
  await shot(page, "21-timeline");
});

test("Timeline: Hide tool calls and the actor filter refetch with the right query and combine", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL?view=timeline");
  const rows = page.getByTestId("timeline-row");
  await expect(rows).toHaveCount(19);

  const hidden = page.waitForRequest((request) => request.url().includes("/timeline") && request.url().includes("tools=0"));
  await page.getByLabel("Hide tool calls").check();
  await hidden;
  await expect(rows).toHaveCount(12);
  await expect(rows.filter({ hasText: "gh_pr_list" })).toHaveCount(0);

  const actor = page.waitForRequest((request) => request.url().includes("/timeline") && request.url().includes("actor=reviewer"));
  await page.getByLabel("Actor").selectOption("reviewer");
  await actor;
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Hide tool calls").uncheck();
  await expect(rows).toHaveCount(3);
  await page.getByLabel("Actor").selectOption("");
  await expect(rows).toHaveCount(19);
  const options = await page.getByLabel("Actor").locator("option").allTextContents();
  expect(options).toEqual(["All actors", "channel", "linter", "migrator", "reviewer", "tester"]);
});

test("Timeline: an empty log says so, and a direct message keeps the shape but not the excerpts", async ({ page }) => {
  await page.goto("./#/c/C0ARCHIVE?view=timeline");
  await expect(page.getByText("Nothing on the timeline yet.")).toBeVisible();
  await page.goto("./#/c/D0PRIVATE?view=timeline");
  await expect(page.getByTestId("timeline-row")).toHaveCount(19);
  await expect(page.getByText("The nightly build is green again.")).toHaveCount(0);
  await expect(page.getByText("Check why the nightly build is red")).toHaveCount(0);
});

// ---------------------------------------------------------------- Factory

const factoryPage = async (page: Page) => {
  await page.goto("./#/c/C0PROJECT?view=factory");
  await expect(page.getByTestId("factory-repo")).toHaveCount(2);
};
const web = (page: Page) => page.getByTestId("factory-repo").filter({ hasText: "acme/web" });
const counts = (page: Page) => web(page).getByTestId("factory-count").allTextContents();

test("Factory: repositories with issues, pull requests, merges, per-repository errors and an activity chart", async ({ page }) => {
  await factoryPage(page);
  await expect(page.getByTestId("view-factory")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Acme", exact: true })).toBeVisible();
  await expect(page.getByTestId("factory-fetched")).toContainText("fetched");
  await expect(page.getByTestId("factory-fetched")).toHaveAttribute("aria-live", "polite");
  const w = web(page);
  await expect(w.getByTestId("factory-issue").first()).toContainText("#31");
  await expect(w.getByTestId("factory-issue").first()).toContainText("bug");
  await expect(w.getByTestId("factory-pr").filter({ hasText: "#44" })).toContainText("draft");
  await expect(w.getByTestId("factory-pr").filter({ hasText: "#41" })).toContainText("changes requested");
  await expect(w.getByTestId("factory-pr").filter({ hasText: "#45" })).toContainText("approved");
  await expect(w.getByTestId("factory-merged").filter({ hasText: "#40" })).toContainText("ana ·");
  await expect(w.getByTestId("factory-marker")).toHaveCount(8);
  await expect(w.getByRole("list", { name: "Event symbol legend" }).getByRole("listitem")).toHaveCount(8);
  await expect(w.locator("[aria-label='UTC date scale'] time")).toHaveCount(8);
  // The second repository could not be read: its error shows, merges say so, and the chart says it is unavailable.
  const api = page.getByTestId("factory-repo").filter({ hasText: "acme/api" });
  await expect(api.getByRole("alert")).toContainText("Could not read acme/api");
  await expect(api).toContainText("Merged pull requests unavailable.");
  await expect(api).toContainText("Activity timeline unavailable: invalid snapshot date.");
  await shot(page, "22-factory");
});

test("Factory: the filter narrows each list and shows N of M; the repository select narrows the page", async ({ page }) => {
  await factoryPage(page);
  const before = await counts(page);
  expect(before).toEqual(["3", "3", "2"]);
  const filter = page.getByLabel("Filter issues and pull requests");
  await filter.fill("login");
  await expect.poll(() => counts(page)).toEqual(["1 of 3", "1 of 3", "0 of 2"]);
  await expect(web(page).getByText("No matching merges.")).toBeVisible();
  await filter.fill("bug");
  await expect.poll(() => counts(page)).toEqual(["1 of 3", "0 of 3", "0 of 2"]);
  await filter.fill("#41");
  await expect.poll(() => counts(page)).toEqual(["0 of 3", "1 of 3", "0 of 2"]);
  await filter.fill("changes_requested");
  await expect.poll(() => counts(page)).toEqual(["0 of 3", "1 of 3", "0 of 2"]);
  await filter.fill("ana");
  await expect.poll(() => counts(page)).toEqual(["0 of 3", "0 of 3", "1 of 2"]);
  await filter.fill("");
  await expect.poll(async () => (await counts(page))[0]).toBe("3");

  const stats = page.getByTestId("factory-stats");
  await expect(stats).toContainText("Repositories");
  await page.getByLabel("Repository").selectOption("acme/web");
  await expect(page.getByTestId("factory-repo")).toHaveCount(1);
  await expect(stats.locator("div").first()).toContainText("1");
  await page.getByLabel("Repository").selectOption("acme/api");
  await expect(page.getByTestId("factory-repo")).toHaveCount(1);
  await expect(page.getByTestId("factory-repo")).toContainText("Could not read acme/api");
});

test("Factory: every marker is keyboard focusable with a tooltip; only github.com links are links", async ({ page }) => {
  await factoryPage(page);
  const w = web(page);
  const issueMarker = w.getByRole("link", { name: /Issue opened/ });
  await issueMarker.focus();
  await expect(issueMarker).toBeFocused();
  const tip = w.getByTestId("factory-tooltip").filter({ hasText: "Login fails on Safari" });
  await expect(tip).toBeVisible();
  await expect(w.getByTestId("factory-tooltip").filter({ hasText: "Bump deps" })).toBeHidden();
  // A marker whose URL is not on github.com is focusable text, not a link.
  await expect(w.getByRole("link", { name: /Deployment created/ })).toHaveCount(0);
  const deploy = w.getByRole("img", { name: /Deployment created/ });
  await deploy.focus();
  await expect(deploy).toBeFocused();
  await expect(w.getByTestId("factory-tooltip").filter({ hasText: "production" })).toBeVisible();
  await shot(page, "22b-factory-chart");
  // Same for an issue whose URL points elsewhere.
  const stray = w.getByTestId("factory-issue").filter({ hasText: "#99" });
  await expect(stray).toBeVisible();
  await expect(stray.getByRole("link")).toHaveCount(0);
  // Every link that opens a new tab goes to github.com and cannot see the opener.
  const links = await page.getByTestId("factory-view").locator("a[target=_blank]").evaluateAll((anchors) =>
    anchors.map((a) => ({ href: (a as HTMLAnchorElement).href, rel: (a as HTMLAnchorElement).rel })));
  expect(links.length).toBeGreaterThan(10);
  for (const link of links) {
    expect(link.href.startsWith("https://github.com/")).toBe(true);
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
  }
});

test("Factory: auto-refresh runs while the page is visible, pauses while it is hidden, and catches up when it returns", async ({ page }) => {
  await page.clock.install();
  let plain = 0;
  page.on("request", (request) => { if (/\/factory(\?|$)/.test(request.url()) && !request.url().includes("refresh=1")) plain++; });
  await factoryPage(page);
  const base = plain;
  expect(base).toBe(1);
  await page.clock.fastForward(31_000);
  await expect.poll(() => plain).toBe(base + 1);
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  await page.clock.fastForward(95_000);
  await page.waitForTimeout(300);
  expect(plain).toBe(base + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => plain).toBe(base + 2);
  // Turned off, it stays off.
  await page.getByLabel("Auto-refresh").uncheck();
  await page.clock.fastForward(95_000);
  await page.waitForTimeout(300);
  expect(plain).toBe(base + 2);
});

test("Factory: Refresh asks the server to refresh, disables itself while loading, and survives being turned away", async ({ page }) => {
  await factoryPage(page);
  const before = Number((await counts(page))[0]);
  const refresh = page.getByRole("button", { name: "Refresh" });
  const asked = page.waitForRequest((request) => request.url().includes("/factory?refresh=1"));
  await refresh.click();
  await asked;
  await expect.poll(async () => Number((await counts(page))[0])).toBe(before + 1);
  await expect(refresh).toBeEnabled();
  // Again straight away: the server says it was refreshed too recently. The page says so and keeps what it had.
  await refresh.click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not refresh" })).toContainText("try again in a moment");
  await expect(page.getByRole("alert").filter({ hasText: "Showing the last data received" })).toBeVisible();
  await expect(web(page).getByTestId("factory-issue").first()).toBeVisible();
  await expect(refresh).toBeEnabled();
});

// ---------------------------------------------------------------- View routing

test("views: switching keeps the thread, the choice lives in the URL, and clicking threads in the same channel leaves the view alone", async ({ page }) => {
  await page.goto(`./#/c/C0GENERAL/t/${THREAD_A}`);
  await expect(page.getByTestId("fork-divider")).toBeVisible();
  await expect(page.getByTestId("view-factory")).toHaveCount(0);
  await page.getByTestId("view-timeline").click();
  await expect(page).toHaveURL(new RegExp(`#/c/C0GENERAL/t/${THREAD_A.replace(".", "\\.")}\\?view=timeline`));
  await expect(page.getByTestId("timeline-view")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Channels and threads" });
  await nav.getByRole("button", { name: /↳ #14/ }).click();
  await expect(page).toHaveURL(/t\/1760003600\.000200\?view=timeline/);
  await expect(page.getByTestId("timeline-view")).toBeVisible();
  await page.getByTestId("view-transcript").click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page.getByTestId("fork-divider")).toBeVisible();
  // A factory channel offers the third view; moving to another channel starts on its transcript.
  await page.getByTestId("view-timeline").click();
  await nav.getByText("#project-x").click();
  await expect(page).toHaveURL(/#\/c\/C0PROJECT$/);
  await expect(page.getByTestId("view-factory")).toBeVisible();
  await page.getByTestId("view-factory").click();
  await expect(page.getByTestId("factory-view")).toBeVisible();
  await expect(page).toHaveURL(/view=factory/);
  // A factory view on a channel with no factory falls back to the transcript.
  await page.goto("./#/c/C0GENERAL?view=factory");
  await expect(page.getByTestId("view-transcript")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("factory-view")).toHaveCount(0);
});

test("views: the command palette jumps straight to a timeline or a factory", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: "Timeline of #general" }).click();
  await expect(page).toHaveURL(/#\/c\/C0GENERAL\?view=timeline/);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog").getByPlaceholder("Jump to a channel or thread…").fill("factory");
  await page.getByRole("option", { name: "Factory of #project-x" }).click();
  await expect(page).toHaveURL(/#\/c\/C0PROJECT\?view=factory/);
  await expect(page.getByTestId("factory-view")).toBeVisible();
});

// ---------------------------------------------------------------- Themes and small screens

test("dark theme: Files, Timeline and Factory", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`./#/c/C0GENERAL/t/${THREAD_A}?tab=files`);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("artifact").first()).toBeVisible();
  await shot(page, "23-files-dark");
  await page.goto("./#/c/C0GENERAL?view=timeline");
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  await shot(page, "24-timeline-dark");
  await page.goto("./#/c/C0PROJECT?view=factory");
  await expect(page.getByTestId("factory-marker").first()).toBeVisible();
  await shot(page, "25-factory-dark");
});

test("390px: Timeline and Factory never scroll the page sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("./#/c/C0GENERAL?view=timeline");
  await expect(page.getByTestId("timeline-row").first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "26-timeline-mobile");
  await page.goto("./#/c/C0PROJECT?view=factory");
  await expect(page.getByTestId("factory-marker").first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, "27-factory-mobile");
  await page.getByLabel("Filter issues and pull requests").fill("a very long filter text that goes on and on");
  await page.waitForTimeout(150);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("390px: the Files tab fits the drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`./#/c/C0GENERAL/t/${THREAD_A}?tab=files`);
  await page.getByRole("button", { name: "Open details panel" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("artifact").first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, "28-files-mobile");
});
