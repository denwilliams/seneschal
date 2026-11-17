import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createNotificationTools } from "./notification-tools.ts";
import { channelPaths, sharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

function setup(opts: { enabled?: boolean; canCollect?: boolean; configuredChannel?: string; root?: string } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "harness-notification-tools-"));
  const shared = sharedPaths(root);
  const channelId = opts.canCollect ? "C-ADMIN" : "C-OPS";
  const paths = channelPaths(root, channelId);
  mkdirSync(shared.notifications, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });

  const channel = {
    ref: { id: channelId, name: opts.canCollect ? "admin" : "ops", isDm: false },
    paths,
    shared,
    notifications: {
      enabled: opts.enabled ?? true,
      channel: opts.configuredChannel ?? "admin",
      canCollect: opts.canCollect ?? false,
      maxPending: 10,
      maxMessageChars: 500,
    },
  } as unknown as ResolvedChannel;

  const tools = createNotificationTools({ channel, currentUserId: () => "U1" });
  const call = async (name: string, params: unknown) => {
    const tool = tools.find((t: ToolDefinition) => t.name === name);
    assert.ok(tool, `no tool called ${name}`);
    const result = await (tool as ToolDefinition).execute(
      "call-1",
      params as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  };

  return { root, shared, channel, tools, call };
}

test("notification tools are hidden when batching is disabled", () => {
  const { tools } = setup({ enabled: false });
  assert.deepEqual(tools, []);
});

test("a normal channel can submit but not collect", async () => {
  const { call } = setup();

  const queued = await call("submit_notification", { title: "Backups", message: "Backup finished." });
  assert.match(queued, /Queued notification/);
  await assert.rejects(() => call("collect_notifications", {}), /Only admin can collect/);
});

test("the configured notification channel collects submitted items", async () => {
  const normal = setup();
  await normal.call("submit_notification", { title: "Backups", message: "Backup finished." });

  const collector = setup({ canCollect: true, root: normal.root });

  const collected = await collector.call("collect_notifications", {});
  assert.match(collected, /Collected 1 notification/);
  assert.match(collected, /#ops from <@U1>/);
  assert.match(collected, /Backup finished/);

  const empty = await collector.call("collect_notifications", {});
  assert.match(empty, /No pending notifications/);
});
