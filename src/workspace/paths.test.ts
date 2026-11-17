import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelPaths, ensureChannelDirs } from "./paths.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "./registry.ts";
import { resolveChannel } from "./resolve.ts";

// No migration or cleanup: initialization only adds the missing directory.
for (const existing of [false, true]) {
  test(`initialization creates tmp for ${existing ? "an existing" : "a new"} workspace and is repeatable`, (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "workspace-tmp-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const paths = channelPaths(dataDir, "C1");
    const retained = join(paths.workspace, "report.md");
    const oldScratch = join(paths.workspace, "scratch.txt");
    const attachment = join(paths.attachmentText, "upload.txt");
    const artifact = join(paths.artifacts, "index.html");
    if (existing) {
      mkdirSync(paths.attachmentText, { recursive: true });
      mkdirSync(paths.artifacts, { recursive: true });
      for (const path of [retained, oldScratch, attachment, artifact]) writeFileSync(path, "keep unchanged");
    }

    assert.equal(existsSync(paths.tmp), false);
    const initialized = ensureChannelDirs(dataDir, "C1");
    assert.equal(initialized.tmp, join(paths.workspace, "tmp"));
    assert.ok(statSync(initialized.tmp).isDirectory());
    const scratch = join(initialized.tmp, "new-scratch.txt");
    writeFileSync(scratch, "keep until requested");
    assert.deepEqual(ensureChannelDirs(dataDir, "C1"), initialized);
    assert.equal(readFileSync(scratch, "utf8"), "keep until requested");
    if (existing) {
      for (const path of [retained, oldScratch, attachment, artifact]) assert.equal(readFileSync(path, "utf8"), "keep unchanged");
    }
  });
}

test("opening an existing channel recreates a missing workspace tmp directory", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "resolve-tmp-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = HarnessConfigSchema.parse({});
  const registry = new ChannelRegistry(dataDir);
  const ref = { id: "C1", name: "eng", isDm: false };
  const first = resolveChannel(config, dataDir, ref, registry).channel!;
  assert.ok(statSync(first.paths.tmp).isDirectory());
  rmSync(first.paths.tmp, { recursive: true });
  const reopened = resolveChannel(config, dataDir, ref, registry).channel!;
  assert.ok(statSync(reopened.paths.tmp).isDirectory());
});
