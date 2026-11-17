import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";

mkdirSync("e2e/screenshots", { recursive: true });

/** PNG width and height from the IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex"), "a PNG signature").toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Console messages that mean something is wrong with the page's own security policy. */
function watchCsp(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text()); });
  return problems;
}

const controlled = (page: Page) => page.evaluate(async () => { await navigator.serviceWorker.ready; return navigator.serviceWorker.controller !== null; });

/** Load the app and wait until its service worker is active, then reload so the worker is the one serving the page. */
async function installed(page: Page, url: string) {
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => controlled(page), { message: "the service worker controls the page after a reload" }).toBe(true);
}

/**
 * A proxy that records what reaches the server. The browser fetches a manifest itself, outside anything a test can observe from
 * the page, so this is how to see whether the request carried the session cookie an access proxy would require.
 */
async function recordingProxy(target: string) {
  const seen: { path: string; cookie: string | undefined }[] = [];
  const server = createHttpServer((req, res) => {
    seen.push({ path: req.url ?? "", cookie: req.headers.cookie });
    const upstream = httpRequest(new URL(req.url ?? "/", target), { method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("the manifest is requested with credentials, parses, and every icon it names is real", async ({ page, context, baseURL }) => {
  const proxy = await recordingProxy(baseURL!);
  try {
    // A cookie like the one an access proxy sets: the manifest request must carry it, or the proxy would answer with a login page.
    await context.addCookies([{ name: "CF_Authorization", value: "session", url: proxy.url }]);
    await page.goto(`${proxy.url}/console2/`);
    const link = page.locator('link[rel="manifest"]');
    expect(await link.getAttribute("crossorigin")).toBe("use-credentials");
    expect(await link.getAttribute("href")).toBe("./manifest.webmanifest");
    await expect.poll(() => proxy.seen.some((r) => r.path === "/console2/manifest.webmanifest"), { message: "the browser asked for the manifest" }).toBe(true);
    const asked = proxy.seen.filter((r) => r.path === "/console2/manifest.webmanifest");
    expect(asked.every((r) => r.cookie?.includes("CF_Authorization=session")), "every manifest request carried the session cookie").toBe(true);
  const manifestUrl = new URL("manifest.webmanifest", page.url());
  const response = await context.request.get(manifestUrl.href);
  expect(response.headers()["content-type"]).toBe("application/manifest+json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({ name: "Harness console", short_name: "Console", display: "standalone", start_url: "./", scope: "./" });
  expect(typeof manifest.id).toBe("string");
  expect(manifest.description).toBeTruthy();
  expect(manifest.background_color).toMatch(/^#/);
  expect(manifest.theme_color).toMatch(/^#/);
  for (const key of ["start_url", "scope"]) expect(manifest[key], `${key} is relative so it works under any proxy prefix`).toMatch(/^\.\//);
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose?: string }[];
  expect(icons.some((i) => i.sizes === "192x192" && i.purpose === "any")).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  for (const icon of icons) {
    expect(icon.src, "relative").not.toMatch(/^(\/|https?:)/);
    const res = await context.request.get(new URL(icon.src, manifestUrl).href);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"], icon.src).toBe(icon.type);
    if (icon.type === "image/png") {
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(await res.body()), icon.src).toEqual({ width: w, height: h });
    }
  }
  // The page also links the favicon and the iOS home-screen icon, relatively.
  for (const selector of ['link[rel="icon"][type="image/png"]', 'link[rel="apple-touch-icon"]']) {
    const href = await page.locator(selector).getAttribute("href");
    expect(href, selector).toMatch(/^\.\//);
    expect((await context.request.get(new URL(href!, page.url()).href)).status(), selector).toBe(200);
  }
  expect(await page.locator('meta[name="theme-color"]').count()).toBe(2);
  expect(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute("content")).toBe("yes");
  } finally {
    await proxy.close();
  }
});

test("the browser finds nothing to complain about when asked whether this can be installed", async ({ page }) => {
  const problems = watchCsp(page);
  await installed(page, "/console2/");
  const client = await page.context().newCDPSession(page);
  await client.send("Page.enable");
  const { installabilityErrors } = (await client.send("Page.getInstallabilityErrors")) as { installabilityErrors: { errorId: string }[] };
  expect(installabilityErrors, `installability errors: ${JSON.stringify(installabilityErrors)}`).toEqual([]);
  const { url, errors } = (await client.send("Page.getAppManifest")) as { url: string; errors: { message: string }[] };
  expect(url).toMatch(/\/console2\/manifest\.webmanifest$/);
  expect(errors, "manifest errors").toEqual([]);
  expect(problems).toEqual([]);
});

test("the service worker registers, becomes active, and controls the page after a reload", async ({ page }) => {
  const problems = watchCsp(page);
  await page.goto("/console2/");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/console2/");
  await page.reload();
  expect(await controlled(page)).toBe(true);
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(new URL(script!).pathname).toBe("/console2/sw.js");
  expect(problems).toEqual([]);
});

test("the worker caches the shell and never anything from the API", async ({ page }) => {
  await installed(page, "/console2/#/c/CCHAN001/t/1700000000.000100?tab=tasks");
  // Use the app so that API traffic has really happened, through the worker's own page.
  await expect(page.getByTestId("connection")).toHaveText(/Connected/);
  await expect(page.getByRole("navigation", { name: "Channels and threads" }).getByText("#general")).toBeVisible();
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  expect(cached.some((p) => p === "/console2/"), "the shell is cached").toBe(true);
  expect(cached.some((p) => p.startsWith("/console2/assets/") && p.endsWith(".js")), "the bundle is cached").toBe(true);
  expect(cached.some((p) => p === "/console2/manifest.webmanifest")).toBe(true);
  expect(cached.filter((p) => p.includes("/api/")), "nothing from the API is ever stored").toEqual([]);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

/** Our own copy of the real server over the fake harness, so a test can kill it and the network is down for real. */
async function ownServer(): Promise<{ port: number; process: ChildProcess; stop: () => Promise<void> }> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "../../src/console2/dev-server.ts", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server did not start: ${output}`)), 30_000);
    child.stdout!.on("data", (chunk) => { output += chunk; if (output.includes("ready")) { clearTimeout(timer); resolve(); } });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the server exited ${code}: ${output}`)); });
  });
  return { port, process: child, stop: async () => {
      // A process killed by a signal has exitCode null but a signalCode, and its "exit" event has already fired.
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("with the server gone and the network down, the installed app still opens, says it is offline, and shows no stale data", async ({ browser }) => {
  const server = await ownServer();
  const context: BrowserContext = await browser.newContext();
  try {
    const page = await context.newPage();
    const problems = watchCsp(page);
    const origin = `http://127.0.0.1:${server.port}`;
    await installed(page, `${origin}/console2/`);
    // Online: the real data is there.
    await expect(page.getByRole("navigation", { name: "Channels and threads" }).getByText("#general")).toBeVisible();
    await expect(page.getByTestId("offline")).toHaveCount(0);

    // Take the network away for real: the server is gone, and the browser is told so.
    await server.stop();
    await context.setOffline(true);
    await expect(page.getByTestId("offline")).toBeVisible();
    await expect(page.getByTestId("offline")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("offline")).toContainText(/offline.*may be out of date/i);
    await expect(page.getByTestId("offline-badge")).toBeVisible();

    // Reload with nothing to reach: only the worker's cache can answer the navigation.
    await page.reload();
    expect(await controlled(page)).toBe(true);
    await expect(page.getByTestId("offline")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Channels and threads" });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    // The API is not served from any cache: the request fails, the UI says so, and no channel appears as if it were live.
    expect(await page.evaluate(() => fetch("./api/v1/tree").then(() => "served", () => "failed"))).toBe("failed");
    await expect(nav.getByRole("alert")).toContainText(/Could not load the tree/);
    await expect(page.getByRole("alert").filter({ hasText: "Activity could not be refreshed" })).toBeVisible();
    await expect(page.getByTestId("activity-entry")).toHaveCount(0);
    await expect(nav.getByText("#general")).toHaveCount(0);
    await expect(page.getByTestId("connection")).not.toHaveText(/^Connected/);
    await page.screenshot({ path: "e2e/screenshots/pwa-offline.png" });

    // Coming back online clears the indicator.
    await context.setOffline(false);
    await expect(page.getByTestId("offline")).toHaveCount(0);
    expect(problems, "no Content-Security-Policy violation while offline").toEqual([]);
  } finally {
    await context.close();
    await server.stop();
  }
});
