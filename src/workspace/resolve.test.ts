import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { agentFooter, footerMarker } from "../factory/workflow/footer.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel } from "./resolve.ts";
import { BUILTIN_SKILLS_DIR, listSkills, writeChannelSkill } from "../agent/skills.ts";
import { GrantStore } from "../agent/grants.ts";

function setup(configInput: unknown) {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-"));
  const config = HarnessConfigSchema.parse(configInput);
  const registry = new ChannelRegistry(dataDir);
  return { dataDir, config, registry };
}

function seedShared(dataDir: string) {
  const knowledge = join(dataDir, "shared", "knowledge");
  const skills = join(dataDir, "shared", "skills", "docs", "pdf");
  mkdirSync(knowledge, { recursive: true });
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(knowledge, "company.md"), "We are a small company.");
  // A description is not decoration: pi refuses to load a skill without one.
  writeFileSync(
    join(skills, "SKILL.md"),
    "---\nname: pdf\ndescription: Extract text from PDFs. Use when handed one.\n---\nPDF stuff",
  );
}

test("an unconfigured channel is isolated by default", () => {
  const { dataDir, config, registry } = setup({});
  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "random", isDm: false }, registry);

  assert.ok(channel);
  assert.equal(channel.connectors.length, 0, "no connectors without explicit opt-in");
  // Its own (empty) skills directory is always handed over, so the agent can
  // write skills into it, and the harness's own skills come last. Nothing from
  // the account catalogue comes with it.
  assert.deepEqual(channel.skillPaths, [channel.paths.skills, BUILTIN_SKILLS_DIR]);
  assert.deepEqual(
    listSkills(channel).map((s) => s.origin),
    ["builtin"],
    "no shared skills without explicit opt-in — only what ships with the harness",
  );
  assert.equal(channel.memory.canWriteShared, false, "cannot write account memory by default");
  assert.equal(channel.memory.foreignFiles.length, 0, "no cross-channel memory by default");
  assert.ok(!channel.tools.includes("bash"), "bash is opt-in");
  // Reading the web is not: an assistant that cannot look anything up answers
  // every question about the present from a stale training set.
  assert.ok(channel.tools.includes("web"), "web is on by default");
  assert.equal(channel.web.allowPrivateHosts, false, "but not onto the local network");
  assert.deepEqual(channel.delegation.targets, [], "no cross-channel delegation by default");
});

test("interactive components inherit the account setting and allow a channel to disable it", () => {
  const { dataDir, config, registry } = setup({
    defaults: { interactiveComponents: { enabled: true } },
    channels: { quiet: { interactiveComponents: { enabled: false } } },
  });

  const enabled = resolveChannel(config, dataDir, { id: "C1", name: "normal", isDm: false }, registry).channel!;
  const disabled = resolveChannel(config, dataDir, { id: "C2", name: "quiet", isDm: false }, registry).channel!;
  assert.equal(enabled.interactiveComponents.enabled, true);
  assert.equal(disabled.interactiveComponents.enabled, false);
});

test("delegation targets are explicit per source channel", () => {
  const { dataDir, config, registry } = setup({
    channels: {
      "life-admin": {
        share: {
          delegateTo: [
            { channel: "engineering", reason: "technical tasks needing bash" },
            "#ops",
          ],
        },
      },
      engineering: {},
    },
  });

  const lifeAdmin = resolveChannel(config, dataDir, { id: "C1", name: "life-admin", isDm: false }, registry).channel!;
  const engineering = resolveChannel(config, dataDir, { id: "C2", name: "engineering", isDm: false }, registry).channel!;

  assert.deepEqual(lifeAdmin.delegation.targets, [
    { channel: "engineering", reason: "technical tasks needing bash" },
    { channel: "#ops" },
  ]);
  assert.deepEqual(engineering.delegation.targets, [], "target channels do not get reciprocal access");
});

test("channels only listen to unmentioned root messages when configured", () => {
  const { dataDir, config, registry } = setup({
    channels: {
      talkative: { respondToRootMessages: true },
      quiet: {},
    },
  });

  const talkative = resolveChannel(config, dataDir, { id: "C1", name: "talkative", isDm: false }, registry).channel!;
  const quiet = resolveChannel(config, dataDir, { id: "C2", name: "quiet", isDm: false }, registry).channel!;
  const unconfigured = resolveChannel(config, dataDir, { id: "C3", name: "random", isDm: false }, registry).channel!;

  assert.equal(talkative.respondToRootMessages, true);
  assert.equal(quiet.respondToRootMessages, false);
  assert.equal(unconfigured.respondToRootMessages, false);
});

