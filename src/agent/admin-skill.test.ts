import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessConfigSchema } from "../config/schema.ts";
import { parseConfigText } from "../config/load.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { checkPath } from "./jail.ts";
import { ADMIN_SKILLS_DIR, BUILTIN_SKILLS_DIR, listSkills, loadAvailableSkills } from "./skills.ts";
import { buildSystemPrompt } from "./prompt.ts";

const root = resolve(import.meta.dirname, "../..");
const skillDir = join(ADMIN_SKILLS_DIR, "administer-harness");

function channels() {
  const dataDir = mkdtempSync(join(tmpdir(), "admin-skill-"));
  const config = HarnessConfigSchema.parse({ channels: { ops: { admin: true, tools: ["read"] }, home: { tools: ["read"] } } });
  const registry = new ChannelRegistry(dataDir);
  const get = (id: string, name: string) => resolveChannel(config, dataDir, { id, name, isDm: false }, registry).channel!;
  return { ops: get("C1", "ops"), home: get("C2", "home") };
}

test("the administration skill reaches the admin channel, and no other channel", () => {
  const { ops, home } = channels();
  assert.ok(ops.admin && !home.admin);
  assert.ok(ops.skillPaths.includes(ADMIN_SKILLS_DIR), "the admin channel's skill paths include admin-skills");
  assert.ok(!home.skillPaths.includes(ADMIN_SKILLS_DIR), "no other channel gets that path");
  assert.ok(loadAvailableSkills(ops).some((skill) => skill.name === "administer-harness"));
  assert.ok(!loadAvailableSkills(home).some((skill) => skill.name === "administer-harness"), "another channel cannot even see that it exists");
  assert.ok(listSkills(ops).find((skill) => skill.name === "administer-harness")?.origin === "builtin", "listed as a shipped skill, not one the channel wrote");
});

test("the admin channel can read the skill's files but never write them; other channels cannot read them at all", () => {
  const { ops, home } = channels();
  const file = join(skillDir, "references", "config.md");
  assert.equal(checkPath({ ...ops.jail, cwd: ops.paths.workspace }, file, "read").allowed, true);
  assert.equal(checkPath({ ...ops.jail, cwd: ops.paths.workspace }, file, "write").allowed, false, "reviewed in git; the agent cannot edit how it is told to administer");
  assert.equal(checkPath({ ...home.jail, cwd: home.paths.workspace }, file, "read").allowed, false, "a non-admin channel has no path to the directory");
});

test("the built-in skills stay available everywhere and the admin skill is not among them", () => {
  const { home } = channels();
  assert.ok(home.skillPaths.includes(BUILTIN_SKILLS_DIR));
  assert.ok(!existsSync(join(BUILTIN_SKILLS_DIR, "administer-harness")), "it lives only under admin-skills/");
});

test("the admin channel's prompt points at the skill, and another channel's prompt does not", () => {
  const { ops, home } = channels();
  const options = { harnessName: "Test", slackChannelLabel: "#c", botUserId: "UBOT", includeLateContext: false };
  assert.match(buildSystemPrompt(ops, options), /administer-harness/);
  assert.doesNotMatch(buildSystemPrompt(home, options), /administer-harness/);
});

