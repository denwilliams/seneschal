import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ArtifactServer, consoleChannelUrl } from "../artifacts/server.ts";
import { legacyConsoleTarget } from "./legacy.ts";
import { ConsoleLinks } from "./links.ts";
import type { ConsoleEvent } from "./api-types.ts";
import { clearTimelineCache } from "./timeline-cache.ts";
import { CONSOLE2_STYLE_HASHES, console2Route } from "./handler.ts";
import { EventHub, liveEvent } from "./events.ts";
import { classifyTool } from "./tools.ts";
import { pageEntries, transcriptEntries } from "./transcript.ts";
import { ChannelTimelineLog } from "../agent/timeline.ts";
import { nodeKind, type Console2Source } from "./source.ts";
import { SECRET, baseUrl, fixture, roots, viewFor } from "./fixture.ts";
import { hashWorkflow, SOFTWARE_FACTORY_WORKFLOW } from "../factory/workflow/definition.ts";
import { emptyFactoryRun, emptyStage, type FactoryRunData } from "../factory/workflow/docs.ts";
import { orderRuns, recoveryOf, workflowRunSummary, workflowRunView } from "./workflows.ts";
import { clearFactoryCache } from "./data.ts";

async function start(f: ReturnType<typeof fixture>) {
  await f.server.start();
  const port = (f.server.address() as { port: number }).port;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: "console.test", ...headers } });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  return { port, get };
}

after(() => { clearTimelineCache(); });

test("console2 routes parse and refuse anything else", () => {
  assert.deepEqual(console2Route("/console2"), { page: "app", file: "index.html" });
  assert.deepEqual(console2Route("/console2/"), { page: "app", file: "index.html" });
  assert.deepEqual(console2Route("/console2/assets/index-abc.js"), { page: "app", file: "assets/index-abc.js" });
  assert.deepEqual(console2Route("/console2/api/v1/tree"), { page: "tree" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1"), { page: "channel", channelId: "C1" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/tasks"), { page: "tasks", channelId: "C1" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/state"), { page: "state", channelId: "C1" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/workflows"), { page: "workflows", channelId: "C1" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/workflows/frun_1"), { page: "workflow", channelId: "C1", runId: "frun_1" });
  assert.equal(console2Route("/console2/api/v1/channels/C1/workflows/a%2Fb"), undefined);
  assert.equal(console2Route("/console2/api/v1/channels/C1/workflows/a/b"), undefined);
  for (const page of ["artifacts", "timeline", "factory"] as const) assert.deepEqual(console2Route(`/console2/api/v1/channels/C1/${page}`), { page, channelId: "C1" });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/threads/1700000000.000100"), { page: "thread", channelId: "C1", threadKey: "1700000000.000100" });
  assert.deepEqual(console2Route("/console2/api/v1/events", new URLSearchParams("channel=C1&thread=main")), { page: "events", channelId: "C1", threadKey: "main" });
  assert.equal(console2Route("/console2/api/v1/events", new URLSearchParams("thread=../x")), undefined);
  assert.equal(console2Route("/console2/api/v2/tree"), undefined);
  assert.equal(console2Route("/console2/api/v1/channels/C1/unknown"), undefined);
  assert.equal(console2Route("/console2/../etc/passwd"), undefined);
  assert.equal(console2Route("/console2/%2e%2e/secret"), undefined);
  assert.equal(console2Route("/console2/assets/.env"), undefined);
  assert.equal(console2Route("/console2/a%2Fb"), undefined);
  assert.equal(console2Route("/console2x"), undefined);
  assert.equal(console2Route("/channels/C1"), undefined);
});

test("thread keys are classified", () => {
  assert.equal(nodeKind("main"), "main");
  assert.equal(nodeKind("sub-1234"), "run");
  assert.equal(nodeKind("scheduled-abc-1"), "scheduled");
  assert.equal(nodeKind("dream"), "dream");
  assert.equal(nodeKind("dream-17"), "dream");
  assert.equal(nodeKind("1700000000.000100"), "thread");
});

test("tools are grouped by where they come from", () => {
  const connectors = ["linear", "my connector"];
  assert.equal(classifyTool("linear__search", connectors).group, "connector");
  assert.equal(classifyTool("my_connector__x", connectors).connector, "my connector");
  assert.equal(classifyTool("bash", connectors).group, "builtin");
  assert.equal(classifyTool("kb_search", connectors).group, "knowledge");
  assert.equal(classifyTool("schedule_create", connectors).group, "schedules");
  assert.equal(classifyTool("memory_write", connectors).group, "memory");
  assert.equal(classifyTool("run_subagent", connectors).group, "subagents");
  assert.equal(classifyTool("mystery", connectors).group, "other");
});

test("transcript entries: tool cards settle, inherited is marked, paging works", () => {
  const entries = transcriptEntries(viewFor("x"), { redacted: false, forkedFromEntry: 5 });
  assert.deepEqual(entries.map((e) => [e.id, e.role, e.inherited === true]), [[1, "user", true], [4, "user", true], [6, "user", false], [7, "assistant", false], [9, "assistant", false]]);
  const assistant = entries.find((e) => e.id === 7)!;
  assert.deepEqual(assistant.toolCalls, [{ callId: "c1", name: "bash", status: "ok" }, { callId: "c2", name: "read", status: "error" }]);
  assert.equal(assistant.tokens, 420);
  assert.equal(assistant.costUsd, 0.02);
  assert.equal(assistant.model, "anthropic/claude");
  assert.ok(!JSON.stringify(entries).includes("echo x"), "tool arguments are never copied");
  assert.ok(!JSON.stringify(entries).includes("output x"), "tool results are never copied");
  const pending = transcriptEntries({ entries: [{ id: 1, kind: "a" }], contributions: [[{ role: "assistant", content: [{ type: "toolCall", id: "z", name: "bash" }] }]] }, { redacted: false, forkedFromEntry: 0 });
  assert.equal(pending[0]!.toolCalls![0]!.status, "pending");

  const page1 = pageEntries(entries, undefined, 2);
  assert.deepEqual(page1.entries.map((e) => e.id), [7, 9]);
  assert.equal(page1.nextBefore, 7);
  const page2 = pageEntries(entries, page1.nextBefore, 2);
  assert.deepEqual(page2.entries.map((e) => e.id), [4, 6]);
  assert.equal(pageEntries(entries, 4, 10).nextBefore, undefined);
  assert.equal(pageEntries(entries, undefined, 99_999).entries.length, entries.length);
});

test("redacted transcripts keep the shape and drop every word", () => {
  const entries = transcriptEntries(viewFor(SECRET), { redacted: true, forkedFromEntry: 5 });
  assert.ok(entries.length > 0 && entries.every((e) => e.redacted === true && e.text === undefined));
  assert.ok(!JSON.stringify(entries).includes(SECRET));
  assert.equal(entries.find((e) => e.id === 7)!.toolCalls!.length, 2);
});

test("API: tree, channel, session, tasks, tools, extend, memory, thread", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const tree = (await get("/console2/api/v1/tree")).json();
    assert.equal(tree.harnessName, "Harness");
    const channel = tree.channels[0];
    assert.equal(channel.live, true);
    assert.equal(channel.state, "blocked");
    assert.deepEqual(channel.nodes.map((n: { id: string }) => n.id), ["main", "1700000000.000100", "dream-123"]);
    const thread = channel.nodes[1];
    assert.equal(thread.state, "running");
    assert.equal(thread.forkedFromEntry, 5);
    assert.deepEqual(thread.children.map((n: { id: string; kind: string }) => [n.id, n.kind]), [["sub-abc", "run"]]);
    assert.equal(channel.nodes[2].state, "blocked");
    assert.equal(channel.nodes[0].label, "main");
    assert.match(thread.label, /^2023-11-14 22:13$/);

    const ch = (await get(`/console2/api/v1/channels/${f.channelId}`)).json();
    assert.equal(ch.live, true);
    assert.equal((ch as { olderViews?: unknown }).olderViews, undefined, "everything it once linked to is in this console now");

    const session = (await get(`/console2/api/v1/channels/${f.channelId}/session?thread=1700000000.000100`)).json();
    assert.equal(session.model, "anthropic/claude");
    assert.equal(session.pinnedModel, true);
    assert.deepEqual(session.context, { usedTokens: 550, windowTokens: 1_000_000 });
    assert.equal(session.usage.calls, 1);
    assert.equal(session.usage.totalTokens, 420);
    assert.equal(session.usage.costUsd, 0.02);
    assert.equal(session.toolCount, 5);
    assert.deepEqual(session.usage.rows.map((r: { type: string; tokens: number }) => [r.type, r.tokens]), [["input", 100], ["output", 20], ["cacheRead", 300], ["cacheWrite", 0]]);

    const tasks = (await get(`/console2/api/v1/channels/${f.channelId}/tasks`)).json();
    assert.equal(tasks.active.length, 1);
    assert.equal(tasks.schedules.length, 1);
    assert.equal(tasks.schedules[0].cron, "0 9 * * *");
    assert.ok(tasks.schedules[0].nextRun);
    assert.ok(tasks.approvals.some((a: { status: string }) => a.status === "requested"));
    assert.equal(tasks.blocked[0].threadKey, "dream-123");
    assert.ok(tasks.activity.some((a: { kind: string }) => a.kind === "tool"));

    const tools = (await get(`/console2/api/v1/channels/${f.channelId}/tools`)).json();
    assert.equal(tools.live, true);
    assert.deepEqual(tools.tools.map((t: { name: string; group: string }) => [t.name, t.group]), [
      ["bash", "builtin"], ["kb_search", "knowledge"], ["linear__search", "connector"], ["read", "builtin"], ["schedule_create", "schedules"],
    ]);
    assert.equal(tools.connectors[0].toolsLoaded, true);

    const extend = (await get(`/console2/api/v1/channels/${f.channelId}/extend`)).json();
    assert.deepEqual(extend.skills, [{ name: "my-skill", source: "channel" }]);
    assert.deepEqual(extend.subagents.map((s: { name: string }) => s.name), ["researcher"]);
    assert.deepEqual(extend.knowledgeBases, [{ name: "wiki" }]);

    const memory = (await get(`/console2/api/v1/channels/${f.channelId}/memory`)).json();
    assert.equal(memory.files[0].name, "MEMORY.md");
    assert.match(memory.files[0].text, /SECRET-WORDS/);

    const transcript = (await get(`/console2/api/v1/channels/${f.channelId}/threads/1700000000.000100?limit=3`)).json();
    assert.equal(transcript.available, true);
    assert.equal(transcript.running, true);
    assert.equal(transcript.forkedFromEntry, 5);
    assert.equal(transcript.entries.length, 3);
    assert.equal(transcript.nextBefore, transcript.entries[0].id);
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/threads/missing`)).json().available, false);
    assert.equal((await get("/console2/api/v1/channels/CNOSUCH1")).status, 404);
  } finally { await f.server.stop(); }
});

test("the tree caps old idle conversations but never hides ones that need attention", async () => {
  const f = fixture();
  const base = f.source.runtime(f.channelId)!;
  const many = Array.from({ length: 400 }, (_, i) => ({ threadKey: `1600000000.${String(i).padStart(6, "0")}`, createdAt: 1, lastActivityAt: 1_600_000_000_000 + i, forkedFromEntry: 5, pinnedModel: false }));
  // The oldest one is blocked: it must stay listed even though it is far outside the newest 150.
  const store = { ...base.store, consoleRoutes: async () => many, consoleBusyThreads: async () => new Set<string>(), blocked: async () => [{ conversationId: 1, threadKey: many[0]!.threadKey, reason: "r", since: 1 }] };
  const source = { ...f.source, runtime: () => ({ ...base, store }) as never };
  const { buildTree, MAX_NODES } = await import("./tree.ts");
  const tree = await buildTree(source);
  const channel = tree.channels[0]!;
  assert.equal(channel.nodes.length, 1 + MAX_NODES + 1, "main, the newest, and the blocked old one");
  assert.equal(channel.hiddenNodes, 400 - MAX_NODES - 1);
  assert.ok(channel.nodes.some((n) => n.id === many[0]!.threadKey && n.state === "blocked"));
  assert.equal(channel.nodes[1]!.id, many[399]!.threadKey, "newest first");
});

test("transcript: several messages in one durable entry stay distinct and paging never cuts between them", () => {
  const view = {
    entries: [{ id: 1, kind: "a" }, { id: 2, kind: "b" }, { id: 3, kind: "c" }],
    contributions: [
      [{ role: "user", content: "one" }],
      [{ role: "user", content: "two-a" }, { role: "assistant", content: "two-b" }, { role: "assistant", content: "two-c" }],
      [{ role: "user", content: "three" }],
    ],
  };
  const entries = transcriptEntries(view, { redacted: false, forkedFromEntry: 0 });
  assert.deepEqual(entries.map((e) => e.key), ["1", "2", "2.1", "2.2", "3"]);
  assert.equal(new Set(entries.map((e) => e.key)).size, entries.length, "keys are unique");
  // A page of two would cut inside entry 2; it grows to take all of it, and the cursor continues exactly after.
  const newest = pageEntries(entries, undefined, 2);
  assert.deepEqual(newest.entries.map((e) => e.key), ["2", "2.1", "2.2", "3"]);
  assert.equal(newest.nextBefore, 2);
  const older = pageEntries(entries, newest.nextBefore, 2);
  assert.deepEqual(older.entries.map((e) => e.key), ["1"]);
  assert.equal(older.nextBefore, undefined);
  // Nothing is skipped or repeated across pages.
  assert.deepEqual([...older.entries, ...newest.entries].map((e) => e.key), entries.map((e) => e.key));
});

test("a blocked descendant shows on every collapsed ancestor, however deep", async () => {
  const f = fixture();
  const root = join(f.dataDir, "channels", f.channelId);
  new ChannelTimelineLog(root).record({ kind: "run.start", actor: "helper", title: "helper started", runKey: "sub-child", threadKey: "sub-abc" });
  clearTimelineCache();
  const base = f.source.runtime(f.channelId)!;
  const store = {
    ...base.store,
    consoleRoutes: async () => [...(await base.store.consoleRoutes()), { threadKey: "sub-child", createdAt: 4, lastActivityAt: 1_700_000_030_000, forkedFromEntry: 0, pinnedModel: true }],
    consoleBusyThreads: async () => new Set<string>(), blocked: async () => [{ conversationId: 1, threadKey: "sub-child", reason: "r", since: 1 }],
  };
  const { buildTree } = await import("./tree.ts");
  const tree = await buildTree({ ...f.source, runtime: () => ({ ...base, store }) as never });
  const thread = tree.channels[0]!.nodes.find((n) => n.id === "1700000000.000100")!;
  const run = thread.children![0]!;
  assert.equal(run.children![0]!.id, "sub-child");
  assert.equal(run.state, "blocked", "the run is as bad as its child");
  assert.equal(thread.state, "blocked", "and so is the thread above it");
  assert.equal(tree.channels[0]!.state, "blocked");
});

test("a failure building a response is a 500 that says so, not a 404", async () => {
  const f = fixture();
  const broken: Console2Source = { ...f.source, channels: () => { throw new Error("disk exploded"); } };
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl, console: true, artifacts: false }, f.dataDir, {}, undefined, undefined, undefined, () => broken);
  await server.start();
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/console2/api/v1/tree`);
    assert.equal(res.status, 500);
    const body = await res.text();
    assert.match(body, /could not read/);
    assert.ok(!body.includes("disk exploded"), "the error text stays in the log");
  } finally { await server.stop(); }
});