test("default allowed users apply to channels and DMs, with channel overrides", () => {
  const { dataDir, config, registry } = setup({
    defaults: { allowUsers: ["U1"] },
    channels: {
      team: {},
      support: { allowUsers: ["U2"] },
    },
  });

  const team = resolveChannel(config, dataDir, { id: "C1", name: "team", isDm: false }, registry).channel!;
  const support = resolveChannel(config, dataDir, { id: "C2", name: "support", isDm: false }, registry).channel!;
  const dm = resolveChannel(config, dataDir, { id: "D1", isDm: true }, registry).channel!;

  assert.deepEqual(team.allowUsers, ["U1"]);
  assert.deepEqual(support.allowUsers, ["U2"]);
  assert.deepEqual(dm.allowUsers, ["U1"]);
});

test("a channel's web override keeps the account settings it does not mention", () => {
  const { dataDir, config, registry } = setup({
    defaults: { web: { search: { provider: "brave", apiKey: "account-key" }, maxChars: 9_000 } },
    channels: { eng: { web: { search: { maxResults: 10 }, allowPrivateHosts: true } } },
  });
  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry);

  assert.equal(channel!.web.search.maxResults, 10, "the override applies");
  assert.equal(channel!.web.search.provider, "brave", "one search key does not clear the others");
  assert.equal(channel!.web.search.apiKey, "account-key");
  assert.equal(channel!.web.maxChars, 9_000);
  assert.equal(channel!.web.allowPrivateHosts, true);
});

test("a channel's image settings merge with defaults and expand its env", () => {
  const { dataDir, config, registry } = setup({
    defaults: { images: { provider: "openai", apiKey: "account-key", model: "gpt-image-1" } },
    channels: { art: { tools: ["read", "images"], images: { size: "1536x1024" } } },
  });
  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "art", isDm: false }, registry);

  assert.equal(channel!.images.provider, "openai");
  assert.equal(channel!.images.apiKey, "account-key");
  assert.equal(channel!.images.model, "gpt-image-1");
  assert.equal(channel!.images.size, "1536x1024");
});

test("workspace symlink targets are empty by default and channel lists replace defaults", () => {
  const { dataDir, config, registry } = setup({
    defaults: { workspace: { symlinkTargets: ["/srv/shared-projects"] } },
    channels: { eng: { workspace: { symlinkTargets: ["/srv/engineering-projects"] } } },
  });

  const eng = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry).channel!;
  const general = resolveChannel(config, dataDir, { id: "C2", name: "general", isDm: false }, registry).channel!;

  assert.deepEqual(eng.jail.workspaceSymlinkRoots, ["/srv/engineering-projects"]);
  assert.deepEqual(general.jail.workspaceSymlinkRoots, ["/srv/shared-projects"]);
});

test("a channel's exec commands merge with defaults and expand its env", () => {
  const { dataDir, config, registry } = setup({
    defaults: {
      exec: {
        commands: {
          gh: { command: "gh", allowArgs: [["pr", "list", "**"]] },
        },
      },
    },
    channels: {
      eng: {
        tools: ["read", "exec"],
        exec: {
          commands: {
            acli: { command: "acli", env: { ACLI_TOKEN: "${ACLI_TOKEN}" } },
          },
        },
      },
    },
  });
  const dir = join(dataDir, "channels", "C1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env"), "ACLI_TOKEN=secret\n");

  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry);

  assert.deepEqual(Object.keys(channel!.exec.commands).sort(), ["acli", "gh"]);
  assert.equal(channel!.exec.commands.acli?.env.ACLI_TOKEN, "secret");
  assert.deepEqual(channel!.exec.commands.gh?.allowArgs, [["pr", "list", "**"]]);
});

test("an account CLI registry is exposed only to channels that allowlist its name", () => {
  const { dataDir, config, registry } = setup({
    cliTools: {
      deploy: {
        command: "/usr/local/bin/deploy",
        env: { DEPLOY_TOKEN: "${DEPLOY_TOKEN}" },
        allowArgs: [["--environment", "staging"]],
      },
    },
    channels: {
      release: { tools: ["read", "exec"], exec: { shared: ["deploy"] } },
      observer: { tools: ["read", "exec"] },
    },
  });
  const dir = join(dataDir, "channels", "CRELEASE");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env"), "DEPLOY_TOKEN=channel-secret\n");

  const release = resolveChannel(config, dataDir, { id: "CRELEASE", name: "release", isDm: false }, registry).channel!;
  const observer = resolveChannel(config, dataDir, { id: "COBSERVER", name: "observer", isDm: false }, registry).channel!;

  assert.deepEqual(Object.keys(release.exec.commands), ["deploy"]);
  assert.deepEqual(release.exec.commands.deploy?.allowArgs, [["--environment", "staging"]]);
  assert.equal(release.exec.commands.deploy?.env.DEPLOY_TOKEN, "channel-secret");
  assert.deepEqual(Object.keys(observer.exec.commands), []);
});

