import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync("e2e/screenshots", { recursive: true });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false });

test("tree renders channels, nodes and the not-loaded hint", async ({ page }) => {
  await page.goto("./");
  const nav = page.getByRole("navigation", { name: "Channels and threads" });
  await expect(nav.getByText("#general")).toBeVisible();
  await expect(nav.getByText("#project-x")).toBeVisible();
  await expect(page.getByTestId("connection")).toHaveText(/Connected/);
  await nav.getByRole("button", { name: /Expand #archive/ }).click();
  await expect(nav.getByText(/Store not loaded/)).toBeVisible();
  await shot(page, "01-empty");
});

test("selecting a thread shows a numbered transcript with tool cards and the fork divider", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByTestId("fork-divider")).toContainText("forked from entry 12 of main");
  await expect(page.getByTestId("entry").filter({ hasText: "#14" })).toBeVisible();
  const cards = page.getByTestId("tool-card");
  await expect(cards.filter({ hasText: "bash" }).first()).toBeVisible();
  await expect(cards.filter({ hasText: "gh_pr_list" }).first()).toContainText("Error");
  await expect(page.getByText("Closing this window never interrupts your agent.")).toBeVisible();
  // Tool calls are names only: nothing that looks like arguments or results.
  await expect(page.getByTestId("tool-card").first()).not.toContainText("{");
  await shot(page, "02-thread");
});

test("the five tabs switch and load their data, and the choice lives in the URL", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByText("anthropic/claude-sonnet-5-5").first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Context used" })).toBeVisible();
  await page.getByRole("tab", { name: "State" }).click();
  await expect(page.getByTestId("state-rev")).toBeVisible();
  await page.getByRole("tab", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/tab=tasks/);
  await expect(page.getByText("Investigate the red nightly build")).toBeVisible();
  await expect(page.getByText("Allow network access for this channel")).toBeVisible();
  await shot(page, "03-tasks");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByText("linear__create_issue")).toBeVisible();
  await page.getByRole("tab", { name: "Extend" }).click();
  await expect(page.getByRole("tabpanel").getByText("reviewer")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Extend" })).toHaveAttribute("data-state", "active");
});

test("a direct message shows the shape but never the words", async ({ page }) => {
  await page.goto("./#/c/D0PRIVATE/t/1760002000.000400");
  await expect(page.getByText("content hidden (direct message)").first()).toBeVisible();
  await expect(page.getByText("nightly build")).toHaveCount(0);
  await shot(page, "04-dm");
});

test("older entries load in pages", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1759900000.000300");
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await page.getByRole("button", { name: "Load older entries" }).click();
  await expect(page.getByTestId("entry")).toHaveCount(120);
});

test("live events stream into the open thread", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByTestId("draft")).toContainText("snapshot is stale", { timeout: 15_000 });
  await expect(page.getByTestId("draft").getByTestId("tool-card")).toContainText("bash");
});

test("command palette jumps to a thread", async ({ page }) => {
  await page.goto("./");
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Jump to a channel or thread…").fill("dana");
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/c\/D0PRIVATE/);
});

test("dark mode toggles and persists", async ({ page }) => {
  await page.goto("./");
  const html = page.locator("html");
  const before = await html.evaluate((el) => el.classList.contains("dark"));
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  expect(await html.evaluate((el) => el.classList.contains("dark"))).toBe(!before);
  await page.reload();
  expect(await html.evaluate((el) => el.classList.contains("dark"))).toBe(!before);
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await shot(page, "05-theme");
});

test("narrow screens collapse the tree into a drawer and never scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByTestId("fork-divider")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "06-mobile-thread");
  await page.getByRole("button", { name: "Open workspace tree" }).click();
  await expect(page.getByRole("dialog").getByText("#general")).toBeVisible();
  await page.waitForTimeout(600); // let the slide-in finish before the screenshot
  await shot(page, "07-mobile-tree");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open details panel" }).click();
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Tasks" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "08-mobile-panel");
});

const stateTab = (page: Page, route = "C0GENERAL/t/1760000000.000100") => page.goto(`./#/c/${route}?tab=state`);

