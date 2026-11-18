import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import { emptyFactoryRun, type FactoryRunData } from "./docs.ts";
import { forgetFiled } from "./issue-ledger.ts";
import { ISSUE_LIMITS, provenanceFooter } from "./issue-text.ts";
import { createFactoryRunService, factoryAuditFile, FactoryRunError, type FactoryRunStore } from "./service.ts";
import { fixture, REPO, type FixtureOptions } from "./test-support.ts";

beforeEach(() => forgetFiled());

class Store implements FactoryRunStore {
  runs: FactoryRunData[] = [];
  startError: Error | undefined;
  async startFactoryRun(input: Parameters<FactoryRunStore["startFactoryRun"]>[0]) {
    if (this.startError) throw this.startError;
    const runId = `fr_${this.runs.length + 1}`;
    this.runs.push({ ...emptyFactoryRun(runId), repo: input.repo, issue: input.issue, issueTitle: input.issueTitle, issueUrl: input.issueUrl, by: input.by, status: "running" });
    return { runId };
  }
  async factoryRun(runId: string) { return this.runs.find((run) => run.runId === runId); }
  async listFactoryRuns() { return [...this.runs]; }
  async decideFactoryRun() {}
  async abortFactoryRun() { return "marked" as const; }
  async addFactoryRunUpdate() {}
}

function setup(t: TestContext, options: FixtureOptions = { issues: { create: true } }, user = "UASKER1", threadKey = "1700000000.000100") {
  const f = fixture(t, options);
  const store = new Store();
  const make = (channel = f.channel) => createFactoryRunService({ channel, store: () => store, github: () => f.github, threadKey, currentUserId: () => user });
  const audit = () => {
    try { return readFileSync(factoryAuditFile(f.channel), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>); } catch { return []; }
  };
  return { f, store, service: make(), make, audit };
}

const ask = { title: "Export to CSV is missing the header row", body: "People who export the table get no header.\n\nDone when: the first row has the column names." };

test("filing is off unless the factory turns it on, and the person is told what to do instead", async (t) => {
  const { service, f, audit } = setup(t, {});
  assert.equal(service.issuesEnabled(), false);
  await assert.rejects(service.createIssue(ask), (e: Error) => e instanceof FactoryRunError && /not set up to file issues.*ask the person to file the issue themselves/s.test(e.message));
  assert.equal(f.github.created.length, 0);
  assert.deepEqual(audit(), []);
  const explicitlyOff = setup(t, { issues: { create: false } });
  assert.equal(explicitlyOff.service.issuesEnabled(), false);
});

test("with filing on, the issue is created in the factory's only repository with the configured labels, and the answer is its link", async (t) => {
  const { service, f, audit } = setup(t);
  assert.equal(service.issuesEnabled(), true);
  const filed = await service.createIssue(ask);
  assert.deepEqual([filed.repo, filed.issue, filed.existing, filed.title, filed.url, filed.run], [REPO, 8, false, ask.title, `https://github.com/${REPO}/issues/8`, undefined]);
  assert.equal(f.github.created.length, 1);
  const [made] = f.github.created;
  assert.deepEqual([made!.repo, made!.title, made!.labels], [REPO, ask.title, ["status:triage"]]);
  assert.ok(made!.body.startsWith(ask.body), "what was written comes first");
  assert.equal(made!.body, `${ask.body}${provenanceFooter()}`, "the complete public body contains no source attribution, including in hidden comments");
  const [line] = audit();
  assert.deepEqual([line!.event, line!.repo, line!.issue, line!.url, line!.title, line!.channelId, line!.userId, line!.threadKey, line!.labels, line!.startRun], ["issue_created", REPO, 8, filed.url, ask.title, f.channel.ref.id, "UASKER1", "1700000000.000100", ["status:triage"], false]);
});

