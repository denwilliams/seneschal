import assert from "node:assert/strict";
import { request } from "node:http";
import { after, test } from "node:test";
import { FactoryRunError, type FactoryRunService } from "../factory/workflow/service.ts";
import { ConsoleMergeApprovals } from "../factory/workflow/console-approvals.ts";
import { ActionLimiter, MAX_BODY_BYTES } from "./actions.ts";
import { console2Route } from "./handler.ts";
import type { Console2Actions } from "./source.ts";
import { fixture, roots, SECRET } from "./fixture.ts";
import { clearTimelineCache } from "./timeline-cache.ts";

after(() => { clearTimelineCache(); });
void roots;

/** A service that records what it was asked and can be told to refuse: the transport is what these tests are about. */
function stub() {
  const calls: unknown[][] = [];
  const polls: string[] = [];
  const audits: { event: string; fields: Record<string, unknown> }[] = [];
  const control = { refuse: undefined as string | undefined, slow: undefined as Promise<void> | undefined, notFactory: false };
  const maybe = async () => { if (control.slow) await control.slow; if (control.refuse) throw new FactoryRunError(control.refuse); };
  const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); await maybe(); };
  const service = {
    decide: record("decide"), abort: record("abort"), recheckIssue: record("recheck"), answer: async (...args: unknown[]) => { calls.push(["answer", ...args]); await maybe(); return { commented: true }; },
    start: async (...args: unknown[]) => { calls.push(["start", ...args]); await maybe(); return { runId: "frun_new", repo: "acme/web", issue: 9, title: `A title ${SECRET}` }; },
    approve: record("approve"), decline: record("decline"), moreRounds: record("moreRounds"),
  } as unknown as FactoryRunService;
  const remotes: string[] = [];
  const identities: unknown[] = [];
  const actions: Console2Actions = {
    service: (_channelId, remote, identity) => { identities.push(identity); remotes.push(remote); return control.notFactory ? undefined : service; },
    pollNow: (channelId) => { polls.push(channelId); return true; },
    audit: (_channelId, event, fields) => { audits.push({ event, fields }); },
  };
  return { actions, calls, polls, audits, control, remotes, identities };
}

async function boot(options: { dm?: boolean; actions?: Console2Actions | false } = {}) {
  const s = stub();
  const f = fixture({ factory: true, ...(options.dm ? { dm: true } : {}), actions: options.actions === undefined ? s.actions : options.actions });
  await f.server.start();
  const port = (f.server.address() as { port: number }).port;
  const post = async (path: string, body: unknown = {}, headers: Record<string, string | undefined> = {}) => {
    const sent: Record<string, string> = { host: "console.test", "content-type": "application/json", "x-console-action": "1" };
    for (const [key, value] of Object.entries(headers)) { if (value === undefined) delete sent[key]; else sent[key] = value; }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: sent, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: () => JSON.parse(text) };
  };
  const run = (name: string, runId = "frun_failed") => `/console2/api/v1/channels/${f.channelId}/workflows/${runId}/actions/${name}`;
  const factory = (name: string) => `/console2/api/v1/channels/${f.channelId}/factory/${name}`;
  return { f, s, port, post, run, factory, stop: () => f.server.stop() };
}

test("action routes are a closed list: merge decisions need verification, direct merging and the rest do not exist", () => {
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/workflows/frun_1/actions/retry"), { page: "action", target: { channelId: "C1", runId: "frun_1", action: "retry" } });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/factory/start"), { page: "action", target: { channelId: "C1", action: "start" } });
  assert.deepEqual(console2Route("/console2/api/v1/channels/C1/factory/poll"), { page: "action", target: { channelId: "C1", action: "poll" } });
  for (const name of ["more_rounds", "stop", "merge", "release", "create_issue", "constructor", "__proto__", "toString"]) {
    assert.equal(console2Route(`/console2/api/v1/channels/C1/workflows/frun_1/actions/${name}`), undefined, name);
    assert.equal(console2Route(`/console2/api/v1/channels/C1/factory/${name}`), undefined, name);
  }
  assert.equal(console2Route("/console2/api/v1/channels/C1/workflows/a%2Fb/actions/retry"), undefined);
});

test("with the switch off, every action is refused and nothing is called", async () => {
  const b = await boot({ actions: false });
  try {
    const r = await b.post(b.run("retry"));
    assert.equal(r.status, 403);
    assert.match(r.json().error, /turned off/);
    assert.equal((await b.post(b.factory("poll"))).status, 403);
    assert.deepEqual(b.s.calls, []);
  } finally { await b.stop(); }
});