test("a channel's shared tool allowlist is its own, and its env expands from its own secrets", () => {
  const { dataDir, config, registry } = setup({
    defaults: {
      // A name in the account defaults is not inherited: share.sharedTools is
      // whole-replaced per channel, same as delegateTo.
      share: { sharedTools: { "never-here": { allowArgs: [] } } },
    },
    channels: {
      home: {
        share: {
          sharedTools: {
            "deploy-notify": { allowArgs: [["--env", "staging"]], env: { TOKEN: "${DEPLOY_TOKEN}" } },
          },
        },
      },
    },
  });
  const dir = join(dataDir, "channels", "C1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "env"), "DEPLOY_TOKEN=secret\n");

  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "home", isDm: false }, registry);

  assert.deepEqual(Object.keys(channel!.sharedTools.execute), ["deploy-notify"]);
  assert.equal(channel!.sharedTools.execute["deploy-notify"]?.env.TOKEN, "secret");
  assert.equal(channel!.sharedTools.canPublish, false, "publishing is off by default");
});

test("a search key given as ${VAR} is expanded from this channel's secrets", () => {
  const { dataDir, config, registry } = setup({
    defaults: { web: { search: { provider: "brave", apiKey: "${SEARCH_KEY}" } } },
    channels: { eng: {} },
  });
  const envFile = join(dataDir, "channels", "C1");
  mkdirSync(envFile, { recursive: true });
  writeFileSync(join(envFile, "env"), "SEARCH_KEY=from-the-channel\n");

  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry);
  assert.equal(channel!.web.search.apiKey, "from-the-channel");
  assert.equal(channel!.web.search.provider, "brave");
  // Names of secrets are surfaced; the value only ever reaches the search call.
  assert.ok(channel!.envKeys.includes("SEARCH_KEY"));
});

test("a search key this channel cannot resolve costs it search, not everything", () => {
  const { dataDir, config, registry } = setup({
    defaults: { web: { search: { provider: "brave", apiKey: "${NOT_SET_ANYWHERE}" } } },
    channels: { eng: {} },
  });

  const { channel } = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry);

  assert.ok(channel, "the channel still resolves");
  assert.equal(channel!.web.search.provider, "none", "search turns itself off");
  assert.ok(channel!.tools.includes("web"), "but the channel can still read a page");
});

test("account knowledge is shared by default, and can be switched off", () => {
  const { dataDir, config, registry } = setup({
    channels: { quiet: { share: { knowledge: false } } },
  });
  seedShared(dataDir);

  const open = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, registry).channel!;
  assert.equal(open.knowledge.length, 1);
  assert.equal(open.knowledge[0]!.name, "company.md");

  const closed = resolveChannel(config, dataDir, { id: "C2", name: "quiet", isDm: false }, registry).channel!;
  assert.equal(closed.knowledge.length, 0);
});

test("runtime channel env expands shared connector settings per channel", () => {
  const { dataDir, config, registry } = setup({
    connectors: {
      gmail: {
        transport: "stdio",
        command: "workspace-mcp",
        env: {
          WORKSPACE_ATTACHMENT_DIR: "${HARNESS_CHANNEL_WORKSPACE}/attachments",
          CHANNEL_ID: "${HARNESS_CHANNEL_ID}",
          CHANNEL_NAME: "${HARNESS_CHANNEL_NAME}",
        },
      },
    },
    channels: {
      ops: { share: { connectors: ["gmail"] } },
      admin: { share: { connectors: ["gmail"] } },
    },
  });

  const ops = resolveChannel(config, dataDir, { id: "C1", name: "ops", isDm: false }, registry).channel!;
  const admin = resolveChannel(config, dataDir, { id: "C2", name: "admin", isDm: false }, registry).channel!;

  const opsEnv = ops.connectors[0]!.config.transport === "stdio" ? ops.connectors[0]!.config.env : {};
  const adminEnv = admin.connectors[0]!.config.transport === "stdio" ? admin.connectors[0]!.config.env : {};

  assert.equal(opsEnv.WORKSPACE_ATTACHMENT_DIR, join(ops.paths.workspace, "attachments"));
  assert.equal(adminEnv.WORKSPACE_ATTACHMENT_DIR, join(admin.paths.workspace, "attachments"));
  assert.notEqual(opsEnv.WORKSPACE_ATTACHMENT_DIR, adminEnv.WORKSPACE_ATTACHMENT_DIR);
  assert.equal(opsEnv.CHANNEL_ID, "C1");
  assert.equal(adminEnv.CHANNEL_ID, "C2");
  assert.equal(opsEnv.CHANNEL_NAME, "ops");
  assert.equal(adminEnv.CHANNEL_NAME, "admin");
});