test("events: a client that stops reading is cut off instead of buffering forever", async () => {
  const f = fixture();
  const hub = new EventHub(() => f.source, { maxClients: 5, pollMs: 1_000_000, heartbeatMs: 1_000_000 });
  const writes: string[] = [];
  let ended = false;
  const stalled = { writeHead: () => {}, write: (chunk: string) => { writes.push(chunk); return false; }, end() { ended = true; (this as { writableEnded: boolean }).writableEnded = true; }, on: () => {}, writableEnded: false, writableLength: 0 };
  assert.equal(await hub.connect(stalled as never, {}, () => {}), true);
  assert.equal(hub.size, 1);
  stalled.writableLength = 2_000_000; // the socket's queue has grown past the limit
  await hub.poll(); // establishes the signature
  f.source.channels = () => []; // the next poll announces a change, which cannot be delivered
  await hub.poll();
  assert.equal(hub.size, 0, "the stalled client was dropped");
  assert.equal(ended, true);
  assert.ok(!writes.some((chunk) => chunk.includes('"type":"tree"')), "nothing more was queued for it");
  hub.closeAll();
});

test("a blocked subagent run shows on its collapsed parent thread and on the channel", async () => {
  const f = fixture();
  const base = f.source.runtime(f.channelId)!;
  const store = { ...base.store, consoleBusyThreads: async () => new Set<string>(), blocked: async () => [{ conversationId: 1, threadKey: "sub-abc", reason: "r", since: 1 }] };
  const { buildTree } = await import("./tree.ts");
  const tree = await buildTree({ ...f.source, runtime: () => ({ ...base, store }) as never });
  const channel = tree.channels[0]!;
  const thread = channel.nodes.find((n) => n.id === "1700000000.000100")!;
  assert.equal(thread.children![0]!.state, "blocked");
  assert.equal(thread.state, "blocked", "the parent is as bad as its worst child");
  assert.equal(channel.state, "blocked");
});

test("session usage is scoped: a thread shows its own, the trunk and no thread show the channel", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const thread = (await get(`/console2/api/v1/channels/${f.channelId}/session?thread=1700000000.000100`)).json();
    const other = (await get(`/console2/api/v1/channels/${f.channelId}/session?thread=9999.1`)).json();
    const main = (await get(`/console2/api/v1/channels/${f.channelId}/session?thread=main`)).json();
    const channel = (await get(`/console2/api/v1/channels/${f.channelId}/session`)).json();
    assert.deepEqual([thread.usage.scope, thread.usage.calls], ["thread", 1]);
    assert.deepEqual([other.usage.scope, other.usage.calls], ["thread", 0]);
    assert.deepEqual([main.usage.scope, main.usage.calls], ["channel", 1]);
    assert.deepEqual([channel.usage.scope, channel.usage.calls], ["channel", 1]);
  } finally { await f.server.stop(); }
});

