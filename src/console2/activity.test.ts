import assert from "node:assert/strict";
import { after, test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_MAX_BYTES, ACTIVITY_SESSION, activityId, activitySnippet, slackFileUrl, ChannelActivityLog, recordPresenceActivity } from "../agent/activity.ts";
import { emptyFactoryRun } from "../factory/workflow/docs.ts";
import { factoryInteraction } from "../slack/factory-presence.ts";
import { buildActivity } from "./activity.ts";
import { fixture } from "./fixture.ts";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const T = Date.parse("2026-11-01T10:00:00.000Z");
const query = (s = "") => new URLSearchParams(s);
function setup() {
  const f = fixture(); dirs.push(f.dataDir);
  let now = T;
  const log = new ChannelActivityLog(join(f.dataDir, "channels", f.channelId), f.channelId, () => now);
  return { ...f, log, tick: (n = 1000) => { now += n; return now; }, now: () => now };
}

test("feed includes posts, scheduled/chat/document updates and prompts, newest first without prioritizing old approvals", () => {
  const f = setup();
  for (const [kind, title] of [["approval", "Deploy approval"], ["scheduled", "Morning digest"], ["chat", "Investigation complete"], ["message", "Document updated"], ["prompt", "Continue?"]] as const) {
    f.log.record({ key: title, kind, title, sourceTs: "1793520000.000100", text: `${title} useful details`, interaction: kind === "approval" || kind === "prompt" ? "pending" : "none" }); f.tick();
  }
  const second = { ...f.source.channels()[0]!, id: "CSECOND", name: "second" };
  f.source.channels = () => [{ ...second, id: f.channelId, name: "general" }, second];
  new ChannelActivityLog(join(f.dataDir, "channels", second.id), second.id, f.now).record({ key: "another", kind: "chat", title: "Other channel" });
  const page = buildActivity(f.source, query(), f.now());
  assert.deepEqual(page.entries.map((e) => e.title), ["Other channel", "Continue?", "Document updated", "Investigation complete", "Morning digest", "Deploy approval"]);
  const approval = page.entries.at(-1)!;
  assert.equal(approval.interaction, "pending"); assert.deepEqual(approval.channel, { id: f.channelId, name: "general" });
  assert.equal(approval.sourceUrl, `https://slack.com/archives/${f.channelId}/p1793520000000100`);
  assert.equal(approval.snippet, "Deploy approval useful details");
});

test("pagination covers all retained entries including timestamp ties, with stable IDs and no repeated status edits", () => {
  const f = setup();
  for (let i = 0; i < 125; i++) f.log.record({ key: String(i), kind: "message", title: `Post ${i}` });
  const all = buildActivity(f.source, query("limit=100"), T).entries;
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const q = query("limit=13"); if (cursor) q.set("cursor", cursor);
    const page = buildActivity(f.source, q, T); seen.push(...page.entries.map((e) => e.id)); cursor = page.nextCursor;
    if (seen.length === 13) { f.tick(); f.log.record({ key: "new", kind: "message", title: "Arrived between pages" }); }
  } while (cursor);
  assert.equal(seen.length, 125); assert.equal(new Set(seen).size, 125); assert.deepEqual(seen.slice(0, 100), all.map((e) => e.id));
  assert.equal(new ChannelActivityLog(join(f.dataDir, "channels", f.channelId), f.channelId).read().length, 126);
  assert.throws(() => buildActivity(f.source, query("limit=101")), /limit/);
  assert.throws(() => buildActivity(f.source, query("limit=1.5")), /limit/);
  assert.throws(() => buildActivity(f.source, query("cursor=garbage")), /cursor/);
  assert.throws(() => buildActivity(f.source, query("since=yesterday")), /since/);
});