test("runtime channel env cannot be spoofed by channel env files", () => {
  const { dataDir, config, registry } = setup({
    connectors: {
      gmail: {
        transport: "stdio",
        command: "workspace-mcp",
        env: {
          WORKSPACE_ATTACHMENT_DIR: "${HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS}",
        },
      },
    },
    channels: { ops: { share: { connectors: ["gmail"] } } },
  });
  const dir = join(dataDir, "channels", "C1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "env"),
    [
      "HARNESS_CHANNEL_ID=C999",
      "HARNESS_CHANNEL_ROOT=/tmp/spoof-root",
      "HARNESS_CHANNEL_WORKSPACE=/tmp/spoof-workspace",
      "HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS=/tmp/spoof-attachments",
      "HARNESS_CHANNEL_NAME=spoof",
    ].join("\n"),
  );

  const ops = resolveChannel(config, dataDir, { id: "C1", name: "ops", isDm: false }, registry).channel!;
  const connectorEnv = ops.connectors[0]!.config.transport === "stdio" ? ops.connectors[0]!.config.env : {};

  assert.equal(ops.env.HARNESS_CHANNEL_ID, "C1");
  assert.equal(ops.env.HARNESS_CHANNEL_NAME, "ops");
  assert.equal(ops.env.HARNESS_CHANNEL_ROOT, ops.paths.root);
  assert.equal(ops.env.HARNESS_CHANNEL_WORKSPACE, ops.paths.workspace);
  assert.equal(ops.env.HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS, ops.paths.attachmentText);
  assert.equal(connectorEnv.WORKSPACE_ATTACHMENT_DIR, ops.paths.attachmentText);
});

test("shared skills and connectors require naming them", () => {
  const { dataDir, config, registry } = setup({
    connectors: {
      gmail: { transport: "stdio", command: "mcp-gmail" },
      calendar: { transport: "stdio", command: "mcp-cal" },
    },
    channels: {
      ops: { share: { skillCollections: ["docs"], connectors: ["gmail"] } },
      lounge: {},
    },
  });
  seedShared(dataDir);

  const ops = resolveChannel(config, dataDir, { id: "C1", name: "ops", isDm: false }, registry).channel!;
  assert.deepEqual(
    listSkills(ops)
      .filter((s) => s.origin !== "builtin")
      .map((s) => [s.name, s.origin]),
    [["pdf", "shared"]],
  );
  assert.deepEqual(ops.connectors.map((c) => c.name), ["gmail"]);

  const lounge = resolveChannel(config, dataDir, { id: "C2", name: "lounge", isDm: false }, registry).channel!;
  assert.deepEqual(
    listSkills(lounge).map((s) => s.origin),
    ["builtin"],
    "a shared skill is not enabled everywhere",
  );
  assert.equal(lounge.connectors.length, 0, "defining a connector must not enable it everywhere");
});

test("the harness's own skills are in every channel, and a channel can shadow one", () => {
  const { dataDir, config, registry } = setup({ channels: { lounge: {} } });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "lounge", isDm: false }, registry).channel!;

  // Nothing was configured and nothing was seeded, so whatever is here ships
  // with the harness — an agent about to write its first skill can read how.
  const builtin = listSkills(channel).filter((s) => s.origin === "builtin");
  assert.ok(builtin.length > 0, "the built-in skills must not need opting in");
  assert.ok(
    builtin.some((s) => s.name === "writing-skills"),
    "writing-skills is the one every channel needs before it saves anything",
  );
  assert.ok(
    channel.jail.readRoots.includes(BUILTIN_SKILLS_DIR),
    "the agent has to be able to read a built-in skill back",
  );
  assert.ok(
    !channel.jail.writeRoots.includes(BUILTIN_SKILLS_DIR),
    "and must never be able to rewrite one — they are the harness's, reviewed in git",
  );

  // Same escape hatch the catalogue has: the channel's directory is first in
  // skillPaths, so its own version wins.
  writeChannelSkill(channel, {
    name: "writing-skills",
    description: "How this channel wants skills written.",
    instructions: "Ours, not the harness's.",
  });
  const shadowed = listSkills(channel).filter((s) => s.name === "writing-skills");
  assert.equal(shadowed.length, 1, "one name, one skill");
  assert.equal(shadowed[0]!.origin, "channel");
});

