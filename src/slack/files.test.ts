import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, modelAcceptsImages } from "./files.ts";
import { channelPaths } from "../workspace/paths.ts";

/** Swap global fetch for the duration of a test. */
async function withFetch(impl: typeof fetch, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// A 1x1 PNG, so resizeImage has something real to decode.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("no files means no images and no notes", async () => {
  const result = await collectFiles(undefined, "xoxb-test");
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.notes, []);
});

test("downloads an image and sends the bot token", async () => {
  let sawAuth: string | undefined;
  await withFetch(
    (async (_url: any, init: any) => {
      sawAuth = init?.headers?.Authorization;
      return new Response(PNG_1X1, { status: 200 });
    }) as any,
    async () => {
      const { images, notes } = await collectFiles(
        [{ mimetype: "image/png", url_private: "https://files.slack.com/x.png", name: "x.png" }],
        "xoxb-test",
      );
      assert.equal(sawAuth, "Bearer xoxb-test", "Slack file URLs need the bot token");
      assert.equal(images.length, 1);
      assert.equal(images[0]!.type, "image");
      assert.ok(images[0]!.data.length > 0);
      assert.deepEqual(notes, []);
    },
  );
});

test("an HTML login page is rejected rather than sent as an image", async () => {
  await withFetch(
    (async () => new Response("<!DOCTYPE html><html>sign in</html>", { status: 200 })) as any,
    async () => {
      const { images, notes } = await collectFiles(
        [{ mimetype: "image/png", url_private: "https://files.slack.com/x.png" }],
        "xoxb-test",
      );
      assert.equal(images.length, 0, "must not pass an HTML page off as an image");
      assert.equal(notes.length, 1);
      assert.match(notes[0]!, /files:read/);
    },
  );
});

test("a failed download is reported, not silently dropped", async () => {
  await withFetch(
    (async () => new Response("nope", { status: 403, statusText: "Forbidden" })) as any,
    async () => {
      const { images, notes } = await collectFiles(
        [{ mimetype: "image/png", url_private: "https://files.slack.com/x.png" }],
        "xoxb-test",
      );
      assert.equal(images.length, 0);
      assert.match(notes[0]!, /403/);
    },
  );
});

test("a channel with nowhere to stage says so rather than pretending to read", async () => {
  let fetched = false;
  await withFetch(
    (async () => {
      fetched = true;
      return new Response(PNG_1X1, { status: 200 });
    }) as any,
    async () => {
      const { images, documents, notes } = await collectFiles(
        [{ mimetype: "application/pdf", filetype: "pdf", name: "report.pdf" }],
        "xoxb-test",
      );
      assert.equal(fetched, false, "nothing is downloaded when it cannot be staged");
      assert.equal(images.length, 0);
      assert.equal(documents.length, 0);
      assert.match(notes[0]!, /report\.pdf .*not read in this channel/);
    },
  );
});

test("a document is downloaded, read, and staged where the agent can open it", async () => {
  const paths = channelPaths(mkdtempSync(join(tmpdir(), "harness-files-")), "C1");
  const body = "# Leave policy\n\nFour weeks a year, accruing monthly.\n";

  await withFetch(
    (async () => new Response(body, { status: 200 })) as any,
    async () => {
      const { documents, notes } = await collectFiles(
        [
          {
            mimetype: "text/markdown",
            name: "leave.md",
            url_private_download: "https://files.slack.com/leave.md",
            permalink: "https://acme.slack.com/files/leave",
          },
        ],
        "xoxb-test",
        { paths, userId: "U1", canFile: true },
      );

      assert.equal(documents.length, 1);
      const staged = documents[0]!;
      assert.equal(staged.filename, "leave.md");
      assert.equal(staged.source, "https://acme.slack.com/files/leave");
      assert.equal(staged.userId, "U1");

      // The text goes inside the jail, the original stays outside it.
      assert.match(readFileSync(staged.textPath, "utf-8"), /Four weeks a year/);
      assert.equal(readFileSync(staged.originalPath, "utf-8"), body);
      assert.ok(staged.textPath.startsWith(paths.workspace));
      assert.ok(!staged.originalPath.startsWith(paths.workspace));

      // The note has to point at the file and say what to do with it.
      assert.match(notes[0]!, /attachments\/leave\.md\.txt/);
      assert.match(notes[0]!, /add_document/);
    },
  );
});

test("a channel that cannot file is told the document will not be kept", async () => {
  const paths = channelPaths(mkdtempSync(join(tmpdir(), "harness-files-")), "C1");
  await withFetch(
    (async () => new Response("Some notes worth reading right now.", { status: 200 })) as any,
    async () => {
      const { notes } = await collectFiles(
        [{ mimetype: "text/plain", name: "notes.txt", url_private: "https://files.slack.com/n.txt" }],
        "xoxb-test",
        { paths, canFile: false },
      );
      assert.doesNotMatch(notes[0]!, /add_document/);
      assert.match(notes[0]!, /cannot file documents/);
    },
  );
});

test("a format with no reader is refused by name, without downloading it", async () => {
  const paths = channelPaths(mkdtempSync(join(tmpdir(), "harness-files-")), "C1");
  let fetched = false;
  await withFetch(
    (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as any,
    async () => {
      const { documents, notes } = await collectFiles(
        [{ mimetype: "application/vnd.ms-excel", name: "budget.xlsx", url_private: "https://x" }],
        "xoxb-test",
        { paths, canFile: true },
      );
      assert.equal(fetched, false);
      assert.equal(documents.length, 0);
      assert.match(notes[0]!, /CSV/);
    },
  );
});

test("an oversized image is skipped with an explanation", async () => {
  const { images, notes } = await collectFiles(
    [
      {
        mimetype: "image/png",
        url_private: "https://files.slack.com/big.png",
        size: 50 * 1024 * 1024,
      },
    ],
    "xoxb-test",
  );
  assert.equal(images.length, 0);
  assert.match(notes[0]!, /too large/i);
});

test("model image capability is read from the model, not guessed", () => {
  assert.equal(modelAcceptsImages({ input: ["text", "image"] }), true);
  assert.equal(modelAcceptsImages({ input: ["text"] }), false);
  assert.equal(modelAcceptsImages(undefined), false);
});
