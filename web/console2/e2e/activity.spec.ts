import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => { await request.post("./__mock", { data: { reset: true } }); });
test("home is a newest-first cross-channel feed, paginates and links interactions to Slack", async ({ page, request }) => {
  await page.goto("./#/");
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  const entries = page.getByTestId("activity-entry");
  await expect(entries).toHaveCount(50);
  await expect(entries.first()).toContainText("Investigation complete");
  await expect(entries.nth(1)).toContainText("Needs attention");
  await expect(entries.nth(1).getByRole("link", { name: "Open in Slack" })).toHaveAttribute("href", /^https:\/\/slack.com\/archives\/C0PROJECT\//);
  await page.getByRole("button", { name: "Load older activity" }).click();
  await expect(entries).toHaveCount(55);
  await request.post("./__mock", { data: { activityResolved: true, activityNew: true } });
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(entries).toHaveCount(56);
  await expect(entries.first()).toContainText("New conversation update");
  await expect(entries.filter({ hasText: "Approval to merge requested" })).toContainText("Resolved");
  await expect(entries.filter({ hasText: "Approval to merge requested" })).not.toContainText("Needs attention");
  await entries.first().getByRole("link", { name: "#general", exact: true }).click();
  await expect(page.getByTestId("view-transcript")).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
});

test("feed handles errors, retry and an empty result without dropping into an infinite loading state", async ({ page }) => {
  let fails = true;
  await page.route("**/api/v1/activity*", (route) => fails ? route.fulfill({ status: 503, body: "Unavailable" }) : route.fulfill({ json: { generatedAt: new Date().toISOString(), watermark: new Date().toISOString(), channelIds: [], entries: [] } }));
  await page.goto("./#/");
  await expect(page.getByRole("alert")).toContainText("could not be refreshed");
  fails = false;
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByText("No activity yet.", { exact: false })).toBeVisible();
});
