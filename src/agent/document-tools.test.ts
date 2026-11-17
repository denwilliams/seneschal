import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocumentTools } from "./document-tools.ts";
import { stageAttachment } from "./attachments.ts";
import { listDocuments, readDocumentText } from "./documents.ts";
import { channelPaths, sharedPaths, type ChannelPaths, type SharedPaths } from "../workspace/paths.ts";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * These are about the seam between the two halves of filing a document: what
 * the agent is trusted to decide, and what it is not allowed to decide.
 */

function setup(access: { canRead?: boolean; canAdd?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-doctools-"));
  const shared: SharedPaths = sharedPaths(root);
  const paths: ChannelPaths = channelPaths(root, "C-OPS");
  mkdirSync(shared.documents, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });

  const channel = {
    ref: { id: "C-OPS", name: "ops", isDm: false },
    paths,
    shared,
    documents: { canRead: access.canRead ?? true, canAdd: access.canAdd ?? true },
  } as unknown as ResolvedChannel;

  const tools = createDocumentTools({
    channel,
    jail: { readRoots: [paths.workspace, paths.attachments], writeRoots: [paths.workspace], cwd: paths.workspace },
    currentUserId: () => "U1",
  });

  const call = async (name: string, params: unknown) => {
    const tool = tools.find((t: ToolDefinition) => t.name === name);
    assert.ok(tool, `no tool called ${name}`);
    const result = await (tool as ToolDefinition).execute("call-1", params as never, undefined as never, undefined as never, undefined as never);
    return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
  };

  return { root, shared, paths, channel, tools, call };
}

const MANUAL = [
  "Boiler service manual",
  "",
  "The pressure should sit between 1.0 and 1.5 bar when cold.",
  "Bleed the radiators before topping the system up, not after.",
].join("\n");

const FILING = {
  title: "Boiler service manual",
  summary:
    "The service manual for the boiler: correct cold pressure, how to bleed the radiators, and the order to do things in.",
  category: "manuals",
  tags: ["boiler", "heating"],
};

test("a staged attachment is filed as the file that arrived, not the text in the workspace", async () => {
  const { paths, shared, call } = setup();
  const { staged } = await stageAttachment(paths, {
    bytes: new TextEncoder().encode(MANUAL),
    filename: "boiler.md",
    mimeType: "text/markdown",
    source: "https://acme.slack.com/files/boiler",
  });

  // The staged text lives in the workspace, which the agent can write to.
  // Rewriting it must not change what the library stores.
  writeFileSync(staged.textPath, "The pressure should sit at 9 bar.\n");

  const reply = await call("add_document", { path: staged.textPath, ...FILING });
  assert.match(reply, /Filed "Boiler service manual"/);

  const [entry] = listDocuments(shared);
  assert.equal(entry!.id, "boiler-service-manual");
  assert.equal(entry!.filename, "boiler.md");
  assert.equal(entry!.source, "https://acme.slack.com/files/boiler");
  assert.equal(entry!.addedByUser, "U1");
  assert.match(readDocumentText(shared, entry!.id), /1\.0 and 1\.5 bar/);
  assert.doesNotMatch(readDocumentText(shared, entry!.id), /9 bar/);
  assert.equal(readFileSync(join(shared.documents, entry!.id, "original.md"), "utf-8"), MANUAL);
});

test("a file the agent wrote itself can be filed, and says where it came from", async () => {
  const { paths, shared, call } = setup();
  const path = join(paths.workspace, "postmortem.md");
  writeFileSync(path, "What broke, why it broke, and what we changed so it does not happen again.");

  await call("add_document", {
    path: "postmortem.md",
    title: "March outage postmortem",
    summary: "What broke during the March outage, the sequence of events, and the three changes made afterwards.",
    category: "incidents",
  });

  const [entry] = listDocuments(shared);
  assert.equal(entry!.source, "written in #ops");
});

test("a path outside the channel is refused", async () => {
  const { root, call } = setup();
  const outside = join(root, "secrets.md");
  writeFileSync(outside, "Another channel's private notes, at length, for the avoidance of doubt.");
  await assert.rejects(() => call("add_document", { path: outside, ...FILING }), /outside/);
});

test("search finds a filed document and read_document returns its text", async () => {
  const { paths, call } = setup();
  const { staged } = await stageAttachment(paths, {
    bytes: new TextEncoder().encode(MANUAL),
    filename: "boiler.md",
    mimeType: "text/markdown",
  });
  await call("add_document", { path: staged.textPath, ...FILING });

  const found = await call("search_documents", { query: "what pressure should the boiler be at" });
  assert.match(found, /boiler-service-manual/);
  assert.match(found, /match: /);

  const read = await call("read_document", { id: "boiler-service-manual" });
  assert.match(read, /1\.0 and 1\.5 bar/);
  assert.match(read, /This is the end/);
});

test("a channel that may not file is shown the tool and told who can turn it on", async () => {
  const { tools, call } = setup({ canAdd: false });
  assert.ok(tools.some((t) => t.name === "add_document"), "the door, not the wall");
  assert.equal(tools.some((t) => t.name === "remove_document"), false);
  await assert.rejects(
    () => call("add_document", { path: "anything.md", ...FILING }),
    /share\.documentsAdd/,
  );
});

test("a channel with no access to the library gets no tools at all", () => {
  const { tools } = setup({ canRead: false, canAdd: false });
  assert.deepEqual(tools, []);
});

test("reading is withheld from a channel that only files", () => {
  const { tools } = setup({ canRead: false, canAdd: true });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["add_document", "remove_document"]);
});