test("the skill is well-formed: valid frontmatter, a real trigger description, and every file it points at exists", () => {
  const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const frontmatter = /^---\nname: ([a-z0-9-]+)\ndescription: "(.*)"\n---\n/s.exec(text);
  assert.ok(frontmatter, "frontmatter with name and a quoted description");
  assert.equal(frontmatter![1], "administer-harness");
  assert.ok(frontmatter![2]!.length > 100 && frontmatter![2]!.length <= 1024, "a description long enough to trigger on, within the limit");
  assert.match(frontmatter![2]!, /Use it when/i, "the description says when to use it");
  const links = [...text.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((m) => m[1]!);
  assert.ok(links.length >= 4, "it points at its references");
  for (const link of new Set(links)) assert.ok(existsSync(join(skillDir, link)), `${link} exists`);
  const onDisk = readdirSync(join(skillDir, "references")).map((f) => `references/${f}`);
  for (const file of onDisk) assert.ok(text.includes(file), `${file} is linked from SKILL.md (an unlinked reference is never read)`);
});

// ── Drift guards: the skill must not describe commands, scripts or keys that no longer exist ───────────────────
const commandsSource = readFileSync(join(root, "src/slack/commands.ts"), "utf8");
const everything = ["SKILL.md", ...readdirSync(join(skillDir, "references")).map((f) => `references/${f}`)]
  .map((f) => readFileSync(join(skillDir, f), "utf8")).join("\n");

test("every `!command` the skill tells people to type is a real command", () => {
  const mentioned = new Set([...everything.matchAll(/`!([a-z-]+)/g)].map((m) => m[1]!));
  assert.ok(mentioned.size >= 12, "the skill names a meaningful set of commands");
  for (const name of mentioned) {
    assert.match(commandsSource, new RegExp(`case "${name}":`), `!${name} is handled by commands.ts`);
  }
});

test("every `npm run <script>` the skill names exists in package.json", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
  const mentioned = new Set([...everything.matchAll(/npm run ([a-z-]+)/g)].map((m) => m[1]!));
  assert.ok(mentioned.has("doctor") && mentioned.has("secrets") && mentioned.has("login"));
  for (const name of mentioned) assert.ok(scripts[name], `npm run ${name} exists`);
});

test("the config keys and admin tools the skill names exist in the code", () => {
  const schema = readFileSync(join(root, "src/config/schema.ts"), "utf8");
  for (const key of ["skillCollections", "allowUsers", "grantable", "allowPermanent", "keepLast", "threadBackfill", "keepTranscripts"]) {
    assert.ok(schema.includes(key), `config key ${key} exists in the schema`);
  }
  const skills = readFileSync(join(root, "src/agent/skills.ts"), "utf8");
  for (const tool of ["admin_list_channel_skills", "admin_read_channel_skill", "admin_save_channel_skill", "admin_delete_channel_skill"]) {
    assert.ok(skills.includes(`"${tool}"`), `${tool} is a real tool`);
    assert.ok(everything.includes(tool), `the skill tells the admin about ${tool}`);
  }
  const configTools = readFileSync(join(root, "src/agent/admin-config-tools.ts"), "utf8");
  for (const tool of ["admin_config_get", "admin_config_edit"]) {
    assert.ok(configTools.includes(`"${tool}"`), `${tool} is a real tool`);
    assert.ok(everything.includes(tool), `the skill tells the admin about ${tool}`);
  }
});

test("what the skill says the config tools refuse is what the policy refuses", async () => {
  const { TOP_LEVEL, CHANNEL, DEFAULTS, SHARE, FACTORY } = await import("../config/edit-policy.ts");
  const refs = readFileSync(join(skillDir, "references", "config.md"), "utf8");
  const denied = (table: Record<string, "allow" | { deny: string }>) => Object.entries(table).filter(([, v]) => v !== "allow").map(([k]) => k);
  const section = refs.slice(refs.indexOf("**Refused, with a reason you pass on**"), refs.indexOf("### Adding a connector from here"));
  for (const key of [...denied(TOP_LEVEL), ...denied(CHANNEL).filter((k) => k !== "admin" && k !== "envFile"), ...denied(DEFAULTS), ...denied(SHARE).filter((k) => k !== "skills")]) {
    assert.ok(section.includes(key), `the skill's list of refused settings names ${key}`);
  }
  for (const key of denied(FACTORY)) assert.ok(section.includes(`factory.${key}`), `the skill's list of refused settings names factory.${key}`);
});

test("the harness image ships the admin skills", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile.harness"), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.match(runtime, /^COPY admin-skills \.\/admin-skills$/m);
});

test("the admin skill documents share.postAs: approval-gated in SKILL.md, every field and the reviewer rule in config.md", () => {
  const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  assert.match(skillMd, /share\.postAs/, "SKILL.md lists share.postAs among the settings that need approval");
  const refs = readFileSync(join(skillDir, "references", "config.md"), "utf8");
  const start = refs.indexOf("### Posting as a user");
  assert.ok(start >= 0, "config.md has a section on share.postAs");
  const next = refs.indexOf("\n### ", start + 1);
  const section = refs.slice(start, next < 0 ? undefined : next);
  // Each field is documented as a key: in code formatting in the prose, or as a key in the YAML example.
  for (const field of ["user", "reviewer", "maxPerHour", "rules", "privateLinkHosts", "timeoutSeconds"]) {
    assert.ok(section.includes(`\`${field}\``) || new RegExp(`^\\s+${field}:`, "m").test(section), `config.md documents \`${field}\` as a key`);
  }
  assert.match(section, /^\s+post_guard:/m, "the example defines the post_guard role");
  assert.match(section, /reviewer.*needs the click|Editing the reviewer needs the click/i, "editing the reviewer role needs approval");
  assert.match(section, /defaults to the channel's model/, "the reviewer model default is documented");
  assert.match(section, /OneDrive/);
  assert.match(section, /user-group mention/);
  for (const scope of ["chat:write", "im:write", "users:read", "channels:read", "groups:read", "im:read", "mpim:read"]) {
    assert.ok(section.includes(scope), `config.md names the ${scope} scope`);
  }
  assert.match(section, /no tools/i, "the reviewer role must have no tools");
  assert.match(section, /no connectors/i, "and no connectors");
  assert.match(section, /defaults\.share\.postAs/, "defaults is refused");
  assert.match(section, /admin_config_request_approval/, "it is requested with the approval tool");
});

test("the shipped example config shows a guards set with a tool-less post_guard and a channel using share.postAs", () => {
  const text = readFileSync(join(root, "config/harness.example.yaml"), "utf8");
  const parsed = parseConfigText(text, "config/harness.example.yaml");
  const guard = parsed.agentSets.guards?.agents.post_guard;
  assert.ok(guard, "a guards set with a post_guard role");
  assert.equal(guard!.tools.length, 0);
  assert.equal(guard!.connectors.length, 0);
  const channel = Object.values(parsed.channels).find((c) => c.agentSet === "guards" && c.share?.postAs);
  assert.ok(channel, "an inbox-style channel on the guards set with share.postAs");
});
