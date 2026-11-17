import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installFromLibrary,
  installedFromLibrary,
  listLibrary,
  publishToLibrary,
  readLibrarySkill,
  unpublishFromLibrary,
} from "./library.ts";
import { createLibraryTools } from "./library-tools.ts";
import { listSkills, writeChannelSkill } from "./skills.ts";
import { sharedPaths, type SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * The library is the one place a channel's work is meant to cross the isolation
 * boundary, so the tests are mostly about the shape of that crossing: only your
 * own skills go out, only the publisher can change what they published, and
 * what comes back in is a copy this channel owns rather than a live link to
 * somebody else's instructions.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-library-"));
  // Derived rather than restated, so a new shared path does not break a test
  // that has nothing to do with it.
  const shared: SharedPaths = sharedPaths(root);
  mkdirSync(shared.library, { recursive: true });
  mkdirSync(shared.skills, { recursive: true });

  const channel = (id: string, name: string, access?: { canRead?: boolean; canPublish?: boolean }) => {
    const skills = join(root, "channels", id, "skills");
    mkdirSync(skills, { recursive: true });
    return {
      ref: { id, name, isDm: false },
      paths: { skills },
      shared,
      skillPaths: [skills],
      library: { canRead: access?.canRead ?? true, canPublish: access?.canPublish ?? true },
    } as unknown as ResolvedChannel;
  };

  return { root, shared, channel };
}

const SKILL = {
  name: "grafana-alerts",
  description: "Read a Grafana alert and work out what actually broke.",
  instructions: "1. Open the alert\n2. The panel title lies; check the query",
};

test("a channel publishes its own skill and another installs it", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);

  const entry = publishToLibrary(shared, ops, { name: SKILL.name, note: "Assumes Grafana 11." });

  assert.equal(entry.version, 1);
  assert.equal(entry.publishedBy, "#ops");
  assert.equal(listLibrary(shared).length, 1);
  assert.equal(listSkills(home).length, 0, "publishing must not activate anything anywhere");

  const result = installFromLibrary(shared, home, SKILL.name);

  assert.equal(result.entry.name, SKILL.name);
  const installed = listSkills(home);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.origin, "channel", "an installed skill belongs to the channel that took it");
  assert.match(readFileSync(result.path, "utf-8"), /The panel title lies/);
  assert.equal(installedFromLibrary(home)[SKILL.name]?.from, "#ops");
});

test("only the publisher can replace what they published", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);
  publishToLibrary(shared, ops, { name: SKILL.name });

  writeChannelSkill(home, { ...SKILL, instructions: "1. Ignore it" });

  assert.throws(
    () => publishToLibrary(shared, home, { name: SKILL.name }),
    /Only the channel that published/,
  );
  assert.throws(() => unpublishFromLibrary(shared, home, SKILL.name), /cannot withdraw it/);
  assert.match(readLibrarySkill(shared, SKILL.name).instructions, /panel title lies/);
});

test("republishing bumps the version and installs can catch up", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);
  publishToLibrary(shared, ops, { name: SKILL.name });
  installFromLibrary(shared, home, SKILL.name);

  writeChannelSkill(ops, { ...SKILL, instructions: "1. Open the alert\n2. Check the datasource too" });
  const second = publishToLibrary(shared, ops, { name: SKILL.name });
  assert.equal(second.version, 2);
  assert.equal(installedFromLibrary(home)[SKILL.name]?.version, 1, "the copy does not change by itself");

  const update = installFromLibrary(shared, home, SKILL.name);
  assert.equal(update.replacedVersion, 1);
  assert.match(readFileSync(update.path, "utf-8"), /datasource/);
});

test("a channel can only publish skills it wrote itself", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");

  assert.throws(() => publishToLibrary(shared, ops, { name: "never-written" }), /not one of this channel's own/);
});

test("installing does not silently overwrite a skill the channel wrote", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);
  publishToLibrary(shared, ops, { name: SKILL.name });
  writeChannelSkill(home, { ...SKILL, instructions: "Our own version, hard won." });

  assert.throws(() => installFromLibrary(shared, home, SKILL.name), /already has its own skill/);

  installFromLibrary(shared, home, SKILL.name, { replace: true });
  assert.match(readFileSync(listSkills(home)[0]!.path, "utf-8"), /panel title lies/);
});

test("withdrawing takes it off the shelf but leaves installed copies alone", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);
  publishToLibrary(shared, ops, { name: SKILL.name });
  installFromLibrary(shared, home, SKILL.name);

  assert.equal(unpublishFromLibrary(shared, ops, SKILL.name), true);
  assert.equal(listLibrary(shared).length, 0);
  assert.equal(listSkills(home).length, 1, "a channel does not lose a skill because the publisher changed its mind");
  assert.equal(unpublishFromLibrary(shared, ops, SKILL.name), false);
});

test("a description with a colon survives the round trip", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, {
    ...SKILL,
    description: "Read a Grafana alert. Use when: someone pastes an alert link.",
  });

  publishToLibrary(shared, ops, { name: SKILL.name });
  installFromLibrary(shared, home, SKILL.name);

  assert.match(listSkills(home)[0]!.description, /someone pastes an alert link/);
});

test("a channel without publish permission is told how to ask", async () => {
  const { shared, channel } = setup();
  const home = channel("C-HOME", "home", { canPublish: false });
  writeChannelSkill(home, SKILL);

  const tools = createLibraryTools({ channel: home, reload: async () => {} }) as any[];
  const publish = tools.find((t) => t.name === "publish_skill");

  assert.ok(publish, "the tool exists so the agent can find the door rather than the wall");
  await assert.rejects(() => publish.execute("id", { name: SKILL.name }), /request_access|libraryPublish/);
  assert.equal(listLibrary(shared).length, 0);
});

test("a channel shut out of the library gets no reading tools", () => {
  const { channel } = setup();
  const closed = channel("C-X", "x", { canRead: false, canPublish: false });

  const names = (createLibraryTools({ channel: closed, reload: async () => {} }) as any[]).map(
    (t) => t.name,
  );
  assert.deepEqual(names, [], "no read access and no publish permission means no library at all");
});

test("the install tool reloads, so the skill is live for the next turn", async () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  writeChannelSkill(ops, SKILL);
  publishToLibrary(shared, ops, { name: SKILL.name });

  let reloads = 0;
  const tools = createLibraryTools({ channel: home, reload: async () => void reloads++ }) as any[];
  const install = tools.find((t) => t.name === "install_library_skill");

  const result = await install.execute("id", { name: SKILL.name });
  assert.equal(reloads, 1);
  assert.match(result.content[0].text, /Installed `grafana-alerts` from #ops/);
});

test("an entry with no metadata is not offered to other channels", () => {
  const { shared } = setup();
  const dir = join(shared.library, "mystery");
  mkdirSync(dir, { recursive: true });
  // A SKILL.md dropped in by hand, with no record of who published it.
  writeChannelSkill(
    { paths: { skills: shared.library }, skillPaths: [shared.library] } as unknown as ResolvedChannel,
    { name: "mystery", description: "Unattributed.", instructions: "do something" },
  );

  assert.equal(existsSync(join(dir, "SKILL.md")), true);
  assert.deepEqual(listLibrary(shared), [], "a skill with no provenance is not advice worth taking");
});
