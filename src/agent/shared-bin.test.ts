import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSharedTools,
  publishSharedTool,
  readSharedToolEntry,
  readSharedToolSource,
  sharedToolPath,
  unpublishSharedTool,
} from "./shared-bin.ts";
import { ensureSharedDirs, type SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * The shared bin is where a channel's script becomes another channel's tool,
 * so the tests are mostly about the boundary of that crossing: only the
 * publisher can replace or remove what it published, a script has to look
 * like a script before it is accepted, and nothing here is copied — running
 * it always reads the live published file.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-shared-bin-"));
  const shared: SharedPaths = ensureSharedDirs(root);

  const channel = (id: string, name: string): ResolvedChannel =>
    ({ ref: { id, name, isDm: false }, shared }) as unknown as ResolvedChannel;

  return { root, shared, channel };
}

const SCRIPT = "#!/usr/bin/env bash\necho hello\n";

test("a channel publishes a script and it lands executable in the shared bin", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");

  const entry = publishSharedTool(shared, ops, {
    name: "deploy-notify",
    description: "Posts a deploy notice.",
    content: SCRIPT,
    note: "Assumes the release webhook is reachable.",
  });

  assert.equal(entry.version, 1);
  assert.equal(entry.publishedBy, "#ops");
  assert.equal(entry.publishedByChannelId, "C-OPS");
  assert.equal(entry.sha256.length, 64);

  const path = sharedToolPath(shared, "deploy-notify");
  assert.equal(readFileSync(path, "utf-8"), SCRIPT);
  assert.equal(statSync(path).mode & 0o111, 0o111, "the published script must be executable");

  assert.equal(listSharedTools(shared).length, 1);
});

test("only the publisher can replace or withdraw what it published", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const home = channel("C-HOME", "home");
  publishSharedTool(shared, ops, { name: "deploy-notify", description: "Posts a deploy notice.", content: SCRIPT });

  assert.throws(
    () =>
      publishSharedTool(shared, home, {
        name: "deploy-notify",
        description: "Something else.",
        content: SCRIPT,
      }),
    /Only the channel that published/,
  );
  assert.throws(() => unpublishSharedTool(shared, home, "deploy-notify"), /cannot withdraw it/);
});

test("republishing bumps the version, keeps the first publish date, and updates the hash", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const first = publishSharedTool(shared, ops, { name: "deploy-notify", description: "v1", content: SCRIPT });

  const updatedScript = "#!/usr/bin/env bash\necho hello again\n";
  const second = publishSharedTool(shared, ops, { name: "deploy-notify", description: "v2", content: updatedScript });

  assert.equal(second.version, 2);
  assert.equal(second.publishedAt, first.publishedAt);
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(readFileSync(sharedToolPath(shared, "deploy-notify"), "utf-8"), updatedScript);
});

test("a script without a shebang is refused", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");

  assert.throws(
    () => publishSharedTool(shared, ops, { name: "no-shebang", description: "x", content: "echo hi\n" }),
    /must start with a shebang/,
  );
});

test("an oversized script is refused", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  const huge = "#!/usr/bin/env bash\n" + "echo x\n".repeat(20_000);

  assert.throws(
    () => publishSharedTool(shared, ops, { name: "too-big", description: "x", content: huge }),
    /are at most .* bytes/,
  );
});

test("an invalid name is rejected before anything is written", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");

  assert.throws(
    () => publishSharedTool(shared, ops, { name: "Not Valid!", description: "x", content: SCRIPT }),
    /not a valid shared tool name/,
  );
  assert.equal(listSharedTools(shared).length, 0);
});

test("reading an unpublished name fails clearly", () => {
  const { shared } = setup();
  assert.throws(() => readSharedToolEntry(shared, "nothing-here"), /No shared tool called/);
});

test("withdrawing removes both the script and its metadata", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  publishSharedTool(shared, ops, { name: "deploy-notify", description: "x", content: SCRIPT });

  assert.equal(unpublishSharedTool(shared, ops, "deploy-notify"), true);
  assert.equal(existsSync(sharedToolPath(shared, "deploy-notify")), false);
  assert.equal(listSharedTools(shared).length, 0);
  assert.equal(unpublishSharedTool(shared, ops, "deploy-notify"), false);
});

test("reading source returns the live published file, not a snapshot", () => {
  const { shared, channel } = setup();
  const ops = channel("C-OPS", "ops");
  publishSharedTool(shared, ops, { name: "deploy-notify", description: "x", content: SCRIPT });

  const first = readSharedToolSource(shared, "deploy-notify");
  assert.equal(first.source, SCRIPT);

  const updated = "#!/usr/bin/env bash\necho updated\n";
  publishSharedTool(shared, ops, { name: "deploy-notify", description: "x", content: updated });

  const second = readSharedToolSource(shared, "deploy-notify");
  assert.equal(second.source, updated);
  assert.equal(second.entry.version, 2);
});
