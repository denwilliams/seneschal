import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfigText, REPO_ROOT } from "./load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

const SAMPLE_PATH = join(REPO_ROOT, "config", "sftp-mcp.example.yaml");

test("the SFTP MCP example is a key-only, remote-root-restricted channel connector", () => {
  const config = parseConfigText(readFileSync(SAMPLE_PATH, "utf-8"), SAMPLE_PATH);
  const dataDir = mkdtempSync(join(tmpdir(), "sftp-mcp-config-"));
  try {
    const channelRoot = join(dataDir, "channels", "C1");
    mkdirSync(channelRoot, { recursive: true });
    writeFileSync(
      join(channelRoot, "env"),
      [
        "SFTP_MCP_SERVER_PATH=/opt/harness-mcp/mcp-server-sftp/index.mjs",
        "SFTP_HOST=approved-endpoint",
        "SFTP_PORT=22",
        "SFTP_USER=dedicated-sftp-account",
        "SFTP_PRIVATE_KEY_PATH=/run/harness/keys/sftp",
        "SFTP_REMOTE_ROOT=/files",
        "SFTP_MAX_READ_BYTES=262144",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o600 },
    );

    const resolved = resolveChannel(
      config,
      dataDir,
      { id: "C1", name: "engineering", isDm: false },
      new ChannelRegistry(dataDir),
    ).channel;
    assert.ok(resolved);
    assert.equal(resolved.connectors.length, 1);

    const connector = resolved.connectors[0]!;
    assert.equal(connector.name, "sftp-files");
    assert.equal(connector.config.transport, "stdio");
    if (connector.config.transport !== "stdio") assert.fail("expected a stdio connector");

    // The launcher removes password auth even if it is ambient in the harness process.
    assert.equal(connector.config.command, "env");
    assert.deepEqual(connector.config.args.slice(0, 4), ["-u", "SFTP_PASSWORD", "node", "/opt/harness-mcp/mcp-server-sftp/index.mjs"]);
    assert.equal(connector.config.env.SFTP_PRIVATE_KEY, "/run/harness/keys/sftp");
    assert.equal(connector.config.env.SFTP_ALLOWED_PREFIX, "/files");
    assert.equal(connector.config.env.SFTP_PASSWORD, undefined);

    // Keep the operational surface deliberately narrow: no shell, host-local transfer, batch, or broad sync tool.
    assert.deepEqual(connector.config.allowTools, [
      "sftp_list",
      "sftp_read",
      "sftp_write",
      "sftp_delete",
      "sftp_mkdir",
      "sftp_rmdir",
      "sftp_rename",
      "sftp_stat",
      "sftp_exists",
    ]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
