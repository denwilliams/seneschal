import assert from "node:assert/strict";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ArtifactServer, webServerPlan } from "../artifacts/server.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { fixture } from "../console2/fixture.ts";
import { clearTimelineCache } from "../console2/timeline-cache.ts";
import { emptyFactoryRun, type FactoryRunData } from "./workflow/docs.ts";
import { createFactoryRunService, type FactoryRunStore } from "./workflow/service.ts";
import type { FactoryGitHub } from "./workflow/deps.ts";

after(clearTimelineCache);

async function boot(options: { token?: string; actions?: boolean; enabled?: boolean; multi?: boolean; dm?: boolean; prefix?: string } = {}) {
  const f = fixture({ factory: true, dm: options.dm });
  const channel = f.source.channels()[0]!;
  const resolved = f.source.resolve(channel)!;
  if (options.multi) resolved.factory!.repositories.push("acme/api");
  const runtime = f.source.runtime(channel.id)!;
  const runs = await runtime.store.listFactoryRuns();
  const calls: unknown[][] = [];
  const control = { slow: undefined as Promise<void> | undefined, fail: false };
  let next = 0;
  const store: FactoryRunStore = Object.assign(runtime.store, {
    async startFactoryRun(input: Parameters<FactoryRunStore["startFactoryRun"]>[0]) {
      calls.push(["start", input.repo, input.issue, input.by]);
      if (control.slow) await control.slow;
      const run = Object.assign(emptyFactoryRun(`new_${++next}`), {
        repo: input.repo, issue: input.issue, issueTitle: input.issueTitle, issueUrl: input.issueUrl,
        startedAt: Date.now(), updatedAt: Date.now(), current: "triage",
      });
      runs.push(run);
      return { runId: run.runId };
    },
    async addFactoryRunUpdate(runId: string, update: FactoryRunData["updates"][number]) {
      calls.push(["update", runId, update]);
      runs.find((r) => r.runId === runId)!.updates.push(update);
    },
    async decideFactoryRun(...args: unknown[]) { calls.push(["decide", ...args]); if (control.slow) await control.slow; if (control.fail) throw new Error("private failure secret"); },
    async reopenFactoryRun(runId: string) {
      calls.push(["reopen", runId]); const run = runs.find((r) => r.runId === runId)!;
      run.status = "running"; run.wait = { kind: "", since: 0 };
    },
    async abortFactoryRun(runId: string) {
      calls.push(["abort", runId]); const run = runs.find((r) => r.runId === runId)!;
      run.status = "aborted"; return "marked" as const;
    },
  });
  const github = {
    async readIssue(repo: string, issue: number) {
      calls.push(["readIssue", repo, issue]);
      if (issue === 404) return undefined;
      return { number: issue, title: "Existing issue", url: `https://github.com/${repo}/issues/${issue}`, state: issue === 410 ? "closed" : "open" };
    },
    async commentIssue(input: unknown) { calls.push(["comment", input]); },
  } as unknown as FactoryGitHub;
  const remotes: string[] = [];
  const audits: unknown[] = [];
  f.source.actions = {
    service: (_channelId, remote) => {
      remotes.push(remote);
      return createFactoryRunService({ channel: resolved, store: () => store, github: () => github, source: "operator", actor: { kind: "console", remote }, currentUserId: () => "", threadKey: "", auditFile: join(f.dataDir, "factory-audit.jsonl") });
    },
    pollNow: () => true,
    audit: (...args) => { audits.push(args); },
  };
  // The adapter must not trust actionsEnabled from its source; only the server's switch counts.
  f.source.actionsEnabled = true;
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: `http://console.test${options.prefix ?? ""}`, artifacts: false, console: true, actions: options.actions !== false,
    ...(options.enabled === false ? {} : { mcp: { enabled: true, bearerToken: options.token } }) }, f.dataDir, {}, undefined, undefined, undefined, () => f.source);
  await server.start();
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}${options.prefix ?? ""}/mcp`;
  const request = async (body: unknown, headers: Record<string, string> = {}, method = "POST", url = endpoint) => fetch(url, {
    method, headers: { host: "console.test", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...headers },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await request({ jsonrpc: "2.0", id: 1, method, params });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json() as Promise<{ result: { isError?: boolean; structuredContent: Record<string, any> } }>;
  };
  const call = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const task = (runId: string) => `${channel.id}:${runId}`;
  return { f, server, channel, resolved, runs, calls, remotes, audits, control, endpoint, request, rpc, call, task, stop: () => server.stop() };
}
const errorCode = (value: { isError?: boolean; structuredContent?: { error?: { code: string } } }) => { assert.equal(value.isError, true); return value.structuredContent?.error?.code; };

test("config is opt-in, preserves localhost, carries optional token without requiring one", () => {
  const defaults = HarnessConfigSchema.parse({});
  assert.equal(defaults.webConsole.host, "127.0.0.1");
  assert.equal(defaults.webConsole.mcp, undefined);
  const configured = HarnessConfigSchema.parse({ webConsole: { enabled: true, baseUrl: "http://localhost:3012", mcp: { enabled: true, bearerToken: "secret" } } });
  assert.deepEqual(webServerPlan(configured).mcp, { enabled: true, bearerToken: "secret" });
  for (const bearerToken of ["", " ", "two tokens", "newline\n"]) assert.equal(HarnessConfigSchema.safeParse({ webConsole: { mcp: { bearerToken } } }).success, false);
});

test("SDK client discovers all six tools and uses stateless Streamable HTTP on the existing listener", async () => {
  const b = await boot({ prefix: "/harness" });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(b.endpoint)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["get_task", "list_factories", "list_repositories", "list_tasks", "send_decision", "start_task"]);
    const listed = await client.callTool({ name: "list_factories" });
    assert.equal((listed.structuredContent as { factories: { factory_id: string }[] }).factories[0]!.factory_id, b.channel.id);
    const health = await fetch(b.endpoint.replace(/mcp$/, "health"));
    assert.equal(health.status, 200);
  } finally { await client.close(); await b.stop(); }
});

test("discovery uses configured factories/repos and hides rejected channels and DMs", async () => {
  const b = await boot({ multi: true });
  try {
    const factories = (await b.call("list_factories")).structuredContent.factories;
    assert.equal(factories[0].name, "Acme");
    assert.equal(factories[0].slack_channel.id, b.channel.id);
    const repos = (await b.call("list_repositories", { factory_id: b.channel.id })).structuredContent.repositories;
    assert.deepEqual(repos.map((r: { repository_id: string }) => r.repository_id), ["acme/web", "acme/api"]);
    assert.equal(repos[0].url, "https://github.com/acme/web");
    assert.equal(errorCode(await b.call("list_repositories", { factory_id: "unknown" })), "unknown_factory");
    b.f.source.resolve = () => undefined;
    assert.deepEqual((await b.call("list_factories")).structuredContent.factories, []);
    assert.equal(errorCode(await b.call("get_task", { task_id: b.task("frun_info") })), "unknown_factory");
  } finally { await b.stop(); }
  const dm = await boot({ dm: true });
  try { assert.deepEqual((await dm.call("list_factories")).structuredContent.factories, []); }
  finally { await dm.stop(); }
});

test("task filters distinguish blocked from human input, paginate after filtering and include older failures", async () => {
  const b = await boot();
  try {
    const first = (await b.call("list_tasks", { factory_id: b.channel.id, blocked: true, limit: 1 })).structuredContent;
    assert.equal(first.tasks.length, 1); assert.ok(first.next_cursor);
    const second = (await b.call("list_tasks", { factory_id: b.channel.id, blocked: true, limit: 1, cursor: first.next_cursor })).structuredContent;
    assert.notEqual(first.tasks[0].task_id, second.tasks[0].task_id);
    const input = (await b.call("list_tasks", { factory_id: b.channel.id, blocked: false, requires_input: true })).structuredContent.tasks;
    assert.deepEqual(input.map((r: { status: string }) => r.status), ["waiting", "waiting"]);
    const ended = (await b.call("list_tasks", { factory_id: b.channel.id, status: "failed", requires_input: false })).structuredContent.tasks;
    assert.equal(ended[0].task_id, b.task("frun_ended"));
    assert.equal(ended[0].blocked, true); assert.ok(ended[0].updated_at);
    assert.equal(errorCode(await b.call("list_tasks", { factory_id: b.channel.id, cursor: "not-a-cursor" })), "invalid_cursor");
    assert.equal(errorCode(await b.call("list_tasks", { factory_id: b.channel.id, repository: "not/member" })), "invalid_repository");
    const invalid = await b.call("list_tasks", { factory_id: b.channel.id, limit: 101 }); assert.equal(invalid.isError, true);
    const repo = (await b.call("list_tasks", { factory_id: b.channel.id, repository: "ACME/WEB" })).structuredContent.tasks;
    assert.equal(repo.length, b.runs.length);
    b.f.source.runtime = () => undefined;
    assert.equal(errorCode(await b.call("list_tasks", { factory_id: b.channel.id })), "unavailable");
  } finally { await b.stop(); }
});

test("get_task provides questions, reports, links, updates, decisions and allowed actions", async () => {
  const b = await boot();
  try {
    const run = b.runs.find((r) => r.runId === "frun_info")!;
    run.slack.channel = b.channel.id; run.slack.ts = "1700000000.000001";
    const info = (await b.call("get_task", { task_id: b.task("frun_info") })).structuredContent;
    assert.match(info.outstanding_question, /which account size/i);
    assert.match(info.recent_reports[0].report, /Which account size/);
    assert.ok(info.workflow.updatesReceived.some((u: { trusted: boolean }) => !u.trusted));
    assert.equal(info.links.slack_thread, `https://slack.com/archives/${b.channel.id}/p1700000000000001`);
    assert.deepEqual(info.available_actions, ["comment", "abort"]);
    assert.ok(info.decisions);
    const approval = (await b.call("get_task", { task_id: b.task("frun_wait") })).structuredContent;
    assert.match(approval.links.pull_request, /pull\/12/); assert.deepEqual(approval.available_actions, ["abort"]);
    assert.equal(errorCode(await b.call("get_task", { task_id: b.task("missing") })), "unknown_task");
    assert.equal(errorCode(await b.call("get_task", { task_id: "frun_info" })), "unknown_task");
    b.resolved.factory!.repositories = ["acme/api"];
    assert.equal(errorCode(await b.call("get_task", { task_id: b.task("frun_info") })), "invalid_repository");
  } finally { await b.stop(); }
});