test("events: an unknown channel is refused before it takes a slot", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const res = await get("/console2/api/v1/events?channel=CNOSUCH1&thread=main");
    assert.equal(res.status, 404);
  } finally { await f.server.stop(); }
});

test("state: the whole object with its revision, size, writer and change log", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const res = (await get(`/console2/api/v1/channels/${f.channelId}/state`)).json();
    assert.deepEqual([res.live, res.rev, res.maxBytes], [true, 14, 65_536]);
    assert.equal(res.value.cursor, 41);
    assert.deepEqual(res.value.jobs, { last: { status: "ok", at: 1_700_000_000 } });
    assert.ok(res.bytes > 50);
    assert.deepEqual(res.updatedBy, { source: "agent", threadKey: "1700000000.000100" }, "who, but not the Slack user id");
    assert.equal(res.updatedAt, "2023-11-14T22:15:00.000Z");
    assert.deepEqual(res.changes.map((c: { rev: number; op: string }) => [c.rev, c.op]), [[13, "append"], [14, "set"]]);
    assert.equal(res.redacted, undefined);
  } finally { await f.server.stop(); }
});

test("state: a direct message shows revision, size and times, but no value and no key names", async () => {
  const f = fixture({ dm: true });
  const { get } = await start(f);
  try {
    const res = await get(`/console2/api/v1/channels/${f.channelId}/state`);
    const body = res.json();
    assert.equal(body.redacted, true);
    assert.equal(body.value, undefined);
    assert.equal(body.rev, 14);
    assert.ok(body.bytes > 0);
    assert.deepEqual(body.changes.map((c: { path: string }) => c.path), ["", ""], "even key names are withheld");
    assert.ok(!res.text.includes(SECRET));
  } finally { await f.server.stop(); }
});

test("state: a closed store says it cannot be read, instead of showing an empty object", async () => {
  const f = fixture({ live: false });
  const { get } = await start(f);
  try {
    const body = (await get(`/console2/api/v1/channels/${f.channelId}/state`)).json();
    assert.deepEqual([body.live, body.rev, body.value, body.changes], [false, 0, undefined, []]);
    assert.match(body.reason, /not open/);
  } finally { await f.server.stop(); }
});

test("state: its revision is in the tree, so a change to the state is a change to the tree", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    assert.equal((await get("/console2/api/v1/tree")).json().channels[0].stateRev, 14);
    f.state.rev = 15;
    assert.equal((await get("/console2/api/v1/tree")).json().channels[0].stateRev, 15);
  } finally { await f.server.stop(); }
});

test("state: the event stream announces a tree change when the state changes", async () => {
  const f = fixture();
  const hub = new EventHub(() => f.source, { maxClients: 2, pollMs: 1_000_000, heartbeatMs: 1_000_000 });
  const written: string[] = [];
  const res = { writeHead: () => {}, write: (chunk: string) => { written.push(chunk); return true; }, end() {}, on: () => {}, writableEnded: false, writableLength: 0 };
  await hub.connect(res as never, {}, () => {});
  await hub.poll(); // sets the signature
  assert.ok(!written.some((chunk) => chunk.includes('"type":"tree"')));
  f.state.rev = 15;
  clearTimelineCache();
  await hub.poll();
  assert.ok(written.some((chunk) => chunk.includes('"type":"tree"')), "the browser is told to refetch");
  hub.closeAll();
});

test("tasks: job runs are listed with their phases, where they are, and why they stopped", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const { jobs } = (await get(`/console2/api/v1/channels/${f.channelId}/tasks`)).json();
    assert.deepEqual(jobs.map((j: { runId: string; job: string; status: string }) => [j.runId, j.job, j.status]), [["run_aaa", "release", "needs_decision"], ["run_bbb", "tally", "completed"]]);
    const waiting = jobs[0];
    assert.equal(waiting.currentPhase, "deploy");
    assert.deepEqual(waiting.phases.map((p: { name: string; status: string; exit?: number }) => [p.name, p.status, p.exit]), [["plan", "done", 0], ["deploy", "running", undefined], ["notify", "pending", undefined]]);
    assert.match(waiting.phases[0].summary, /exit 0/);
    assert.match(waiting.reason, /interrupted/);
    assert.deepEqual(waiting.input, { branch: `main ${SECRET}` });
    assert.deepEqual(waiting.by, { source: "agent", threadKey: "1700000000.000100" }, "who started it, but not the Slack user id");
    assert.equal(waiting.endedAt, undefined);
    assert.equal(jobs[1].currentPhase, undefined, "a finished run has no current phase");
    assert.ok(jobs[1].endedAt);
  } finally { await f.server.stop(); }
});

test("tasks: a direct message shows job names, statuses and exit codes, but no output, reasons or inputs", async () => {
  const f = fixture({ dm: true });
  const { get } = await start(f);
  try {
    const res = await get(`/console2/api/v1/channels/${f.channelId}/tasks`);
    const { jobs } = res.json();
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs[0].phases.map((p: { name: string; status: string; exit?: number }) => [p.name, p.status, p.exit]), [["plan", "done", 0], ["deploy", "running", undefined], ["notify", "pending", undefined]]);
    for (const job of jobs) {
      assert.equal(job.reason, undefined);
      assert.equal(job.input, undefined);
      for (const phase of job.phases) assert.equal(phase.summary, undefined);
    }
    assert.ok(!res.text.includes(SECRET));
  } finally { await f.server.stop(); }
});

test("tasks: a closed store has no job runs to show", async () => {
  const f = fixture({ live: false });
  const { get } = await start(f);
  try {
    assert.deepEqual((await get(`/console2/api/v1/channels/${f.channelId}/tasks`)).json().jobs, []);
  } finally { await f.server.stop(); }
});

test("extend: the channel's job definitions, with the ones its permissions would refuse marked unavailable and why", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const { jobs } = (await get(`/console2/api/v1/channels/${f.channelId}/extend`)).json();
    const byName = Object.fromEntries(jobs.map((j: { name: string }) => [j.name, j]));
    assert.deepEqual(Object.keys(byName).sort(), ["deploy", "tally"]);
    assert.equal(byName.tally.available, true);
    assert.equal(byName.tally.description, "Count things");
    assert.deepEqual(byName.tally.phases, [{ name: "count", kind: "state" }]);
    assert.equal(byName.deploy.available, false);
    assert.match(byName.deploy.problem, /does not have the exec tool/);
    assert.deepEqual(byName.deploy.inputs, [{ name: "env", required: false, default: "staging" }]);
    assert.deepEqual(byName.deploy.phases, [{ name: "go", kind: "exec" }]);
  } finally { await f.server.stop(); }
});

test("tree: a channel's job version is in the tree, so job activity reaches the browser", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    assert.equal((await get("/console2/api/v1/tree")).json().channels[0].jobVersion, 7);
  } finally { await f.server.stop(); }
});

test("connectors that can be signed in to from the console carry a Connect URL: only supported opt-ins, with the prefix and safe encoding", async () => {
  const f = fixture();
  const resolve = f.source.resolve;
  const callbackUrl = "https://console.example.org/harness/oauth/callback";
  f.source.baseUrl = "https://console.example.org/harness/";
  f.source.config = () => ({ name: "Harness", channels: {}, webConsole: { oauth: { callbackUrl } } }) as never;
  f.source.resolve = (channel) => ({ ...resolve(channel)!, connectors: [
    { name: "calendar", config: { transport: "http", oauth: { consoleCallback: true, redirectUrl: callbackUrl, clientSecret: "do-not-render-client-secret" } } },
    { name: "stdio", config: { transport: "stdio" } },
    { name: "manual", config: { transport: "http", oauth: { redirectUrl: callbackUrl } } },
    { name: "other-callback", config: { transport: "http", oauth: { consoleCallback: true, redirectUrl: "https://elsewhere.example.org" } } },
    { name: "custom-store", config: { transport: "http", oauth: { consoleCallback: true, redirectUrl: callbackUrl, tokenFile: "private-secret-path.json" } } },
    { name: "unsafe<script>", config: { transport: "http", oauth: { consoleCallback: true, redirectUrl: callbackUrl } } },
  ] }) as never;
  const { get } = await start(f);
  try {
    for (const page of ["extend", "tools"]) {
      const res = await get(`/console2/api/v1/channels/${f.channelId}/${page}`);
      const connectors = res.json().connectors as { name: string; connectable: boolean; connectUrl?: string }[];
      const withUrl = connectors.filter((c) => c.connectUrl !== undefined);
      assert.deepEqual(withUrl.map((c) => c.name), ["calendar"], `${page}: only a supported opt-in gets a URL (the name with markup is refused by the pattern check)`);
      assert.equal(withUrl[0]!.connectUrl, `/harness/oauth/connect?channel=${f.channelId}&connector=calendar`, "below the console's own prefix");
      assert.ok(connectors.filter((c) => !c.connectable).every((c) => c.connectUrl === undefined));
      assert.ok(!res.text.includes("do-not-render-client-secret") && !res.text.includes("private-secret-path"), "no secret is ever rendered");
    }
    f.source.config = () => ({ name: "Harness", channels: {} }) as never;
    const without = (await get(`/console2/api/v1/channels/${f.channelId}/extend`)).json().connectors as { connectUrl?: string }[];
    assert.ok(without.every((c) => c.connectUrl === undefined), "with no console OAuth configured there is nothing to connect");
  } finally { await f.server.stop(); }
});

