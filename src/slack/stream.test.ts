import { test } from "node:test";
import assert from "node:assert/strict";
import type { WebClient } from "@slack/web-api";
import { SlackResponseStream } from "./stream.ts";

interface Call {
  method: string;
  args: Record<string, any>;
}

function mockClient(opts: { reactionsFail?: boolean } = {}) {
  const calls: Call[] = [];
  let ts = 0;
  const record = (method: string) => async (args: Record<string, any>) => {
    calls.push({ method, args });
    if (method === "reactions.add" && opts.reactionsFail) {
      const err: any = new Error("missing_scope");
      err.data = { error: "missing_scope" };
      throw err;
    }
    return { ok: true, ts: `100.${++ts}` };
  };

  const client = {
    chat: { postMessage: record("chat.postMessage"), update: record("chat.update") },
    reactions: { add: record("reactions.add"), remove: record("reactions.remove") },
    assistant: { threads: { setStatus: record("assistant.setStatus") } },
  } as unknown as WebClient;

  return { client, calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

const base = { channel: "C1", threadTs: "1.1", anchorTs: "1.0", ackEmoji: "hourglass" };

test("acknowledges with a reaction and posts no placeholder message", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({ client, ...base });

  await stream.open();

  assert.equal(of("reactions.add").length, 1, "reaction added immediately");
  assert.equal(of("reactions.add")[0]!.args.name, "hourglass");
  assert.equal(of("chat.postMessage").length, 0, "nothing posted on open");
});

test("a fast reply produces exactly one message and no intermediate state", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({ client, ...base });

  await stream.open();
  stream.appendText("The answer is 42.");
  await stream.close();

  assert.equal(of("chat.postMessage").length, 1, "one message");
  assert.equal(of("chat.update").length, 0, "never edited");
  assert.equal(of("chat.postMessage")[0]!.args.text, "The answer is 42.");
});

test("the acknowledgement reaction is removed when the reply lands", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({ client, ...base });

  await stream.open();
  stream.appendText("done");
  await stream.close();

  assert.equal(of("reactions.remove").length, 1);
  assert.equal(of("reactions.remove")[0]!.args.name, "hourglass");
});

test("a slow tool-only turn eventually shows progress", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 300,
  });

  await stream.open();
  stream.setStatus("running `bash`…");

  // Before the progress threshold, still silent. The margin is wide so a busy machine cannot make the wait overshoot it.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(of("chat.postMessage").length, 0, "silent while still fast");

  // After it, a progress message appears.
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(of("chat.postMessage").length, 1, "progress shown for a slow turn");
  assert.match(of("chat.postMessage")[0]!.args.text, /running/);

  await stream.close("finished");
});


test("a silent model turn eventually shows thinking progress", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 20,
  });

  await stream.open();
  stream.setStatus("thinking…");
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(of("chat.postMessage").length, 1, "progress shown without a tool event");
  assert.match(of("chat.postMessage")[0]!.args.text, /thinking/);

  await stream.close("finished");
});


test("a visible status is refreshed with elapsed time while work stays silent", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 0,
    statusHeartbeatMs: 30,
  });

  await stream.open();
  stream.setStatus("thinking…");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(of("chat.postMessage").length, 1, "initial status posted");

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(of("chat.update").some((c) => /still working/.test(c.args.text)), "status heartbeat shown");

  await stream.close("finished");
});

test("a deferred status stays hidden when the turn finishes quickly", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 0,
    quietAfterMs: 500,
  });

  await stream.open();
  stream.setStatus("running `bash`…", { defer: true });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(of("chat.postMessage").length, 0, "nothing shown for a quick tool");

  await stream.close("The answer is 42.");
  assert.equal(of("chat.postMessage").length, 1, "one message");
  assert.equal(of("chat.postMessage")[0]!.args.text, "The answer is 42.");
});

test("a deferred status appears once the turn goes quiet", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 0,
    quietAfterMs: 40,
  });

  await stream.open();
  stream.setStatus("running `bash`…", { defer: true });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(of("chat.postMessage").length, 0, "held back while still fast");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(of("chat.postMessage").length, 1, "shown once the turn went quiet");
  assert.match(of("chat.postMessage")[0]!.args.text, /running `bash`/);

  await stream.close("done");
});

test("streaming text resets the quiet clock, so tool status stays hidden", async () => {
  const { client, calls, of } = mockClient();
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 0,
    quietAfterMs: 50,
  });

  await stream.open();
  stream.setStatus("running `bash`…", { defer: true });

  // Text keeps arriving, so the user has feedback and the status is not needed.
  for (let i = 0; i < 5; i++) {
    stream.appendText("word ");
    await new Promise((r) => setTimeout(r, 20));
  }

  const rendered = () =>
    calls.filter((c) => c.method === "chat.postMessage" || c.method === "chat.update");
  assert.ok(rendered().length > 0, "the text itself was posted");
  assert.ok(
    !rendered().some((c) => /running `bash`/.test(c.args.text)),
    "status withheld while text was still streaming",
  );

  // Once the text stops, the still-running tool is worth explaining.
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(
    rendered().some((c) => /running `bash`/.test(c.args.text)),
    "status shown once the stream fell silent",
  );

  await stream.close("done");
});