test("channel-private connectors stay in their channel", () => {
  const { dataDir, config, registry } = setup({
    channels: {
      home: { connectors: { hass: { transport: "http", url: "http://localhost:8123/mcp" } } },
      other: {},
    },
  });

  const home = resolveChannel(config, dataDir, { id: "C1", name: "home", isDm: false }, registry).channel!;
  assert.deepEqual(home.connectors.map((c) => c.name), ["hass"]);
  assert.equal(home.connectors[0]!.origin, "channel");

  const other = resolveChannel(config, dataDir, { id: "C2", name: "other", isDm: false }, registry).channel!;
  assert.equal(other.connectors.length, 0);
});

test("write roots never include another channel's workspace", () => {
  const { dataDir, config, registry } = setup({ channels: { a: {}, b: {} } });
  const a = resolveChannel(config, dataDir, { id: "C1", name: "a", isDm: false }, registry).channel!;
  const b = resolveChannel(config, dataDir, { id: "C2", name: "b", isDm: false }, registry).channel!;

  for (const root of a.jail.writeRoots) {
    assert.ok(!root.startsWith(b.paths.root), `${root} must not be writable from channel a`);
  }
  for (const root of a.jail.readRoots) {
    assert.ok(!root.startsWith(b.paths.workspace), `${root} must not be readable from channel a`);
  }
});

test("the shared tool bin is never in any channel's filesystem jail", () => {
  // Execution has to go through the argv-checked shared__<name> tool, never
  // through a generic read/write/bash call — even for a channel with publish
  // and execute access to everything.
  const { dataDir, config, registry } = setup({
    channels: {
      ops: {
        tools: ["read", "write", "bash"],
        share: { sharedToolsPublish: true, sharedTools: { anything: { allowArgs: [] } } },
      },
    },
  });
  const ops = resolveChannel(config, dataDir, { id: "C1", name: "ops", isDm: false }, registry).channel!;

  assert.ok(!ops.jail.readRoots.includes(ops.shared.bin));
  assert.ok(!ops.jail.writeRoots.includes(ops.shared.bin));
});