test("artifacts: files with the URL each is served at, below the console's prefix and safely encoded; dotfiles and symlinks never listed", async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), "console2-artifacts-"));
  roots.push(dir);
  mkdirSync(join(dir, "reports", "q 4"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  writeFileSync(join(dir, "reports", "q 4", "a&b #1.pdf"), "x".repeat(2048));
  writeFileSync(join(dir, ".secret"), "no");
  symlinkSync("/etc/hostname", join(dir, "link.txt"));
  const resolve = f.source.resolve;
  f.source.baseUrl = "https://console.example.org/harness/";
  f.source.resolve = (channel) => ({ ...resolve(channel)!, artifacts: { directory: dir, url: "x" } }) as never;
  const { get } = await start(f);
  try {
    const body = (await get(`/console2/api/v1/channels/${f.channelId}/artifacts`)).json();
    assert.deepEqual([body.enabled, body.truncated, body.reason], [true, false, undefined]);
    assert.deepEqual(body.entries.map((e: { path: string }) => e.path).sort(), ["index.html", "reports/q 4/a&b #1.pdf"]);
    const nested = body.entries.find((e: { path: string }) => e.path.startsWith("reports"));
    assert.equal(nested.size, 2048);
    assert.match(nested.modified, /^\d{4}-\d\d-\d\dT/);
    assert.equal(nested.url, `https://console.example.org/harness/channels/${f.channelId}/artifacts/reports/q%204/a%26b%20%231.pdf`);
    assert.ok(!JSON.stringify(body).includes(".secret") && !JSON.stringify(body).includes("link.txt"));
  } finally { await f.server.stop(); }
});

test("artifacts: a channel without artifact hosting says so instead of failing", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const res = await get(`/console2/api/v1/channels/${f.channelId}/artifacts`);
    assert.equal(res.status, 200);
    const body = res.json();
    assert.deepEqual([body.enabled, body.entries], [false, []]);
    assert.match(body.reason, /not on for this channel/);
  } finally { await f.server.stop(); }
});

test("timeline: rows newest first with the graph's lanes, forks and merges, plus a summary and the actors", async () => {
  const f = fixture();
  const log = new ChannelTimelineLog(join(f.dataDir, "channels", f.channelId));
  log.record({ kind: "turn.start", actor: "channel", threadKey: "1.1", title: "Request received", at: "2026-10-18T10:00:00.000Z" });
  log.record({ kind: "run.start", actor: "coder", runKey: "sub-a", threadKey: "1.1", userId: "U1", title: "coder started", at: "2026-10-18T10:00:01.000Z" });
  log.record({ kind: "tool", actor: "coder", runKey: "sub-a", title: "bash", status: "ok", at: "2026-10-18T10:00:02.000Z" });
  log.record({ kind: "run.end", actor: "coder", runKey: "sub-a", title: "coder done", status: "done", next: "reviewer", steps: 1, durationMs: 61_000, costUsd: 0.05, at: "2026-10-18T10:01:02.000Z" });
  log.record({ kind: "turn.end", actor: "channel", threadKey: "1.1", title: "Replied", status: "ok", at: "2026-10-18T10:01:03.000Z" });
  clearTimelineCache();
  const { get } = await start(f);
  try {
    const url = `/console2/api/v1/channels/${f.channelId}/timeline`;
    const body = (await get(url)).json();
    const mine = body.rows.filter((r: { actor: string; kind: string }) => ["coder", "channel"].includes(r.actor) && r.kind !== "approval.requested" && r.kind !== "post" && !(r.actor === "channel" && r.kind === "tool"));
    assert.deepEqual(mine.map((r: { title: string }) => r.title), ["Replied", "coder done", "bash", "coder started", "Request received"], "newest first");
    const byTitle = Object.fromEntries(mine.map((r: { title: string }) => [r.title, r]));
    assert.deepEqual([byTitle["coder started"].shape, byTitle["coder started"].lane], ["fork", 1]);
    assert.deepEqual([byTitle["coder done"].shape, byTitle["coder done"].lane, byTitle["coder done"].next, byTitle["coder done"].steps, byTitle["coder done"].costUsd], ["merge", 1, "reviewer", 1, 0.05]);
    assert.deepEqual([byTitle["Replied"].lane, byTitle["Replied"].shape, byTitle["Replied"].dead], [0, "node", false]);
    assert.ok(body.lanes >= 1);
    assert.equal(body.actors[0], "channel", "the channel agent comes first");
    assert.ok(body.actors.includes("coder"));
    assert.equal(body.summary.runs >= 1 && body.summary.byStatus.done === 1, true);
    assert.equal(body.count, body.rows.length, "no filter, so every event is a row");
    assert.ok(!JSON.stringify(body).includes("\"U1\""), "no Slack user id leaves the server");
    assert.ok(!JSON.stringify(body).includes("sub-a"), "nor a run key");

    const noTools = (await get(`${url}?tools=0`)).json();
    assert.ok(noTools.rows.every((r: { kind: string }) => r.kind !== "tool"));
    assert.ok(noTools.rows.some((r: { title: string }) => r.title === "coder started"), "forks and merges stay when tool calls are hidden");
    const onlyCoder = (await get(`${url}?actor=coder`)).json();
    assert.deepEqual(onlyCoder.rows.map((r: { actor: string }) => r.actor), ["coder", "coder", "coder"]);
    assert.equal(onlyCoder.lanes, body.lanes, "the graph is still the whole picture");
    assert.equal((await get(`${url}?limit=2`)).json().count, 2);
    assert.equal((await get(`${url}?actor=%22%3E%3Cscript%3E`)).json().rows.length, 0, "an unknown actor is just no rows");
  } finally { await f.server.stop(); }
});

test("timeline: a direct message shows what happened but none of what was said", async () => {
  const f = fixture({ dm: true });
  const { get } = await start(f);
  try {
    const res = await get(`/console2/api/v1/channels/${f.channelId}/timeline`);
    const body = res.json();
    assert.ok(body.rows.length > 0);
    assert.ok(body.rows.every((r: { detail?: string }) => r.detail === undefined));
    assert.ok(!res.text.includes(SECRET));
  } finally { await f.server.stop(); }
});