test("a deferred status is not withheld when there is no reaction to rely on", async () => {
  const { client, of } = mockClient({ reactionsFail: true });
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 0,
    quietAfterMs: 60_000,
  });

  await stream.open();
  stream.setStatus("running `bash`…", { defer: true });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(of("chat.postMessage").length, 1, "shown immediately without an ack");
  await stream.close("done");
});

test("falls back to a visible progress message when reacting fails", async () => {
  const { client, of } = mockClient({ reactionsFail: true });
  const stream = new SlackResponseStream({
    client,
    ...base,
    updateIntervalMs: 10,
    progressAfterMs: 60_000,
  });

  await stream.open();
  stream.setStatus("working…");
  await new Promise((r) => setTimeout(r, 40));

  // No reaction was possible, so the user must see something in the channel
  // without waiting for the normal progress delay.
  assert.equal(of("chat.postMessage").length, 1);
  await stream.close("done");
  assert.equal(of("reactions.remove").length, 0, "nothing to remove");
});

test("errors are reported and the acknowledgement is cleared", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({ client, ...base });

  await stream.open();
  await stream.fail("Something went wrong");

  assert.equal(of("chat.postMessage").length, 1);
  assert.match(of("chat.postMessage")[0]!.args.text, /Something went wrong/);
  assert.equal(of("reactions.remove").length, 1, "reaction cleared on failure");
});

test("drives the native assistant status in assistant threads", async () => {
  const { client, of } = mockClient();
  const stream = new SlackResponseStream({ client, ...base, assistantThread: true });

  await stream.open();
  assert.ok(of("assistant.setStatus").length >= 1);
  assert.equal(of("assistant.setStatus")[0]!.args.status, "is thinking...");

  await stream.close("done");
  const last = of("assistant.setStatus").at(-1)!;
  assert.equal(last.args.status, "", "status cleared when finished");
});

test("a long reply still updates in place rather than posting twice", async () => {
  const { client, of } = mockClient({});
  const stream = new SlackResponseStream({ client, ...base, updateIntervalMs: 10 });

  await stream.open();
  stream.appendText("partial…");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(of("chat.postMessage").length, 1, "posted once streaming started");

  stream.appendText(" and the rest");
  await stream.close();

  assert.equal(of("chat.postMessage").length, 1, "no second message");
  assert.ok(of("chat.update").length >= 1, "final text delivered by edit");
  assert.equal(of("chat.update").at(-1)!.args.text, "partial… and the rest");
});

for (const scenario of ["update", "first text post", "first progress post"] as const) {
  test(`failure waits for an in-flight ${scenario} before rendering its notice`, { timeout: 5_000 }, async (t) => {
    // The production flush timer is unref'd; keep the test alive while awaiting its request.
    const keepAlive = setTimeout(() => {}, 5_000);
    t.after(() => clearTimeout(keepAlive));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    let posted!: () => void;
    const firstPost = new Promise<void>((resolve) => { posted = resolve; });
    const messages = new Map<string, string>();
    const calls: Call[] = [];
    let acknowledgementsCleared = 0;
    const render = (method: string) => async (args: Record<string, any>) => {
      calls.push({ method, args });
      const interim = !args.text.startsWith(":warning:");
      if (interim && (scenario === "update" ? method === "chat.update" : method === "chat.postMessage")) {
        started();
        await held;
      }
      const ts = args.ts ?? `reply-${messages.size + 1}`;
      messages.set(ts, args.text);
      if (method === "chat.postMessage") posted();
      return { ok: true, ts };
    };
    const client = {
      chat: { postMessage: render("chat.postMessage"), update: render("chat.update") },
      reactions: { add: async () => {}, remove: async () => { acknowledgementsCleared++; } },
    } as unknown as WebClient;
    const stream = new SlackResponseStream({ client, ...base, updateIntervalMs: 5, progressAfterMs: 0 });
    await stream.open();
    if (scenario === "first progress post") stream.setStatus("thinking…");
    else stream.appendText("Partial");
    if (scenario === "update") {
      await firstPost;
      stream.appendText(" answer");
    }
    await inFlight;
    const failed = stream.fail("502: stream interrupted");
    try {
      // Let fail() run while the older Slack request remains blocked.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls.filter((call) => call.args.text.startsWith(":warning:")).length, 0,
        "terminal notice must not race an older interim request");
      assert.equal(acknowledgementsCleared, 0, "acknowledgement stays until final delivery");
    } finally {
      release();
      await failed;
    }
    assert.deepEqual([...messages.values()], [":warning: 502: stream interrupted"],
      "notice remains visible with no orphan partial/progress message");
    assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1);
    assert.equal(acknowledgementsCleared, 1);
  });
}
