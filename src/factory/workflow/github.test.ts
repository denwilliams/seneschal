import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFooter, footerMarker } from "./footer.ts";
import { createGitHub, type GhRun } from "./github.ts";

/** A description the way the service builds one: it ends with the marker line. */
const MARKED = `b\n\n${footerMarker({ role: "filing", stage: "issue" })}`;

const view = (extra: object = {}) => JSON.stringify({ state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: "fix/7", baseRefName: "release", baseRefOid: "b".repeat(40), headRefOid: "a".repeat(40), files: [{ path: "src/a.ts" }, { path: "infra/x.tf" }], additions: 10, deletions: 2, mergeCommit: null, ...extra });

function gh(replies: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];
  const run: GhRun = async (args, input) => {
    calls.push(args);
    inputs.push(input);
    const reply = replies(args);
    if (reply instanceof Error) throw reply;
    return { stdout: reply };
  };
  return { run, calls, inputs };
}
const failing = (stdout: string, stderr = ""): Error => Object.assign(new Error("exit 1"), { stdout, stderr });

test("a pull request is read with the repository and number the engine passes, and nothing else", async () => {
  const { run, calls } = gh(() => view());
  const facts = await createGitHub(run).readPr("acme/app", 12);
  assert.deepEqual(facts, { state: "open", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: "fix/7", baseRefName: "release", baseSha: "b".repeat(40), headSha: "a".repeat(40), changedFiles: ["src/a.ts", "infra/x.tf"], additions: 10, deletions: 2 });
  assert.deepEqual(calls[0], ["pr", "view", "12", "--repo", "acme/app", "--json", "state,headRefOid,files,additions,deletions,mergeCommit,mergeable,mergeStateStatus,headRefName,baseRefName,baseRefOid"]);
  assert.equal((await createGitHub(gh(() => view({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } })).run).readPr("acme/app", 12)).mergeCommit, "c".repeat(40));
  assert.equal((await createGitHub(gh(() => view({ state: "CLOSED" })).run).readPr("acme/app", 12)).state, "closed");
});

test("required checks: counted by bucket; gh's non-zero exit for failing or pending checks is an answer; none required is zero", async () => {
  const ok = gh(() => JSON.stringify([{ bucket: "pass" }, { bucket: "pass" }, { bucket: "skipping" }]));
  assert.deepEqual(await createGitHub(ok.run).readChecks("acme/app", 12), { required: 3, failing: 0, pending: 0 });
  assert.deepEqual(ok.calls[0], ["pr", "checks", "12", "--repo", "acme/app", "--required", "--json", "bucket"]);
  const mixed = gh(() => failing(JSON.stringify([{ bucket: "pass" }, { bucket: "fail" }, { bucket: "cancel" }, { bucket: "pending" }])));
  assert.deepEqual(await createGitHub(mixed.run).readChecks("acme/app", 12), { required: 4, failing: 2, pending: 1 });
  assert.deepEqual(await createGitHub(gh(() => failing("", "no required checks reported on the 'fix/7' branch")).run).readChecks("acme/app", 12), { required: 0, failing: 0, pending: 0 });
  await assert.rejects(createGitHub(gh(() => failing("", "HTTP 401: Bad credentials")).run).readChecks("acme/app", 12), /exit 1/, "a real failure is not an answer");
});

test("merge: only at the expected head, with the method asked for; an already merged pull request is the answer, a closed one is an error", async () => {
  let state = view();
  const merge = gh((args) => { if (args[1] === "merge") { state = view({ state: "MERGED", mergeCommit: { oid: "d".repeat(40) } }); return ""; } return state; });
  const result = await createGitHub(merge.run).mergePr({ repo: "acme/app", number: 12, method: "rebase", expectedHead: "a".repeat(40) });
  assert.deepEqual(result, { mergeCommit: "d".repeat(40) });
  assert.deepEqual(merge.calls.find((c) => c[1] === "merge"), ["pr", "merge", "12", "--repo", "acme/app", "--rebase", "--match-head-commit", "a".repeat(40)]);

  const again = gh(() => view({ state: "MERGED", mergeCommit: { oid: "e".repeat(40) } }));
  assert.deepEqual(await createGitHub(again.run).mergePr({ repo: "acme/app", number: 12, method: "squash", expectedHead: "a".repeat(40) }), { mergeCommit: "e".repeat(40) });
  assert.ok(!again.calls.some((c) => c[1] === "merge"), "nothing is merged twice");

  await assert.rejects(createGitHub(gh(() => view({ state: "CLOSED" })).run).mergePr({ repo: "acme/app", number: 12, method: "squash", expectedHead: "a" }), /is closed/);
});