test("State tab: shows the revision, size, who changed it, and the value as a tree", async ({ page }) => {
  await stateTab(page);
  // The mock keeps incrementing while earlier browser tests run; do not assume the suite finishes before rev 20.
  await expect(page.getByTestId("state-rev")).toHaveText(/^rev \d+$/);
  expect(Number((await page.getByTestId("state-rev").innerText()).replace("rev ", ""))).toBeGreaterThanOrEqual(14);
  await expect(page.getByTestId("state-size")).toHaveText(/ of 64 KB$/);
  await expect(page.getByRole("progressbar", { name: "State size used" })).toBeVisible();
  await expect(page.getByTestId("state-updated")).toContainText(/Last changed .* by\s*agent\s*in thread/);
  const tree = page.getByRole("tree", { name: "Channel state" });
  await expect(tree.getByText(/^train:$/)).toBeVisible();
  await expect(tree.getByText('"thursday"')).toBeVisible();
  await expect(tree.getByText("false").first()).toBeVisible();
  await expect(tree.getByText("null").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Memory and notes/ })).toBeVisible();
  await shot(page, "09-state");
});

test("State tab: the tree collapses and expands from the keyboard, and the third level starts closed", async ({ page }) => {
  await stateTab(page);
  const release = page.getByRole("button", { name: /^Collapse release, \{4 keys\}$/ });
  await expect(release).toBeVisible();
  await expect(page.getByRole("button", { name: /^Expand last, \{4 keys\}$/ })).toBeVisible(); // jobs.last is the third level
  await release.focus();
  await page.keyboard.press("Enter");
  const collapsed = page.getByRole("button", { name: /^Expand release, \{4 keys\}$/ });
  await expect(collapsed).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText('"thursday"')).toHaveCount(0);
  await collapsed.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /^Collapse release/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText('"thursday"')).toBeVisible();
});

