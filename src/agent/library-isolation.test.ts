import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLibraryTools } from "./library-tools.ts";
import { installFromLibrary, installedFromLibrary, listLibrary, publishToLibrary, unpublishFromLibrary } from "./library.ts";
import { listSkills, writeChannelSkill } from "./skills.ts";
import { checkPath } from "./jail.ts";
import { GrantStore } from "./grants.ts";
import { workspaceFixture } from "../workspace/fixture.ts";

/**
 * The agent-published `shared/library` (copy-on-install), alongside
 * collections: how an ordinary channel shares a skill without being trusted to
 * write a live collection. Uses the real resolver so config, grants and the
 * jail are what a session would get.
 */

const SKILL = { name: "grafana-alerts", description: "Read a Grafana alert.", instructions: "check the query" };
const callTool = async (tools: any[], name: string, params: unknown) =>
  (await tools.find((t) => t.name === name).execute("t", params)).content[0].text as string;

function world() {
  const f = workspaceFixture({
    defaults: { permissions: { grantable: ["skillPublish"] } },
    channels: {
      CPUB: { share: { libraryPublish: true } },
      CNOPUB: {},
      CNOREAD: { share: { library: false } },
    },
  });
  return f;
}
const tools = (c: ReturnType<ReturnType<typeof world>["resolve"]>) => createLibraryTools({ channel: c, reload: async () => {} });

test("publishing needs share.libraryPublish or an active skillPublish grant", async () => {
  const f = world();
  const pub = f.resolve("CPUB");
  const nopub = f.resolve("CNOPUB");
  writeChannelSkill(pub, SKILL);
  writeChannelSkill(nopub, SKILL);

  assert.equal(pub.library.canPublish, true);
  assert.equal(nopub.library.canPublish, false);
  await assert.rejects(() => callTool(tools(nopub), "publish_skill", { name: SKILL.name }), /cannot publish to the shared library/);
  assert.deepEqual(listLibrary(f.shared), [], "a refused publish leaves nothing on the shelf");
  assert.ok(!tools(nopub).some((t) => t.name === "unpublish_skill"));

  // runtime grant
  new GrantStore(f.dataDir).grant("CNOPUB", {
    capability: "skillPublish",
    grantedBy: "U1",
    grantedAt: new Date().toISOString(),
    expiresAt: null,
  });
  const granted = f.resolve("CNOPUB");
  assert.equal(granted.library.canPublish, true);
  assert.match(await callTool(tools(granted), "publish_skill", { name: SKILL.name }), /Published/);
  assert.equal(listLibrary(f.shared).length, 1);

  // revocation takes effect on the next resolve
  new GrantStore(f.dataDir).revoke("CNOPUB", "skillPublish");
  assert.equal(f.resolve("CNOPUB").library.canPublish, false);
});

test("install copies: later publisher edits and withdrawal do not change the installed copy", () => {
  const f = world();
  const pub = f.resolve("CPUB");
  const reader = f.resolve("CNOPUB");
  writeChannelSkill(pub, SKILL);
  publishToLibrary(f.shared, pub, { name: SKILL.name });
  const { path } = installFromLibrary(f.shared, reader, SKILL.name);
  const installedText = readFileSync(path, "utf-8");
  assert.match(installedText, /check the query/);

  // publisher edits its own skill and republishes, then withdraws
  writeChannelSkill(pub, { ...SKILL, instructions: "COMPLETELY DIFFERENT" });
  assert.equal(readFileSync(path, "utf-8"), installedText, "editing the source skill does not reach the copy");
  publishToLibrary(f.shared, pub, { name: SKILL.name });
  assert.equal(readFileSync(path, "utf-8"), installedText, "republishing does not push to installers");
  unpublishFromLibrary(f.shared, pub, SKILL.name);
  assert.equal(readFileSync(path, "utf-8"), installedText, "withdrawing leaves installed copies alone");

  // the copy is a plain file in the installer's own skills dir, not a link
  assert.equal(path, join(reader.paths.skills, SKILL.name, "SKILL.md"));
  assert.ok(!path.startsWith(f.shared.library));
  // editing the copy cannot affect anyone else
  writeChannelSkill(reader, { ...SKILL, instructions: "reader's own edit" });
  assert.ok(!existsSync(join(f.shared.library, SKILL.name)), "nothing in the library after withdrawal");
});

