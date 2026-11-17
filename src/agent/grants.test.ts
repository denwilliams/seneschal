import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantStore, describeCapability, isExpired, type Grant } from "./grants.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";

function store() {
  return { dir: mkdtempSync(join(tmpdir(), "grants-")), make: (d: string) => new GrantStore(d) };
}

function grant(capability: string, minutes: number | null): Grant {
  return {
    capability: capability as Grant["capability"],
    grantedBy: "U1",
    grantedAt: new Date().toISOString(),
    expiresAt: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString(),
  };
}

test("a web approval honestly names page reads and workspace downloads", () => {
  assert.match(describeCapability("web"), /reading web pages/i);
  assert.match(describeCapability("web"), /downloading public files/i);
  assert.match(describeCapability("web"), /workspace/i);
});

test("a sharedToolsPublish approval names the shared bin, not just 'publishing'", () => {
  assert.match(describeCapability("sharedToolsPublish"), /shared tool bin/i);
  assert.match(describeCapability("sharedToolsPublish"), /let other channels run it/i);
});

test("a grant is active until it expires", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", 60));
  assert.equal(s.has("C1", "network"), true);

  // Ask again as if an hour and a bit had passed.
  const later = Date.now() + 61 * 60_000;
  assert.equal(s.has("C1", "network", later), false, "grants must lapse on their own");
});

test("an expired grant is not returned as active", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", -1));
  assert.equal(s.active("C1").length, 0);
  assert.equal(s.all("C1").length, 1, "but it is still on record");
});

test("grants do not cross channels", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", 60));
  assert.equal(s.has("C1", "network"), true);
  assert.equal(s.has("C2", "network"), false, "approving in one channel must not affect another");
});

test("grants survive a restart", () => {
  const { dir, make } = store();
  make(dir).grant("C1", grant("network", 60));
  assert.equal(make(dir).has("C1", "network"), true);
});

test("re-granting extends rather than stacking", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", 15));
  s.grant("C1", grant("network", 120));
  assert.equal(s.active("C1").length, 1);
});

test("revoke removes a grant immediately", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", 60));
  assert.equal(s.revoke("C1", "network"), true);
  assert.equal(s.has("C1", "network"), false);
  assert.equal(s.revoke("C1", "network"), false, "revoking twice is not an error");
});

test("a grant of something not grantable is ignored when resolving", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grants-"));
  // Someone edits grants.json by hand, or the config is tightened afterwards.
  new GrantStore(dataDir).grant("C1", grant("bash", null));

  const config = HarnessConfigSchema.parse({
    channels: { eng: { permissions: { grantable: ["network"] } } },
  });
  const channel = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  ).channel!;

  assert.ok(!channel.tools.includes("bash"), "config is the ceiling, not the grant file");
  assert.equal(channel.grants.length, 0);
});

test("a network grant opens the sandbox only where it was granted", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grants-"));
  new GrantStore(dataDir).grant("C1", grant("network", 60));

  const config = HarnessConfigSchema.parse({
    defaults: { sandbox: { mode: "docker" }, permissions: { grantable: ["network"] } },
    channels: { eng: {}, home: {} },
  });
  const registry = new ChannelRegistry(dataDir);

  const eng = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry)
    .channel!;
  const home = resolveChannel(config, dataDir, { id: "C2", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(eng.sandbox.network, "bridge");
  assert.equal(home.sandbox.network, "none", "the other channel stays offline");
});

test("a bash grant adds the tool without editing config", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grants-"));
  new GrantStore(dataDir).grant("C1", grant("bash", 60));

  const config = HarnessConfigSchema.parse({
    channels: { eng: { permissions: { grantable: ["bash"] } } },
  });
  const channel = resolveChannel(
    config,
    dataDir,
    { id: "C1", name: "eng", isDm: false },
    new ChannelRegistry(dataDir),
  ).channel!;

  assert.ok(channel.tools.includes("bash"));
});