test("the skill library is readable by default and never writable", () => {
  const { dataDir, config, registry } = setup({ channels: { home: {} } });
  const home = resolveChannel(config, dataDir, { id: "C1", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(home.library.canRead, true, "browsing what other channels shared is the default");
  assert.equal(home.library.canPublish, false, "publishing is not");
  assert.ok(home.jail.readRoots.includes(home.shared.library));
  assert.ok(
    !home.jail.writeRoots.some((root) => root.startsWith(home.shared.library)),
    "publishing has to go through the tool that checks the permission and records the publisher",
  );
});

test("the document library is on by default and never writable through the file tools", () => {
  const { dataDir, config, registry } = setup({ channels: { home: {} } });
  const home = resolveChannel(config, dataDir, { id: "C1", name: "home", isDm: false }, registry)
    .channel!;

  // Both halves default open, unlike the rest of `share`: a shelf nobody may
  // file onto is a shelf, and "attach it and it is kept" is the whole feature.
  assert.equal(home.documents.canRead, true);
  assert.equal(home.documents.canAdd, true);
  assert.ok(home.jail.readRoots.includes(home.shared.documents));
  assert.ok(
    !home.jail.writeRoots.some((root) => root.startsWith(home.shared.documents)),
    "filing has to go through the tool that records which channel filed it",
  );
});

test("a channel where something private might be attached can be shut out of the document library", () => {
  const { dataDir, config, registry } = setup({
    channels: { private: { share: { documents: false, documentsAdd: false } } },
  });
  const isolated = resolveChannel(config, dataDir, { id: "C1", name: "private", isDm: false }, registry)
    .channel!;

  assert.equal(isolated.documents.canRead, false);
  assert.equal(isolated.documents.canAdd, false);
  assert.ok(!isolated.jail.readRoots.includes(isolated.shared.documents));
});

test("the notification inbox is outside every jail and only the configured channel collects", () => {
  const { dataDir, config, registry } = setup({
    notifications: { channel: "admin" },
    channels: { admin: {}, home: {} },
  });
  const admin = resolveChannel(config, dataDir, { id: "C1", name: "admin", isDm: false }, registry)
    .channel!;
  const home = resolveChannel(config, dataDir, { id: "C2", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(admin.notifications.enabled, true);
  assert.equal(admin.notifications.canCollect, true);
  assert.equal(home.notifications.canCollect, false);
  for (const root of [...admin.jail.readRoots, ...admin.jail.writeRoots, ...home.jail.readRoots, ...home.jail.writeRoots]) {
    assert.ok(
      !root.startsWith(admin.shared.notifications),
      `${root} would let a channel read or edit batched notifications without the tool`,
    );
  }
});

test("the feedback log is outside every jail, in both directions", () => {
  const { dataDir, config, registry } = setup({ channels: { home: {} } });
  const home = resolveChannel(config, dataDir, { id: "C1", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(home.feedback.isReviewer, false);
  for (const root of [...home.jail.readRoots, ...home.jail.writeRoots]) {
    assert.ok(
      !root.startsWith(home.shared.feedback),
      `${root} would let a channel file feedback in another's name, or read what other channels filed`,
    );
  }
});

test("the digest channel may read every channel's feedback, without direct file write access", () => {
  const { dataDir, config, registry } = setup({
    feedback: { digestChannel: "admin" },
    channels: { admin: {}, home: {} },
  });
  // The registry learns ids from messages, so the digest channel is only
  // recognised once the harness has seen it.
  const admin = resolveChannel(config, dataDir, { id: "C1", name: "admin", isDm: false }, registry)
    .channel!;
  const home = resolveChannel(config, dataDir, { id: "C2", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(admin.feedback.isReviewer, true);
  assert.ok(admin.jail.readRoots.includes(admin.shared.feedback));
  assert.ok(
    !admin.jail.writeRoots.some((root) => root.startsWith(admin.shared.feedback)),
    "direct file writes could erase what another channel filed",
  );

  assert.equal(home.feedback.isReviewer, false);
  assert.ok(!home.jail.readRoots.includes(home.shared.feedback));
});

test("a channel can be shut out of the library entirely", () => {
  const { dataDir, config, registry } = setup({
    channels: { private: { share: { library: false } } },
  });
  const isolated = resolveChannel(config, dataDir, { id: "C1", name: "private", isDm: false }, registry)
    .channel!;

  assert.equal(isolated.library.canRead, false);
  assert.ok(!isolated.jail.readRoots.includes(isolated.shared.library));
});

test("publishing can be granted at runtime, but only where it is grantable", () => {
  const { dataDir, config, registry } = setup({
    channels: {
      ops: { permissions: { grantable: ["skillPublish"] } },
      home: {},
    },
  });
  const grant = {
    capability: "skillPublish" as const,
    grantedBy: "U1",
    grantedAt: new Date().toISOString(),
    expiresAt: null,
  };
  new GrantStore(dataDir).grant("COPS", grant);
  new GrantStore(dataDir).grant("CHOME", grant);

  const ops = resolveChannel(config, dataDir, { id: "COPS", name: "ops", isDm: false }, registry)
    .channel!;
  const home = resolveChannel(config, dataDir, { id: "CHOME", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(ops.library.canPublish, true);
  assert.equal(
    home.library.canPublish,
    false,
    "a grant for something outside permissions.grantable must not take effect",
  );
});

test("publishing to the shared bin can be granted at runtime, the same way skill publishing can", () => {
  const { dataDir, config, registry } = setup({
    channels: {
      ops: { permissions: { grantable: ["sharedToolsPublish"] } },
      home: {},
    },
  });
  const grant = {
    capability: "sharedToolsPublish" as const,
    grantedBy: "U1",
    grantedAt: new Date().toISOString(),
    expiresAt: null,
  };
  new GrantStore(dataDir).grant("COPS", grant);
  new GrantStore(dataDir).grant("CHOME", grant);

  const ops = resolveChannel(config, dataDir, { id: "COPS", name: "ops", isDm: false }, registry)
    .channel!;
  const home = resolveChannel(config, dataDir, { id: "CHOME", name: "home", isDm: false }, registry)
    .channel!;

  assert.equal(ops.sharedTools.canPublish, true);
  assert.equal(
    home.sharedTools.canPublish,
    false,
    "a grant for something outside permissions.grantable must not take effect",
  );
});

test("cross-channel memory is granted only when named, and resolves by name", () => {
  const { dataDir, config, registry } = setup({
    channels: { ops: { share: { channelMemoryRead: ["alerts"] } } },
  });

  // The alerts channel must have been seen before its name can resolve to an ID.
  resolveChannel(config, dataDir, { id: "CALERTS", name: "alerts", isDm: false }, registry);
  const ops = resolveChannel(config, dataDir, { id: "COPS", name: "ops", isDm: false }, registry).channel!;

  assert.equal(ops.memory.foreignFiles.length, 1);
  assert.equal(ops.memory.foreignFiles[0]!.channel, "alerts");
  assert.ok(ops.memory.foreignFiles[0]!.path.includes("CALERTS"));
});

test("config lookup by Slack ID wins over name", () => {
  const { dataDir, config, registry } = setup({
    channels: { C1: { description: "by id" }, general: { description: "by name" } },
  });
  const resolved = resolveChannel(config, dataDir, { id: "C1", name: "general", isDm: false }, registry).channel!;
  assert.equal(resolved.description, "by id");
});

test("unconfigured channels can be refused entirely", () => {
  const { dataDir, config, registry } = setup({
    allowUnconfiguredChannels: false,
    channels: { general: {} },
  });
  const result = resolveChannel(config, dataDir, { id: "C9", name: "secret", isDm: false }, registry);
  assert.ok(result.rejected);
  assert.equal(result.channel, undefined);
});

test("a Dockerfile in the channel directory becomes the channel's image", () => {
  const { dataDir, config, registry } = setup({
    channels: { eng: { tools: ["bash"], sandbox: { mode: "docker", image: "configured:latest" } } },
  });
  // Resolve once to create the directories, then drop a Dockerfile in.
  resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);
  writeFileSync(join(dataDir, "channels", "C9", "Dockerfile"), "FROM debian:bookworm-slim\n");

  const { channel } = resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);
  assert.ok(channel);
  assert.equal(channel.sandbox.image, "harness-channel-c9:latest");
  assert.equal(channel.channelDockerfile, join(dataDir, "channels", "C9", "Dockerfile"));
});

test("without one, the configured image is left alone", () => {
  const { dataDir, config, registry } = setup({
    channels: { eng: { tools: ["bash"], sandbox: { mode: "docker", image: "configured:latest" } } },
  });
  const { channel } = resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);

  assert.ok(channel);
  assert.equal(channel.sandbox.image, "configured:latest");
  assert.equal(channel.channelDockerfile, undefined);
});

test("a Dockerfile is ignored on the host, where there is no image to build", () => {
  const { dataDir, config, registry } = setup({
    channels: { eng: { tools: ["bash"], sandbox: { mode: "host" } } },
  });
  resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);
  writeFileSync(join(dataDir, "channels", "C9", "Dockerfile"), "FROM debian:bookworm-slim\n");

  const { channel } = resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);
  assert.ok(channel);
  assert.equal(channel.channelDockerfile, undefined);
});

test("the Dockerfile sits outside the jail, so the agent cannot rewrite its own container", () => {
  const { dataDir, config, registry } = setup({
    channels: { eng: { tools: ["bash", "write"], sandbox: { mode: "docker" } } },
  });
  const { channel } = resolveChannel(config, dataDir, { id: "C9", name: "eng", isDm: false }, registry);

  assert.ok(channel);
  for (const root of channel.jail.writeRoots) {
    assert.ok(
      !channel.paths.dockerfile.startsWith(join(root, "/")),
      `${channel.paths.dockerfile} must not be writable via ${root}`,
    );
  }
});

test("work that knows only the channel id still gets that channel's config", () => {
  const { dataDir, config, registry } = setup({
    channels: { ops: { tools: ["read", "bash"], model: "anthropic/claude-opus-4" } },
  });

  // Somebody talks to #ops: the name arrives on the Slack event, and is
  // written down.
  const live = resolveChannel(config, dataDir, { id: "C7", name: "ops", isDm: false }, registry);
  assert.equal(live.channel?.configKey, "ops");

  // A scheduled task fires later, in a process that has not seen a message in
  // this channel — all it has is the id off the stored task. Without the name
  // it would miss the entry above and run on the account defaults: no bash, a
  // different model, none of the channel's secrets.
  const afterRestart = new ChannelRegistry(dataDir);
  const { channel } = resolveChannel(config, dataDir, { id: "C7", isDm: false }, afterRestart);

  assert.ok(channel);
  assert.equal(channel.configKey, "ops");
  assert.equal(channel.ref.name, "ops");
  assert.ok(channel.tools.includes("bash"), "the channel's tools, not the defaults");
  assert.equal(channel.model, "anthropic/claude-opus-4");
});

test("a background run in a configured channel is not turned away as unconfigured", () => {
  const { dataDir, config, registry } = setup({
    allowUnconfiguredChannels: false,
    channels: { ops: {} },
  });
  resolveChannel(config, dataDir, { id: "C7", name: "ops", isDm: false }, registry);

  const result = resolveChannel(config, dataDir, { id: "C7", isDm: false }, new ChannelRegistry(dataDir));
  assert.equal(result.rejected, undefined);
  assert.equal(result.channel?.configKey, "ops");
});

test("a channel nobody has named yet still resolves, on the defaults", () => {
  const { dataDir, config, registry } = setup({ channels: { ops: { tools: ["read", "bash"] } } });

  const { channel } = resolveChannel(config, dataDir, { id: "C7", isDm: false }, registry);
  assert.ok(channel);
  assert.equal(channel.configKey, undefined);
  assert.ok(!channel.tools.includes("bash"));
});

test("every channel gets a bin directory on its shell's PATH", () => {
  const { dataDir, config, registry } = setup({});
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry).channel!;

  assert.equal(channel.paths.bin, join(channel.paths.workspace, "bin"));
  // Created up front, so an operator can drop a CLI in before the channel has
  // ever been used rather than having to guess the path into existence.
  assert.ok(existsSync(channel.paths.bin));
  // Inside the workspace, so it is writable: the agent saving a script there
  // is the same permission as writing any other file, and no wider.
  assert.ok(channel.jail.writeRoots.some((root) => channel.paths.bin.startsWith(root)));
});

test("artifact hosting gives each channel a private workspace directory and stable URL prefix", () => {
  const { dataDir, config, registry } = setup({
    webConsole: { enabled: true, artifacts: true, baseUrl: "https://files.example.test/static" },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry).channel!;

  assert.equal(channel.paths.artifacts, join(dataDir, "channels", "C1", "workspace", "artifacts"));
  assert.deepEqual(channel.artifacts, {
    directory: channel.paths.artifacts,
    url: "https://files.example.test/static/channels/C1/artifacts/",
  });
  assert.equal(channel.env.HARNESS_CHANNEL_ARTIFACTS, channel.paths.artifacts);
  assert.equal(channel.env.HARNESS_CHANNEL_ARTIFACT_URL, "https://files.example.test/static/channels/C1/artifacts/");
  assert.ok(channel.jail.writeRoots.includes(channel.paths.workspace));
});


test("factory config gives only that channel the selected reviewed lifecycle skills", () => {
  const { dataDir, config, registry } = setup({
    channels: { eng: { factory: { name: "Home Factory", repositories: ["acme/widget"], lifecycleSkills: ["planning", "review"] } } },
  });
  const channel = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry).channel!;
  assert.deepEqual(channel.factory, { name: "Home Factory", repositories: ["acme/widget"], lifecycleSkills: ["planning", "review"], announce: true, maxLiveRuns: 3 });
  assert.ok(channel.skillPaths.some((path) => path.endsWith("factory-skills/factory-planning")));
  assert.ok(channel.skillPaths.some((path) => path.endsWith("factory-skills/factory-review")));
  assert.ok(!channel.skillPaths.some((path) => path.endsWith("factory-skills/factory-implementation")));
  const factorySkills = listSkills(channel).filter((skill) => skill.name.startsWith("factory-"));
  assert.deepEqual(factorySkills.map((skill) => skill.origin), ["builtin", "builtin"]);
});

test("a factory channel's shell is switched to the footer guard; any other channel's is not", (t) => {
  // This fixture starts outside a factory, even when the test worker does not.
  for (const key of ["HARNESS_AGENT_FOOTER", "HARNESS_AGENT_FOOTER_MARKER"]) {
    const inherited = process.env[key];
    t.after(() => {
      if (inherited === undefined) delete process.env[key];
      else process.env[key] = inherited;
    });
    delete process.env[key];
  }
  const { dataDir, config, registry } = setup({
    channels: {
      eng: { factory: { name: "Home Factory", repositories: ["acme/widget"] } },
      plain: {},
    },
  });
  const factory = resolveChannel(config, dataDir, { id: "C1", name: "eng", isDm: false }, registry).channel!;
  assert.equal(factory.env.HARNESS_AGENT_FOOTER, agentFooter(), "the channel's own agent writes under the footer too");
  assert.equal(factory.env.HARNESS_AGENT_FOOTER_MARKER, footerMarker());
  const shim = join(factory.globalBin, "gh");
  assert.ok(existsSync(shim), "installed in the operator's global bin, which every shell and container has on its PATH");
  assert.match(readFileSync(shim, "utf8"), /harness-managed: gh-footer-shim/);
  const plain = resolveChannel(config, dataDir, { id: "C2", name: "plain", isDm: false }, registry).channel!;
  assert.equal(plain.env.HARNESS_AGENT_FOOTER, undefined);
  assert.equal(plain.env.HARNESS_AGENT_FOOTER_MARKER, undefined);
});

test("a thread with an old JSONL transcript is recognised as one the conversation store is picking up", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hasLegacyTranscript, threadSessionDir } = await import("./paths.ts");
  const sessions = mkdtempSync(join(tmpdir(), "legacy-sessions-"));
  assert.equal(hasLegacyTranscript(sessions, "1.1"), false, "no directory, no transcript");
  mkdirSync(threadSessionDir(sessions, "1.1"), { recursive: true });
  assert.equal(hasLegacyTranscript(sessions, "1.1"), false, "the presence marker alone is not a transcript");
  writeFileSync(join(threadSessionDir(sessions, "1.1"), "session.jsonl"), "{}\n");
  assert.equal(hasLegacyTranscript(sessions, "1.1"), true);
  assert.equal(hasLegacyTranscript(sessions, "2.2"), false, "other threads are unaffected");
});
