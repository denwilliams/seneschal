import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadConfig, parseConfigText, REPO_ROOT } from "../config/load.ts";
import { createDocumentTools } from "../agent/document-tools.ts";
import { listDocuments } from "../agent/documents.ts";
import { checkPath } from "../agent/jail.ts";
import { sharedPaths } from "./paths.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel, type ResolvedChannel } from "./resolve.ts";

function toolsFor(channel: ResolvedChannel) {
  const tools = createDocumentTools({ channel, jail: { ...channel.jail, cwd: channel.paths.workspace }, currentUserId: () => "U1" });
  return {
    names: tools.map((tool) => tool.name),
    async call(name: string, params: unknown) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `missing tool ${name}`);
      const result = await tool.execute("test", params as never, undefined, undefined, undefined as never);
      return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    },
  };
}

for (const location of ["default", "absolute", "relative"] as const) {
  test(`${location} document library: resolve, file, find, update and remove in the selected directory`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "harness-document-paths-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "state");
    const oldLibrary = sharedPaths(dataDir).documents;
    const selected = location === "default" ? oldLibrary : join(root, "external", "library");
    const documentsDir = location === "default" ? undefined
      : location === "absolute" ? selected : relative(REPO_ROOT, selected);
    // A config outside the repo proves relative paths are not based on its directory.
    const configPath = join(root, "harness.yaml");
    writeFileSync(configPath, JSON.stringify({ dataDir, documentsDir }));
    const loaded = loadConfig(configPath);
    assert.equal(loaded.config.documentsDir, documentsDir);
    assert.equal(existsSync(selected), false, "loading config does not migrate or initialise storage");
    if (location !== "default") {
      mkdirSync(oldLibrary, { recursive: true });
      writeFileSync(join(oldLibrary, "sentinel.txt"), "leave the old library alone");
    }
    const registry = new ChannelRegistry(dataDir);
    const resolveFirst = () => resolveChannel(loaded.config, loaded.dataDir, { id: "C1", isDm: false }, registry).channel!;
    const cwd = process.cwd();
    let channel: ResolvedChannel;
    try {
      process.chdir(root);
      channel = resolveFirst();
    } finally { process.chdir(cwd); }
    assert.ok(channel);
    assert.equal(channel.shared.documents, selected);
    assert.ok(existsSync(selected), "channel resolution initialises the selected library");
    assert.equal(channel.shared.skills, sharedPaths(dataDir).skills);
    assert.equal(channel.paths.workspace, join(dataDir, "channels", "C1", "workspace"));

    // An arbitrary file is not automatically turned into a library entry.
    writeFileSync(join(selected, "unmanaged.md"), "not filed");
    assert.deepEqual(listDocuments(channel.shared), []);
    const source = join(channel.paths.workspace, "policy.md");
    const text = "Annual leave is four weeks, with manager approval required to carry over more than ten days.";
    writeFileSync(source, text);
    const filing = { path: source, title: "Leave policy", summary: text, category: "hr" };
    const tools = toolsFor(channel);
    assert.match(await tools.call("add_document", filing), /Filed/);
    const entryDir = join(selected, "leave-policy");
    assert.equal(readFileSync(join(entryDir, "original.md"), "utf8"), text);
    assert.match(readFileSync(join(entryDir, "text.md"), "utf8"), /four weeks/);
    const metadata = () => JSON.parse(readFileSync(join(entryDir, "document.json"), "utf8"));
    assert.equal(metadata().addedByChannelId, "C1");
    assert.match(readFileSync(join(selected, "INDEX.md"), "utf8"), /Leave policy/);
    assert.match(await tools.call("search_documents", { query: "leave" }), /leave-policy/);
    assert.match(await tools.call("list_documents", { category: "hr" }), /Leave policy/);
    assert.match(await tools.call("read_document", { id: "leave-policy" }), /four weeks/);
    await tools.call("add_document", { ...filing, summary: `${text} Reviewed this year.` });
    assert.equal(metadata().version, 2);

    const other = resolveChannel(loaded.config, dataDir, { id: "C2", isDm: false }, registry).channel!;
    assert.match(await toolsFor(other).call("read_document", { id: "leave-policy" }), /four weeks/);
    await assert.rejects(() => toolsFor(other).call("remove_document", { id: "leave-policy" }), /cannot remove/);
    assert.match(await tools.call("remove_document", { id: "leave-policy" }), /Removed/);
    assert.equal(existsSync(entryDir), false);
    assert.match(readFileSync(join(selected, "INDEX.md"), "utf8"), /Nothing filed/);
    assert.equal(readFileSync(join(selected, "unmanaged.md"), "utf8"), "not filed");
    if (location !== "default") {
      assert.equal(readFileSync(join(oldLibrary, "sentinel.txt"), "utf8"), "leave the old library alone");
      assert.equal(existsSync(join(oldLibrary, "INDEX.md")), false);
      assert.equal(existsSync(join(selected, "sentinel.txt")), false, "no silent migration");
    }
  });
}

test("custom document storage preserves sharing, jail and tool permissions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-document-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "state");
  const documentsDir = join(root, "external", "library");
  const config = parseConfigText(JSON.stringify({ documentsDir, channels: {
    C2: { share: { documents: false, documentsAdd: false } },
    C3: { share: { documents: true, documentsAdd: false } },
  } }));
  const registry = new ChannelRegistry(dataDir);
  const channel = (id: string) => resolveChannel(config, dataDir, { id, isDm: false }, registry).channel!;
  const reader = channel("C1");
  const privateChannel = channel("C2");
  const readOnly = channel("C3");
  const jail = (c: ResolvedChannel) => ({ ...c.jail, cwd: c.paths.workspace });
  const libraryFile = join(documentsDir, "unmanaged.md");
  writeFileSync(libraryFile, "not automatically indexed");
  const sibling = join(root, "external", "secret.md");
  writeFileSync(sibling, "not shared");
  symlinkSync(sibling, join(documentsDir, "escape.md"));
  assert.equal(checkPath(jail(reader), libraryFile, "read").allowed, true);
  assert.equal(checkPath(jail(reader), libraryFile, "write").allowed, false);
  for (const path of [sibling, join(documentsDir, "escape.md"), join(dataDir, "channels", "C2", "memory", "MEMORY.md")]) {
    assert.equal(checkPath(jail(reader), path, "read").allowed, false, path);
  }
  assert.equal(checkPath(jail(privateChannel), libraryFile, "read").allowed, false);
  assert.deepEqual(privateChannel.documents, { canRead: false, canAdd: false });
  assert.deepEqual(toolsFor(privateChannel).names, []);
  await assert.rejects(() => toolsFor(readOnly).call("add_document", {}), /cannot file documents/);
  assert.equal(toolsFor(readOnly).names.includes("read_document"), true);
  assert.equal(toolsFor(readOnly).names.includes("remove_document"), false);
  assert.equal(reader.containerMounts.some((mount) => mount.hostPath === documentsDir), false);
  // Filing still cannot use a source outside the channel's own allowed roots.
  await assert.rejects(() => toolsFor(reader).call("add_document", {
    path: sibling, title: "Secret", summary: "A long enough summary of a private file that must not be filed by this channel.", category: "private",
  }), /outside/);
});

test("documentsDir is optional but an explicit empty string is rejected", () => {
  assert.equal(parseConfigText("").documentsDir, undefined);
  assert.throws(() => parseConfigText('documentsDir: ""'), /documentsDir/);
});