test("start infers a sole repo, validates membership/existence, prevents duplicates and never guesses in multi-repo factories", async () => {
  const b = await boot();
  try {
    // Remove live fixture runs to leave capacity for the real service.
    b.runs.splice(0, b.runs.length);
    const started = (await b.call("start_task", { factory_id: b.channel.id, issue_number: 31 })).structuredContent;
    assert.equal(started.task_id, b.task("new_1")); assert.equal(started.task.status, "running");
    assert.equal(b.calls.find((c) => c[0] === "start")?.[1], "acme/web");
    assert.equal((b.calls.find((c) => c[0] === "start")?.[3] as { userId: string }).userId, "", "no invented Slack identity");
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 31 })), "workflow_refused");
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 404 })), "workflow_refused");
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 410 })), "workflow_refused");
    b.resolved.factory!.repositories.push("acme/api");
    const reads = b.calls.filter((c) => c[0] === "readIssue").length;
    const ambiguous = await b.call("start_task", { factory_id: b.channel.id, issue_number: 32 });
    assert.equal(errorCode(ambiguous), "ambiguous_repository"); assert.equal(ambiguous.structuredContent.error.details.choices.length, 2);
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 32, repository: "other/repo" })), "invalid_repository");
    assert.equal(b.calls.filter((c) => c[0] === "readIssue").length, reads, "no searching by number");
    const explicit = (await b.call("start_task", { factory_id: b.channel.id, issue_number: 31, repository: "ACME/API" })).structuredContent;
    assert.equal(explicit.task.repository, "acme/api"); assert.notEqual(explicit.task_id, started.task_id);
  } finally { await b.stop(); }
});

