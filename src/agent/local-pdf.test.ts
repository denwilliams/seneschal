import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ATTACHMENT_BYTES } from "./attachment-limits.ts";
import { extractLocalPdf, snapshotAttachmentPdfs } from "./local-pdf.ts";

function makePdf(content: string): Uint8Array {
  const body = Buffer.from(content, "latin1");
  return new Uint8Array(Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n%%EOF\n`,
    "latin1",
  ));
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "local-pdf-"));
  const workspace = join(root, "workspace");
  const attachmentDir = join(workspace, "attachments");
  mkdirSync(attachmentDir, { recursive: true });
  return { root, workspace, attachmentDir };
}

test("extractLocalPdf writes text beside a staged PDF and preserves the source", async () => {
  const { workspace, attachmentDir } = setup();
  const source = join(attachmentDir, "receipt.pdf");
  const bytes = makePdf("BT (The receipt total is forty two dollars.) Tj ET");
  writeFileSync(source, bytes);

  const result = await extractLocalPdf({ workspace, attachmentDir }, "attachments/receipt.pdf");

  assert.equal(result.textPath, `${realpathSync(source)}.txt`);
  assert.equal(result.reused, false);
  assert.deepEqual(readFileSync(source), Buffer.from(bytes));
  assert.match(readFileSync(result.textPath, "utf8"), /receipt total is forty two dollars/i);
  assert.equal(lstatSync(result.textPath).isSymbolicLink(), false);
});

test("extractLocalPdf supports a Markdown sibling without overwriting an existing output", async () => {
  const { workspace, attachmentDir } = setup();
  const source = join(attachmentDir, "receipt.pdf");
  writeFileSync(source, makePdf("BT (Markdown output keeps this sentence.) Tj ET"));

  const first = await extractLocalPdf({ workspace, attachmentDir }, source, "md");
  const originalOutput = readFileSync(first.textPath, "utf8");
  const second = await extractLocalPdf({ workspace, attachmentDir }, source, "md");

  assert.equal(first.textPath, `${realpathSync(source)}.md`);
  assert.equal(second.reused, true);
  assert.equal(readFileSync(first.textPath, "utf8"), originalOutput);
});


test("extractLocalPdf never treats stale or race-created output as current text", async () => {
  const { workspace, attachmentDir } = setup();
  const source = join(attachmentDir, "receipt.pdf");
  writeFileSync(source, makePdf("BT (The old receipt says ten dollars.) Tj ET"));
  const first = await extractLocalPdf({ workspace, attachmentDir }, source);
  const oldText = readFileSync(first.textPath, "utf8");

  writeFileSync(source, makePdf("BT (The replacement receipt says ninety dollars.) Tj ET"));
  await assert.rejects(
    extractLocalPdf({ workspace, attachmentDir }, source),
    /does not match the current PDF extraction/,
  );
  assert.equal(readFileSync(first.textPath, "utf8"), oldText);

  const raced = join(attachmentDir, "raced.pdf");
  writeFileSync(raced, makePdf("BT (A race must not be trusted.) Tj ET"));
  writeFileSync(`${raced}.txt`, "untrusted output\n");
  await assert.rejects(
    extractLocalPdf({ workspace, attachmentDir }, raced),
    /without a complete harness extraction stamp/,
  );
});

test("snapshotAttachmentPdfs sees a PDF after more than one hundred directory entries", () => {
  const { workspace, attachmentDir } = setup();
  for (let n = 0; n < 120; n++) writeFileSync(join(attachmentDir, `item-${String(n).padStart(3, "0")}.txt`), "x");
  const late = join(attachmentDir, "zz-receipt.pdf");
  writeFileSync(late, makePdf("BT (The late attachment is still found.) Tj ET"));

  const found = snapshotAttachmentPdfs({ workspace, attachmentDir });
  assert.ok(found.some((entry) => entry.path === realpathSync(late)));
});

test("extractLocalPdf rejects paths outside attachment staging, symlinks, non-PDFs and oversized files", async () => {
  const { root, workspace, attachmentDir } = setup();
  const outside = join(root, "outside.pdf");
  writeFileSync(outside, makePdf("BT (Outside is forbidden.) Tj ET"));
  const text = join(attachmentDir, "notes.pdf");
  writeFileSync(text, "not a PDF");
  const tooLarge = join(attachmentDir, "large.pdf");
  writeFileSync(tooLarge, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_ATTACHMENT_BYTES)]));
  const linked = join(attachmentDir, "linked.pdf");
  symlinkSync(outside, linked);

  await assert.rejects(extractLocalPdf({ workspace, attachmentDir }, outside), /attachments directory/);
  await assert.rejects(extractLocalPdf({ workspace, attachmentDir }, "attachments/notes.pdf"), /not a PDF/);
  await assert.rejects(extractLocalPdf({ workspace, attachmentDir }, "attachments/large.pdf"), /attachment limit/);
  await assert.rejects(extractLocalPdf({ workspace, attachmentDir }, "attachments/linked.pdf"), /symlink/);
});
