import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_CONFIG } from "../mock/admin";
import { rawEditor } from "./yaml-editor-helper";

// Opt-in, synthetic mock-backed captures; never use a live operator configuration.
// SCREENSHOTS=1 npm run e2e -- e2e/screenshots-recent-conversations.spec.ts
// python3 scripts/shrink-pngs.py ../../docs/screenshots/recent-conversations
const OUT = resolve(process.cwd(), "../../docs/screenshots/recent-conversations");
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to regenerate review evidence");
for (const theme of ["light", "dark"] as const) for (const width of [1180, 390]) {
  test(`${theme} ${width}px: inherited values and explicit false`, async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.request.post("__mock", { data: { reset: true } });
    await page.setViewportSize({ width, height: 1400 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("./#/admin");
    await rawEditor(page).fill(ADMIN_CONFIG.replace("  preferences: Be concise.\n", "  preferences: Be concise.\n  recentConversations: {enabled: true, debounceSeconds: 90, maxThreads: 12, model: example/summary, maxTranscriptChars: 8000}\n")
      .replace("    preferences: Summarise decisions.\n", "    preferences: Summarise decisions.\n    recentConversations: {enabled: false, maxThreads: 5}\n"));
    await page.getByRole("button", { name: "Basic settings", exact: true }).click();
    const target = page.getByRole("region", { name: width === 1180 && theme === "dark" ? "Default recent conversations" : "Channel recent conversations", exact: true });
    await expect(target).toBeVisible();
    expect(await target.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await target.screenshot({ path: `${OUT}/${theme}-${width === 390 ? "mobile" : "desktop"}.png`, scale: "css" });
  });
}
