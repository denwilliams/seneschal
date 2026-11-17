import { expect, test, type Locator, type Page } from "@playwright/test";

const LONG = "1759900000.000300";
const OTHER = "1760003600.000200";
const route = (thread = LONG) => `./#/c/C0GENERAL/t/${thread}`;
const viewport = (page: Page) => page.locator("main [data-radix-scroll-area-viewport]");
const bottomGap = (element: Locator) => element.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const atBottom = async (page: Page) => {
  await expect.poll(() => bottomGap(viewport(page))).toBeLessThanOrEqual(1);
  await expect(page.locator("main article").last()).toBeInViewport();
};
const scrollTo = async (page: Page, top: number) => {
  await viewport(page).evaluate((el, value) => { el.scrollTop = value; }, top);
  // Deliver the scroll event before the next update.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

test("an overflowing transcript opens at its newest entries", async ({ page }) => {
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  expect(await viewport(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await atBottom(page);
});

test("switching transcripts resets following even after reading older entries", async ({ page }) => {
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await scrollTo(page, 0);
  await page.goto(route(OTHER));
  await expect(page.getByTestId("entry")).toHaveCount(8);
  await atBottom(page);
  await scrollTo(page, 0);
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await atBottom(page);
});

test("following survives layout settling after initial load and viewport resizing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await atBottom(page);
  // No transcript state changes: only the actual scroll container gets shorter.
  await page.setViewportSize({ width: 1280, height: 600 });
  await atBottom(page);
  // Width changes reflow entry text after React's layout effects have run.
  await page.setViewportSize({ width: 390, height: 844 });
  await atBottom(page);
  // Content-only layout changes also need following, without a React render.
  await page.addStyleTag({ content: "main article { min-height: 160px; }" });
  await atBottom(page);
});

test("initial positioning retries when the scroll area is not laid out yet", async ({ page }) => {
  // Simulate a containing panel becoming measurable after the data/layout effect.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.id = "delayed-layout";
      style.textContent = "main { display: none !important; }";
      document.head.append(style);
    });
  });
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  expect(await viewport(page).evaluate((el) => el.clientHeight)).toBe(0);
  await page.locator("#delayed-layout").evaluate((el) => el.remove());
  await atBottom(page);
});

test("new output follows only at the bottom, and returning to the bottom resumes it", async ({ page }) => {
  // Keep the mock's real EventSource, but inject deterministic output into its message handler.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (window as unknown as { transcriptEvents: EventSource }).transcriptEvents = this;
      }
    };
  });
  const append = (delta: string) => page.evaluate(({ threadKey, delta }) => {
    const source = (window as unknown as { transcriptEvents: EventSource }).transcriptEvents;
    source.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "thread", channelId: "C0GENERAL", threadKey, at: new Date().toISOString(),
      event: { kind: "text_delta", delta },
    }) }));
  }, { threadKey: LONG, delta });
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await atBottom(page);
  await append("Streaming output\n".repeat(60));
  await expect(page.getByTestId("draft")).toContainText("Streaming output");
  await atBottom(page);
  await scrollTo(page, 250);
  const top = await viewport(page).evaluate((el) => el.scrollTop);
  await append("Paused output\n".repeat(20));
  await expect(page.getByTestId("draft")).toContainText("Paused output");
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBe(top);
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(() => viewport(page).evaluate((el) => el.scrollTop)).toBe(top);
  await scrollTo(page, Number.MAX_SAFE_INTEGER);
  await append("Following again\n".repeat(20));
  await expect(page.getByTestId("draft")).toContainText("Following again");
  await atBottom(page);
});

test("loading older entries preserves the visible entry, including movement during the request", async ({ page }) => {
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await scrollTo(page, 0);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/threads/*?*before=*", async (request) => {
    await pending;
    await request.continue();
  });
  await page.getByRole("button", { name: "Load older entries" }).click();
  await expect(page.getByRole("button", { name: "Loading…", exact: true })).toBeVisible();
  await scrollTo(page, 250);
  const anchor = page.getByTestId("entry").nth(5);
  const before = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  const id = await anchor.getAttribute("aria-label");
  release();
  await expect(page.getByTestId("entry")).toHaveCount(120);
  const restoredTop = () => page.getByRole("article", { name: id!, exact: true }).evaluate((el) => el.getBoundingClientRect().top);
  await expect.poll(async () => Math.abs((await restoredTop()) - before)).toBeLessThanOrEqual(1);
});

test("an older-page response cannot reposition a different transcript", async ({ page }) => {
  await page.goto(route());
  await expect(page.getByTestId("entry")).toHaveCount(60);
  await scrollTo(page, 0);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/threads/*?*before=*", async (request) => {
    await pending;
    await request.continue();
  });
  await page.getByRole("button", { name: "Load older entries" }).click();
  await expect(page.getByRole("button", { name: "Loading…", exact: true })).toBeVisible();
  await page.goto(route(OTHER));
  await expect(page.getByTestId("entry")).toHaveCount(8);
  await atBottom(page);
  const response = page.waitForResponse((response) => new URL(response.url()).searchParams.has("before"));
  release();
  await response;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByTestId("entry")).toHaveCount(8);
  await atBottom(page);
});
