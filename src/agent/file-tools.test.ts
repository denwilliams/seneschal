import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTools, type FileUploader } from "./file-tools.ts";

/**
 * The upload path is the one place a channel can hand a file to Slack, so what
 * these protect is mostly the jail: an unchecked path here is a way to read
 * another channel's memory and publish it into this one.
 */

interface Recorded {
  calls: Parameters<FileUploader["upload"]>[0][];
}

function setup(opts: { withThread?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-upload-"));
  const workspace = join(root, "workspace");
  const otherChannel = join(root, "other-channel");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(otherChannel, { recursive: true });
  writeFileSync(join(otherChannel, "MEMORY.md"), "another channel's secrets");

  const recorded: Recorded = { calls: [] };
  const uploader: FileUploader = {
    upload: async (input) => {
      recorded.calls.push(input);
      return { permalink: "https://slack.example/files/1" };
    },
  };

  const [tool] = createFileTools({
    uploader,
    channelId: "C1",
    channelLabel: "#ops",
    currentThreadTs: () => (opts.withThread === false ? undefined : "1700.0001"),
    jail: { readRoots: [workspace], writeRoots: [workspace], cwd: workspace },
  });

  return { root, workspace, otherChannel, recorded, tool: tool as any };
}

test("attaches a file from the workspace, in the current thread", async () => {
  const { workspace, recorded, tool } = setup();
  writeFileSync(join(workspace, "chart.png"), "not really a png, but bytes");

  const result = await tool.execute("id", { path: "chart.png", comment: "p99 by hour" });

  assert.equal(recorded.calls.length, 1);
  const call = recorded.calls[0]!;
  assert.equal(call.channelId, "C1");
  assert.equal(call.filename, "chart.png");
  assert.equal(call.comment, "p99 by hour");
  assert.equal(call.threadTs, "1700.0001", "answering someone means attaching in their thread");
  assert.match(result.content[0].text, /Attached chart\.png/);
  assert.match(result.content[0].text, /visible in the channel/, "a png previews inline");
});

test("to_channel attaches at channel level instead of in the thread", async () => {
  const { workspace, recorded, tool } = setup();
  writeFileSync(join(workspace, "weekly.png"), "bytes");

  await tool.execute("id", { path: "weekly.png", to_channel: true });

  assert.equal(recorded.calls[0]!.threadTs, undefined, "publishing is not a thread reply");
});

test("a file outside the channel's roots is refused", async () => {
  const { otherChannel, recorded, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { path: join(otherChannel, "MEMORY.md") }),
    /isolated|outside/i,
  );
  assert.equal(recorded.calls.length, 0, "nothing may reach Slack after a jail refusal");
});

test("a symlink out of the workspace is refused", async () => {
  const { workspace, otherChannel, recorded, tool } = setup();
  symlinkSync(join(otherChannel, "MEMORY.md"), join(workspace, "innocent.md"));

  await assert.rejects(() => tool.execute("id", { path: "innocent.md" }), /isolated|outside/i);
  assert.equal(recorded.calls.length, 0, "a planted symlink must not become an upload");
});

test("traversal out of the workspace is refused", async () => {
  const { recorded, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { path: "../other-channel/MEMORY.md" }),
    /isolated|outside/i,
  );
  assert.equal(recorded.calls.length, 0);
});

test("a missing file is an error the agent can act on", async () => {
  const { tool } = setup();

  await assert.rejects(() => tool.execute("id", { path: "nope.png" }), /no file at nope\.png/i);
});

test("a directory is not a file", async () => {
  const { workspace, tool } = setup();
  mkdirSync(join(workspace, "reports"));

  await assert.rejects(() => tool.execute("id", { path: "reports" }), /is a directory/i);
});

test("an empty file is refused rather than posted", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "empty.csv"), "");

  await assert.rejects(() => tool.execute("id", { path: "empty.csv" }), /empty/i);
});

test("an oversized file is refused with its size named", async () => {
  const { workspace, recorded, tool } = setup();
  writeFileSync(join(workspace, "huge.bin"), Buffer.alloc(21 * 1024 * 1024));

  await assert.rejects(() => tool.execute("id", { path: "huge.bin" }), /21\.0MB.*20\.0MB/s);
  assert.equal(recorded.calls.length, 0, "the cap exists to keep it off the uplink");
});

test("a non-previewing type is described honestly", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "report.pdf"), "%PDF-1.4 ...");

  const result = await tool.execute("id", { path: "report.pdf" });

  assert.match(result.content[0].text, /file people can open/, "only images preview inline");
});

test("title and alt text are passed through when given", async () => {
  const { workspace, recorded, tool } = setup();
  writeFileSync(join(workspace, "latency.png"), "bytes");

  await tool.execute("id", {
    path: "latency.png",
    title: "Checkout latency",
    alt_text: "Line chart rising sharply after 09:00",
  });

  assert.equal(recorded.calls[0]!.title, "Checkout latency");
  assert.match(recorded.calls[0]!.altText!, /Line chart/);
});

test("an empty path is rejected before anything touches the filesystem", async () => {
  const { tool } = setup();

  await assert.rejects(() => tool.execute("id", { path: "   " }), /needs the path/i);
});
