import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

for (const [name, theme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["mobile", "light", 390]] as const) {
  test(`Kiri execution boundary (${name})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 1100 });
    // Synthetic Kiri variant of the existing mock; no live console data.
    await page.route("**/channels/C0GENERAL/session*", async (route) => {
      const response = await route.fetch(), body = await response.json();
      body.sandbox = "kiri"; body.execution.configuredMode = "kiri"; body.execution.toolMode = "kiri";
      await route.fulfill({ response, json: body });
    });
    await page.route("**/channels/C0GENERAL/tools*", async (route) => {
      const response = await route.fetch(), body = await response.json();
      body.execution.configuredMode = "kiri"; body.execution.toolMode = "kiri";
      for (const tool of body.tools) if (tool.name === "bash") tool.execution.location = "kiri";
      await route.fulfill({ response, json: body });
    });
    await page.goto("./#/c/C0GENERAL/t/1760000000.000100?tab=session");
    const open = page.getByRole("button", { name: "Open details panel" });
    if (await open.isVisible()) await open.click();
    const boundary = page.locator("section").filter({ has: page.getByRole("heading", { name: "Execution environment", exact: true }) });
    await expect(boundary).toContainText("Kiri"); await expect(boundary).toContainText("Running");
    await expect(boundary).toContainText("A channel sandbox applies only to bash");
    await expect(boundary).not.toContainText("Docker");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if (process.env.SCREENSHOTS) {
      const out = resolve(process.cwd(), "../../docs/screenshots/kiri"); mkdirSync(out, { recursive: true });
      await page.waitForTimeout(250); await page.mouse.move(0, 0);
      await page.screenshot({ path: `${out}/console-${name}.png`, scale: "css" });
    }
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    const bash = page.locator("li").filter({ has: page.locator("code", { hasText: /^bash$/ }) });
    await expect(bash).toContainText("Kiri");
    const read = page.locator("li").filter({ has: page.locator("code", { hasText: /^read$/ }) });
    await expect(read).toContainText("Outside sandbox");
  });
}