test("labels come from configuration only, and the model has no way to choose one", async (t) => {
  const { service, f } = setup(t, { issues: { create: true, labels: ["status:triage", "from-slack"] } });
  await service.createIssue({ ...ask, labels: ["status:approved"] } as never);
  assert.deepEqual(f.github.created[0]!.labels, ["status:triage", "from-slack"]);
});

test("a factory with several repositories needs to be told which; a repository outside it is refused, spelling aside", async (t) => {
  const { service, f } = setup(t, { issues: { create: true }, repositories: [REPO, "acme/web"] });
  await assert.rejects(service.createIssue(ask), /several repositories \(acme\/app, acme\/web\); say which/);
  await assert.rejects(service.createIssue({ ...ask, repository: "evil/repo" }), /evil\/repo is not one of this factory's repositories/);
  const filed = await service.createIssue({ ...ask, repository: "ACME/WEB" });
  assert.equal(filed.repo, "acme/web", "spelled as configured");
  assert.equal(f.github.created[0]!.repo, "acme/web");
});

test("a channel whose team lacks a role the workflow needs cannot file: the same refusal as starting a run", async (t) => {
  const { f, make } = setup(t);
  const service = make({ ...f.channel, agents: f.channel.agents.filter((agent) => agent.name !== "reviewer") });
  assert.equal(service.issuesEnabled(), false);
  await assert.rejects(service.createIssue(ask), /Issues cannot be filed here: its team has no `reviewer` subagent/);
  const notAFactory = make({ ...f.channel, factory: undefined });
  await assert.rejects(notAFactory.createIssue(ask), /not a software factory/);
  assert.equal(f.github.created.length, 0);
});

test("an issue needs a title and a description once what cannot be shown is taken out", async (t) => {
  const { service, f } = setup(t);
  await assert.rejects(service.createIssue({ ...ask, title: " \u0000\n " }), /needs a title/);
  await assert.rejects(service.createIssue({ ...ask, body: "‮ \n" }), /needs a description/);
  assert.equal(f.github.created.length, 0);
});

test("what is filed has been sanitised: mentions, closing keywords, hidden characters and length", async (t) => {
  const { service, f } = setup(t);
  await service.createIssue({
    title: `@channel‮  fixes #3 ${"long ".repeat(100)}`,
    body: `Please @alice look. This closes #4.\u0000\n<img src=x onerror=alert(1)>\n![t](https://evil.example/p.png)\n${"z".repeat(20_000)}`,
  });
  const made = f.github.created[0]!;
  assert.ok(made.title.length <= ISSUE_LIMITS.titleChars, `${made.title.length}`);
  assert.ok(made.title.startsWith("`@channel` fixes `#3` long"), made.title);
  assert.ok(!/[\u0000‮]/.test(made.title + made.body));
  assert.match(made.body, /Please `@alice` look\. This closes `#4`\./);
  assert.match(made.body, /&lt;img src=x onerror=alert\(1\)>/);
  assert.match(made.body, /!\\\[t\]\(https:\/\/evil\.example\/p\.png\)/);
  assert.ok(made.body.length < ISSUE_LIMITS.bodyChars + 400, "bounded, plus the footer");
  assert.match(made.body, /has not been reviewed by a person\._\n<!-- harness:factory role=filing stage=issue -->$/, "the footer is last, and is the harness's own, with its marker");
});

test("the same request asked twice returns the first issue, and a closed or a different one files a new issue", async (t) => {
  const { service, f, audit } = setup(t);
  const first = await service.createIssue(ask);
  const again = await service.createIssue({ ...ask, title: `  ${ask.title.toUpperCase()}!` });
  assert.deepEqual([again.existing, again.issue, again.url], [true, first.issue, first.url]);
  assert.equal(f.github.created.length, 1, "no second issue");
  assert.deepEqual(audit().map((line) => line.event), ["issue_created"], "a repeat is not a creation, so it does not count against the limit");

  const other = await service.createIssue({ ...ask, title: "Something else entirely" });
  assert.equal(other.existing, false);
  assert.equal(f.github.created.length, 2);

  f.github.issues.set(first.issue, { ...f.github.issues.get(first.issue)!, state: "closed" });
  const afterClose = await service.createIssue(ask);
  assert.equal(afterClose.existing, false, "the first one was closed, so this is a new request");
  assert.equal(f.github.created.length, 3);
});

test("a request filed at the same moment twice is one issue, not two", async (t) => {
  const { service, f } = setup(t);
  const [a, b] = await Promise.all([service.createIssue(ask), service.createIssue(ask)]);
  assert.equal(f.github.created.length, 1);
  assert.deepEqual([a.issue, b.issue, [a.existing, b.existing].sort()], [a.issue, a.issue, [false, true]]);
});

test("an hour's limit applies per channel, is audited when it refuses, and does not reset when the process restarts", async (t) => {
  const { service, f, make, audit } = setup(t, { issues: { create: true, maxPerHour: 2 } });
  await service.createIssue({ ...ask, title: "One" });
  await service.createIssue({ ...ask, title: "Two" });
  await assert.rejects(service.createIssue({ ...ask, title: "Three" }), /2 issues have been filed from this channel in the last hour \(2 at most\)/);
  assert.equal(f.github.created.length, 2);
  const refused = audit().at(-1)!;
  assert.deepEqual([refused.event, refused.limit, refused.repo], ["issue_refused", 2, REPO]);

  // A new process: what it filed itself is gone, but the audit file remembers.
  forgetFiled();
  await assert.rejects(make().createIssue({ ...ask, title: "Four" }), /2 issues have been filed/);
  assert.equal(f.github.created.length, 2);
  // And the same request, repeated after the restart, is still the same request.
  const same = await make().createIssue({ ...ask, title: "Two" });
  assert.equal(same.existing, true);
});

test("a limit holds even when the audit line cannot be written", async (t) => {
  const { f } = setup(t);
  // A path below a regular file cannot be created, on any platform.
  const blocker = join(f.dataDir, "blocker");
  writeFileSync(blocker, "x");
  const service = createFactoryRunService({ channel: { ...f.channel, factory: { ...f.channel.factory!, issues: { create: true, labels: ["status:triage"], maxPerHour: 1, requireApproval: false } } }, store: () => new Store(), github: () => f.github, threadKey: "t", currentUserId: () => "UASKER1", auditFile: join(blocker, "sub", "audit.jsonl") });
  await service.createIssue({ ...ask, title: "One" });
  await assert.rejects(service.createIssue({ ...ask, title: "Two" }), /1 issues have been filed|at most/);
});

test("GitHub refusing is told plainly, with a hint when a label is the cause, and is audited without leaking more than a line", async (t) => {
  const { service, f, audit } = setup(t);
  f.github.createError = "could not add label: 'status:triage' not found\nsecond line with token ghp_secret";
  await assert.rejects(service.createIssue(ask), (e: Error) => {
    assert.match(e.message, /GitHub did not create the issue: could not add label: 'status:triage' not found \(a label in `factory.issues.labels` is missing and the harness could not create it/);
    assert.ok(!e.message.includes("ghp_secret"));
    return true;
  });
  assert.deepEqual(audit().map((line) => [line.event, String(line.error).includes("ghp_secret")]), [["issue_failed", false]]);
  f.github.createError = undefined;
  assert.equal((await service.createIssue(ask)).issue, 8, "a failure did not count against the limit");
});

test("with startRun, a run starts on the new issue; if it cannot, the issue is still reported with why", async (t) => {
  const { service, store, audit } = setup(t);
  const filed = await service.createIssue({ ...ask, startRun: true });
  assert.deepEqual([filed.run?.runId, filed.runError], ["fr_1", undefined]);
  assert.deepEqual([store.runs[0]!.repo, store.runs[0]!.issue, store.runs[0]!.by], [REPO, filed.issue, { source: "agent", threadKey: "1700000000.000100", userId: "UASKER1" }]);
  assert.deepEqual(audit().map((line) => [line.event, line.startRun]).slice(0, 2), [["issue_created", true], ["start", undefined]]);

  store.startError = new Error("not available in this channel: recovery");
  const second = await service.createIssue({ ...ask, title: "Another request", startRun: true });
  assert.equal(second.run, undefined);
  assert.match(second.runError!, /not available in this channel/);
  assert.ok(second.issue > filed.issue, "the issue exists either way");
});

test("without a store or without GitHub in the session, nothing is filed and nothing throws something unexpected", async (t) => {
  const { f } = setup(t);
  const noGitHub = createFactoryRunService({ channel: f.channel, store: () => new Store(), github: () => undefined, threadKey: "t", currentUserId: () => "UASKER1" });
  await assert.rejects(noGitHub.createIssue(ask), /cannot be filed in this session/);
});

for (const isDm of [false, true]) {
  for (const userId of ["UREQUESTER9", ""]) {
    for (const threadKey of ["1700000000.000100", ""]) {
      test(`filing from ${isDm ? "a DM" : "a channel"} with ${userId ? "a" : "no"} requester and ${threadKey ? "a" : "no"} thread keeps attribution private`, async (t) => {
        const { f, store, audit } = setup(t);
        const channel = { ...f.channel, ref: { ...f.channel.ref, id: isDm ? "DPRIVATE9" : "CPRIVATE9", isDm } };
        const service = createFactoryRunService({ channel, store: () => store, github: () => f.github, threadKey, currentUserId: () => userId });
        const filed = await service.createIssue(ask);
        assert.equal(f.github.created[0]!.body, `${ask.body}${provenanceFooter()}`, "neither visible text nor hidden comments disclose source details");
        const [line] = audit();
        assert.deepEqual([line!.event, line!.issue, line!.channelId, line!.userId, line!.threadKey], ["issue_created", filed.issue, channel.ref.id, userId, threadKey], "available source attribution stays in the private local audit");
      });
    }
  }
}

// ── A label that is not there ────────────────────────────────────────────────────────────────────────────

function withLabels(t: TestContext) {
  const { f, store } = setup(t);
  const ensured: string[] = [];
  const service = createFactoryRunService({
    channel: f.channel, store: () => store, github: () => f.github, threadKey: "t", currentUserId: () => "UASKER1", labels: { ensure: async (repo) => { ensured.push(repo); } },
  });
  return { f, service, ensured };
}

test("filing that fails on a label that is not there makes the labels exist and tries once more", async (t) => {
  const { f, service, ensured } = withLabels(t);
  f.github.createErrors = ["could not add label: 'status:triage' not found"];
  const filed = await service.createIssue(ask);
  assert.equal(filed.existing, false);
  assert.deepEqual(ensured, [REPO]);
  assert.equal(f.github.created.length, 1, "filed once, on the second try");
});

test("if the label is still missing after that, it fails with a reason the person can act on, and does not loop", async (t) => {
  const { f, service, ensured } = withLabels(t);
  f.github.createErrors = ["could not add label: 'status:triage' not found", "could not add label: 'status:triage' not found"];
  await assert.rejects(service.createIssue(ask), (e: Error) => e instanceof FactoryRunError && /token needs permission to create labels/.test(e.message));
  assert.deepEqual(ensured, [REPO], "labels were ensured once, not again");
  assert.equal(f.github.created.length, 0);
});

test("any other failure is not retried and does not touch labels", async (t) => {
  const { f, service, ensured } = withLabels(t);
  f.github.createErrors = ["HTTP 403: Resource not accessible by personal access token"];
  await assert.rejects(service.createIssue(ask), /GitHub did not create the issue: HTTP 403/);
  assert.deepEqual(ensured, []);
});