test("a console action needs JSON, the custom header, and an origin that is this server's own", async () => {
  const b = await boot();
  try {
    assert.equal((await b.post(b.run("retry"), {}, { "content-type": "text/plain" })).status, 415);
    assert.equal((await b.post(b.run("retry"), "retry", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await b.post(b.run("retry"), {}, { "x-console-action": undefined })).status, 403);
    assert.equal((await b.post(b.run("retry"), {}, { "x-console-action": "0" })).status, 403);
    assert.equal((await b.post(b.run("retry"), {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post(b.run("retry"), {}, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await b.post(b.run("retry"), {}, { "sec-fetch-site": "same-site" })).status, 403);
    assert.deepEqual(b.s.calls, [], "none of those reached the service");
    assert.equal((await b.post(b.run("retry"), {}, { origin: "http://console.test", "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await b.post(b.run("retry", "frun_failed"), {}, { "content-type": "application/json; charset=utf-8" })).status, 200);
    assert.equal(b.s.calls.length, 2);
  } finally { await b.stop(); }
});

test("a request for another host is refused before anything else (DNS rebinding)", async () => {
  const b = await boot();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: b.port, path: b.run("retry"), method: "POST", headers: { host: "attacker.example", "content-type": "application/json", "x-console-action": "1" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 421);
    assert.deepEqual(b.s.calls, []);
  } finally { await b.stop(); }
});

test("only POST acts; a GET or an OPTIONS on an action route is not an action, and no CORS is answered", async () => {
  const b = await boot();
  try {
    const get = await fetch(`http://127.0.0.1:${b.port}${b.run("retry")}`, { headers: { host: "console.test" } });
    assert.equal(get.status, 405);
    const options = await fetch(`http://127.0.0.1:${b.port}${b.run("retry")}`, { method: "OPTIONS", headers: { host: "console.test", origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-console-action" } });
    assert.equal(options.status, 405);
    assert.equal(options.headers.get("access-control-allow-origin"), null);
    const put = await fetch(`http://127.0.0.1:${b.port}${b.run("retry")}`, { method: "PUT", headers: { host: "console.test", "content-type": "application/json", "x-console-action": "1" }, body: "{}" });
    assert.equal(put.status, 405);
    assert.deepEqual(b.s.calls, []);
  } finally { await b.stop(); }
});

test("unverified merge decisions are refused; more rounds and direct merges are unknown routes", async () => {
  const b = await boot();
  try {
    for (const name of ["approve", "decline", "abort/../approve"]) {
      assert.equal((await b.post(b.run(name))).status, 403, name);
    }
    for (const name of ["more_rounds", "stop", "merge", "release"]) {
      const r = await b.post(b.run(name));
      assert.equal(r.status, 404, name);
    }
    assert.equal((await b.post(b.factory("approve"))).status, 404);
    assert.equal((await b.post(b.factory("create_issue"), { title: "x", body: "y" })).status, 404);
    assert.equal((await b.post("/console2/api/v1/channels/CCHAN001/session")).status, 405, "a POST to a page that only reads is the wrong method, as before");
    assert.deepEqual(b.s.calls, []);
  } finally { await b.stop(); }
});

test("a body that is too large, not JSON, or has keys it should not is refused; unknown keys are not ignored", async () => {
  const b = await boot();
  try {
    const oversized = await b.post(b.run("answer"), { text: "x".repeat(MAX_BODY_BYTES + 10) });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("connection"), "close");
    assert.deepEqual(oversized.json(), { error: "That request is too large." });
    assert.equal((await b.post(b.run("retry"), "{not json")).status, 400);
    assert.equal((await b.post(b.run("retry"), { stage: "implement" })).status, 400, "retry takes no arguments");
    assert.equal((await b.post(b.run("retry"), { by: "U1" })).status, 400, "nobody can name who is acting");
    assert.equal((await b.post(b.run("answer"), { text: "ok", user: "U1" })).status, 400);
    assert.equal((await b.post(b.run("answer"), { text: "" })).status, 400);
    assert.equal((await b.post(b.run("answer"), { text: "x".repeat(4001) })).status, 400);
    assert.equal((await b.post(b.run("answer"), { text: 5 })).status, 400);
    assert.equal((await b.post(b.run("restart_from"), { stage: "Implement; rm -rf /" })).status, 400);
    assert.equal((await b.post(b.run("restart_from"), {})).status, 400);
    assert.equal((await b.post(b.factory("start"), { issue: "x".repeat(300) })).status, 400);
    assert.equal((await b.post(b.factory("start"), { issue: "#1", repo: "other/repo" })).status, 400);
    assert.deepEqual(b.s.calls, []);
  } finally { await b.stop(); }
});

test("an oversized chunked action returns 413, closes the connection, and leaves the server alive", async () => {
  const b = await boot();
  try {
    // A streaming fetch has no Content-Length, so this must reach the body iterator's limit check.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.close();
      },
    });
    const res = await fetch(`http://127.0.0.1:${b.port}${b.factory("poll")}`, {
      method: "POST",
      headers: { host: "console.test", "content-type": "application/json", "x-console-action": "1" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
    assert.deepEqual(await res.json(), { error: "That request is too large." });
    assert.deepEqual(b.s.polls, [], "an oversized body never reaches the action");
    assert.deepEqual(b.s.audits, []);
    assert.equal((await b.post(b.factory("poll"))).status, 200, "a subsequent action still succeeds");
    assert.deepEqual(b.s.polls, [b.f.channelId]);
  } finally { await b.stop(); }
});

test("an oversized chunked action is answered before the upload finishes", async () => {
  const b = await boot();
  try {
    const result = await new Promise<{ status: number; connection: string | undefined; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: b.port, path: b.factory("poll"), method: "POST", headers: {
        host: "console.test", "content-type": "application/json", "x-console-action": "1", "transfer-encoding": "chunked",
      } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body });
          req.destroy();
        });
      });
      req.on("error", reject);
      // Do not end the upload: the server must answer without draining the rest of an unbounded body.
      req.write(Buffer.alloc(MAX_BODY_BYTES + 1));
    });
    assert.equal(result.status, 413);
    assert.equal(result.connection, "close");
    assert.deepEqual(JSON.parse(result.body), { error: "That request is too large." });
    assert.deepEqual(b.s.polls, []);
    assert.equal((await b.post(b.factory("poll"))).status, 200);
  } finally { await b.stop(); }
});

test("each action asks the service for exactly that, and says what happened in fixed words", async () => {
  const b = await boot();
  try {
    assert.equal((await b.post(b.run("retry"))).json().message, "Retrying.");
    assert.equal((await b.post(b.run("skip"), {})).json().message, "Skipped.");
    assert.equal((await b.post(b.run("restart_from"), { stage: "triage" })).json().message, "Going back to triage.");
    assert.equal((await b.post(b.run("abort"))).json().message, "Aborted.");
    assert.equal((await b.post(b.run("recheck"))).json().message, "Reading the issue again.");
    assert.equal((await b.post(b.run("answer"), { text: "Accounts over 10k users" })).json().message, "Answer recorded on the issue. The run carries on.");
    const started = (await b.post(b.factory("start"), { issue: "acme/web#9", notes: "go" })).json();
    assert.deepEqual(started, { ok: true, message: "Run started.", runId: "frun_new" });
    assert.deepEqual((await b.post(b.factory("poll"))).json(), { ok: true, message: "Polling now." });
    assert.deepEqual(b.s.calls, [
      ["decide", "frun_failed", "retry"], ["decide", "frun_failed", "skip"], ["decide", "frun_failed", "restart_from", "triage"], ["abort", "frun_failed"],
      ["recheck", "frun_failed"], ["answer", "frun_failed", "Accounts over 10k users"], ["start", "acme/web#9", "go"],
    ]);
    assert.deepEqual(b.s.polls, [b.f.channelId]);
    assert.ok(b.s.remotes.every((remote) => /^127\.0\.0\.1$/.test(remote)), "the service is told where it came from");
  } finally { await b.stop(); }
});

test("a refusal from the service is a 409 that says why; an unknown run is a 404; every outcome is audited with the caller", async () => {
  const b = await boot();
  try {
    b.s.control.refuse = "Run frun_failed has already finished (completed).";
    const refused = await b.post(b.run("retry"));
    assert.equal(refused.status, 409);
    assert.match(refused.json().error, /already finished/);
    b.s.control.refuse = "There is no workflow run frun_zzz.";
    assert.equal((await b.post(b.run("abort", "frun_zzz"))).status, 404);
    b.s.control.refuse = undefined;
    await b.post(b.run("retry"));
    const lines = b.s.audits.map((a) => a.fields);
    assert.deepEqual(lines.map((l) => [l.actor, l.action, l.runId, l.outcome]), [["console", "retry", "frun_failed", "refused"], ["console", "abort", "frun_zzz", "refused"], ["console", "retry", "frun_failed", "ok"]]);
    assert.ok(lines.every((l) => l.remote === "127.0.0.1"));
    assert.match(String(lines[0]!.reason), /already finished/);
    b.s.control.notFactory = true;
    assert.equal((await b.post(b.run("retry"))).status, 404);
  } finally { await b.stop(); }
});

test("an action in a direct message channel shows structure only: a refusal is a fixed sentence, a start does not echo the title", async () => {
  const b = await boot({ dm: true });
  try {
    b.s.control.refuse = `Run frun_failed ended failed (boom ${SECRET}).`;
    const refused = await b.post(`/console2/api/v1/channels/${b.f.channelId}/workflows/frun_failed/actions/retry`);
    assert.equal(refused.status, 409);
    assert.ok(!refused.text.includes(SECRET) && !refused.text.includes("boom"));
    assert.ok(b.s.audits.every((a) => !JSON.stringify(a.fields).includes(SECRET)), "nor does the audit line carry the reason");
    b.s.control.refuse = undefined;
    const started = await b.post(`/console2/api/v1/channels/${b.f.channelId}/factory/start`, { issue: "#9" });
    assert.ok(!started.text.includes(SECRET) && !started.text.includes("A title"));
    assert.equal(started.status, 200);
  } finally { await b.stop(); }
});

test("a double click runs the action once: the second is told it is already being done", async () => {
  const b = await boot();
  try {
    let release: () => void = () => {};
    b.s.control.slow = new Promise<void>((resolve) => { release = resolve; });
    const first = b.post(b.run("abort"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await b.post(b.run("abort"));
    assert.equal(second.status, 409);
    assert.match(second.json().error, /already being done/);
    release();
    assert.equal((await first).status, 200);
    assert.equal(b.s.calls.filter((call) => call[0] === "abort").length, 1);
    assert.equal((await b.post(b.run("abort"))).status, 200, "and it can be done again once it has finished");
  } finally { await b.stop(); }
});

test("the rate limit holds per caller and overall, and says when to come back", () => {
  let now = 1_000_000;
  const limiter = new ActionLimiter({ perRemote: 3, global: 5, windowMs: 60_000 }, () => now);
  assert.equal(limiter.take("a"), undefined);
  assert.equal(limiter.take("a"), undefined);
  assert.equal(limiter.take("a"), undefined);
  assert.equal(limiter.take("a"), 60, "a fourth from the same caller waits for the first to age out");
  assert.equal(limiter.take("b"), undefined);
  assert.equal(limiter.take("b"), undefined);
  assert.ok((limiter.take("c") ?? 0) > 0, "the overall limit (5) stops a sixth from anyone");
  now += 61_000;
  assert.equal(limiter.take("a"), undefined, "and the window moves on");
});

test("merge controls require a run-scoped browser cookie verified by an authorized Slack user", async () => {
  const b = await boot();
  try {
    let challengeId = "";
    b.s.actions.mergeApprovals = new ConsoleMergeApprovals({
      run: async (channel, runId) => b.f.source.runtime(channel)?.store.factoryRun(runId),
      allowed: (_channel, _run, user) => user === "U1",
      post: async ({ id }) => { challengeId = id; },
    });
    const get = async (cookie = "") => (await (await fetch(`http://127.0.0.1:${b.port}/console2/api/v1/channels/${b.f.channelId}/workflows/frun_wait`, { headers: { host: "console.test", cookie } })).json() as { run: { guidance: { actions: string[]; mergeVerification: { state: string; challenge?: string } } } }).run.guidance;
    assert.deepEqual((await get()).actions, ["verify_approver", "abort"]);
    const route = (action: string) => b.run(action, "frun_wait");
    assert.equal((await b.post(route("approve"), { userId: "U1" })).status, 400);
    assert.equal((await b.post(route("approve"), {}, { "x-forwarded-user": "U1" })).status, 403);
    b.f.source.baseUrl = "https://console.test/proxy/harness";
    const request = await b.post(route("verify_approver"));
    assert.equal(request.status, 200);
    const rawCookie = request.headers.get("set-cookie")!;
    assert.match(rawCookie, /Path=\/proxy\/harness\/console2\/api\/v1\/; HttpOnly; SameSite=Strict; Max-Age=600; Secure$/);
    const cookie = rawCookie.split(";")[0]!;
    assert.equal((await get(cookie)).mergeVerification.state, "pending");
    assert.equal((await b.post(route("approve"), {}, { cookie })).status, 403);
    assert.equal(await b.s.actions.mergeApprovals.confirm(challengeId, "U2", b.f.channelId), false);
    assert.equal(await b.s.actions.mergeApprovals.confirm(challengeId, "U1", b.f.channelId), true);
    assert.equal((await b.post(route("approve"), {}, { cookie: `${cookie}; ${cookie}` })).status, 403, "ambiguous cookies cannot authorize a merge");
    const verified = await get(cookie);
    assert.deepEqual(verified.actions, ["approve", "decline", "abort"]);
    assert.deepEqual(verified.mergeVerification, { state: "verified" }, "neither Slack identity nor browser bearer token is exposed in the view");
    for (const action of ["approve", "decline"]) assert.equal((await b.post(route(action), {}, { cookie })).status, 200);
    assert.equal((await b.post(b.run("approve", "frun_info"), {}, { cookie })).status, 403, "a different run cannot borrow the identity");
    assert.deepEqual(b.s.calls, [["approve", "frun_wait"], ["decline", "frun_wait"]]);
    assert.equal((b.s.identities.at(-1) as { userId: string }).userId, "U1");
  } finally { await b.stop(); }
});

test("the server answers 429 with Retry-After when a caller sends too many", async () => {
  const b = await boot();
  try {
    let limited: { status: number; headers: Headers } | undefined;
    for (let i = 0; i < 30 && !limited; i++) {
      const r = await b.post(b.factory("poll"));
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, "the per-caller limit of 20 a minute was reached");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  } finally { await b.stop(); }
});

test("the tree says whether the console may act, so the page can say so", async () => {
  for (const [actions, expected] of [[false, undefined], [undefined, true]] as const) {
    const b = await boot(actions === false ? { actions: false } : {});
    try {
      const tree = await (await fetch(`http://127.0.0.1:${b.port}/console2/api/v1/tree`, { headers: { host: "console.test" } })).json() as { actions?: boolean };
      assert.equal(tree.actions, expected);
    } finally { await b.stop(); }
  }
});

test("the view says nothing can be done while the switch is off, and what can be done when it is on", async () => {
  const off = await boot({ actions: false });
  try {
    const res = await fetch(`http://127.0.0.1:${off.port}/console2/api/v1/channels/${off.f.channelId}/workflows/frun_failed`, { headers: { host: "console.test" } });
    const { run } = await res.json() as { run: { guidance?: { summary: string; actions?: string[] } } };
    assert.ok(run.guidance?.summary, "the guidance is read-only information and is always there for a stuck run");
    assert.equal(run.guidance?.actions, undefined, "but it offers no actions");
    const list = await (await fetch(`http://127.0.0.1:${off.port}/console2/api/v1/channels/${off.f.channelId}/workflows`, { headers: { host: "console.test" } })).json() as { actions?: unknown };
    assert.equal(list.actions, undefined);
  } finally { await off.stop(); }
  const on = await boot();
  try {
    const { run } = await (await fetch(`http://127.0.0.1:${on.port}/console2/api/v1/channels/${on.f.channelId}/workflows/frun_failed`, { headers: { host: "console.test" } })).json() as { run: { guidance: { actions: string[]; restartFrom: string[] } } };
    assert.deepEqual(run.guidance.actions, ["retry", "restart_from", "abort"]);
    assert.deepEqual(run.guidance.restartFrom, ["triage"]);
    const info = (await (await fetch(`http://127.0.0.1:${on.port}/console2/api/v1/channels/${on.f.channelId}/workflows/frun_info`, { headers: { host: "console.test" } })).json() as { run: { guidance: { actions: string[]; elsewhere: string[] } } }).run;
    assert.deepEqual(info.guidance.actions, ["answer", "recheck", "abort"]);
    const merge = (await (await fetch(`http://127.0.0.1:${on.port}/console2/api/v1/channels/${on.f.channelId}/workflows/frun_wait`, { headers: { host: "console.test" } })).json() as { run: { guidance: { actions: string[]; elsewhere: string[] } } }).run;
    assert.deepEqual(merge.guidance.actions, ["abort"], "without verification support merge decisions stay unavailable");
    assert.match(merge.guidance.elsewhere.join(" "), /Slack/);
    assert.match(info.guidance.elsewhere.join(" "), /factory_recheck_issue/, "the way to get a run that missed an answer going is named");
    const done = await fetch(`http://127.0.0.1:${on.port}/console2/api/v1/channels/${on.f.channelId}/workflows/frun_done`, { headers: { host: "console.test" } });
    assert.equal(((await done.json()) as { run: { guidance?: unknown } }).run.guidance, undefined, "a finished run has nothing to do");
    const list = await (await fetch(`http://127.0.0.1:${on.port}/console2/api/v1/channels/${on.f.channelId}/workflows`, { headers: { host: "console.test" } })).json() as { actions: { start: boolean; poll: boolean; repositories: string[] } };
    assert.deepEqual(list.actions, { start: true, poll: true, repositories: ["acme/web"] });
  } finally { await on.stop(); }
});

