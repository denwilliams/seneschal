import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync, statSync, renameSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSaveToolOutputTool, withToolOutputSource } from "./tool-output.ts";
import type { JailConfig } from "./jail.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "tool-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const other = join(root, "other-channel");
  mkdirSync(workspace);
  mkdirSync(other);
  const jail: JailConfig = { cwd: workspace, readRoots: [workspace], writeRoots: [workspace, other], workspaceSymlinkRoots: [other] };
  const save = (tools: ToolDefinition[]) => createSaveToolOutputTool({ tools, jail });
  const invoke = async (tool: ToolDefinition, name: string, path = "result.json", args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await tool.execute("call-id", { tool: name, arguments: args, path }, signal, undefined, {} as never);
    assert.equal(result.content[0]?.type, "text");
    return { result, status: JSON.parse((result.content[0] as { text: string }).text) };
  };
  return { root, workspace, other, jail, save, invoke, read: (path = "result.json") => JSON.parse(readFileSync(join(workspace, path), "utf8")) };
}

const dummy = (execute: ToolDefinition["execute"]): ToolDefinition => defineTool({
  name: "example", label: "Example", description: "Example", parameters: Type.Object({}), execute,
}) as ToolDefinition;

test("real built-in read saves exact returned content/details before conversation handling", async (t) => {
  const f = fixture(t);
  const text = "Original unicode: café 🦊\n" + "one long line\n".repeat(3000);
  writeFileSync(join(f.workspace, "input.txt"), text);
  const builtin = createReadToolDefinition(f.workspace) as ToolDefinition;
  const expected = await builtin.execute("expected", { path: "input.txt" }, undefined, undefined, {} as never);
  const { result, status } = await f.invoke(f.save([builtin]), "read", "exports/read.json", { path: "input.txt" });
  assert.ok(!result.isError);
  assert.equal(status.saved, true);
  assert.equal(status.path, "exports/read.json");
  const saved = f.read(status.path);
  assert.deepEqual(saved.result, JSON.parse(JSON.stringify(expected)));
  assert.equal(saved.representation, "pi");
  assert.equal(saved.result.details.truncation.truncated, true);
  assert.equal(saved.completeness.status, "reported_incomplete");
  assert.match(status.completeness.warning, /truncation, pagination/);
  assert.ok(!JSON.stringify(result).includes("Original unicode"), "only a receipt reaches the conversation");
  assert.equal(status.bytes, statSync(join(f.workspace, status.path)).size);
  assert.equal(statSync(join(f.workspace, status.path)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(f.workspace, "exports")), ["read.json"]);
});

test("large mixed results preserve text, structured content, images and metadata without recopying", async (t) => {
  const f = fixture(t);
  const response = {
    content: [{ type: "text" as const, text: "x".repeat(200_000) }, { type: "image" as const, mimeType: "image/png", data: "AAEC" }],
    structuredContent: { rows: [{ value: 3, label: "原文" }], nextCursor: "page-2" },
    details: { partial: true, untouched: [null, false, 0] },
  };
  const { status } = await f.invoke(f.save([dummy(async () => response)]), "example");
  assert.equal(status.saved, true);
  assert.deepEqual(f.read().result, response);
  assert.match(status.completeness.warning, /not a verified complete upstream export/);
});

test("MCP source retention does not expose transport-only data in normal results", async (t) => {
  const f = fixture(t);
  const raw = { content: [{ type: "resource", resource: { uri: "test://raw", blob: "AAEC", mimeType: "application/octet-stream" } }], structuredContent: { rows: [1, 2] }, _meta: { nextCursor: "more" } };
  const normal = withToolOutputSource({ content: [{ type: "text" as const, text: "display only" }], details: {} }, raw);
  assert.ok(!JSON.stringify(normal).includes("test://raw"));
  const { status } = await f.invoke(f.save([dummy(async () => normal)]), "example");
  assert.equal(status.saved, true);
  assert.equal(f.read().representation, "mcp");
  assert.deepEqual(f.read().result, raw);
});

test("only bound tools can be invoked, and the dispatcher cannot invoke itself", async (t) => {
  const f = fixture(t);
  const tools = [dummy(async () => { throw new Error("must not run"); })];
  const save = f.save(tools);
  tools.push(save);
  for (const name of ["not_authorized", "other_connector__export", "save_tool_output"]) {
    const { result, status } = await f.invoke(save, name);
    assert.equal(result.isError, true);
    assert.equal(status.saved, false);
    assert.equal(status.toolExecuted, false);
    assert.match(status.error, /not available/);
  }
  assert.deepEqual(readdirSync(f.workspace), []);
});