function resolve(configInput: unknown, dataDir = mkdtempSync(join(tmpdir(), "grants-"))) {
  const config = HarnessConfigSchema.parse(configInput);
  return {
    dataDir,
    channel: resolveChannel(
      config,
      dataDir,
      { id: "C1", name: "eng", isDm: false },
      new ChannelRegistry(dataDir),
    ).channel!,
  };
}

test("network and web are grantable by default; bash and memoryWrite are not", () => {
  const { channel } = resolve({ channels: { eng: {} } });
  // Asking is not a privilege: nothing happens without a human approving.
  assert.deepEqual(channel.permissions.grantable, ["network", "web"]);
});

test("a capability already in effect is not worth requesting", () => {
  const shell = ["read", "bash"] as const;

  // Host mode already has network, so asking for it would be a no-op.
  const host = resolve({ channels: { eng: { tools: [...shell], sandbox: { mode: "host" } } } });
  assert.ok(!host.channel.requestable.includes("network"));

  // Sandboxed and offline: now it means something.
  const sandboxed = resolve({
    channels: { eng: { tools: [...shell], sandbox: { mode: "docker" } } },
  });
  assert.ok(sandboxed.channel.requestable.includes("network"));

  // `web` is on by default, so a channel on the defaults is never offered it.
  const defaults = resolve({ channels: { eng: {} } });
  assert.ok(!defaults.channel.requestable.includes("web"));
});

test("a channel with no shell is offered web rather than network", () => {
  // `network` opens the sandbox for bash. Without bash there is nothing for it
  // to open, so asking would spend a human's approval on a no-op.
  const { channel } = resolve({
    channels: { eng: { tools: ["read", "write"], sandbox: { mode: "docker" } } },
  });
  assert.ok(!channel.requestable.includes("network"));
  assert.ok(channel.requestable.includes("web"));
});

test("granting web turns the tool on for the channel", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grants-"));
  const offline = resolve({ channels: { eng: { tools: ["read"] } } }, dataDir);
  assert.ok(!offline.channel.tools.includes("web"));

  new GrantStore(dataDir).grant("C1", grant("web", 60));
  const { channel } = resolve({ channels: { eng: { tools: ["read"] } } }, dataDir);

  assert.ok(channel.tools.includes("web"), "the grant adds the tool");
  assert.ok(!channel.requestable.includes("web"), "and it stops being requestable");
});

test("an already-granted capability drops out of requestable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grants-"));
  new GrantStore(dataDir).grant("C1", grant("network", 60));
  const { channel } = resolve({ channels: { eng: { sandbox: { mode: "docker" } } } }, dataDir);

  assert.equal(channel.sandbox.network, "bridge");
  assert.ok(!channel.requestable.includes("network"), "it already has it");
});

test("permanent grants are off unless explicitly allowed", () => {
  const { channel } = resolve({ channels: { eng: {} } });
  assert.equal(channel.permissions.allowPermanent, false);

  const opted = resolve({ channels: { eng: { permissions: { allowPermanent: true } } } });
  assert.equal(opted.channel.permissions.allowPermanent, true);
});

test("a permanent grant never expires", () => {
  const { dir, make } = store();
  const s = make(dir);
  s.grant("C1", grant("network", null));
  assert.equal(s.has("C1", "network", Date.now() + 365 * 24 * 60 * 60_000), true);
});

test("a channel override keeps the account defaults it does not mention", () => {
  const { channel } = resolve({
    defaults: { sandbox: { mode: "docker", memory: "2g" } },
    channels: { eng: { sandbox: { network: "bridge" } } },
  });
  assert.equal(channel.sandbox.network, "bridge", "the override applies");
  assert.equal(channel.sandbox.mode, "docker", "and the default is not reset");
  assert.equal(channel.sandbox.memory, "2g");
});

test("isExpired treats a null expiry as permanent", () => {
  assert.equal(isExpired(grant("network", null)), false);
});