test("factory: a software-factory channel's live GitHub view, cached and rate limited; any other channel is a 404", async () => {
  clearFactoryCache();
  const f = fixture();
  const calls: string[][] = [];
  const resolve = f.source.resolve;
  f.source.github = (async (_env: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args.includes("merged")) return [{ number: 7, title: "Ship it", url: "https://github.com/acme/web/pull/7", mergedAt: new Date().toISOString(), updatedAt: "", state: "MERGED", author: { login: "ana" } }];
    if (args[0] === "issue") return [{ number: 1, title: "Broken <img>", url: "https://github.com/acme/web/issues/1", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", labels: [{ name: "bug" }] }];
    return [];
  }) as never;
  const { get } = await start(f);
  try {
    const url = `/console2/api/v1/channels/${f.channelId}/factory`;
    const notFactory = await get(url);
    assert.equal(notFactory.status, 404);
    assert.match(notFactory.json().error, /not a software factory/);

    f.source.resolve = (channel) => ({ ...resolve(channel)!, factory: { name: "Acme", repositories: ["acme/web"] } }) as never;
    const body = (await get(url)).json();
    assert.equal(body.name, "Acme");
    assert.equal(body.repositories[0].repository, "acme/web");
    assert.equal(body.repositories[0].merged[0].title, "Ship it");
    assert.equal(body.repositories[0].merged[0].author.login, "ana");
    assert.equal(body.repositories[0].issues[0].title, "Broken <img>");
    assert.deepEqual(body.repositories[0].issues[0].labels, [{ name: "bug" }]);
    assert.equal(body.repositories[0].timeline.axis.length, 8);
    assert.equal(body.repositories[0].activity, undefined, "raw activity is not sent, only the drawn timeline");
    const before = calls.length;
    await get(url);
    assert.equal(calls.length, before, "a second view is served from the cache");
    await get(`${url}?refresh=1`);
    assert.equal(calls.length, before, "a refresh right after a fetch is still rate limited");
  } finally { await f.server.stop(); }
});

test("workflows: runs that need a person come first, then newest; each shows its stages, round, risk and PR", async () => {
  const f = fixture({ factory: true });
  const { get } = await start(f);
  try {
    const body = (await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json();
    assert.equal(body.channelId, f.channelId);
    assert.deepEqual(body.runs.map((r: { runId: string }) => r.runId), ["frun_failed", "frun_info", "frun_decide", "frun_wait", "frun_ended", "frun_done", "frun_rej"], "waiting and needs_decision first (newest of them first), then the rest newest first");
    const wait = body.runs.find((r: { runId: string }) => r.runId === "frun_wait");
    assert.deepEqual([wait.repo, wait.issue, wait.status, wait.current, wait.round], ["acme/web", 7, "waiting", "merge", 2]);
    assert.equal(wait.waiting.kind, "merge");
    assert.deepEqual(wait.risk, { scored: true, model: 3, final: 4 });
    assert.deepEqual(wait.stages.map((s: { name: string; status: string }) => [s.name, s.status]), [["triage", "success"], ["implement", "success"], ["review", "success"], ["merge", "in_progress"], ["deploy", "not_started"]]);
    assert.deepEqual(wait.stages.find((s: { name: string }) => s.name === "merge").kind, "gate");
    assert.equal(wait.stages.find((s: { name: string }) => s.name === "implement").role, "coder");
    assert.deepEqual(wait.pr, { number: 12, url: "https://github.com/acme/web/pull/12", merged: false });
    assert.equal(wait.stages[0].attempts, undefined, "the list carries no attempts");
    const done = body.runs.find((r: { runId: string }) => r.runId === "frun_done");
    assert.deepEqual([done.status, done.pr.merged, done.stages[4].status, done.waiting], ["completed", true, "skipped", undefined]);
    assert.equal(body.runs.find((r: { runId: string }) => r.runId === "frun_rej").risk.scored, false);
    assert.equal(body.runs.find((r: { runId: string }) => r.runId === "frun_decide").waiting.kind, "decide");
  } finally { await f.server.stop(); }
});

test("workflows: one run with every attempt, the merge rule, and who may approve as a count (never ids)", async () => {
  const f = fixture({ factory: true });
  const { get } = await start(f);
  try {
    const res = await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`);
    const { run } = res.json();
    const review = run.stages.find((s: { name: string }) => s.name === "review");
    assert.deepEqual(review.attempts.map((a: { entry: number; verdict: string }) => [a.entry, a.verdict]), [[1, "changes_requested"], [2, "approved"]]);
    assert.equal(review.attempts[0].runKey, "sub-rev1");
    assert.deepEqual([review.attempts[0].durationMs, review.attempts[0].costUsd, review.attempts[0].steps], [60_000, 0.25, 4]);
    assert.match(review.attempts[0].summary, /trims the password/);
    assert.deepEqual(run.risk, { scored: true, model: 3, final: 4, reason: `Touches auth. ${SECRET}`, floors: [`touches sensitive paths (infra/prod.tf) ${SECRET}`] });
    assert.match(run.reason, /over this repository's limit/);
    assert.deepEqual(run.mergeRule, { autoMergeMaxRisk: 2, method: "squash", approvers: { source: "factory", count: 2 } });
    assert.ok(!res.text.includes('"U1"') && !res.text.includes('"U2"') && !res.text.includes("userId"), "no Slack user id leaves the server");
    assert.ok(!res.text.includes("definition") && !res.text.includes("reviewedHead") && !res.text.includes("abc1234"), "nor the pinned definition or the reviewed commit");
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/workflows/nope`)).status, 404);
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/workflows/a%2Fb`)).status, 404);
    assert.equal((await get(`/console2/api/v1/channels/CNOPE00/workflows`)).status, 404);
  } finally { await f.server.stop(); }
});

test("workflows: a run waiting for information shows the updates it received, trusted and not, and how it began", async () => {
  const f = fixture({ factory: true });
  const { get } = await start(f);
  try {
    const list = (await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json();
    const info = list.runs.find((r: { runId: string }) => r.runId === "frun_info");
    assert.deepEqual([info.status, info.waiting.kind, info.origin, info.by.source, info.updates], ["waiting", "info", "intake", "intake", { trusted: 3, untrusted: 1 }]);
    assert.equal(list.runs.find((r: { runId: string }) => r.runId === "frun_wait").origin, "manual");
    const { run } = (await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_info`)).json();
    assert.deepEqual(run.updatesReceived.map((u: { kind: string; trusted: boolean; author?: string }) => [u.kind, u.trusted, u.author]), [["comment", true, "maintainer"], ["comment", false, "stranger"], ["labels", true, undefined], ["comment", true, "den"]]);
    assert.deepEqual(run.updatesReceived.map((u: { viaToken?: boolean }) => u.viaToken), [undefined, undefined, undefined, true], "a reply written through the token's account is marked");
    assert.match(run.updatesReceived[0].excerpt, /10k-user accounts/);
    assert.equal(run.updatesReceived[0].association, "MEMBER");
  } finally { await f.server.stop(); }
});

test("workflows: a stage that failed is a run waiting for a person, not an ended one: the stage, the attempt and the answers that apply", async () => {
  const f = fixture({ factory: true });
  const { get } = await start(f);
  try {
    const list = (await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json();
    const failed = list.runs.find((r: { runId: string }) => r.runId === "frun_failed");
    assert.deepEqual([failed.status, failed.waiting.kind, failed.current], ["needs_decision", "failed", "implement"]);
    assert.deepEqual(failed.recovery, { stage: "implement", attempt: 2, ended: false, answers: ["retry", "restart_from", "abort"], restartFrom: ["triage"] }, "the coder cannot be skipped, and only triage is earlier");
    assert.deepEqual(failed.stages.map((s: { status: string }) => s.status), ["success", "failed", "not_started", "not_started", "not_started"]);
    assert.equal(failed.endedAt, undefined, "the run has not ended");
    // A run that ended failed is carried on by retry alone.
    const ended = list.runs.find((r: { runId: string }) => r.runId === "frun_ended");
    assert.deepEqual([ended.status, ended.waiting, ended.recovery], ["failed", undefined, { stage: "review", attempt: 1, ended: true, answers: ["retry"], restartFrom: [] }]);
    // Nothing else has a recovery.
    assert.deepEqual(list.runs.filter((r: { recovery?: unknown }) => r.recovery).map((r: { runId: string }) => r.runId), ["frun_failed", "frun_ended"]);

    const { run } = (await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_failed`)).json();
    assert.deepEqual(run.stages[1].attempts.map((a: { status: string }) => a.status), ["failed", "failed"], "every attempt is on the record");
    assert.match(run.reason, /stage "implement" failed: npm test: 3 failures/);
    assert.deepEqual(run.recovery.answers, ["retry", "restart_from", "abort"]);
  } finally { await f.server.stop(); }
});

test("workflows: recoveryOf knows which stages can be skipped and which earlier stages can be gone back to, and nothing for a run that is fine", () => {
  const stages = (current: string): FactoryRunData["stages"] => SOFTWARE_FACTORY_WORKFLOW.stages.map((stage) => ({ ...emptyStage(stage.name), status: stage.name === current ? "failed" : "success", entries: 1, attempts: stage.name === current ? [{ entry: 1, role: "r", runKey: "k", status: "failed", verdict: "", summary: "", report: "", reask: false, startedAt: 1, endedAt: 2, durationMs: 1, costUsd: 0, steps: 0 }] : [] }));
  const run = (current: string, over: Partial<FactoryRunData> = {}): FactoryRunData => ({
    ...emptyFactoryRun("fr_x"), workflow: "software-factory", definition: JSON.stringify(SOFTWARE_FACTORY_WORKFLOW), hash: hashWorkflow(SOFTWARE_FACTORY_WORKFLOW),
    status: "needs_decision", wait: { kind: "failed", since: 1 }, current, stages: stages(current), ...over,
  });
  assert.deepEqual(recoveryOf(run("triage"))!.answers, ["retry", "abort"], "the first stage has nothing before it");
  assert.deepEqual(recoveryOf(run("deploy"))!.answers, ["retry", "skip", "restart_from", "abort"], "an optional stage can be skipped");
  assert.deepEqual(recoveryOf(run("deploy"))!.restartFrom, ["triage", "implement", "review", "merge"]);
  assert.equal(recoveryOf(run("review", { status: "running", wait: { kind: "", since: 0 } })), undefined, "a run that is going has none");
  assert.equal(recoveryOf(run("review", { wait: { kind: "decide", since: 1 } })), undefined, "an interrupted stage is a different wait");
  assert.equal(recoveryOf(run("review", { hash: "tampered" })), undefined, "a run whose pinned workflow does not match its hash has none");
  assert.equal(recoveryOf(run("review", { status: "failed", wait: { kind: "", since: 0 } }))!.ended, true);
  assert.equal(recoveryOf(run("review", { status: "aborted", wait: { kind: "", since: 0 } })), undefined, "an aborted run is not carried on");
});

test("workflows: the intake block shows the mapping: held, queued and open issues, the last poll and its error", async () => {
  const f = fixture({ factory: true });
  const { get } = await start(f);
  try {
    const { intake } = (await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json();
    assert.deepEqual([intake.enabled, intake.intervalSeconds, intake.repos.length], [true, 120, 1]);
    const repo = intake.repos[0];
    assert.equal(repo.repo, "acme/web");
    assert.deepEqual(repo.counts, { open: 2, held: 1, queued: 1, ignored: 1, closed: 1 });
    assert.deepEqual(repo.mappings.map((m: { issue: number; status: string }) => [m.issue, m.status]), [[20, "held"], [21, "queued"], [11, "open"], [7, "open"], [22, "ignored"], [23, "closed"]], "held and queued first, then open, then the rest");
    assert.equal(repo.mappings.find((m: { issue: number }) => m.issue === 11).runId, "frun_info");
    assert.match(repo.mappings[0].reason, /not an owner, member or collaborator/);
    assert.match(repo.lastPollAt, /^\d{4}-/);
    assert.match(repo.lastError, /HTTP 403/);
    assert.deepEqual([repo.labels.status, repo.labels.created, repo.labels.error], ["created", ["status:triage", "factory:go"], undefined]);
    assert.match(repo.labels.checkedAt, /^\d{4}-/);
  } finally { await f.server.stop(); }
});

test("workflows: the intake block says whether the factory's labels are there: all there, created, or could not be checked", async () => {
  const { buildWorkflows } = await import("./workflows.ts");
  const f = fixture({ factory: true });
  const base = f.source.runtime(f.channelId)!;
  const repos = await base.store.listFactoryIntake();
  const withLabels = (labels?: { checkedAt: number; created: string[]; error: string }) => ({
    ...f.source, runtime: () => ({ ...base, store: { ...base.store, listFactoryIntake: async () => repos.map((repo) => ({ ...repo, labels })) } }) as never,
  });
  const channel = f.source.channels()[0]!;
  const view = async (labels?: { checkedAt: number; created: string[]; error: string }) => (await buildWorkflows(withLabels(labels), channel)).intake!.repos[0]!.labels;
  assert.equal(await view(undefined), undefined, "before the first check there is nothing to say");
  assert.deepEqual(await view({ checkedAt: 0, created: [], error: "" }), undefined, "a record that was never written is not a check");
  assert.deepEqual((await view({ checkedAt: 1_700_000_000_000, created: [], error: "" }))!.status, "ok");
  assert.deepEqual((await view({ checkedAt: 1_700_000_000_000, created: ["status:triage"], error: "" }))!, { status: "created", checkedAt: "2023-11-14T22:13:20.000Z", created: ["status:triage"] });
  const failed = (await view({ checkedAt: 1_700_000_000_000, created: [], error: `HTTP 403 ${"x".repeat(600)}` }))!;
  assert.equal(failed.status, "failed");
  assert.ok(failed.error!.length <= 300, "bounded");
  // Directly addressed channels keep the status and lose the reason, which could carry anything GitHub said.
  const dm = fixture({ dm: true, factory: true });
  const dmBase = dm.source.runtime(dm.channelId)!;
  const dmSource = { ...dm.source, runtime: () => ({ ...dmBase, store: { ...dmBase.store, listFactoryIntake: async () => repos.map((repo) => ({ ...repo, labels: { checkedAt: 1_700_000_000_000, created: [], error: `HTTP 403 ${SECRET}` } })) } }) as never };
  const dmLabels = (await buildWorkflows(dmSource, dm.source.channels()[0]!)).intake!.repos[0]!.labels!;
  assert.deepEqual([dmLabels.status, dmLabels.error], ["failed", undefined]);
  await f.server.stop(); await dm.server.stop();
});

test("workflows: a channel with no intake and no mapping has no intake block", async () => {
  const f = fixture();
  const resolve = f.source.resolve;
  f.source.resolve = (channel) => ({ ...resolve(channel)!, factory: { name: "Acme", repositories: ["acme/web"], lifecycleSkills: [] } }) as never;
  const { get } = await start(f);
  try {
    const store = f.source.runtime(f.channelId)!.store as unknown as { listFactoryIntake: () => Promise<unknown[]> };
    store.listFactoryIntake = async () => [];
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json().intake, undefined);
  } finally { await f.server.stop(); }
});

test("workflows: without a factory config there is no merge rule; with none set, the channel's allowed users decide", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`)).json().run.mergeRule, undefined);
    const resolve = f.source.resolve;
    f.source.resolve = (channel) => ({ ...resolve(channel)!, allowUsers: ["U7", "U8", "U9"], factory: { name: "Acme", repositories: ["acme/web"], lifecycleSkills: [] } }) as never;
    const rule = (await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`)).json().run.mergeRule;
    assert.deepEqual(rule, { autoMergeMaxRisk: 0, method: "squash", approvers: { source: "channel", count: 3 } }, "nothing merges by itself unless configured");
    f.source.resolve = (channel) => ({ ...resolve(channel)!, allowUsers: undefined, factory: { name: "Acme", repositories: ["acme/web"], lifecycleSkills: [] } }) as never;
    assert.deepEqual((await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`)).json().run.mergeRule.approvers, { source: "channel" }, "no list at all: anyone who can speak");
  } finally { await f.server.stop(); }
});

