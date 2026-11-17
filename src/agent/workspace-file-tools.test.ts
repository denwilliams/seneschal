import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceFileTools } from "./workspace-file-tools.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-workspace-file-ops-"));
  const workspace = join(root, "workspace");
  const memory = join(root, "memory");
  const otherChannel = join(root, "other-channel");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(memory, { recursive: true });
  mkdirSync(otherChannel, { recursive: true });
  writeFileSync(join(memory, "MEMORY.md"), "notes");
  writeFileSync(join(otherChannel, "secret.txt"), "another channel");

  const [tool] = createWorkspaceFileTools({
    jail: { readRoots: [workspace], writeRoots: [workspace, memory], cwd: workspace },
  });

  return { root, workspace, memory, otherChannel, tool: tool as any };
}

test("creates nested workspace directories", async () => {
  const { workspace, tool } = setup();

  const result = await tool.execute("id", { operation: "mkdir", path: "FY26/receipts" });

  assert.ok(existsSync(join(workspace, "FY26", "receipts")));
  assert.match(result.content[0].text, /Created directory FY26\/receipts/);
});

test("moves a file and creates destination parents by default", async () => {
  const { workspace, tool } = setup();
  mkdirSync(join(workspace, "attachments"));
  writeFileSync(join(workspace, "attachments", "invoice.pdf"), "pdf");

  const result = await tool.execute("id", {
    operation: "move",
    path: "attachments/invoice.pdf",
    to_path: "FY26/receipts/invoice.pdf",
  });

  assert.equal(existsSync(join(workspace, "attachments", "invoice.pdf")), false);
  assert.equal(readFileSync(join(workspace, "FY26", "receipts", "invoice.pdf"), "utf8"), "pdf");
  assert.match(result.content[0].text, /Moved attachments\/invoice\.pdf to FY26\/receipts\/invoice\.pdf/);
});

test("rename is an alias for moving to a new path", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "draft.txt"), "draft");

  await tool.execute("id", { operation: "rename", path: "draft.txt", to_path: "final.txt" });

  assert.equal(existsSync(join(workspace, "draft.txt")), false);
  assert.equal(readFileSync(join(workspace, "final.txt"), "utf8"), "draft");
});

test("copies a file without removing the source", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "source.txt"), "copy me");

  const result = await tool.execute("id", { operation: "copy", path: "source.txt", to_path: "copies/source.txt" });

  assert.equal(readFileSync(join(workspace, "source.txt"), "utf8"), "copy me");
  assert.equal(readFileSync(join(workspace, "copies", "source.txt"), "utf8"), "copy me");
  assert.match(result.content[0].text, /Copied source\.txt to copies\/source\.txt/);
});

test("refuses to overwrite an existing destination unless asked", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "new.txt"), "new");
  writeFileSync(join(workspace, "old.txt"), "old");

  await assert.rejects(
    () => tool.execute("id", { operation: "move", path: "new.txt", to_path: "old.txt" }),
    /already exists/i,
  );

  await tool.execute("id", { operation: "move", path: "new.txt", to_path: "old.txt", overwrite: true });
  assert.equal(readFileSync(join(workspace, "old.txt"), "utf8"), "new");
});

test("deletes a file", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "old.txt"), "old");

  const result = await tool.execute("id", { operation: "delete", path: "old.txt" });

  assert.equal(existsSync(join(workspace, "old.txt")), false);
  assert.match(result.content[0].text, /Deleted file old\.txt/);
});

test("requires recursive true to delete a directory", async () => {
  const { workspace, tool } = setup();
  mkdirSync(join(workspace, "old"));
  writeFileSync(join(workspace, "old", "file.txt"), "old");

  await assert.rejects(
    () => tool.execute("id", { operation: "delete", path: "old" }),
    /recursive: true/i,
  );

  await tool.execute("id", { operation: "delete", path: "old", recursive: true });
  assert.equal(existsSync(join(workspace, "old")), false);
});

test("requires recursive true to copy a directory", async () => {
  const { workspace, tool } = setup();
  mkdirSync(join(workspace, "dir"));
  writeFileSync(join(workspace, "dir", "file.txt"), "contents");

  await assert.rejects(
    () => tool.execute("id", { operation: "copy", path: "dir", to_path: "dir-copy" }),
    /recursive: true/i,
  );

  await tool.execute("id", { operation: "copy", path: "dir", to_path: "dir-copy", recursive: true });
  assert.equal(readFileSync(join(workspace, "dir-copy", "file.txt"), "utf8"), "contents");
});

test("blocks traversal out of the workspace even when the target is otherwise writable", async () => {
  const { memory, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { operation: "delete", path: "../memory/MEMORY.md" }),
    /not inside this channel's workspace/i,
  );
  assert.equal(readFileSync(join(memory, "MEMORY.md"), "utf8"), "notes");
});

test("blocks files from another channel", async () => {
  const { otherChannel, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { operation: "copy", path: join(otherChannel, "secret.txt"), to_path: "secret.txt" }),
    /outside|isolated/i,
  );
});

test("blocks symlinks that leave the workspace", async () => {
  const { workspace, otherChannel, tool } = setup();
  symlinkSync(join(otherChannel, "secret.txt"), join(workspace, "shortcut.txt"));

  await assert.rejects(
    () => tool.execute("id", { operation: "copy", path: "shortcut.txt", to_path: "copy.txt" }),
    /outside|isolated/i,
  );
});

test("refuses to delete the workspace root", async () => {
  const { workspace, tool } = setup();

  await assert.rejects(
    () => tool.execute("id", { operation: "delete", path: workspace, recursive: true }),
    /workspace root/i,
  );
});

test("requires destination for operations that need one", async () => {
  const { workspace, tool } = setup();
  writeFileSync(join(workspace, "file.txt"), "x");

  await assert.rejects(() => tool.execute("id", { operation: "move", path: "file.txt" }), /to_path/i);
});
