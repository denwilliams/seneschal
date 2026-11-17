import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDocument,
  describeDocument,
  listCategories,
  listDocuments,
  readDocumentPage,
  removeDocument,
  searchDocuments,
  slugify,
} from "./documents.ts";
import { sharedPaths, type SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";

/**
 * The library is account-wide, so these tests are mostly about the two things
 * that makes true: a document filed in one channel is found from another, and
 * a channel can only change what it filed itself.
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-documents-"));
  const shared: SharedPaths = sharedPaths(root);
  mkdirSync(shared.documents, { recursive: true });

  const channel = (id: string, name: string) =>
    ({ ref: { id, name, isDm: false }, shared }) as unknown as ResolvedChannel;

  const file = (name: string, content: string) => {
    const dir = join(root, "incoming");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  return { root, shared, channel, file };
}

const LEAVE_POLICY = [
  "# Leave policy",
  "",
  "Everyone gets four weeks of annual leave a year, accruing monthly.",
  "Carrying more than ten days into the next year needs a manager's approval.",
  "Sick leave is ten days a year and does not accrue.",
].join("\n");

function filing(over: Partial<Parameters<typeof addDocument>[2]> = {}) {
  return {
    title: "Leave policy 2026",
    summary:
      "The company leave policy for 2026: four weeks annual leave accruing monthly, ten days of sick leave, and the rules for carrying leave over.",
    category: "hr",
    tags: ["leave", "policy"],
    ...over,
  } as Parameters<typeof addDocument>[2];
}

test("a document is filed with the metadata the agent supplied and the facts the harness derived", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  const path = file("leave.md", LEAVE_POLICY);

  const { entry } = await addDocument(shared, hr, { ...filing(), path, addedByUser: "U1" });

  assert.equal(entry.id, "leave-policy-2026");
  assert.equal(entry.category, "hr");
  assert.deepEqual(entry.tags, ["leave", "policy"]);
  // Derived here, not taken from the caller.
  assert.equal(entry.filename, "leave.md");
  assert.equal(entry.bytes, Buffer.byteLength(LEAVE_POLICY));
  assert.equal(entry.extractedVia, "text");
  assert.equal(entry.addedBy, "#hr");
  assert.equal(entry.addedByChannelId, "C-HR");
  assert.equal(entry.addedByUser, "U1");
  assert.equal(entry.version, 1);
  assert.match(entry.checksum, /^[0-9a-f]{64}$/);

  // Both the text and the file as attached.
  const dir = join(shared.documents, entry.id);
  assert.match(readFileSync(join(dir, "text.md"), "utf-8"), /four weeks of annual leave/);
  assert.equal(readFileSync(join(dir, "original.md"), "utf-8"), LEAVE_POLICY);
});

test("a thin summary is refused, because the summary is the index", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  const path = file("leave.md", LEAVE_POLICY);

  await assert.rejects(
    addDocument(shared, hr, { ...filing({ summary: "A policy." }), path }),
    /what somebody reads instead of the document/,
  );
  await assert.rejects(
    addDocument(shared, hr, { ...filing({ category: "!!!" }), path }),
    /needs a category/,
  );
  assert.equal(listDocuments(shared).length, 0);
});

test("one channel files a document and another finds it", async () => {
  const { shared, channel, file } = setup();
  await addDocument(shared, channel("C-HR", "hr"), { ...filing(), path: file("leave.md", LEAVE_POLICY) });

  const hits = searchDocuments(shared, "how much annual leave do we get");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.entry.id, "leave-policy-2026");
  assert.match(hits[0]!.snippet ?? "", /annual leave/);

  // Filed in #hr, found from #engineering: the shelf is the account's.
  const fromElsewhere = searchDocuments(shared, "leave");
  assert.equal(fromElsewhere[0]?.entry.addedBy, "#hr");
});

test("search ranks a title match above a passing mention in the body", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  await addDocument(shared, hr, { ...filing(), path: file("leave.md", LEAVE_POLICY) });
  await addDocument(shared, hr, {
    ...filing({
      title: "Office move",
      summary: "Plan for the move to the new office in March, including the packing schedule and who is doing what.",
      category: "operations",
      tags: [],
    }),
    path: file("move.md", "The move happens in March. Nobody should book leave that week."),
  });

  const hits = searchDocuments(shared, "leave policy");
  assert.equal(hits[0]!.entry.id, "leave-policy-2026");
  assert.equal(hits.length, 2);

  const scoped = searchDocuments(shared, "leave", { category: "operations" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.entry.id, "office-move");
});

test("the same file filed twice by the same channel updates it rather than duplicating it", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  const path = file("leave.md", LEAVE_POLICY);

  await addDocument(shared, hr, { ...filing(), path });
  const again = await addDocument(shared, hr, {
    ...filing({
      summary:
        "Leave for 2026. Four weeks annual, ten days sick, ten days maximum carry-over and only with a manager's sign-off.",
    }),
    path,
  });

  assert.equal(again.replacedVersion, 1);
  assert.equal(again.entry.version, 2);
  assert.match(again.entry.summary, /maximum carry-over/);
  assert.equal(listDocuments(shared).length, 1);
});

test("the same file filed by another channel is reported as already on the shelf", async () => {
  const { shared, channel, file } = setup();
  const path = file("leave.md", LEAVE_POLICY);
  await addDocument(shared, channel("C-HR", "hr"), { ...filing(), path });

  const second = await addDocument(shared, channel("C-OPS", "ops"), {
    ...filing({ title: "Holiday rules", category: "operations" }),
    path,
  });

  assert.equal(second.duplicateOf?.id, "leave-policy-2026");
  assert.equal(second.duplicateOf?.addedBy, "#hr");
  assert.equal(listDocuments(shared).length, 1);
});

test("only the channel that filed a document may remove it", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  const ops = channel("C-OPS", "ops");
  await addDocument(shared, hr, { ...filing(), path: file("leave.md", LEAVE_POLICY) });

  assert.throws(() => removeDocument(shared, ops, "leave-policy-2026"), /filed by #hr/);

  assert.equal(removeDocument(shared, hr, "leave-policy-2026"), true);
  assert.equal(listDocuments(shared).length, 0);
  assert.equal(existsSync(join(shared.documents, "leave-policy-2026")), false);
});

test("a document is read a page at a time", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the handbook.`).join("\n");
  await addDocument(shared, hr, { ...filing({ title: "Handbook" }), path: file("handbook.md", long) });

  const first = readDocumentPage(shared, "handbook", { limit: 100 });
  assert.equal(first.text.length, 100);
  assert.equal(first.more, true);

  const next = readDocumentPage(shared, "handbook", { offset: 100, limit: 100 });
  assert.equal(next.offset, 100);
  assert.notEqual(next.text, first.text);

  const end = readDocumentPage(shared, "handbook", { offset: first.total - 10 });
  assert.equal(end.more, false);
});

test("the shelf is grouped by category and rendered for a human", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  await addDocument(shared, hr, { ...filing(), path: file("leave.md", LEAVE_POLICY) });
  await addDocument(shared, hr, {
    ...filing({
      title: "Expenses",
      summary: "What can be claimed, the limits on each category, and how long a claim takes to be paid.",
      category: "finance",
    }),
    path: file("expenses.md", "Claim within 30 days. Meals up to $40."),
  });

  assert.deepEqual(listCategories(shared), [
    { category: "finance", count: 1 },
    { category: "hr", count: 1 },
  ]);

  const index = readFileSync(join(shared.documents, "INDEX.md"), "utf-8");
  assert.match(index, /## finance/);
  assert.match(index, /## hr/);
  assert.match(index, /Leave policy 2026/);
  assert.match(describeDocument(listDocuments(shared)[0]!), /`expenses`/);
});

test("titles become ids that are safe as directory names", async () => {
  assert.equal(slugify("Q3 Report — Final (v2)"), "q3-report-final-v2");
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("!!!", ""), "");
});

test("two documents may honestly share a title, and neither is lost", async () => {
  const { shared, channel, file } = setup();
  const hr = channel("C-HR", "hr");
  await addDocument(shared, hr, {
    ...filing({ title: "Minutes" }),
    path: file("a.md", "Minutes of the meeting on the fifth. We agreed to defer the upgrade."),
  });
  const second = await addDocument(shared, hr, {
    ...filing({ title: "Minutes" }),
    path: file("b.md", "Minutes of the meeting on the twelfth. The upgrade was approved."),
  });

  assert.equal(second.entry.id, "minutes-2");
  assert.equal(second.replacedVersion, undefined);
  // Worth saying out loud, because two entries of the *same* minutes is the
  // mistake this makes possible.
  assert.equal(second.alongside?.id, "minutes");
  assert.equal(listDocuments(shared).length, 2);
});