test("workflows: a direct message shows the structure of a run and none of what it was about", async () => {
  const f = fixture({ dm: true, factory: true });
  const { get } = await start(f);
  try {
    const list = await get(`/console2/api/v1/channels/${f.channelId}/workflows`);
    const one = await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`);
    for (const res of [list, one]) assert.ok(!res.text.includes(SECRET), "no sentinel");
    assert.ok(list.json().runs.length === 7 && list.json().runs.every((r: { issueTitle?: string }) => r.issueTitle === undefined));
    // A failed stage in a direct message: the structure (which stage, which attempt, which answers) shows, the words do not.
    const failedDm = (await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_failed`)).text;
    assert.ok(!failedDm.includes(SECRET), "no sentinel in a failed run");
    const failed = JSON.parse(failedDm).run;
    assert.deepEqual([failed.recovery.stage, failed.recovery.attempt, failed.recovery.answers], ["implement", 2, ["retry", "restart_from", "abort"]]);
    assert.deepEqual([failed.reason, failed.stages[1].attempts.map((a: { summary?: string }) => a.summary)], [undefined, [undefined, undefined]]);
    // Intake and the updates keep their shape and lose their words: no titles, authors, reasons, excerpts or poll errors.
    const intake = list.json().intake;
    assert.deepEqual(intake.repos[0].counts, { open: 2, held: 1, queued: 1, ignored: 1, closed: 1 });
    assert.ok(intake.repos[0].mappings.every((m: { title?: string; author?: string; reason?: string }) => m.title === undefined && m.author === undefined && m.reason === undefined));
    assert.equal(intake.repos[0].lastError, undefined);
    const info = (await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_info`)).json().run;
    assert.deepEqual(info.updatesReceived.map((u: { kind: string; trusted: boolean }) => [u.kind, u.trusted]), [["comment", true], ["comment", false], ["labels", true], ["comment", true]]);
    assert.ok(info.updatesReceived.every((u: { author?: string; excerpt?: string }) => u.author === undefined && u.excerpt === undefined));
    const { run } = one.json();
    assert.deepEqual([run.status, run.round, run.risk.model, run.risk.final], ["waiting", 2, 3, 4]);
    assert.deepEqual([run.reason, run.risk.reason, run.risk.floors], [undefined, undefined, undefined]);
    const review = run.stages.find((s: { name: string }) => s.name === "review");
    assert.equal(review.attempts.length, 2);
    assert.ok(review.attempts.every((a: { summary?: string; durationMs: number; costUsd: number }) => a.summary === undefined && a.durationMs > 0 && a.costUsd > 0));
    assert.equal(review.attempts[0].verdict, "changes_requested", "a verdict is structure");
  } finally { await f.server.stop(); }
});

test("workflows: a store that is not open lists nothing and has no run to show", async () => {
  const f = fixture({ live: false });
  const { get } = await start(f);
  try {
    assert.deepEqual((await get(`/console2/api/v1/channels/${f.channelId}/workflows`)).json().runs, []);
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`)).status, 404);
  } finally { await f.server.stop(); }
});

test("workflows: hostile text is passed as data, bounded, and a verdict that is not a word is dropped", () => {
  const run = emptyFactoryRun("frun_x");
  Object.assign(run, { workflow: "software-factory", repo: "acme/web", issue: 1, issueTitle: `<img src=x onerror=alert(1)>${"x".repeat(500)}`, issueUrl: "javascript:alert(1)", status: "failed", reason: "y".repeat(1000), definition: "{not json" });
  run.stages = [{ ...emptyStage("review"), status: "failed", entries: 1, attempts: [{
    entry: 1, role: "reviewer", runKey: "sub-x", status: "failed", verdict: "<script>", summary: "z".repeat(900), report: "", reask: false,
    startedAt: 1, endedAt: 2, durationMs: -5, costUsd: 0, steps: 0,
  }] }];
  const view = workflowRunView(run, false, undefined);
  assert.ok(view.issueTitle!.startsWith("<img src=x onerror=alert(1)>"), "text is data: the browser escapes it");
  assert.equal(view.issueTitle!.length, 200);
  assert.equal(view.reason!.length, 400);
  assert.equal(view.stages[0]!.attempts[0]!.verdict, undefined);
  assert.equal(view.stages[0]!.attempts[0]!.summary!.length, 300);
  assert.equal(view.stages[0]!.attempts[0]!.durationMs, 0, "a negative duration is not shown");
  assert.deepEqual([view.stages[0]!.kind, view.stages[0]!.role], ["agent", undefined], "an unreadable definition costs only the role");
  assert.equal(view.mergeRule, undefined);
  assert.equal(workflowRunSummary(run, true).issueTitle, undefined);
});

test("workflows: ordering is a pure function of status and start time", () => {
  const make = (id: string, status: "running" | "waiting" | "needs_decision" | "completed", startedAt: number) => Object.assign(emptyFactoryRun(id), { status, startedAt });
  const order = orderRuns([make("a", "completed", 5), make("b", "waiting", 1), make("c", "running", 9), make("d", "needs_decision", 3)]).map((r) => r.runId);
  assert.deepEqual(order, ["d", "b", "c", "a"]);
});

