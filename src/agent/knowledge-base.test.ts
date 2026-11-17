import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeBaseError,
  listDirectory,
  listPages,
  listTree,
  openKnowledgeBase,
  readPage,
  resolveInside,
  searchKnowledgeBase,
} from "./knowledge-base.ts";

function wiki() {
  const outside = mkdtempSync(join(tmpdir(), "kb-outside-"));
  writeFileSync(join(outside, "secret.md"), "top secret\n");
  const dir = mkdtempSync(join(tmpdir(), "kb-"));
  const files: Record<string, string> = {
    "index.md": "# Handbook\n\n- [[Billing]]\n- [Refunds](topics/refunds.md)\n- [[people/Ada Lovelace|Ada]]\n- [web](https://example.com/x.md)\n- ![[diagram.png]]\n",
    "topics/billing.md": "---\ntitle: Billing overview\n---\nInvoices go out on the 1st.\nRefunds are described in [[refunds]].\n",
    "topics/refunds.md": "# Refunds\n\nA refund takes 5 business days.\nSee [back](../index.md#top).\n",
    "people/Ada Lovelace.md": "# Ada Lovelace\n\nOwns the billing system.\n",
    ".obsidian/workspace.json": "{}",
    "notes.txt": "plain text note about invoices\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(join(dir, "blob.md"), Buffer.from([0x61, 0x00, 0x62]));
  symlinkSync(outside, join(dir, "escape"));
  symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"));
  const kb = openKnowledgeBase("handbook", { path: dir, index: "index.md" }, "/", "test")!;
  return { dir, outside, kb };
}

test("an unreadable knowledge base folder is skipped, not fatal", () => {
  assert.equal(openKnowledgeBase("x", { path: "/definitely/not/here", index: "index.md" }, "/", "test"), undefined);
  assert.equal(openKnowledgeBase("x", { path: tmpdir(), index: "../up.md" }, "/", "test"), undefined);
});

test("reading the index returns the text and the pages it links to", () => {
  const { kb } = wiki();
  const page = readPage(kb, undefined);
  assert.equal(page.path, "index.md");
  assert.match(page.text, /# Handbook/);
  // [[Billing]] resolves by file name, [[a/b|alias]] by path, a markdown link relative to the page. Web links and embeds are not pages.
  assert.deepEqual(page.links.sort(), ["people/Ada Lovelace.md", "topics/billing.md", "topics/refunds.md"]);
  assert.equal(page.nextOffset, undefined);
});

test("links resolve relative to the page that contains them", () => {
  const { kb } = wiki();
  assert.deepEqual(readPage(kb, "topics/refunds.md").links, ["index.md"]);
  assert.deepEqual(readPage(kb, "topics/billing.md").links, ["topics/refunds.md"]);
});

test("a long page is read a part at a time", () => {
  const { kb } = wiki();
  const first = readPage(kb, "index.md", 0, 10);
  assert.equal(first.text.length, 10);
  assert.equal(first.nextOffset, 10);
  const rest = readPage(kb, "index.md", first.nextOffset, 100_000);
  assert.equal(first.text + rest.text, readPage(kb, "index.md").text);
  assert.equal(rest.nextOffset, undefined);
});

test("paths cannot leave the knowledge base, however they are spelled", () => {
  const { kb, outside } = wiki();
  for (const bad of ["../x.md", "topics/../../x.md", "/etc/passwd", `${outside}/secret.md`, "..", "C:\\Windows\\win.ini", "topics\\..\\..\\x"]) {
    assert.throws(() => resolveInside(kb, bad), KnowledgeBaseError, bad);
  }
  // A symlink inside the wiki that points outside is a dead end, for files and folders alike.
  assert.throws(() => readPage(kb, "leak.md"), /outside/);
  assert.throws(() => readPage(kb, "escape/secret.md"), /outside/);
  assert.throws(() => listDirectory(kb, "escape"), /outside/);
});

test("hidden files and folders are not part of the wiki", () => {
  const { kb } = wiki();
  assert.throws(() => readPage(kb, ".obsidian/workspace.json"), /hidden/);
  assert.throws(() => listDirectory(kb, ".obsidian"), /hidden/);
  assert.ok(!listDirectory(kb, ".").entries.some((e) => e.name.startsWith(".")));
  assert.ok(!listPages(kb).some((p) => p.startsWith(".")));
});

test("listing shows folders first, and leaves out links that point outside", () => {
  const { kb } = wiki();
  const { entries } = listDirectory(kb, ".");
  assert.deepEqual(entries.filter((e) => e.kind === "directory").map((e) => e.name), ["people", "topics"]);
  assert.ok(!entries.some((e) => e.name === "escape" || e.name === "leak.md"));
  assert.throws(() => listDirectory(kb, "index.md"), /file, not a folder/);
});

test("binary files and folders are refused with a message that says what to do", () => {
  const { kb } = wiki();
  assert.throws(() => readPage(kb, "blob.md"), /not a text file/);
  assert.throws(() => readPage(kb, "topics"), /kb_ls/);
  assert.throws(() => readPage(kb, "missing.md"), /nothing at/);
});

test("search ranks pages with every term first and weights titles and paths", () => {
  const { kb } = wiki();
  const hits = searchKnowledgeBase(kb, "billing refunds");
  // Only billing.md has both terms in its content (refunds.md has 'refund' text but not 'billing').
  assert.equal(hits[0]!.path, "topics/billing.md");
  assert.equal(hits[0]!.title, "Billing overview");
  assert.ok(hits[0]!.snippets.some((s) => s.includes("Refunds are described")));
  assert.deepEqual(searchKnowledgeBase(kb, "nonexistentterm"), []);
  assert.deepEqual(searchKnowledgeBase(kb, ""), []);
});

test("search matches quoted phrases, text files, and can be limited to a folder", () => {
  const { kb } = wiki();
  assert.deepEqual(searchKnowledgeBase(kb, '"business days"').map((h) => h.path), ["topics/refunds.md"]);
  assert.ok(searchKnowledgeBase(kb, "invoices").some((h) => h.path === "notes.txt"));
  assert.deepEqual(searchKnowledgeBase(kb, "billing", { under: "people" }).map((h) => h.path), ["people/Ada Lovelace.md"]);
  assert.equal(searchKnowledgeBase(kb, "billing", { limit: 1 }).length, 1);
});

test("search never reads through a link out of the wiki", () => {
  const { kb } = wiki();
  assert.deepEqual(searchKnowledgeBase(kb, "secret"), []);
});

test("a recursive listing stops at its limit, and does not follow links out of the wiki or into themselves", () => {
  const { kb } = wiki();
  const all = listTree(kb, ".");
  assert.ok(all.entries.some((e) => e.path === "topics/billing.md"));
  assert.ok(!all.entries.some((e) => e.path.startsWith("escape") || e.path === "leak.md"));
  assert.equal(all.truncated, false);
  const capped = listTree(kb, ".", 3);
  assert.equal(capped.entries.length, 3);
  assert.equal(capped.truncated, true);
  assert.throws(() => listTree(kb, "../"), /outside/);
});