test("untilSettled polls until the pull request is merged or closed, and stops when told to", async () => {
  let reads = 0;
  const polling = gh(() => view(++reads < 3 ? {} : { state: "MERGED" }));
  const sleeps: number[] = [];
  const facts = await createGitHub(polling.run, { pollMs: 7, sleep: async (ms) => { sleeps.push(ms); } }).untilSettled({ repo: "acme/app", number: 12, signal: new AbortController().signal });
  assert.equal(facts.state, "merged");
  assert.deepEqual(sleeps, [7, 7]);

  const controller = new AbortController();
  const stopped = createGitHub(gh(() => view()).run, { pollMs: 10_000 }).untilSettled({ repo: "acme/app", number: 12, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(stopped, /aborted/);
});

test("mergeability refresh is bounded, unknown is preserved, and explicit conflicts do not need a retry", async () => {
  for (const result of ["MERGEABLE", "CONFLICTING", "UNKNOWN"]) {
    let reads = 0;
    const api = gh(() => view({ mergeable: ++reads < 3 ? "UNKNOWN" : result, mergeStateStatus: "UNKNOWN" }));
    const sleeps: number[] = [];
    const facts = await createGitHub(api.run, { sleep: async (ms) => { sleeps.push(ms); } }).readPr("acme/app", 12);
    assert.equal(facts.mergeable, result);
    assert.equal(reads, 3);
    assert.deepEqual(sleeps, [1000, 1000]);
  }
  const dirty = gh(() => view({ mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }));
  assert.equal((await createGitHub(dirty.run).readPr("acme/app", 12)).mergeStateStatus, "DIRTY");
  assert.equal(dirty.calls.length, 1);
  const absent = gh(() => view({ mergeable: null, mergeStateStatus: null }));
  assert.equal((await createGitHub(absent.run, { sleep: async () => {} }).readPr("acme/app", 12)).mergeable, "UNKNOWN");
  assert.equal(absent.calls.length, 3, "missing mergeability is not implicitly clean");
});

test("the GitHub adapter never submits a conflicting, unknown or changed-head merge", async () => {
  for (const extra of [{ mergeable: "CONFLICTING" }, { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }, { mergeable: "UNKNOWN" }, { headRefOid: "b".repeat(40) }]) {
    const api = gh(() => view(extra));
    await assert.rejects(createGitHub(api.run, { sleep: async () => {} }).mergePr({ repo: "acme/app", number: 12, method: "squash", expectedHead: "a".repeat(40) }), /mergeability|head changed/);
    assert.ok(!api.calls.some((args) => args[1] === "merge"));
  }
});

test("approval polling returns confirmed open conflicts or a changed head, but not an unknown as a conflict", async () => {
  for (const extra of [{ mergeable: "CONFLICTING" }, { mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }, { headRefOid: "b".repeat(40) }]) {
    const api = gh(() => view(extra));
    const facts = await createGitHub(api.run).untilSettled({ repo: "acme/app", number: 12, signal: new AbortController().signal, expectedHead: "a".repeat(40) });
    assert.equal(facts.state, "open");
    assert.equal(api.calls.length, 1);
  }
  let reads = 0;
  const api = gh(() => view(++reads < 3 ? { mergeable: "UNKNOWN" } : { mergeable: "CONFLICTING" }));
  const sleeps: number[] = [];
  const facts = await createGitHub(api.run, { pollMs: 7, sleep: async (ms) => { sleeps.push(ms); } }).untilSettled({ repo: "acme/app", number: 12, signal: new AbortController().signal, expectedHead: "a".repeat(40) });
  assert.equal(facts.mergeable, "CONFLICTING");
  assert.deepEqual(sleeps, [7, 7]);
});

test("an issue is read by number; a missing one is undefined, any other failure is an error", async () => {
  const found = gh(() => JSON.stringify({ number: 7, title: "Login fails", url: "https://github.com/acme/app/issues/7", state: "OPEN" }));
  assert.deepEqual(await createGitHub(found.run).readIssue("acme/app", 7), { number: 7, title: "Login fails", url: "https://github.com/acme/app/issues/7", state: "open" });
  assert.deepEqual(found.calls[0], ["issue", "view", "7", "--repo", "acme/app", "--json", "number,title,url,state"]);
  const closed = gh(() => JSON.stringify({ number: 7, title: "t", url: "u", state: "CLOSED" }));
  assert.equal((await createGitHub(closed.run).readIssue("acme/app", 7))?.state, "closed");
  assert.equal(await createGitHub(gh(() => failing("", "GraphQL: Could not resolve to an issue or pull request with the number of 99.")).run).readIssue("acme/app", 99), undefined);
  await assert.rejects(createGitHub(gh(() => failing("", "HTTP 401: Bad credentials")).run).readIssue("acme/app", 7), /exit 1/);
});

test("an issue is created with argv only, the body on standard input, one --label per configured label, and the new issue's URL read back", async () => {
  const body = `line one\n$(touch /tmp/x) \`id\` "quoted"\n\n${MARKED}`;
  const made = gh(() => "\nhttps://github.com/acme/app/issues/31\n");
  const facts = await createGitHub(made.run).createIssue({ repo: "acme/app", title: "Export lacks a header; rm -rf /", body, labels: ["status:triage", "from slack"] });
  assert.deepEqual(facts, { number: 31, title: "Export lacks a header; rm -rf /", url: "https://github.com/acme/app/issues/31", state: "open" });
  assert.deepEqual(made.calls[0], ["issue", "create", "--repo", "acme/app", "--title", "Export lacks a header; rm -rf /", "--body-file", "-", "--label", "status:triage", "--label", "from slack"]);
  assert.equal(made.inputs[0], body, "the body goes to gh's standard input, never the command line");
  assert.ok(!made.calls[0]!.includes(body));
  const bare = gh(() => "https://github.com/acme/app/issues/32");
  await createGitHub(bare.run).createIssue({ repo: "acme/app", title: "t", body: MARKED, labels: [] });
  assert.ok(!bare.calls[0]!.includes("--label"));
});

test("the harness's own write is refused, and gh not run, when its text has no footer", async () => {
  const made = gh(() => "https://github.com/acme/app/issues/31");
  await assert.rejects(createGitHub(made.run).createIssue({ repo: "acme/app", title: "t", body: "a description with no footer", labels: [] }), /without the harness footer/);
  assert.equal(made.calls.length, 0);
});

test("a comment the harness posts goes on standard input and is refused when it has no footer", async () => {
  const made = gh(() => "");
  const body = `Answered in Slack.\n\n${agentFooter({ role: "factory", stage: "triage", runId: "run1" })}`;
  await createGitHub(made.run).commentIssue({ repo: "acme/app", number: 7, body });
  assert.deepEqual(made.calls[0], ["issue", "comment", "7", "--repo", "acme/app", "--body-file", "-"]);
  assert.equal(made.inputs[0], body);
  await assert.rejects(createGitHub(made.run).commentIssue({ repo: "acme/app", number: 7, body: "no footer" }), /without the harness footer/);
  assert.equal(made.calls.length, 1);
});

test("an issue gh did not clearly create is an error, not a guess: no URL, a pull request, another repository", async () => {
  for (const out of ["", "created!", "https://github.com/acme/app/pull/5", "https://github.com/other/repo/issues/5", "https://evil.example/acme/app/issues/5"]) {
    await assert.rejects(createGitHub(gh(() => out).run).createIssue({ repo: "acme/app", title: "t", body: MARKED, labels: [] }), /did not say which issue it created/, out);
  }
  await assert.rejects(createGitHub(gh(() => failing("", "could not add label: 'status:triage' not found")).run).createIssue({ repo: "acme/app", title: "t", body: MARKED, labels: ["status:triage"] }), /exit 1/);
});