test("the original console's addresses redirect to where each page now lives; downloads and other paths are untouched", async () => {
  const f = fixture();
  const resolve = f.source.resolve;
  f.source.baseUrl = "https://console.example.org/harness/";
  f.source.resolve = (channel) => ({ ...resolve(channel)!, artifacts: { directory: tmpdir(), url: "x" } }) as never;
  const { get } = await start(f);
  try {
    const id = f.channelId;
    const location = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${(f.server.address() as { port: number }).port}${path}`, { redirect: "manual", headers: { host: "console.test" } });
      return [res.status, res.headers.get("location"), res.headers.get("cache-control")];
    };
    assert.deepEqual(await location("/"), [302, "/harness/console2/", "no-store"]);
    assert.deepEqual(await location(`/channels/${id}`), [302, `/harness/console2/#/c/${id}`, "no-store"]);
    assert.deepEqual(await location(`/channels/${id}/factory`), [302, `/harness/console2/#/c/${id}?view=factory`, "no-store"]);
    assert.deepEqual(await location(`/channels/${id}/timeline`), [302, `/harness/console2/#/c/${id}?view=timeline`, "no-store"]);
    assert.deepEqual(await location(`/channels/${id}/artifacts`), [302, `/harness/console2/#/c/${id}?tab=files`, "no-store"]);
    assert.equal((await location(`/channels/${id}/other`))[0], 404);
    assert.equal((await get("/api/channels/x/factory")).status, 404, "the old JSON endpoints are gone");
    assert.equal((await get("/assets/console/factory.js")).status, 404, "and so are the old page scripts");
    assert.equal((await get("/health")).status, 200);
  } finally { await f.server.stop(); }
});

test("legacyConsoleTarget never matches an artifact download or a malformed escape", () => {
  const links = new ConsoleLinks("https://c.example.org");
  assert.equal(legacyConsoleTarget("/channels/C1/artifacts/report.html", links), undefined);
  assert.equal(legacyConsoleTarget("/channels/%E0%A4%A", links), undefined);
  assert.equal(legacyConsoleTarget("/channels", links), undefined);
  assert.equal(legacyConsoleTarget("/channels/C1/", links), "/console2/#/c/C1");
});

test("the channel's console URL is its webConsole2 page, under any prefix", () => {
  assert.equal(consoleChannelUrl("https://c.example.org/h/", "C1"), "https://c.example.org/h/console2/#/c/C1");
  assert.equal(consoleChannelUrl("https://c.example.org", "C 1"), "https://c.example.org/console2/#/c/C%201");
});

test("API: a closed store degrades to file-backed data with an explanation", async () => {
  const f = fixture({ live: false });
  const { get } = await start(f);
  try {
    const tree = (await get("/console2/api/v1/tree")).json();
    assert.equal(tree.channels[0].live, false);
    assert.deepEqual(tree.channels[0].nodes, []);
    const transcript = (await get(`/console2/api/v1/channels/${f.channelId}/threads/main`)).json();
    assert.equal(transcript.available, false);
    assert.match(transcript.reason, /not open/);
    const session = (await get(`/console2/api/v1/channels/${f.channelId}/session`)).json();
    assert.equal(session.live, false);
    assert.equal(session.model, "anthropic/claude");
    assert.equal(session.toolCount, 2);
    const tools = (await get(`/console2/api/v1/channels/${f.channelId}/tools`)).json();
    assert.deepEqual(tools.tools.map((t: { name: string }) => t.name), ["bash", "read"]);
    assert.equal(tools.connectors[0].toolsLoaded, false);
    assert.equal((await get(`/console2/api/v1/channels/${f.channelId}/tasks`)).json().blocked.length, 0);
  } finally { await f.server.stop(); }
});

test("privacy: nothing a direct message said appears in any API response", async () => {
  const f = fixture({ dm: true });
  const { get } = await start(f);
  try {
    const paths = [
      "/console2/api/v1/tree", `/console2/api/v1/channels/${f.channelId}`, `/console2/api/v1/channels/${f.channelId}/session`,
      `/console2/api/v1/channels/${f.channelId}/tasks`, `/console2/api/v1/channels/${f.channelId}/tools`, `/console2/api/v1/channels/${f.channelId}/extend`,
      `/console2/api/v1/channels/${f.channelId}/memory`, `/console2/api/v1/channels/${f.channelId}/state`, `/console2/api/v1/channels/${f.channelId}/artifacts`, `/console2/api/v1/channels/${f.channelId}/timeline`, `/console2/api/v1/channels/${f.channelId}/workflows`, `/console2/api/v1/channels/${f.channelId}/workflows/frun_wait`, `/console2/api/v1/channels/${f.channelId}/threads/main`,
      `/console2/api/v1/channels/${f.channelId}/threads/1700000000.000100`,
    ];
    for (const path of paths) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.ok(!res.text.includes(SECRET), `${path} leaked direct message content`);
    }
    const transcript = (await get(`/console2/api/v1/channels/${f.channelId}/threads/1700000000.000100`)).json();
    assert.equal(transcript.redacted, true);
    assert.ok(transcript.entries.every((e: { redacted?: boolean }) => e.redacted === true));
    const memory = (await get(`/console2/api/v1/channels/${f.channelId}/memory`)).json();
    assert.equal(memory.files[0].redacted, true);
    const tasks = (await get(`/console2/api/v1/channels/${f.channelId}/tasks`)).json();
    assert.equal(tasks.schedules[0].prompt, "");
    assert.equal(tasks.schedules[0].lastError, "failed", "an error string can carry what was asked");
    assert.ok(tasks.active.every((t: { links?: unknown }) => t.links === undefined), "link labels come from what was asked");
    assert.ok(tasks.approvals.some((a: { kind: string; title: string }) => a.kind === "post" && a.title === "Post"), "a post's title can name its subject");
    assert.ok(tasks.scheduleRuns.every((r: { error?: string }) => r.error === undefined || r.error === "failed"));
  } finally { await f.server.stop(); }
});

test("non-DM channels show content, but never tool arguments or results", async () => {
  const f = fixture();
  const { get } = await start(f);
  try {
    const text = (await get(`/console2/api/v1/channels/${f.channelId}/threads/1700000000.000100`)).text;
    assert.ok(text.includes("question"));
    assert.ok(!text.includes("echo "), "tool arguments");
    assert.ok(!text.includes("output "), "tool results");
    const tools = (await get(`/console2/api/v1/channels/${f.channelId}/tools`)).text;
    assert.ok(!tools.includes(SECRET), "env values never appear");
  } finally { await f.server.stop(); }
});

test("hardening: host, origin, method, headers", async () => {
  const f = fixture();
  const { get, port } = await start(f);
  try {
    const rawStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ port, host: "127.0.0.1", path: "/console2/api/v1/tree", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rawStatus, 421, "a rebinding Host header is refused");
    assert.equal((await get("/console2/api/v1/tree", { origin: "https://evil.example" })).status, 403);
    assert.equal((await get("/console2/api/v1/tree", { origin: "null" })).status, 403);
    const same = await get("/console2/api/v1/tree", { origin: "http://console.test" });
    assert.equal(same.status, 200);
    assert.equal(same.headers.get("cache-control"), "no-store");
    assert.equal(same.headers.get("x-content-type-options"), "nosniff");
    assert.equal(same.headers.get("access-control-allow-origin"), null, "no CORS");
    const post = await fetch(`http://127.0.0.1:${port}/console2/api/v1/tree`, { method: "POST", headers: { host: "console.test" } });
    assert.equal(post.status, 405);
    assert.equal((await get("/console2/api/v1/nope")).status, 404);
  } finally { await f.server.stop(); }
});

