import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, deflateSync } from "node:zlib";
import { canExtract, extractText, looksLikeProse, UnreadableFile } from "./extract.ts";

/**
 * Fixtures are built rather than checked in: a binary .docx in the repo is a
 * file nobody can review, and building one here means the zip reader is tested
 * against a zip whose layout the test states outright.
 */

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A PDF whose single content stream is uncompressed. */
function makePdf(content: string, opts: { compress?: boolean } = {}): Uint8Array {
  const body = opts.compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${opts.compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`,
    "latin1",
  );
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n%%EOF\n", "latin1");
  return new Uint8Array(Buffer.concat([head, body, tail]));
}

/** A valid enough one-page PDF for pdf.js, which wants a page tree and xref. */
function makePdfWithXref(content: string): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += object;
  }

  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** A zip with stored or deflated entries, laid out by hand. */
function makeZip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, "utf-8");
    const compressed = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf-8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}

test("plain text keeps its shape", async () => {
  const result = await extractText(bytes("# Notes\r\n\r\nLine one\r\nLine two\r\n"), {
    filename: "notes.md",
  });
  assert.equal(result.via, "text");
  assert.equal(result.text, "# Notes\n\nLine one\nLine two");
  assert.equal(result.approximate, false);
});

test("a file claiming to be text but full of binary is refused", async () => {
  const binary = new Uint8Array([0x54, 0x00, 0x01, 0x02, 0x03]);
  await assert.rejects(extractText(binary, { filename: "notes.txt" }), UnreadableFile);
});

test("HTML is read as prose, not as markup", async () => {
  const html = "<html><head><title>Policy</title><style>p{}</style></head><body><h1>Leave</h1><p>Four weeks a year.</p></body></html>";
  const result = await extractText(bytes(html), { filename: "policy.html" });
  assert.equal(result.via, "html");
  assert.match(result.text, /Four weeks a year\./);
  assert.doesNotMatch(result.text, /<p>|p\{\}/);
});

test("text is truncated at the cap, and says so", async () => {
  const result = await extractText(bytes("x".repeat(500)), { filename: "big.txt", maxChars: 100 });
  assert.equal(result.text.length, 100);
  assert.equal(result.truncated, true);
});

test("an uncompressed PDF gives up its words", async () => {
  const pdf = makePdf("BT /F1 12 Tf 72 720 Td (The tolerance is plus or minus two millimetres.) Tj ET");
  const result = await extractText(pdf, { filename: "datasheet.pdf", external: false, pdfjs: false });
  assert.equal(result.via, "pdf");
  assert.equal(result.approximate, true);
  assert.match(result.text, /tolerance is plus or minus two millimetres/);
});

test("pdf.js is bundled for normal PDFs when poppler is absent", async () => {
  const pdf = makePdfWithXref("BT /F1 12 Tf 72 720 Td (Bundled pdfjs extracted this sentence.) Tj ET");
  const result = await extractText(pdf, { filename: "brochure.pdf", external: false });
  assert.equal(result.via, "pdfjs");
  assert.equal(result.approximate, false);
  assert.match(result.text, /Bundled pdfjs extracted this sentence/);
});

test("a FlateDecode PDF is inflated first", async () => {
  const pdf = makePdf(
    "BT (The service is booked for the fifteenth of October.) Tj ET",
    { compress: true },
  );
  const result = await extractText(pdf, { filename: "booking.pdf", external: false, pdfjs: false });
  assert.match(result.text, /booked for the fifteenth of October/);
});

test("kerned runs keep the space between the words", async () => {
  const pdf = makePdf("BT [(Quarterly)-250(revenue)-250(rose)-250(by)-250(eleven)-250(percent)] TJ ET");
  const result = await extractText(pdf, { filename: "q3.pdf", external: false, pdfjs: false });
  assert.match(result.text, /Quarterly revenue rose by eleven percent/);
});

test("escapes and octal in a PDF literal string survive", async () => {
  const pdf = makePdf("BT (Rates \\(2026\\) rose by 5\\045 in the winter quarter) Tj ET");
  const result = await extractText(pdf, { filename: "rates.pdf", external: false, pdfjs: false });
  assert.match(result.text, /Rates \(2026\) rose by 5% in the winter quarter/);
});

test("a PDF whose text decodes to glyph ids is refused rather than indexed", async () => {
  // Identity-H: two bytes per glyph, high byte zero. Exactly the case where a
  // naive extraction produces something that looks like text and is not.
  const glyphs = Array.from({ length: 60 }, (_, i) => `\\000\\${(40 + i).toString(8).padStart(3, "0")}`).join("");
  const pdf = makePdf(`BT (${glyphs}) Tj ET`);
  await assert.rejects(
    extractText(pdf, { filename: "brochure.pdf", external: false, pdfjs: false }),
    (err: unknown) => err instanceof UnreadableFile && /could not decode/.test((err as Error).message),
  );
});

test("a PDF with no text at all is called a scan", async () => {
  const pdf = new Uint8Array(Buffer.from("%PDF-1.4\ntrailer\n%%EOF\n", "latin1"));
  await assert.rejects(
    extractText(pdf, { filename: "scan.pdf", external: false, pdfjs: false }),
    (err: unknown) => err instanceof UnreadableFile && /scan/.test((err as Error).message),
  );
});

test("a docx is read out of the zip", async () => {
  const docx = makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
      '<w:document><w:body><w:p><w:r><w:t xml:space="preserve">Kelly Heating </w:t></w:r>' +
      "<w:r><w:t>services the boiler.</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>The freeze starts on the fifteenth.</w:t></w:r></w:p></w:body></w:document>",
  });
  const result = await extractText(docx, { filename: "boiler.docx" });
  assert.equal(result.via, "docx");
  assert.equal(result.text, "Kelly Heating services the boiler.\nThe freeze starts on the fifteenth.");
});

test("a pptx keeps its slide numbers, in order", async () => {
  const pptx = makeZip({
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Next quarter</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Where we are</a:t></a:r></a:p></p:sld>",
  });
  const result = await extractText(pptx, { filename: "review.pptx" });
  assert.equal(result.via, "pptx");
  assert.match(result.text, /## Slide 2\n\nWhere we are[\s\S]*## Slide 10\n\nNext quarter/);
});

test("a zip that is not an office document says which part is missing", async () => {
  const zip = makeZip({ "readme.txt": "nothing to see" });
  await assert.rejects(
    extractText(zip, { filename: "notes.docx" }),
    (err: unknown) => err instanceof UnreadableFile && /word\/document\.xml/.test((err as Error).message),
  );
});

test("formats with no reader are named before anything is downloaded", async () => {
  assert.equal(canExtract("report.pdf", "application/pdf"), true);
  assert.equal(canExtract("notes.md", "text/markdown"), true);
  assert.equal(canExtract("budget.xlsx", undefined), false);
  assert.equal(canExtract("clip.mp4", "video/mp4"), false);

  await assert.rejects(
    extractText(bytes("anything"), { filename: "budget.xlsx" }),
    (err: unknown) => err instanceof UnreadableFile && /CSV/.test((err as Error).message),
  );
  await assert.rejects(
    extractText(bytes("anything"), { filename: "minutes.doc" }),
    (err: unknown) => err instanceof UnreadableFile && /\.docx/.test((err as Error).message),
  );
});

test("prose is told apart from a decode that went wrong", () => {
  assert.equal(looksLikeProse("The quarterly report is due on Friday."), true);
  assert.equal(looksLikeProse("      "), false);
  assert.equal(looksLikeProse("short"), false);
});