test("acted-on old prompts appear in incremental updates, expire correctly, and in-memory requests become unavailable on restart", () => {
  const f = setup();
  f.log.record({ key: "grant", kind: "approval", sourceTs: "1793520000.000001", title: "Approval", interaction: "pending" });
  f.log.record({ key: "config", kind: "approval", sourceTs: "1793520000.000002", title: "Config", interaction: "pending", ephemeral: true, expiresAt: new Date(T + 2000).toISOString() });
  const old = buildActivity(f.source, query(), T);
  f.tick(); f.log.resolve("1793520000.000001");
  const delta = buildActivity(f.source, query(`since=${old.watermark}`), f.now());
  assert.equal(delta.entries.find((e) => e.title === "Approval")!.interaction, "resolved");
  assert.equal(delta.entries.find((e) => e.title === "Approval")!.at, old.entries.find((e) => e.title === "Approval")!.at);
  f.tick(); assert.equal(buildActivity(f.source, query(), f.now()).entries.find((e) => e.title === "Config")!.interaction, "expired");
  const file = join(f.dataDir, "channels", f.channelId, "activity.jsonl");
  appendFileSync(file, JSON.stringify({ ...f.log.read().find((e) => e.title === "Config"), id: activityId(f.channelId, "old-process"), title: "Old process", expiresAt: undefined, session: ACTIVITY_SESSION + "old" }) + "\n");
  assert.equal(buildActivity(f.source, query()).entries.find((e) => e.title === "Old process")!.interaction, "unavailable");
  f.log.record({ key: "unlinked", kind: "prompt", title: "No link", interaction: "pending" });
  assert.equal(buildActivity(f.source, query(), f.now()).entries.find((e) => e.title === "No link")!.interaction, "unavailable");
});

test("workflow wait identities are deduplicated and old waits resolve when the card moves on", () => {
  const f = setup();
  const view = (value: string) => ({ ts: "1793520000.000100", text: "Waiting for merge approval", interaction: { key: value, pending: true } });
  recordPresenceActivity(f.log, view("wait-one"));
  f.tick(); recordPresenceActivity(f.log, view("wait-one"));
  assert.equal(f.log.read().length, 1);
  f.tick(); recordPresenceActivity(f.log, view("wait-two"));
  assert.deepEqual(f.log.read().map((e) => e.interaction), ["resolved", "pending"]);
  f.tick(); recordPresenceActivity(f.log, { ts: "1793520000.000100", text: "Approved", interaction: { key: "wait-two", pending: false } });
  const page = buildActivity(f.source, query(), f.now());
  assert.ok(page.entries.every((e) => e.interaction !== "pending"));
  assert.equal(page.entries.length, 3);
  assert.ok(!JSON.stringify(f.log.read()).includes("wait-one"), "button payloads are not stored");
});

test("DM, unknown, rejected and removed channel histories are not returned", () => {
  const f = setup(); f.log.record({ key: "x", kind: "message", title: "Allowed" });
  new ChannelActivityLog(join(f.dataDir, "channels", "DPRIVATE"), "DPRIVATE").record({ key: "dm", kind: "message", title: "DM SECRET" });
  new ChannelActivityLog(join(f.dataDir, "channels", "CUNKNOWN"), "CUNKNOWN").record({ key: "unknown", kind: "message", title: "UNKNOWN SECRET" });
  const dm = { ...f.source.channels()[0]!, id: "DPRIVATE", isDm: true };
  f.source.channels = () => [{ ...dm, id: f.channelId, isDm: false }, dm];
  assert.deepEqual(buildActivity(f.source, query()).entries.map((e) => e.title), ["Allowed"]);
  f.source.resolve = () => undefined;
  assert.deepEqual(buildActivity(f.source, query()).entries, []);
  assert.deepEqual(buildActivity(f.source, query()).channelIds, []);
});

test("snippets redact credentials, URL query secrets and code before persistence; rotation and torn lines remain readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-")); dirs.push(dir);
  const log = new ChannelActivityLog(dir, "CCHAN001", () => T);
  const text = "A useful report https://user:password@example.com/private https://example.com/doc?token=secret#secret api_key=topsecret Bearer hidden xoxb-hidden ```private tool payload```";
  log.record({ key: "safe", kind: "message", title: "Report", text });
  const disk = readFileSync(join(dir, "activity.jsonl"), "utf8");
  for (const secret of ["topsecret", "hidden", "private tool payload", "?token", "user:password"]) assert.ok(!disk.includes(secret), secret);
  assert.match(activitySnippet(text), /A useful report/);
  writeFileSync(join(dir, "activity.jsonl"), disk + "\n".repeat(ACTIVITY_MAX_BYTES));
  log.record({ key: "new", kind: "message", title: "New" });
  appendFileSync(join(dir, "activity.jsonl"), "{torn");
  assert.equal(log.read().length, 2);
  log.record({ key: "after-crash", kind: "message", title: "First post after restart" });
  assert.equal(log.read().length, 3, "a torn tail must not swallow the next valid snapshot");
});

