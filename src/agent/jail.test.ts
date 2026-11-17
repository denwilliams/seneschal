import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkPath, createJailExtension, type JailConfig } from "./jail.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jail-"));
  const workspace = join(root, "channels", "C1", "workspace");
  const memory = join(root, "channels", "C1", "memory");
  const knowledge = join(root, "shared", "knowledge");
  const otherChannel = join(root, "channels", "C2", "workspace");
  const project = join(root, "projects", "permitted");
  const unpermitted = join(root, "projects", "unpermitted");
  for (const d of [workspace, memory, knowledge, otherChannel, project, unpermitted]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(knowledge, "company.md"), "# Company");
  writeFileSync(join(otherChannel, "secret.txt"), "other channel data");
  writeFileSync(join(project, "README.md"), "permitted project");
  writeFileSync(join(unpermitted, "README.md"), "unpermitted project");

  const jail: JailConfig = {
    cwd: workspace,
    writeRoots: [workspace, memory],
    readRoots: [workspace, memory, knowledge],
  };
  return { root, workspace, memory, knowledge, otherChannel, project, unpermitted, jail };
}

test("allows writes inside the channel workspace", () => {
  const { jail } = fixture();
  assert.equal(checkPath(jail, "notes.md", "write").allowed, true);
  assert.equal(checkPath(jail, "./sub/dir/notes.md", "write").allowed, true);
});

test("blocks traversal out of the workspace", () => {
  const { jail } = fixture();
  assert.equal(checkPath(jail, "../../C2/workspace/secret.txt", "read").allowed, false);
  assert.equal(checkPath(jail, "../../../etc/passwd", "read").allowed, false);
});

test("blocks absolute paths to another channel", () => {
  const { jail, otherChannel } = fixture();
  const result = checkPath(jail, join(otherChannel, "secret.txt"), "read");
  assert.equal(result.allowed, false);
});

test("allows reading shared knowledge but not writing it", () => {
  const { jail, knowledge } = fixture();
  const target = join(knowledge, "company.md");
  assert.equal(checkPath(jail, target, "read").allowed, true);
  assert.equal(checkPath(jail, target, "write").allowed, false);
});

test("resolves symlinks before checking, so links cannot escape", () => {
  const { jail, workspace, otherChannel } = fixture();
  const link = join(workspace, "escape");
  symlinkSync(otherChannel, link);
  const result = checkPath(jail, join(link, "secret.txt"), "read");
  assert.equal(result.allowed, false, "symlink to another channel must be blocked");
});

test("blocks a symlinked parent directory even for a file that does not exist yet", () => {
  const { jail, workspace, otherChannel } = fixture();
  const link = join(workspace, "out");
  symlinkSync(otherChannel, link);
  const result = checkPath(jail, join(link, "new-file.txt"), "write");
  assert.equal(result.allowed, false);
});

test("writable roots are implicitly readable", () => {
  const { jail, memory } = fixture();
  assert.equal(checkPath(jail, join(memory, "MEMORY.md"), "read").allowed, true);
});

test("allows a configured target only through a workspace symlink", () => {
  const { jail, workspace, project } = fixture();
  const link = join(workspace, "project");
  symlinkSync(project, link);
  const configured: JailConfig = { ...jail, workspaceSymlinkRoots: [project] };

  assert.equal(checkPath(configured, join(link, "README.md"), "read").allowed, true);
  assert.equal(checkPath(configured, join(link, "new-file.txt"), "write").allowed, true);
  assert.equal(
    checkPath(configured, join(project, "README.md"), "read").allowed,
    false,
    "a target allowlist must not make its absolute path generally accessible",
  );
});

test("configured symlink targets do not permit other targets", () => {
  const { jail, workspace, project, unpermitted } = fixture();
  const permittedLink = join(workspace, "permitted");
  const unpermittedLink = join(workspace, "unpermitted");
  symlinkSync(project, permittedLink);
  symlinkSync(unpermitted, unpermittedLink);
  const configured: JailConfig = { ...jail, workspaceSymlinkRoots: [project] };

  assert.equal(checkPath(configured, join(permittedLink, "README.md"), "read").allowed, true);
  assert.equal(checkPath(configured, join(unpermittedLink, "README.md"), "read").allowed, false);
});

test("configured targets require the symlink to originate in the workspace", () => {
  const { jail, root, project } = fixture();
  const externalLink = join(root, "external-link");
  symlinkSync(project, externalLink);
  const configured: JailConfig = { ...jail, workspaceSymlinkRoots: [project] };

  assert.equal(checkPath(configured, join(externalLink, "README.md"), "read").allowed, false);
});


test("normalizes Pi path syntax before enforcing the jail", () => {
  const { jail, project } = fixture();

  for (const rawPath of [`@${project}/README.md`, `file://${project}/README.md`, "~/.ssh"]) {
    assert.equal(
      checkPath(jail, rawPath, "read").allowed,
      false,
      `${rawPath} must not be treated as a workspace-relative path`,
    );
  }
  assert.ok(homedir().startsWith("/"));
});

test("native tools receive the checked canonical path, not the symlink", () => {
  const { jail, workspace, project, unpermitted } = fixture();
  const link = join(workspace, "project");
  symlinkSync(project, link);
  const configured: JailConfig = { ...jail, workspaceSymlinkRoots: [project] };
  let handler: ((event: any) => unknown) | undefined;
  const extension = createJailExtension(configured);
  extension.factory({ on: (_event: string, callback: (event: any) => unknown) => (handler = callback) } as any);

  const event = { toolName: "read", input: { path: join(link, "README.md") } };
  assert.equal(handler!(event), undefined);
  assert.equal(event.input.path, realpathSync(join(project, "README.md")));

  // Retargeting the original link after authorization cannot redirect the
  // native operation, because its input now names the checked target.
  unlinkSync(link);
  symlinkSync(unpermitted, link);
  assert.equal(event.input.path, realpathSync(join(project, "README.md")));
});