test("provenance: entries and installs record who published what, and when", () => {
  const f = world();
  const pub = f.resolve("CPUB", { name: "ops" });
  const reader = f.resolve("CNOPUB");
  writeChannelSkill(pub, SKILL);
  const entry = publishToLibrary(f.shared, pub, { name: SKILL.name, note: "assumes v11" });
  assert.equal(entry.publishedByChannelId, "CPUB");
  assert.equal(entry.publishedBy, "#ops");
  assert.equal(entry.version, 1);
  assert.match(entry.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.note, "assumes v11");
  installFromLibrary(f.shared, reader, SKILL.name);
  const record = installedFromLibrary(reader)[SKILL.name]!;
  assert.deepEqual([record.from, record.version], ["#ops", 1]);
  assert.deepEqual(installedFromLibrary(f.resolve("CPUB")), {}, "the publisher has not installed anything");
});

test("only skills the channel wrote are publishable: not collection skills, not other channels' skills", () => {
  const f = workspaceFixture({
    channels: { CPUB: { share: { libraryPublish: true, skillCollections: ["team"] } }, COTHER: {} },
  });
  f.addCollectionSkill("team", "from-collection");
  const pub = f.resolve("CPUB");
  const other = f.resolve("COTHER");
  writeChannelSkill(other, SKILL);
  assert.throws(() => publishToLibrary(f.shared, pub, { name: "from-collection" }), /not one of this channel's own skills/);
  assert.throws(() => publishToLibrary(f.shared, pub, { name: SKILL.name }), /not one of this channel's own skills/);
  assert.ok(listSkills(pub).some((s) => s.name === "from-collection"));
  assert.deepEqual(listLibrary(f.shared), []);
});

test("no cross-channel access to the library except through the tools", () => {
  const f = world();
  const pub = f.resolve("CPUB");
  const noread = f.resolve("CNOREAD");
  const reader = f.resolve("CNOPUB");
  writeChannelSkill(pub, SKILL);
  publishToLibrary(f.shared, pub, { name: SKILL.name });
  const entryFile = join(f.shared.library, SKILL.name, "SKILL.md");

  // File tools: never writable, even by the publisher; readable only when share.library is on.
  for (const c of [pub, reader, noread]) {
    const jail = { readRoots: c.jail.readRoots, writeRoots: c.jail.writeRoots, cwd: c.paths.workspace };
    assert.equal(checkPath(jail, entryFile, "write").allowed, false, `${c.ref.id} must not write the library directly`);
    assert.equal(checkPath(jail, join(f.shared.library, "new", "SKILL.md"), "write").allowed, false);
  }
  const jailOf = (c: typeof pub) => ({ readRoots: c.jail.readRoots, writeRoots: c.jail.writeRoots, cwd: c.paths.workspace });
  assert.equal(checkPath(jailOf(reader), entryFile, "read").allowed, true);
  assert.equal(checkPath(jailOf(noread), entryFile, "read").allowed, false);

  // A channel shut out of the library has no reading tools and cannot install.
  assert.deepEqual(tools(noread).map((t) => t.name), ["publish_skill"].filter(() => noread.library.canPublish));
  // Another channel cannot replace or withdraw what the publisher published.
  writeChannelSkill(reader, { ...SKILL, instructions: "mine" });
  assert.throws(() => publishToLibrary(f.shared, reader, { name: SKILL.name }), /cannot|already in the library/i);
  assert.throws(() => unpublishFromLibrary(f.shared, reader, SKILL.name), /cannot withdraw/);
  assert.equal(listLibrary(f.shared).length, 1);
  // Nothing of the publisher's own skills directory is exposed by publishing.
  assert.deepEqual(readdirSync(f.shared.library), [SKILL.name]);
  const jr = jailOf(reader);
  assert.equal(checkPath(jr, join(pub.paths.skills, SKILL.name, "SKILL.md"), "read").allowed, false);
});
