/**
 * Opt-in, synthetic proof that the sandbox CLI is NOT a secret-browser boundary.
 * Never point this at an existing session, profile, site or real credential.
 * This is an investigation probe, not the acceptance suite for secure login.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const session = `boundary-${randomUUID()}`;
const password = `synthetic-password-${randomUUID()}`;
const cookie = `synthetic-cookie-${randomUUID()}`;
const dir = await mkdtemp(join(tmpdir(), "camoufox-boundary-"));
const config = join(dir, "config.json");
await writeFile(config, "{}", { mode: 0o600 });
// Do not inherit channel service tokens, real browser config or persistent HOME.
const env = {
  PATH: process.env.PATH,
  HOME: dir,
  CAMOUFOX_CLI_CONFIG: config,
  ...(process.env.CAMOUFOX_INSTALL_DIR ? { CAMOUFOX_INSTALL_DIR: process.env.CAMOUFOX_INSTALL_DIR } : {}),
};
const cli = async (...args) => {
  const { stdout } = await exec("camoufox-cli", ["--session", session, "--json", ...args], {
    env, cwd: dir, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, "Synthetic CLI operation failed");
  return result.data;
};
// Simulate a wrapper supplying a value outside argv/tool output. The general
// CLI can still read it afterwards; hiding the fill command's result is futile.
const supplyOutsideArgv = () => new Promise((resolve, reject) => {
  const socket = connect(`/tmp/camoufox-cli-${session}.sock`);
  let response = "";
  socket.setTimeout(10_000, () => socket.destroy(new Error("Synthetic socket timeout")));
  socket.on("error", reject);
  socket.on("data", (data) => { response += data; });
  socket.on("connect", () => socket.write(JSON.stringify({
    id: "synthetic-fill", action: "eval", params: {
      expression: `document.querySelector('input').value = ${JSON.stringify(password)}; undefined`,
    },
  }) + "\n"));
  socket.on("end", () => {
    try {
      assert.equal(JSON.parse(response).success, true, "Synthetic fill failed");
      resolve();
    } catch { reject(new Error("Synthetic fill failed")); }
  });
});
const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "set-cookie": `boundary=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
    "cache-control": "no-store",
  });
  res.end('<!doctype html><title>Synthetic boundary probe</title><label>Password <input type="password"></label>');
});
let failed = false;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await cli("open", `http://127.0.0.1:${port}/`);
  await supplyOutsideArgv();
  const readBack = await cli("eval", "document.querySelector('input').value");
  assert.equal(readBack.result, password, "Expected general CLI to read synthetic filled password");
  const scriptCookies = await cli("eval", "document.cookie");
  assert.equal(scriptCookies.result, "", "Cookie must really be HttpOnly");
  const cookies = await cli("cookies");
  assert.ok(cookies.cookies.some((entry) => entry.name === "boundary" && entry.value === cookie && entry.httpOnly));
  console.log("CONFIRMED: general CLI recovered a synthetic filled password.");
  console.log("CONFIRMED: general CLI recovered a synthetic HttpOnly session cookie.");
  console.log("This proves a missing boundary, NOT that secure login is implemented.");
} catch {
  // Do not print upstream responses, browser logs or exception messages.
  console.error("Boundary probe failed or browser unavailable; no security conclusion from this run.");
  failed = true;
} finally {
  // Session name is fresh and private to this probe; never close other sessions.
  try { await cli("close"); } catch { failed = true; }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
