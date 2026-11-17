import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureChannelDirs } from "../workspace/paths.ts";
import { TaskStatusStore } from "../tasks/store.ts";
import { ArtifactServer, artifactChannelUrl, artifactRequestPath, artifactUrl, isAllowedHost, webServerPlan } from "./server.ts";
import { consoleOAuthFixture } from "../agent/consoleConnectorOAuth-fixture.ts";
import { HarnessConfigSchema } from "../config/schema.ts";

function rawRequest(port: number, path: string, method = "GET", headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("webServerPlan reads only webConsole: one listener, console whenever the server is on, artifacts when asked", () => {
  assert.deepEqual(webServerPlan(HarnessConfigSchema.parse({})), {
    enabled: false, host: "127.0.0.1", port: 3012, baseUrl: undefined, console: false, artifacts: false, historyLimit: 100, actions: false,
  });
  assert.deepEqual(webServerPlan(HarnessConfigSchema.parse({ webConsole: { enabled: true, host: "0.0.0.0", port: 4012, baseUrl: "https://c.example.test/h", historyLimit: 5 } })), {
    enabled: true, host: "0.0.0.0", port: 4012, baseUrl: "https://c.example.test/h", console: true, artifacts: false, historyLimit: 5, actions: false,
  });
  assert.equal(webServerPlan(HarnessConfigSchema.parse({ webConsole: { enabled: true, artifacts: true, baseUrl: "https://c.example.test" } })).artifacts, true);
  // Console actions are off unless the operator turns them on, and never run without the server.
  assert.equal(webServerPlan(HarnessConfigSchema.parse({ webConsole: { enabled: true, actions: true, baseUrl: "https://c.example.test" } })).actions, true);
  assert.equal(webServerPlan(HarnessConfigSchema.parse({ webConsole: { actions: true, baseUrl: "https://c.example.test" } })).actions, false);
  // Artifacts never run without the server: there is no artifacts-only mode.
  const off = webServerPlan(HarnessConfigSchema.parse({ webConsole: { artifacts: true, baseUrl: "https://c.example.test" } }));
  assert.equal(off.enabled, false);
  assert.equal(off.artifacts, false);
});

test("artifact URL helpers keep a stable channel namespace and reject unsafe paths", () => {
  assert.equal(artifactChannelUrl("https://files.example.test/static/", "C123"), "https://files.example.test/static/channels/C123/artifacts/");
  assert.equal(artifactUrl("https://files.example.test/static", "C123", "nested/report 1.html"), "https://files.example.test/static/channels/C123/artifacts/nested/report%201.html");
  assert.equal(artifactUrl("https://files.example.test", "C123", "../memory/MEMORY.md"), undefined);
  assert.deepEqual(artifactRequestPath("/channels/C123/artifacts/nested/report%201.html"), { channelId: "C123", path: ["nested", "report 1.html"] });
  assert.equal(artifactRequestPath("/channels/C123/artifacts/%2e%2e/memory/MEMORY.md"), undefined);
  assert.equal(artifactRequestPath("/channels/C123/artifacts/%2Fetc/passwd"), undefined);
});

test("artifact server honours the path prefix in the configured public base URL", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "report.txt"), "visible");
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test/static" }, dataDir);
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    assert.equal((await rawRequest(port, "/static/channels/C123/artifacts/report.txt")).status, 200);
    assert.equal((await rawRequest(port, "/channels/C123/artifacts/report.txt")).status, 404);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact server resists a double root swap after pinning its root descriptor", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  const outside = join(dataDir, "private");
  mkdirSync(outside);
  writeFileSync(join(paths.artifacts, "report.txt"), "safe data");
  writeFileSync(join(outside, "report.txt"), "private data");
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test" },
    dataDir,
    { afterRootOpen: () => {
      const original = `${paths.artifacts}-original`;
      renameSync(paths.artifacts, original);
      symlinkSync(outside, paths.artifacts);
      // Restore the safe root, then replace it again. A path-based
      // stat/realpath/open sequence can be steered across these swaps; the
      // helper keeps traversing from the descriptor opened before either one.
      unlinkSync(paths.artifacts);
      renameSync(original, paths.artifacts);
      renameSync(paths.artifacts, original);
      symlinkSync(outside, paths.artifacts);
    } },
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const response = await rawRequest(port, "/channels/C123/artifacts/report.txt");
    assert.equal(response.status, 200);
    assert.equal(response.body, "safe data");
    assert.notEqual(response.body, "private data");
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact server refuses an intermediate symlink to a private directory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  const nested = join(paths.artifacts, "nested");
  const outside = join(dataDir, "private");
  mkdirSync(outside);
  writeFileSync(join(outside, "report.txt"), "private data");
  symlinkSync(outside, nested);
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test" },
    dataDir,
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const response = await rawRequest(port, "/channels/C123/artifacts/nested/report.txt");
    assert.equal(response.status, 404);
    assert.notEqual(response.body, "private data");
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact server terminates its helper when a browser aborts a large response", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "large.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  let helper: ChildProcess | undefined;
  let helperReady!: () => void;
  const spawned = new Promise<void>((resolve) => { helperReady = resolve; });
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test" },
    dataDir,
    { onHelperSpawn: (child) => { helper = child; helperReady(); } },
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/channels/C123/artifacts/large.bin" }, (res) => {
        res.once("data", () => { res.destroy(); resolve(); });
      });
      req.once("error", reject);
      req.end();
    });
    await spawned;
    assert.ok(helper);
    await Promise.race([
      once(helper!, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("artifact helper survived an aborted response")), 1_000)),
    ]);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact server terminates its helper when a client aborts before FIFO metadata", async (t) => {
  if (process.platform === "win32") return t.skip("mkfifo is a POSIX test");
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  const fifo = join(paths.artifacts, "waiting.fifo");
  execFileSync("mkfifo", [fifo]);
  let helper: ChildProcess | undefined;
  let helperReady!: () => void;
  const spawned = new Promise<void>((resolve) => { helperReady = resolve; });
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test" },
    dataDir,
    { onHelperSpawn: (child) => { helper = child; helperReady(); } },
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const req = request({ host: "127.0.0.1", port, path: "/channels/C123/artifacts/waiting.fifo" });
    req.once("error", () => undefined);
    req.end();
    await spawned;
    assert.ok(helper);
    req.destroy();
    await Promise.race([
      once(helper!, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pre-metadata helper survived client abort")), 1_000)),
    ]);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact server serves only regular files in the requesting channel artifact directory", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-artifacts-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "report.html"), "<h1>report</h1>");
  writeFileSync(join(paths.artifacts, "empty.txt"), "");
  mkdirSync(join(paths.artifacts, "nested"));
  writeFileSync(join(paths.artifacts, "nested", "report.txt"), "nested report");
  writeFileSync(paths.memoryFile, "private memory");
  writeFileSync(join(dataDir, "outside.txt"), "outside");
  symlinkSync(join(dataDir, "outside.txt"), join(paths.artifacts, "leak.txt"));

  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://files.example.test" }, dataDir);
  try {
    await server.start();
    const address = server.address() as { port: number };

    const page = await rawRequest(address.port, "/channels/C123/artifacts/report.html");
    assert.equal(page.status, 200);
    assert.equal(page.body, "<h1>report</h1>");
    assert.match(String(page.headers["content-type"]), /^text\/html/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");

    const head = await rawRequest(address.port, "/channels/C123/artifacts/report.html", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const nested = await rawRequest(address.port, "/channels/C123/artifacts/nested/report.txt");
    assert.equal(nested.status, 200);
    assert.equal(nested.body, "nested report");
    const empty = await rawRequest(address.port, "/channels/C123/artifacts/empty.txt");
    assert.equal(empty.status, 200);
    assert.equal(empty.body, "");

    assert.equal((await rawRequest(address.port, "/channels/C123/artifacts/%2e%2e/memory/MEMORY.md")).status, 404);
    assert.equal((await rawRequest(address.port, "/channels/C123/artifacts/%2Fetc/passwd")).status, 404);
    assert.equal((await rawRequest(address.port, "/channels/C123/artifacts/leak.txt")).status, 404);
    rmSync(paths.artifacts, { recursive: true });
    symlinkSync(dataDir, paths.artifacts);
    assert.equal((await rawRequest(address.port, "/channels/C123/artifacts/outside.txt")).status, 404);
    assert.equal((await rawRequest(address.port, "/channels/C123/artifacts/")).status, 404);
    const post = await rawRequest(address.port, "/channels/C123/artifacts/report.html", "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the one web server answers /health and /api/status with the task status JSON, honouring historyLimit", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const tasks = new TaskStatusStore(dataDir);
  for (let i = 0; i < 3; i++) tasks.update(tasks.start({ channelId: "C1", channelName: "eng", summary: `done ${i}`, kind: "code" }).id, "closed_successfully");
  tasks.start({ channelId: "C1", channelName: "eng", summary: "working", kind: "code", links: [{ url: "https://github.com/acme/widget/pull/7" }] });
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test", artifacts: false, historyLimit: 2 },
    dataDir, {}, undefined, undefined,
    { tasks, channels: () => [{ id: "C1", name: "eng", isDm: false, firstSeen: "a", lastSeen: "b" }], configuredChannels: () => ["#ops"] },
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const health = await rawRequest(port, "/health");
    assert.equal(health.status, 200);
    assert.match(String(health.headers["content-type"]), /^application\/json/);
    assert.equal(health.body, '{"ok":true}');

    const status = await rawRequest(port, "/api/status");
    assert.equal(status.status, 200);
    assert.match(String(status.headers["content-type"]), /^application\/json/);
    assert.equal(status.headers["cache-control"], "no-store");
    assert.equal(status.headers["x-content-type-options"], "nosniff");
    assert.equal(health.headers["x-content-type-options"], "nosniff");
    const body = JSON.parse(status.body);
    assert.deepEqual(Object.keys(body).sort(), ["active", "channels", "generatedAt", "history"]);
    assert.equal(body.history.length, 2);
    assert.equal(body.active.length, 1);
    assert.equal(body.active[0].links[0].label, "PR acme/widget#7");
    assert.deepEqual(body.channels.map((channel: { id: string; state: string }) => [channel.id, channel.state]), [["C1", "active"], ["#ops", "idle"]]);
    const eng = body.channels[0];
    assert.deepEqual(Object.keys(eng).sort(), ["active", "firstSeen", "history", "id", "isDm", "lastSeen", "name", "state"]);
    assert.equal(eng.history.length, 2);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("/health and /api/status are also served below a baseUrl path prefix", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const server = new ArtifactServer(
    { enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test/harness", artifacts: false },
    dataDir, {}, undefined, undefined,
    { tasks: new TaskStatusStore(dataDir), channels: () => [], configuredChannels: () => [] },
  );
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    assert.equal((await rawRequest(port, "/health")).status, 200);
    assert.equal((await rawRequest(port, "/harness/health")).status, 200);
    assert.equal((await rawRequest(port, "/api/status")).status, 200);
    assert.deepEqual(JSON.parse((await rawRequest(port, "/harness/api/status")).body).channels, []);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a disabled web server does not listen, so it serves no /health or /api/status", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const server = new ArtifactServer(
    { enabled: false, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test" },
    dataDir, {}, undefined, undefined,
    { tasks: new TaskStatusStore(dataDir), channels: () => [], configuredChannels: () => [] },
  );
  try {
    await server.start();
    assert.equal(server.address(), null);
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact downloads are absent when artifacts are off, while /health still answers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "report.txt"), "visible");
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test", artifacts: false }, dataDir);
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    assert.equal((await rawRequest(port, "/channels/C123/artifacts/report.txt")).status, 404);
    assert.equal((await rawRequest(port, "/health")).status, 200);
    assert.equal((await rawRequest(port, "/api/status")).status, 404, "no status source, no status route");
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("isAllowedHost accepts loopback, the bind host and the baseUrl hostname, and nothing else", () => {
  const config = { host: "127.0.0.1", baseUrl: "https://console.example.test/h" };
  assert.equal(isAllowedHost("attacker.example", config), false);
  assert.equal(isAllowedHost(undefined, config), false);
  assert.equal(isAllowedHost("", config), false);
  assert.equal(isAllowedHost("localhost:3012", config), true);
  assert.equal(isAllowedHost("[::1]:3012", config), true);
  assert.equal(isAllowedHost("127.0.0.1", config), true);
  assert.equal(isAllowedHost("Console.Example.Test", config), true);
  assert.equal(isAllowedHost("console.example.test:443", config), true);
  assert.equal(isAllowedHost("console.example.test.attacker.example", config), false);
  assert.equal(isAllowedHost("harness.lan:3012", { host: "harness.lan" }), true);
  const wildcard = { host: "0.0.0.0", baseUrl: "https://console.example.test" };
  assert.equal(isAllowedHost("0.0.0.0", wildcard), false);
  assert.equal(isAllowedHost("0.0.0.0:3012", wildcard), false);
  assert.equal(isAllowedHost("localhost", wildcard), true);
  assert.equal(isAllowedHost("[::]:3012", { host: "::" }), false);
});

test("every route refuses an unrecognised Host with 421, a DNS-rebinding defence", async (t) => {
  const f = consoleOAuthFixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "report.txt"), "visible");
  const status = { tasks: new TaskStatusStore(dataDir), channels: () => [], configuredChannels: () => [] };
  const prefixed = new ArtifactServer(
    { enabled: true, console: true, artifacts: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.org/harness" },
    dataDir, {}, undefined, f.manager, status,
  );
  const bare = new ArtifactServer({ enabled: true, console: true, artifacts: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test" }, dataDir, {}, undefined, undefined, status);
  try {
    await prefixed.start();
    await bare.start();
    const prefixedPort = (prefixed.address() as { port: number }).port;
    const barePort = (bare.address() as { port: number }).port;
    const evil = { Host: "attacker.example" };
    for (const [port, path] of [
      [barePort, "/api/status"], [barePort, "/"], [barePort, "/health"], [barePort, "/channels/C123/artifacts/report.txt"],
      [prefixedPort, "/harness/"], [prefixedPort, "/harness/api/status"], [prefixedPort, "/harness/channels/C123/artifacts/report.txt"],
      [prefixedPort, "/harness/oauth/callback?state=x&code=y"], [prefixedPort, "/harness/oauth/connect"],
    ] as const) {
      const response = await rawRequest(port, path, "GET", evil);
      assert.equal(response.status, 421, path);
      assert.equal(response.body, "Misdirected request");
      assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal((await rawRequest(prefixedPort, "/harness/oauth/claim", "POST", evil)).status, 421, "OAuth POST routes too");
    assert.equal((await rawRequest(barePort, "/api/status", "GET", { Host: `localhost:${barePort}` })).status, 200);
    assert.equal((await rawRequest(barePort, "/api/status", "GET", { Host: "console.example.test" })).status, 200);
    assert.equal((await rawRequest(prefixedPort, "/harness/api/status", "GET", { Host: "console.example.org" })).status, 200);
    assert.equal((await rawRequest(barePort, "/channels/C123/artifacts/report.txt", "GET", { Host: "console.example.test" })).status, 200);
  } finally {
    await prefixed.stop();
    await bare.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a request with no Host header is refused", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test", artifacts: false }, dataDir);
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/health", setHost: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once("error", reject);
      req.end();
    });
    // Node's HTTP/1.1 parser already answers 400 before the handler sees it;
    // isAllowedHost(undefined) is false as well (unit test above).
    assert.ok(status === 400 || status === 421, String(status));
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("artifact files always carry the sandbox CSP, so their scripts cannot read the console or /api/status", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-web-"));
  const paths = ensureChannelDirs(dataDir, "C123");
  writeFileSync(join(paths.artifacts, "page.html"), "<script>fetch('/api/status')</script>");
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: "https://console.example.test" }, dataDir);
  try {
    await server.start();
    const port = (server.address() as { port: number }).port;
    const response = await rawRequest(port, "/channels/C123/artifacts/page.html");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-security-policy"], "sandbox allow-scripts allow-downloads; worker-src 'none'");
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