test("State tab: a long string is cut until asked for, and a long array pages", async ({ page }) => {
  await stateTab(page);
  const more = page.getByRole("button", { name: "show all" });
  await expect(more).toBeVisible();
  await expect(page.getByText(/leaves on Thursday and the notes are written on Wednesday\. the release train leaves on Thursday and the notes are written on Wednesday\. the release train leaves on Thursday and the notes are written on Wednesday\."$/)).toHaveCount(0);
  await more.click();
  await expect(page.getByRole("button", { name: "show less" })).toBeVisible();
  await expect(page.getByText('"tag-50"', { exact: true })).toBeVisible();
  await expect(page.getByText('"tag-51"', { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Show 10 more/ }).click();
  await expect(page.getByText('"tag-60"', { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);
});

test("State tab: Copy JSON puts the whole object on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stateTab(page);
  await page.getByRole("button", { name: "Copy JSON" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Copied to the clipboard" })).toBeAttached();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.release.train).toBe("thursday");
  expect(copied.tags).toHaveLength(60);
});

test("State tab: the change log starts closed and lists the newest change first", async ({ page }) => {
  await stateTab(page);
  const trigger = page.getByRole("button", { name: /Recent changes/ });
  await expect(page.getByRole("list", { name: "Recent state changes" })).toHaveCount(0);
  await trigger.click();
  const items = page.getByRole("list", { name: "Recent state changes" }).getByRole("listitem");
  await expect(items.first()).toContainText(/^#\d+/);
  expect(Number((await items.first().innerText()).match(/^#(\d+)/)![1])).toBeGreaterThanOrEqual(14);
  await expect(items.first()).toContainText(/\/(flags\/verbose|counters\/activity)/);
  await expect(items.last()).toContainText("#7");
  await expect(items.last()).toContainText("/release/train");
  await expect(items.last()).toContainText("set");
  await shot(page, "10-state-changes");
});

test("State tab: a direct message shows revision and size but never the contents or key names", async ({ page }) => {
  await stateTab(page, "D0PRIVATE/t/1760002000.000400");
  await expect(page.getByTestId("state-rev")).toHaveText("rev 6");
  await expect(page.getByTestId("state-hidden")).toHaveText("Contents are hidden for direct messages.");
  await expect(page.getByRole("tree")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy JSON" })).toHaveCount(0);
  await page.getByRole("button", { name: /Recent changes/ }).click();
  const items = page.getByRole("list", { name: "Recent state changes" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).not.toContainText("/");
  await shot(page, "11-state-dm");
});

test("State tab: a channel whose store is not open says why instead of showing a value", async ({ page }) => {
  await stateTab(page, "C0ARCHIVE");
  await expect(page.getByText(/not open in the running harness/)).toBeVisible();
  await expect(page.getByTestId("state-rev")).toHaveCount(0);
  await expect(page.getByRole("tree")).toHaveCount(0);
});

test("State tab: an empty state explains what it is for", async ({ page }) => {
  await stateTab(page, "C0PROJECT");
  await expect(page.getByTestId("state-rev")).toHaveText("rev 0");
  await expect(page.getByText("Nothing in the channel state yet. Agents write it with state_update; it is shared by every thread in this channel.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy JSON" })).toHaveCount(0);
});

test("State tab: refetches when the tree event says the state changed", async ({ page }) => {
  await stateTab(page);
  const first = Number((await page.getByTestId("state-rev").innerText()).replace("rev ", ""));
  // The mock raises the revision and sends a `tree` event every 20 seconds.
  await expect(async () => {
    expect(Number((await page.getByTestId("state-rev").innerText()).replace("rev ", ""))).toBeGreaterThan(first);
  }).toPass({ timeout: 45_000 });
});

test("State tab: dark theme and narrow screens, with no sideways scrolling", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await stateTab(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("state-rev")).toBeVisible();
  await shot(page, "12-state-dark");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await stateTab(page);
  await page.reload();
  await page.getByRole("button", { name: "Open details panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "State" }).click();
  await expect(dialog.getByTestId("state-rev")).toBeVisible();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, "13-state-mobile");
  await page.getByRole("button", { name: "Show all" }).first().click().catch(() => {});
});

// ── Jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────

const jobsTab = async (page: Page, channel = "C0GENERAL", thread = "1760000000.000100") => {
  await page.goto(`./#/c/${channel}/t/${thread}?tab=tasks`);
  await expect(page.getByRole("list", { name: "Job runs" })).toBeVisible();
};
const runCard = (page: Page, job: string) => page.getByTestId("job-run").filter({ hasText: job });

test("Jobs: the Tasks tab opens with the job runs, each with its status in words", async ({ page }) => {
  await jobsTab(page);
  const runs = page.getByTestId("job-run");
  await expect(runs).toHaveCount(5);
  await expect(page.getByTestId("job-status")).toHaveText(["Running", "Needs a decision", "Completed", "Failed", "Aborted"]);
  // The section sits above the tasks, and counts its runs.
  const order = await page.getByRole("tabpanel").locator("h3").allInnerTexts();
  expect(order[0]).toMatch(/^JOBS\s*5$/i);
  expect(order.findIndex((t) => /active tasks/i.test(t))).toBeGreaterThan(0);
  await shot(page, "14-jobs-light");
});

test("Jobs: a run that needs a decision says what happened and who can act, and marks the interrupted phase", async ({ page }) => {
  await jobsTab(page);
  const card = runCard(page, "release-check");
  await expect(card.getByTestId("job-status")).toHaveText("Needs a decision");
  await expect(card.getByRole("status")).toContainText("Waiting for a person. This console cannot act: tell the agent in Slack which to do.");
  await expect(card.getByRole("status")).toContainText("Retry it, skip it, or abort the run.");
  const phases = card.getByRole("list", { name: "Phases of release-check" }).getByRole("listitem");
  await expect(phases).toHaveCount(3);
  await expect(phases.nth(0)).toContainText("plan");
  await expect(phases.nth(0)).toContainText("exec · exit 0");
  await expect(phases.nth(0)).toContainText("Done");
  await expect(phases.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(phases.nth(1)).toContainText("Running (current)");
  await expect(phases.nth(1)).toContainText("interrupted: waiting for a decision");
  await expect(phases.nth(2)).toContainText("Waiting");
  await expect(phases.nth(0)).not.toHaveAttribute("aria-current", "step");
  // Read-only: nothing here acts.
  await expect(card.getByRole("button", { name: /retry|skip|abort|approve/i })).toHaveCount(0);
  await expect(card.getByText("Inputs (2)")).toBeVisible();
  await card.getByText("Inputs (2)").click();
  await expect(card.getByText("T-42")).toBeVisible();
  await expect(card.getByText("started")).toContainText(/by agent in thread/);
});

test("Jobs: a failed run shows its reason and the failed phase with its exit code, and a long summary is cut until asked for", async ({ page }) => {
  await jobsTab(page);
  const card = runCard(page, "flaky-sync");
  await expect(card.getByTestId("job-status")).toHaveText("Failed");
  await expect(card.getByRole("status")).toContainText('phase "push" failed: exit 2');
  const failed = card.getByTestId("job-phase").filter({ hasText: "push" });
  await expect(failed).toContainText("exec · exit 2");
  await expect(failed).toContainText("Failed");
  await expect(failed).toHaveAttribute("data-status", "failed");
  await expect(failed).toHaveAttribute("aria-current", "step");
  await expect(failed).not.toContainText("every retry after that failed");
  await failed.getByRole("button", { name: "Show all" }).click();
  await expect(failed).toContainText("every retry after that failed");
  await expect(failed.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByText("3 phases").or(card.getByText(/1 of 3 done/))).toBeVisible();
});

test("Jobs: finished runs say how long they took; an aborted one says who ended it; a running one has no end time", async ({ page }) => {
  await jobsTab(page);
  await expect(runCard(page, "snapshot-and-publish")).toContainText("took 42.0s");
  await expect(runCard(page, "snapshot-and-publish")).toContainText("2 of 2 done");
  await expect(runCard(page, "weekly-dependency-audit-and-report").getByRole("status")).toContainText("aborted by U9: wrong branch");
  await expect(runCard(page, "nightly-snapshot")).not.toContainText("took");
  await expect(runCard(page, "nightly-snapshot").getByTestId("job-phase").first()).toHaveAttribute("data-status", "running");
});

test("Jobs: a direct message shows names, statuses and exit codes, never summaries, reasons or inputs", async ({ page }) => {
  await jobsTab(page, "D0PRIVATE", "1760002000.000400");
  await expect(page.getByTestId("job-run")).toHaveCount(5);
  await expect(page.getByTestId("jobs-hidden")).toHaveText("Details are hidden for direct messages.");
  await expect(page.getByTestId("phase-summary")).toHaveCount(0);
  const list = page.getByRole("list", { name: "Job runs" });
  await expect(list).toContainText("release-check");
  await expect(list).toContainText("Needs a decision");
  await expect(list).toContainText("exec · exit 0");
  await expect(list).not.toContainText("interrupted: waiting for a decision");
  await expect(list).not.toContainText("T-42");
  await expect(list).not.toContainText("wrong branch");
  await expect(list).not.toContainText("Could not resolve host");
  await expect(list.getByText(/^Inputs/)).toHaveCount(0);
  await shot(page, "15-jobs-dm");
});

test("Jobs: a channel with no runs has no Jobs section", async ({ page }) => {
  await page.goto("./#/c/C0PROJECT/t/1760001000.000300?tab=tasks");
  await expect(page.getByText("Active tasks")).toBeVisible();
  await expect(page.getByRole("list", { name: "Job runs" })).toHaveCount(0);
});

test("Jobs: the Extend tab lists the channel's job definitions, with the one it cannot run marked and explained", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100?tab=extend");
  const defs = page.getByTestId("job-definition");
  await expect(defs).toHaveCount(2);
  const ok = defs.filter({ hasText: "release-check" });
  await expect(ok).toContainText("Review the release candidate and record the result");
  await expect(ok).toContainText('branch (default "main")');
  await expect(ok).toContainText("ticket (required)");
  const chain = ok.getByRole("list", { name: "Phases of release-check" }).getByRole("listitem");
  await expect(chain).toHaveCount(3);
  for (const [index, [name, kind]] of [["plan", "exec"], ["deploy", "exec"], ["notify", "state"]].entries()) {
    await expect(chain.nth(index)).toContainText(name!);
    await expect(chain.nth(index)).toContainText(kind!);
  }
  await expect(chain.nth(0)).not.toContainText("→");
  await expect(chain.nth(1)).toContainText("→");
  await expect(ok.getByTestId("job-unavailable")).toHaveCount(0);
  const bad = defs.filter({ hasText: "weekly-dependency-audit-and-report" });
  await expect(bad.getByTestId("job-unavailable")).toHaveText("Unavailable");
  await expect(bad.getByTestId("job-problem")).toContainText('there is no command "npm" in this channel\'s exec policy');
  await expect(bad).toContainText("none");
  await shot(page, "16-jobs-extend");
});

test("Jobs: dark theme and a narrow screen, with no sideways scrolling and the status still told in words", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await jobsTab(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("job-status").first()).toHaveText("Running");
  await shot(page, "17-jobs-dark");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await page.getByRole("button", { name: "Open details panel" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Tasks" }).click();
  await expect(dialog.getByTestId("job-run").first()).toBeVisible();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, "18-jobs-mobile");
  await dialog.getByTestId("job-run").filter({ hasText: "flaky-sync" }).scrollIntoViewIfNeeded();
  await dialog.getByRole("button", { name: "Show all" }).first().click();
  await page.waitForTimeout(150);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, "19-jobs-mobile-expanded");
});

// ── Installable app ──────────────────────────────────────────────────────────────────────────────────────────────

test("the offline indicator appears when the network goes away and clears when it returns", async ({ page, context }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByTestId("fork-divider")).toBeVisible();
  await expect(page.getByTestId("offline")).toHaveCount(0);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);
  await context.setOffline(true);
  const banner = page.getByTestId("offline");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toContainText("You are offline");
  await expect(banner).toContainText("may be out of date");
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await expect(page.getByTestId("connection"), "never claims to be connected while the browser says the network is down").not.toHaveText(/^Connected/);
  await shot(page, "09-offline");
  await context.setOffline(false);
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);
  await expect(page.getByTestId("connection")).toHaveText(/Connected/, { timeout: 20_000 });
});

/** What Chromium fires when the page can be installed. */
const offerInstall = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, { prompt: async () => { (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1; }, userChoice: Promise.resolve({ outcome: "accepted" }) });
  window.dispatchEvent(event);
});

test("the install button shows only while the browser offers installation, is single-use, and goes away once installed", async ({ page }) => {
  await page.goto("./");
  const button = page.getByTestId("install");
  await expect(button).toHaveCount(0);
  await offerInstall(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName("Install the console as an app");
  await expect(button).toContainText("Install");
  await button.hover();
  await expect(page.getByRole("tooltip")).toContainText("Install this console as an app on this device");
  await shot(page, "10-install-button");
  await button.click();
  expect(await page.evaluate(() => (window as unknown as { __prompted: number }).__prompted), "the browser's own dialog was shown").toBe(1);
  await expect(button).toHaveCount(0);
  await offerInstall(page);
  await expect(button).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(button).toHaveCount(0);
  await offerInstall(page);
  await expect(button, "an installed app is never offered installation again").toHaveCount(0);
});

test("the install button and the offline marker fit the header on a phone, in light and dark", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByTestId("fork-divider")).toBeVisible();
  await offerInstall(page);
  await expect(page.getByTestId("install")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  await expect(page.getByTestId("offline")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Nothing in the header is pushed off the screen.
  const boxes = await page.locator("header").first().locator("button, [data-testid]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return { right: r.right, width: r.width }; }));
  for (const box of boxes) expect(box.right).toBeLessThanOrEqual(390 + 0.5);
  await shot(page, "11-mobile-install-offline-light");
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.waitForTimeout(500); // colours animate when the theme changes; the screenshot should not catch them half way
  await shot(page, "12-mobile-install-offline-theme-toggled");
  await context.setOffline(false);
});

test("the header no longer points at a retired overview, and the older-views links are gone now that Timeline and Factory are built in", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100");
  await expect(page.getByRole("link", { name: "Open the original console" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Older views" })).toHaveCount(0);
});

test("a connector that needs signing in has a Connect link that leads to the browser pairing page", async ({ page }) => {
  await page.goto("./#/c/C0GENERAL/t/1760000000.000100?tab=extend");
  const connect = page.getByRole("tabpanel").getByRole("link", { name: "Connect notion" });
  await expect(connect).toHaveAttribute("href", "/proxy/harness/oauth/connect?channel=C0GENERAL&connector=notion");
  await expect(page.getByRole("tabpanel").getByRole("link", { name: /Connect (linear|git)/ })).toHaveCount(0);
});
