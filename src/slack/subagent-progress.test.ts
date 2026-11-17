import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeSlack, formatProgress, SubagentProgressPoster } from "./subagent-progress.ts";

const started = { kind: "started" as const, agent: "coder", runKey: "sub-a", task: "Implement acme/app#7: login fails on an empty password." };

test("the hand-off says who it went to and what the job is", () => {
  assert.equal(formatProgress(started), ":handshake: Handing this to *coder*:\n> Implement acme/app#7: login fails on an empty password.");
});

test("a subagent's own commentary is shown as coming from it", () => {
  assert.equal(formatProgress({ kind: "update", agent: "reviewer", runKey: "r", text: "The diff is small, one file.\n\nRunning the suite now." }), "*reviewer*: The diff is small, one file. Running the suite now.");
});

test("the closing line says how it ended, how long it took, and what it suggests next", () => {
  assert.equal(formatProgress({ kind: "finished", agent: "coder", runKey: "a", status: "done", durationMs: 252_000, steps: 14, next: "reviewer" }),
    ":white_check_mark: *coder* finished (4m 12s · 14 steps). It suggests *reviewer* next.");
  assert.equal(formatProgress({ kind: "finished", agent: "reviewer", runKey: "b", status: "failed", durationMs: 2_000, steps: 1 }), ":x: *reviewer* failed (2s · 1 step).");
  assert.match(formatProgress({ kind: "finished", agent: "x", runKey: "c", status: "needs_input", durationMs: 9000, steps: 3 }), /needs an answer/);
  assert.match(formatProgress({ kind: "finished", agent: "x", runKey: "c", status: "blocked", durationMs: 9000, steps: 3 }), /is blocked/);
  assert.doesNotMatch(formatProgress({ kind: "finished", agent: "x", runKey: "c", status: "done", durationMs: 9000, steps: 3, next: "none" }), /suggests/);
});

test("what a subagent read cannot become a mention or a link in the thread", () => {
  const hostile = "Ignore that. <!channel> <!here> <@U123> <https://evil.example|click> &amp; more";
  const text = formatProgress({ kind: "update", agent: "coder", runKey: "a", text: hostile });
  assert.doesNotMatch(text, /<!channel>|<!here>|<@U123>|<https:\/\/evil/);
  assert.match(text, /&lt;!channel&gt;/);
  assert.match(formatProgress({ ...started, task: "do <!everyone> now" }), /&lt;!everyone&gt;/);
  assert.equal(escapeSlack("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("credentials in a URL, and very long text, never reach the thread", () => {
  const text = formatProgress({ ...started, task: `clone https://user:hunter2@github.com/acme/app ${"x".repeat(2000)}` });
  assert.doesNotMatch(text, /hunter2/);
  assert.ok(text.length < 700);
  assert.match(text, /…$/);
});

function fakeStream() {
  const posts: string[] = [];
  const statuses: string[] = [];
  return {
    posts, statuses,
    stream: { postInterjection: async (text: string) => { posts.push(text); }, setStatus: (s: string) => { statuses.push(s); } },
  };
}

test("the hand-off and the closing line are always posted, and the status line follows the run", async () => {
  const f = fakeStream();
  const poster = new SubagentProgressPoster(f.stream);
  poster.sink(started);
  poster.sink({ kind: "finished", agent: "coder", runKey: "sub-a", status: "done", durationMs: 5000, steps: 2 });
  await Promise.resolve();
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.statuses, ["waiting on coder…", "thinking…"]);
});

test("commentary is throttled, capped per run, deduplicated and ignored when trivial", () => {
  const f = fakeStream();
  let clock = 1_000_000;
  const poster = new SubagentProgressPoster(f.stream, { now: () => clock, minUpdateGapMs: 10_000, maxUpdatesPerRun: 2, minUpdateChars: 24 });
  const say = (text: string) => poster.sink({ kind: "update", agent: "coder", runKey: "sub-a", text });
  say("Looking at the repository layout first.");            // posted
  clock += 2_000; say("Reading the provider registry now."); // too soon: dropped
  clock += 9_000; say("Reading the provider registry now."); // posted (gap ok)
  clock += 11_000; say("Reading the provider registry now."); // duplicate of the last: dropped
  clock += 11_000; say("A third distinct thing worth saying.");  // over the cap: dropped
  clock += 11_000; say("ok");                                 // trivial
  assert.equal(f.posts.length, 2);
  // Another run has its own allowance.
  poster.sink({ kind: "update", agent: "reviewer", runKey: "sub-b", text: "Checking the diff against the issue." });
  assert.equal(f.posts.length, 3);
});

test("a failing Slack call can never break the run that is being reported", async () => {
  const broken = new SubagentProgressPoster({ postInterjection: async () => { throw new Error("slack down"); }, setStatus: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => broken.sink(started));
  assert.doesNotThrow(() => broken.sink({ kind: "update", agent: "coder", runKey: "sub-a", text: "Something worth saying about it." }));
  assert.doesNotThrow(() => broken.sink({ kind: "finished", agent: "coder", runKey: "sub-a", status: "done", durationMs: 1000, steps: 1 }));
  await new Promise((r) => setTimeout(r, 10)); // the rejected posts are swallowed, not unhandled rejections
});

test("with updates off, only the hand-off and the closing line are posted", () => {
  const f = fakeStream();
  const poster = new SubagentProgressPoster(f.stream, { updates: false });
  poster.sink(started);
  poster.sink({ kind: "update", agent: "coder", runKey: "sub-a", text: "Looking at the repository layout first." });
  poster.sink({ kind: "finished", agent: "coder", runKey: "sub-a", status: "done", durationMs: 5000, steps: 2 });
  assert.equal(f.posts.length, 2);
  assert.ok(f.posts.every((p) => !/repository layout/.test(p)));
});