test("target schema, argument preparation and execution context are preserved", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const controller = new AbortController();
  const tool = defineTool({
    name: "number", label: "Number", description: "Number", parameters: Type.Object({ n: Type.Number() }),
    prepareArguments: (args: any) => ({ n: args.alias }),
    execute: async (id, args, signal, progress, context) => {
      calls++;
      assert.equal(id, "call-id");
      assert.equal(signal, controller.signal);
      assert.equal(progress, undefined);
      assert.ok(context);
      return { content: [{ type: "text", text: String(args.n) }], details: {} };
    },
  });
  const save = f.save([tool as ToolDefinition]);
  const bad = await f.invoke(save, "number", "bad.json", { alias: "not-a-number" });
  assert.equal(bad.status.toolExecuted, false);
  assert.equal(calls, 0);
  const good = await f.invoke(save, "number", "good.json", { alias: 42 }, controller.signal);
  assert.equal(good.status.saved, true);
  assert.equal(calls, 1);
  assert.equal(f.read("good.json").result.content[0].text, "42");
});

test("nested built-in paths still enforce the native tool jail", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.other, "private.txt"), "secret");
  // Even though the ordinary fixture permits other as a write root, remove that
  // permission here to test the target tool's jail rather than the save jail.
  f.jail.writeRoots = [f.workspace];
  const read = createReadToolDefinition(f.workspace) as ToolDefinition;
  const { result, status } = await f.invoke(f.save([read]), "read", "private.json", { path: join(f.other, "private.txt") });
  assert.equal(result.isError, true);
  assert.equal(status.toolExecuted, false);
  assert.match(status.error, /outside/);
  assert.ok(!existsSync(join(f.workspace, "private.json")));
});

test("output paths cannot escape via traversal, shared roots, aliases, or allowed external symlinks", async (t) => {
  const f = fixture(t);
  symlinkSync(f.other, join(f.workspace, "shared"));
  symlinkSync(join(f.other, "missing.json"), join(f.workspace, "dangling.json"));
  f.jail.pathAliases = [{ from: "/elsewhere", to: f.other }, { from: "/workspace", to: f.workspace }];
  let calls = 0;
  const save = f.save([dummy(async () => { calls++; return { content: [], details: {} }; })]);
  for (const path of ["../other-channel/leak.json", join(f.other, "leak.json"), "shared/leak.json", "shared/new/deep.json", "dangling.json", "/elsewhere/leak.json", ".", " "]) {
    const { result, status } = await f.invoke(save, "example", path);
    assert.equal(result.isError, true, path);
    assert.equal(status.saved, false, path);
    assert.equal(status.toolExecuted, false, path);
  }
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(f.other), []);
  const good = await f.invoke(save, "example", "/workspace/allowed.json");
  assert.equal(good.status.path, "allowed.json");
});

test("failures before invocation do not overwrite files or run a mutation", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "existing.json"), "keep");
  let calls = 0;
  const save = f.save([dummy(async () => { calls++; return { content: [], details: {} }; })]);
  for (const path of ["existing.json", "existing.json/sub/file.json"]) {
    const { status } = await f.invoke(save, "example", path);
    assert.equal(status.saved, false);
    assert.equal(status.toolExecuted, false);
  }
  const aborted = new AbortController();
  aborted.abort();
  const { status } = await f.invoke(save, "example", "aborted.json", {}, aborted.signal);
  assert.equal(status.toolExecuted, false);
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(f.workspace, "existing.json"), "utf8"), "keep");
  assert.deepEqual(readdirSync(f.workspace), ["existing.json"]);
});