test("concurrent starts are safely reported without duplicate executions", async () => {
  const b = await boot();
  let release = () => {};
  try {
    b.runs.splice(0, b.runs.length);
    b.control.slow = new Promise<void>((r) => { release = r; });
    const first = b.call("start_task", { factory_id: b.channel.id, issue_number: 31 });
    while (!b.calls.some((c) => c[0] === "start")) await new Promise((r) => setTimeout(r, 5));
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 31 })), "conflict");
    release(); assert.equal((await first).structuredContent.ok, true);
    assert.equal(b.runs.length, 1);
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 31 })), "workflow_refused");
  } finally { release(); await b.stop(); }
});

test("decisions use the existing console actor service: answers resume info, retries preserve execution, abort cancels", async () => {
  const b = await boot();
  try {
    const answered = (await b.call("send_decision", { task_id: b.task("frun_info"), action: "comment", message: "Accounts over 10k users" })).structuredContent;
    assert.equal(answered.outcome, "answer_recorded");
    const comment = b.calls.find((c) => c[0] === "comment")?.[1] as { body: string };
    assert.match(comment.body, /Accounts over 10k users/); assert.match(comment.body, /harness:factory/);
    const update = b.calls.find((c) => c[0] === "update")?.[2] as { trusted: boolean; author: string };
    assert.equal(update.author, "console"); assert.equal(update.trusted, true);
    assert.equal((await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" })).structuredContent.ok, true);
    assert.deepEqual(b.calls.find((c) => c[0] === "decide"), ["decide", "frun_failed", "retry", "console", "", ""]);
    // Existing terminal retry checks capacity; free it first.
    for (const run of b.runs) if (run.status === "waiting" || run.status === "needs_decision") run.status = "aborted";
    const retried = (await b.call("send_decision", { task_id: b.task("frun_ended"), action: "retry" })).structuredContent;
    assert.equal(retried.task.task_id, b.task("frun_ended")); assert.equal(retried.task.repository, "acme/web"); assert.equal(retried.task.status, "running");
    assert.equal((await b.call("send_decision", { task_id: b.task("frun_ended"), action: "abort" })).structuredContent.task.status, "aborted");
    assert.ok(b.remotes.every((r) => r === "127.0.0.1")); assert.ok(b.audits.length >= 4);
  } finally { await b.stop(); }
});

test("writes reject unsupported actions, identity injection, empty decisions and invalid lifecycle states", async () => {
  const b = await boot();
  try {
    assert.equal(errorCode(await b.call("send_decision", { task_id: b.task("frun_info"), action: "comment" })), "message_required");
    for (const [run, action] of [["frun_done", "abort"], ["frun_wait", "retry"], ["frun_wait", "comment"], ["frun_info", "retry"]]) {
      assert.equal(errorCode(await b.call("send_decision", { task_id: b.task(run!), action, message: "approve" })), "invalid_state");
    }
    for (const action of ["approve", "merge", "decline", "more_rounds"]) assert.equal((await b.call("send_decision", { task_id: b.task("frun_wait"), action })).isError, true);
    assert.equal((await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry", userId: "U1" })).isError, true);
    assert.deepEqual(b.calls, []);
    b.control.fail = true;
    const failed = await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" });
    assert.equal(errorCode(failed), "operation_failed"); assert.ok(!JSON.stringify(failed).includes("private failure secret"));
  } finally { await b.stop(); }
});

test("server action switch overrides the source and prevents every MCP write", async () => {
  const b = await boot({ actions: false });
  try {
    assert.equal(errorCode(await b.call("start_task", { factory_id: b.channel.id, issue_number: 31 })), "actions_disabled");
    assert.equal(errorCode(await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" })), "actions_disabled");
    assert.deepEqual((await b.call("get_task", { task_id: b.task("frun_info") })).structuredContent.available_actions, []);
    assert.deepEqual(b.calls, []);
  } finally { await b.stop(); }
});

test("concurrent actions are refused while in flight and write rate limits are shared across requests", async () => {
  const b = await boot();
  let release = () => {};
  try {
    b.control.slow = new Promise<void>((r) => { release = r; });
    const first = b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" });
    while (!b.calls.some((c) => c[0] === "decide")) await new Promise((r) => setTimeout(r, 5));
    assert.equal(errorCode(await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" })), "conflict");
    assert.equal(errorCode(await b.call("send_decision", { task_id: b.task("frun_failed"), action: "abort" })), "conflict", "different MCP actions on the same execution also serialize");
    release(); assert.equal((await first).structuredContent.ok, true);
    b.control.slow = undefined;
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const value = await b.call("send_decision", { task_id: b.task("frun_failed"), action: "retry" });
      if (value.isError && value.structuredContent.error.code === "rate_limited") { limited = true; break; }
    }
    assert.equal(limited, true);
  } finally { release(); await b.stop(); }
});

test("oversized chunked MCP uploads are rejected before upload completion without crashing the server", async () => {
  const b = await boot();
  try {
    const response = await new Promise<{ status: number; connection?: string; body: string }>((resolve, reject) => {
      const request = httpRequest(b.endpoint, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => { resolve({ status: res.statusCode!, connection: res.headers.connection, body }); request.destroy(); });
      });
      request.on("error", reject);
      // No Content-Length and no end(): the bounded reader must answer without draining the upload.
      request.write(Buffer.alloc(17000));
    });
    assert.equal(response.status, 413); assert.equal(response.connection, "close");
    assert.equal(JSON.parse(response.body).error.code, "body_too_large");
    assert.deepEqual(b.calls, []);
    assert.equal((await b.rpc("tools/list")).result !== undefined, true, "server remains alive");
  } finally { await b.stop(); }
});

test("bearer authentication, host/origin protection, body bounds, methods and opt-in routing", async () => {
  const b = await boot({ token: "token-for-tests" });
  try {
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    for (const authorization of ["", "Bearer wrong", "token-for-tests"]) {
      const response = await b.request(rpc, { authorization }); assert.equal(response.status, 401); assert.equal(response.headers.get("www-authenticate"), "Bearer");
    }
    assert.equal((await b.request(rpc)).status, 200);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(b.endpoint, { method: "POST", headers: { host: "evil.test" } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end("{}");
    });
    assert.equal(hostStatus, 421);
    assert.equal((await b.request(rpc, { origin: "https://evil.test" })).status, 403);
    const cross = await b.request(rpc, { "sec-fetch-site": "cross-site" }); assert.equal(cross.status, 403); assert.equal(cross.headers.get("access-control-allow-origin"), null);
    assert.equal((await b.request(rpc, { origin: "http://console.test" })).status, 200);
    assert.equal((await b.request(rpc, { "content-type": "text/plain" })).status, 415);
    assert.equal((await b.request("{" )).status, 400);
    assert.equal((await b.request("x".repeat(17000))).status, 413);
    assert.equal((await b.request(undefined, {}, "GET")).status, 405);
    assert.equal((await b.request(undefined, {}, "DELETE")).status, 405);
  } finally { await b.stop(); }
  const off = await boot({ enabled: false });
  try { assert.equal((await off.request({})).status, 405); }
  finally { await off.stop(); }
});