test("static app: served with a strict CSP; hashed assets cache; nothing escapes the build", async () => {
  const dist = mkdtempSync(join(tmpdir(), "console2-dist-"));
  roots.push(dist);
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>c2</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  const outside = mkdtempSync(join(tmpdir(), "console2-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret");
  symlinkSync(join(outside, "secret.txt"), join(dist, "assets", "link.txt"));
  const previous = process.env.HARNESS_CONSOLE2_DIST;
  process.env.HARNESS_CONSOLE2_DIST = dist;
  const f = fixture();
  const { get } = await start(f);
  try {
    const index = await get("/console2/");
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("cache-control"), "no-store");
    assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    assert.equal(index.headers.get("x-frame-options"), "DENY");
    const asset = await get("/console2/assets/index-abc.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await get("/console2/assets/missing.js")).status, 404);
    const linked = await get("/console2/assets/link.txt");
    assert.equal(linked.status, 404);
    assert.ok(!linked.text.includes("top secret"));
    assert.equal((await get("/console2/%2e%2e/%2e%2e/etc/passwd")).status, 404);
  } finally {
    await f.server.stop();
    if (previous === undefined) delete process.env.HARNESS_CONSOLE2_DIST; else process.env.HARNESS_CONSOLE2_DIST = previous;
  }
});

test("/console2 redirects to /console2/ so the app's relative file names resolve", async () => {
  const f = fixture();
  const { port } = await start(f);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/console2?x=1`, { redirect: "manual" });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "/console2/?x=1");
  } finally { await f.server.stop(); }
});

test("installable app: manifest and worker are served with the right types and are always revalidated; the CSP allows exactly a same-origin worker and manifest", async () => {
  const dist = mkdtempSync(join(tmpdir(), "console2-pwa-"));
  roots.push(dist);
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>c2</title>");
  writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify({ name: "Harness console", start_url: "./", scope: "./" }));
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(dist, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dist, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "1");
  const previous = process.env.HARNESS_CONSOLE2_DIST;
  process.env.HARNESS_CONSOLE2_DIST = dist;
  const f = fixture();
  const { port, get } = await start(f);
  try {
    const manifest = await get("/console2/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
    assert.equal(manifest.headers.get("cache-control"), "no-cache", "revalidated, not immutable");
    assert.equal(manifest.json().scope, "./");

    const worker = await get("/console2/sw.js");
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("content-type") ?? "", /^text\/javascript/, "a worker script must be served as JavaScript");
    assert.equal(worker.headers.get("cache-control"), "no-cache", "a worker the browser keeps without asking could never be replaced");
    assert.equal(worker.headers.get("x-content-type-options"), "nosniff");
    assert.equal(worker.headers.get("service-worker-allowed"), null, "it is served from the directory it controls, so none is needed");

    assert.equal((await get("/console2/icon-192.png")).headers.get("content-type"), "image/png");
    assert.equal((await get("/console2/icon.svg")).headers.get("content-type"), "image/svg+xml");
    assert.match((await get("/console2/assets/index-abc.js")).headers.get("cache-control") ?? "", /immutable/, "hashed files stay immutable");
    assert.equal((await get("/console2/")).headers.get("cache-control"), "no-store");

    for (const path of ["/console2/sw.js", "/console2/manifest.webmanifest"]) {
      const head = await fetch(`http://127.0.0.1:${port}${path}`, { method: "HEAD" });
      assert.equal(head.status, 200, `HEAD ${path}`);
      assert.equal(await head.text(), "");
    }

    const csp = (await get("/console2/")).headers.get("content-security-policy") ?? "";
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    assert.deepEqual(directives["worker-src"], ["'self'"]);
    assert.deepEqual(directives["manifest-src"], ["'self'"]);
    assert.deepEqual(directives["script-src"], ["'self'"], "scripts stay same-origin only, with no 'unsafe-inline' or 'unsafe-eval'");
    assert.deepEqual(directives["default-src"], ["'none'"]);
    assert.deepEqual(directives["connect-src"], ["'self'"]);
    assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
    assert.deepEqual(directives["style-src"], ["'self'", ...CONSOLE2_STYLE_HASHES.map((hash) => `'${hash}'`)], "inline styles only by hash: scroll area, dialog scroll lock and YAML editor");
    assert.equal(CONSOLE2_STYLE_HASHES.length, 3);
    assert.ok(!/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp));
  } finally {
    await f.server.stop();
    if (previous === undefined) delete process.env.HARNESS_CONSOLE2_DIST; else process.env.HARNESS_CONSOLE2_DIST = previous;
  }
});

test("appCacheControl: the page is never stored, hashed files never change, and anything else is revalidated", async () => {
  const { appCacheControl } = await import("./handler.ts");
  assert.equal(appCacheControl("index.html"), "no-store");
  assert.equal(appCacheControl("assets/index-abc.js"), "public, max-age=31536000, immutable");
  for (const file of ["sw.js", "manifest.webmanifest", "icon-512.png", "theme-init.js"]) assert.equal(appCacheControl(file), "no-cache", file);
});

test("static app: a missing build says so", async () => {
  const previous = process.env.HARNESS_CONSOLE2_DIST;
  process.env.HARNESS_CONSOLE2_DIST = join(tmpdir(), "console2-no-such-dist");
  const f = fixture();
  const { get } = await start(f);
  try {
    const res = await get("/console2/");
    assert.equal(res.status, 503);
    assert.match(res.text, /not built/);
  } finally {
    await f.server.stop();
    if (previous === undefined) delete process.env.HARNESS_CONSOLE2_DIST; else process.env.HARNESS_CONSOLE2_DIST = previous;
  }
});

test("console2 is not served when the console is off or no source is given", async () => {
  const off = fixture();
  const noSource = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl, console: true, artifacts: false }, off.dataDir);
  await noSource.start();
  try {
    const port = (noSource.address() as { port: number }).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/console2/api/v1/tree`, { headers: { host: "console.test" } })).status, 404);
  } finally { await noSource.stop(); }
});

test("live events: text is dropped for direct messages, kept otherwise", () => {
  assert.deepEqual(liveEvent({ type: "text_delta", delta: "hi" }, false), { kind: "text_delta", delta: "hi" });
  assert.equal(liveEvent({ type: "text_delta", delta: "hi" }, true), undefined);
  assert.deepEqual(liveEvent({ type: "tool_start", toolName: "bash", callId: "c" }, true), { kind: "tool_start", callId: "c", name: "bash" });
  assert.deepEqual(liveEvent({ type: "tool_end", toolName: "bash", callId: "c", isError: true }, false), { kind: "tool_end", callId: "c", name: "bash", isError: true });
  assert.equal(liveEvent({ type: "resync" }, false), undefined);
});

function readEvents(port: number, query: string, headers: Record<string, string> = { host: "console.test" }) {
  const events: ConsoleEvent[] = [];
  let status = 0;
  let waiter: (() => void) | undefined;
  const req = httpRequest({ port, host: "127.0.0.1", path: `/console2/api/v1/events${query}`, headers }, (res) => {
    status = res.statusCode ?? 0;
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) { events.push(JSON.parse(data.slice(6))); waiter?.(); }
      }
    });
  });
  req.end();
  const until = async (predicate: (all: ConsoleEvent[]) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate(events)) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(events)}`);
      await new Promise<void>((resolve) => { waiter = resolve; setTimeout(resolve, 25); });
    }
  };
  return { events, until, close: () => req.destroy(), get status() { return status; } };
}

test("events: hello, thread activity, resync, redaction, cleanup", async () => {
  const f = fixture();
  const { port } = await start(f);
  try {
    const client = readEvents(port, `?channel=${f.channelId}&thread=1700000000.000100`);
    await client.until((all) => all.some((e) => e.type === "hello"));
    assert.equal(client.status, 200);
    // Wait for the store to attach, then drive it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await f.stream.emit([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", changes: [{ type: "text_delta", delta: "hello" }] },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c9" },
      { type: "tool_execution_end", toolName: "bash", toolCallId: "c9", entry: { model: [{ isError: false }] } },
    ]);
    await client.until((all) => all.some((e) => e.type === "thread" && e.event.kind === "tool_end"));
    const kinds = client.events.flatMap((e) => (e.type === "thread" ? [e.event.kind] : []));
    assert.deepEqual(kinds, ["message_start", "text_delta", "tool_start", "tool_end"]);
    await f.stream.emit([{ type: "snapshot" }]);
    await client.until((all) => all.some((e) => e.type === "resync"));
    client.close();
    const deadline = Date.now() + 2000;
    while (!f.stream.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.stream.stopped, true, "the store's event stream is released when the browser leaves");
  } finally { await f.server.stop(); }
});

test("events: a direct message streams activity but never its words", async () => {
  const f = fixture({ dm: true });
  const { port } = await start(f);
  try {
    const client = readEvents(port, `?channel=${f.channelId}&thread=main`);
    await client.until((all) => all.some((e) => e.type === "hello"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await f.stream.emit([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", changes: [{ type: "text_delta", delta: SECRET }] },
      { type: "tool_execution_start", toolName: "bash", toolCallId: "c9" },
    ]);
    await client.until((all) => all.some((e) => e.type === "thread" && e.event.kind === "tool_start"));
    assert.ok(!JSON.stringify(client.events).includes(SECRET));
    client.close();
  } finally { await f.server.stop(); }
});

test("events: an unknown thread still gets the tree feed; the origin check applies", async () => {
  const f = fixture();
  const { port } = await start(f);
  try {
    const client = readEvents(port, `?channel=${f.channelId}&thread=missing`);
    await client.until((all) => all.some((e) => e.type === "hello"));
    assert.equal(client.events.some((e) => e.type === "thread"), false);
    client.close();
    const bad = readEvents(port, "", { host: "console.test", origin: "https://evil.example" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(bad.status, 403);
    bad.close();
  } finally { await f.server.stop(); }
});

test("events: the hub caps connections and announces tree changes", async () => {
  const f = fixture();
  let changed = false;
  const hub = new EventHub(() => ({ ...f.source, channels: () => (changed ? [] : f.source.channels()) }), { maxClients: 1, pollMs: 20, heartbeatMs: 1000 });
  const written: string[] = [];
  const fakeRes = (): never => ({
    writeHead: () => {}, write: (chunk: string) => { written.push(chunk); return true; }, end() { (this as { writableEnded: boolean }).writableEnded = true; },
    on: () => {}, writableEnded: false,
  }) as never;
  assert.equal(await hub.connect(fakeRes(), {}, () => {}), true);
  const refused: { status?: number } = {};
  const full = { writeHead: (status: number) => { refused.status = status; }, end: () => {}, write: () => true, on: () => {}, writableEnded: false } as never;
  assert.equal(await hub.connect(full, {}, () => {}), false);
  assert.equal(refused.status, 503);
  await hub.poll();
  changed = true;
  await hub.poll();
  assert.ok(written.some((chunk) => chunk.includes('"type":"tree"')));
  hub.closeAll();
  assert.equal(hub.size, 0);
});

test("the server shuts down even with an event stream open", async () => {
  const f = fixture();
  const { port } = await start(f);
  const client = readEvents(port, "");
  await client.until((all) => all.some((e) => e.type === "hello"));
  await Promise.race([f.server.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error("stop() hung")), 3000))]);
  client.close();
});