test("thrown tool failures, returned errors and serialization failures are explicit", async (t) => {
  const f = fixture(t);
  const thrown = await f.invoke(f.save([dummy(async () => { throw new Error("provider refused"); })]), "example");
  assert.equal(thrown.status.saved, false);
  assert.equal(thrown.status.toolExecuted, true);
  assert.match(thrown.status.error, /provider refused/);
  const returned = await f.invoke(f.save([dummy(async () => ({ isError: true, content: [{ type: "text", text: "failed" }], details: { code: 5 } }))]), "example");
  assert.equal(returned.result.isError, true);
  assert.equal(returned.status.saved, true);
  assert.equal(returned.status.toolSucceeded, false);
  assert.equal(f.read().result.isError, true);
  for (const details of [NaN, Infinity, 1n, () => 1, Symbol("unsupported")]) {
    const failed = await f.invoke(f.save([dummy(async () => ({ content: [], details }))]), "example", "bad.json");
    assert.equal(failed.status.saved, false);
    assert.equal(failed.status.toolExecuted, true);
    assert.equal(failed.status.toolSucceeded, true);
    assert.match(failed.status.error, /cannot be represented/);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const failedCycle = await f.invoke(f.save([dummy(async () => ({ content: [], details: cyclic }))]), "example", "cycle.json");
  assert.equal(failedCycle.status.saved, false);
  assert.equal(failedCycle.status.toolExecuted, true);
  assert.match(failedCycle.status.error, /circular/i);
  assert.deepEqual(readdirSync(f.workspace), ["result.json"]);
});

test("a destination created by the target is not overwritten after execution", async (t) => {
  const f = fixture(t);
  const save = f.save([dummy(async () => {
    writeFileSync(join(f.workspace, "result.json"), "keep the raced-in file");
    return { content: [], details: {} };
  })]);
  const { status } = await f.invoke(save, "example");
  assert.equal(status.saved, false);
  assert.equal(status.toolExecuted, true);
  assert.equal(readFileSync(join(f.workspace, "result.json"), "utf8"), "keep the raced-in file");
  assert.deepEqual(readdirSync(f.workspace), ["result.json"]);
});

test("a destination parent retargeted by the tool is rejected before publishing", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "out"));
  const save = f.save([dummy(async () => {
    renameSync(join(f.workspace, "out"), join(f.workspace, "moved"));
    symlinkSync(f.other, join(f.workspace, "out"));
    return { content: [], details: {} };
  })]);
  const { status } = await f.invoke(save, "example", "out/result.json");
  assert.equal(status.saved, false);
  assert.equal(status.toolExecuted, true);
  assert.deepEqual(readdirSync(f.other), []);
  assert.deepEqual(readdirSync(join(f.workspace, "moved")), []);
});

test("a real observer replacing the parent during root staging never receives the private export", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "exports"));
  let replaced = false;
  const watcher = watch(f.workspace, (_event, name) => {
    if (replaced || !name?.toString().startsWith(".tool-output-")) return;
    replaced = true;
    renameSync(join(f.workspace, "exports"), join(f.workspace, "moved"));
    symlinkSync(f.other, join(f.workspace, "exports"));
  });
  t.after(() => watcher.close());
  const privateText = "private output".repeat(1_000_000);
  const { status } = await f.invoke(f.save([dummy(async () => ({ content: [{ type: "text", text: privateText }], details: {} }))]), "example", "exports/result.json");
  assert.equal(replaced, true, "observer must actually attempt the staging race");
  assert.deepEqual(readdirSync(f.other), []);
  assert.ok(!readdirSync(f.workspace).some((name) => name.startsWith(".tool-output-")));
  // If publication beat the observer, it must still be in the original inode,
  // never under the external symlink. Otherwise report post-invocation failure.
  if (status.saved) {
    assert.equal(JSON.parse(readFileSync(join(f.workspace, "moved/result.json"), "utf8")).result.content[0].text, privateText);
  } else {
    assert.equal(status.toolExecuted, true);
    assert.equal(status.toolSucceeded, true);
    assert.deepEqual(readdirSync(join(f.workspace, "moved")), []);
  }
});

test("workspace replacement by a tool fails with explicit post-invocation status", async (t) => {
  const f = fixture(t);
  const save = f.save([dummy(async () => {
    renameSync(f.workspace, join(f.root, "original-workspace"));
    symlinkSync(f.other, f.workspace);
    return { content: [{ type: "text", text: "private" }], details: {} };
  })]);
  const { status } = await f.invoke(save, "example");
  assert.equal(status.saved, false);
  assert.equal(status.toolExecuted, true);
  assert.equal(status.toolSucceeded, true);
  assert.deepEqual(readdirSync(f.other), []);
  assert.deepEqual(readdirSync(join(f.root, "original-workspace")), []);
});