test("real HTTP endpoint enforces Origin, bounds queries, remains read-only, and returns no-store JSON", async () => {
  const f = setup(); f.log.record({ key: "x", kind: "chat", title: "Reply" });
  await f.server.start();
  const origin = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`;
  const get = (path = "", options: RequestInit = {}) => fetch(origin + "/console2/api/v1/activity" + path, { ...options, headers: { host: "console.test", ...options.headers } });
  try {
    const res = await get(); assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store"); assert.equal(((await res.json()) as { entries: unknown[] }).entries.length, 1);
    assert.equal((await get("?limit=999")).status, 400);
    assert.equal((await get("", { headers: { origin: "https://evil.test" } })).status, 403);
    assert.equal((await get("", { method: "POST" })).status, 405);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(origin + "/console2/api/v1/activity", { headers: { host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 421);
  } finally { await f.server.stop(); }
});

test("workflow interaction metadata comes from authoritative wait/decision state, including information prompts", () => {
  const run = emptyFactoryRun("fr_abcd");
  run.status = "waiting"; run.wait.kind = "info"; run.wait.since = 10;
  assert.equal(factoryInteraction(run).pending, true);
  const old = factoryInteraction(run).key;
  run.wait.since = 20; assert.notEqual(factoryInteraction(run).key, old);
  run.wait.kind = "merge"; assert.equal(factoryInteraction(run).pending, true);
  run.slack.decision = { kind: "approve", since: 20, by: "U1", at: 30 };
  assert.equal(factoryInteraction(run).pending, false);
  run.status = "completed"; assert.equal(factoryInteraction(run).pending, false);
});

test("credential redaction handles quoted values, unclosed fences, JWTs and fine-grained tokens", () => {
  const samples = [
    '\"password\": \"a long credential with spaces\"',
    '~~~unclosed private code',
    '```unclosed private code',
    'github_pat_hiddencredential',
    'eyJhbGciOiJub25lIn0.privatepayload.signature',
    '-----BEGIN PRIVATE KEY----- unclosed private key',
  ];
  for (const text of samples) {
    const snippet = activitySnippet(text);
    assert.ok(!snippet.includes("long credential") && !snippet.includes("private") && !snippet.includes("hiddencredential"), snippet);
  }
});

test("file source links are restricted to safe Slack permalinks", () => {
  const f = setup();
  f.log.record({ key: "file", kind: "message", title: "Document published", fileUrl: "https://team.slack.com/files/U123/F123/report.pdf?secret=omitted#private" });
  assert.equal(buildActivity(f.source, query(), T).entries[0]!.sourceUrl, "https://team.slack.com/files/U123/F123/report.pdf");
  for (const raw of ["javascript:alert(1)", "https://evil.test/files/U123/F123/a", "https://team.slack.com.evil.test/files/U123/F123/a", "https://user:secret@team.slack.com/files/U123/F123/a", "https://team.slack.com/api/private"]) assert.equal(slackFileUrl(raw), undefined);
});


test("incremental pagination retains its state-change filter and ceiling across all pages", () => {
  const f = setup();
  for (let i = 0; i < 7; i++) {
    f.log.record({ key: `approval-${i}`, kind: "approval", title: `Approval ${i}`, sourceTs: `1793520000.00000${i}`, interaction: "pending" });
    f.tick();
  }
  const initial = buildActivity(f.source, query(), f.now());
  f.tick();
  for (let i = 0; i < 7; i++) f.log.resolve(`1793520000.00000${i}`);
  const q = query(`limit=2&since=${initial.watermark}`);
  let page = buildActivity(f.source, q, f.now());
  const until = page.watermark;
  const updates = [...page.entries];
  f.tick();
  f.log.record({ key: "later", kind: "chat", title: "Arrived during poll" });
  while (page.nextCursor) {
    page = buildActivity(f.source, query(`limit=2&cursor=${page.nextCursor}`), f.now());
    assert.equal(page.watermark, until);
    updates.push(...page.entries);
  }
  assert.equal(updates.length, 7);
  assert.equal(new Set(updates.map((row) => row.id)).size, 7);
  assert.ok(updates.every((row) => row.interaction === "resolved"));
  const next = buildActivity(f.source, query(`since=${until}`), f.now());
  assert.ok(next.entries.some((row) => row.title === "Arrived during poll"));
});
