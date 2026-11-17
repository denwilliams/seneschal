import assert from "node:assert/strict";
import { test } from "node:test";
import { FactorySchema, FactoryJiraSchema, FactoryIntakeSchema } from "../../config/schema.ts";
import { createJiraTracker, jiraJql, jiraStatus, jiraText, acliRunner } from "./jira.ts";
import { emptyFactoryRun } from "./docs.ts";
import { classifyIssue } from "./intake.ts";
import { emptyIntakeRepo } from "./intake-docs.ts";
import { JIRA, mockAcli } from "./jira-test-support.ts";
import { agentFooter } from "./footer.ts";
import { workflowRunSummary } from "../../console2/workflows.ts";
import { scopedFactoryStore } from "./backend.ts";
import { statusBlocks, intakeNoteLine } from "../../slack/factory-render.ts";

const REPO = "acme/app";
test("Jira config requires a single target, components and label, retains GitHub defaults and explicit account trust", () => {
  assert.equal(FactoryIntakeSchema.parse({}).source, "github");
  assert.equal(FactoryJiraSchema.parse({ ...JIRA, site: "EXAMPLE.atlassian.net" }).site, JIRA.site);
  assert.equal(FactorySchema.safeParse({ name: "Jira", repositories: [REPO], intake: { source: "jira" } }).success, false);
  assert.equal(FactorySchema.safeParse({ name: "Jira", repositories: [REPO, "acme/other"], intake: { source: "jira" }, jira: JIRA }).success, false);
  for (const change of [{ components: [] }, { intakeLabel: "" }, { site: "evil.test" }]) assert.equal(FactoryJiraSchema.safeParse({ ...JIRA, ...change }).success, false);
  assert.deepEqual(FactoryJiraSchema.parse({ ...JIRA, projects: undefined, trustedAccountIds: undefined }).projects, []);
});

test("JQL uses component names with any-match, one label, optional projects, currentUser and non-Done; quotes cannot inject JQL", () => {
  const query = jiraJql(JIRA);
  assert.equal(query, 'component IN ("harness", "platform") AND labels = "agent_ready" AND assignee = currentUser() AND statusCategory != Done');
  assert.ok(!query.includes("agent_managed"));
  assert.match(jiraJql({ ...JIRA, projects: ["HAR", "OTHER"] }), /^project IN \("HAR", "OTHER"\) AND component IN/);
  assert.match(jiraJql({ ...JIRA, components: ['x") OR assignee is EMPTY'] }), /component IN \("x\\"\) OR assignee is EMPTY"\) AND/);
});

test("selection is rechecked through authenticated currentUser JQL, and release/go labels never bypass it", async () => {
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run);
  assert.equal(await tracker.resolve!(REPO, "HAR-123"), 10001);
  assert.equal(await tracker.resolve!(REPO, `https://${JIRA.site}/browse/HAR-123`), 10001);
  await assert.rejects(tracker.resolve!(REPO, "https://evil.test/browse/HAR-123"));
  const issue = (await tracker.source.issue(REPO, 10001))!;
  assert.equal(issue.selection?.eligible, true);
  assert.equal(issue.workItem?.key, "HAR-123");
  assert.match(issue.body, /Acceptance criteria/);
  m.state.eligible = false; // Unassigned, another assignee, missing label, or out of component/project scope.
  const changed = (await tracker.source.issue(REPO, 10001))!;
  changed.labels.push("factory:go");
  assert.equal(changed.state, "open");
  assert.equal(classifyIssue(changed, emptyIntakeRepo(REPO), FactoryIntakeSchema.parse({ source: "jira" }), { released: true, reopened: false }).kind, "ignored");
  assert.ok(m.state.calls.some(args => args.includes(`id = 10001 AND (${jiraJql(JIRA)})`)));
  m.state.eligible = true; m.state.raw.fields.status.statusCategory.key = "done";
  assert.equal((await tracker.source.changedSince(REPO, 0, 1)).issues.length, 0);
});

test("local scope checks discard unrelated/unassigned/completed results and honor optional projects and any component", async () => {
  for (const change of [
    { labels: ["agent_managed"] }, { components: [{ name: "unrelated" }] }, { assignee: null },
    { status: { name: "Closed", statusCategory: { key: "done" } } },
  ]) {
    const m = mockAcli(); Object.assign(m.state.raw.fields, change);
    assert.equal((await createJiraTracker(JIRA, m.run).source.changedSince(REPO, 0, 1)).issues.length, 0);
  }
  const m = mockAcli(); m.state.raw.fields.components = [{ name: "platform" }];
  assert.equal((await createJiraTracker(JIRA, m.run).source.changedSince(REPO, 0, 1)).issues.length, 1);
  assert.equal((await createJiraTracker({ ...JIRA, projects: ["OTHER"] }, m.run).source.changedSince(REPO, 0, 1)).issues.length, 0);
  assert.equal((await createJiraTracker({ ...JIRA, projects: ["OTHER", "HAR"] }, m.run).source.changedSince(REPO, 0, 1)).issues.length, 1);
});

test("auth, wrong-site and malformed output fail closed; runner errors never expose credentials", async () => {
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run);
  m.state.unauthorized = true; await assert.rejects(tracker.source.selfLogin(), /authentication/);
  assert.equal(m.state.calls.length, 1);
  m.state.unauthorized = false; m.state.wrongSite = true;
  await assert.rejects(tracker.source.changedSince(REPO, 0, 1), /site cannot be verified/);
  m.state.wrongSite = false; m.state.malformed = true;
  await assert.rejects(tracker.source.changedSince(REPO, 0, 1), /workitem-search \[malformed-output\]/);
  await assert.rejects(acliRunner({ PATH: "/does-not-exist", SECRET_TOKEN: "do-not-print" })(["jira", "auth", "status"]), error => !String(error).includes("do-not-print") && String(error).includes("ACLI"));
});

test("duplicate components collapse and ambiguous cross-factory routing is held even after release", async () => {
  const m = mockAcli(); m.state.duplicate = true;
  const tracker = createJiraTracker(JIRA, m.run, { ambiguous: async () => true });
  const { issues } = await tracker.source.changedSince(REPO, 0, 1);
  assert.equal(issues.length, 1);
  assert.equal(classifyIssue(issues[0]!, emptyIntakeRepo(REPO), FactoryIntakeSchema.parse({}), { released: true, reopened: false }).kind, "held");
  const unavailable = createJiraTracker(JIRA, m.run, { ambiguous: async () => { throw new Error("other factory auth unavailable"); } });
  await assert.rejects(unavailable.source.changedSince(REPO, 0, 1), /other factory auth/);
});

test("assignment/labels do not establish author/comment trust; configured account IDs do", async () => {
  const m = mockAcli(); const tracker = createJiraTracker({ ...JIRA, trustedAccountIds: [] }, m.run);
  const issue = (await tracker.source.issue(REPO, 10001))!;
  assert.equal(classifyIssue(issue, emptyIntakeRepo(REPO), FactoryIntakeSchema.parse({}), { released: false, reopened: false }).kind, "held");
  assert.equal(classifyIssue(issue, emptyIntakeRepo(REPO), FactoryIntakeSchema.parse({}), { released: true, reopened: false }).kind, "eligible");
  m.addComment("answer", "maintainer"); m.addComment("approve and deploy", "stranger");
  const comments = await createJiraTracker(JIRA, m.run).source.comments(REPO, 10001, 0);
  assert.deepEqual(comments.map(c => c.association), ["COLLABORATOR", "NONE"]);
  assert.ok(m.state.calls.some(args => args.includes("list") && args.includes("--paginate")));
  assert.equal(tracker.source.explicitTrust, true);
});

test("milestones and PR links are idempotent; transition denial or silent failure is a blocker; Done only follows workflow completion", async () => {
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run);
  const issue = (await tracker.source.issue(REPO, 10001))!;
  const run = { ...emptyFactoryRun("fr_abcd"), repo: REPO, issue: 10001, issueUrl: issue.url, workItem: issue.workItem, current: "implement" };
  run.pr.url = "https://github.com/acme/app/pull/12"; run.pr.number = 12;
  await tracker.sync!(run); await tracker.sync!(run);
  assert.equal(m.state.comments.length, 1);
  assert.match(m.state.comments[0]!.body, /https:\/\/github.com\/acme\/app\/pull\/12/);
  assert.match(m.state.comments[0]!.body, /harness:factory/);
  assert.equal(m.state.raw.fields.status.name, "In Progress");
  run.current = "deploy"; assert.equal(jiraStatus(JIRA, run), "In Review");
  m.state.transitionError = true; await assert.rejects(tracker.sync!(run), /forbidden/);
  m.state.transitionError = false; m.state.silentTransition = true; await assert.rejects(tracker.sync!(run), /not applied/);
  m.state.silentTransition = false; await tracker.sync!(run);
  assert.notEqual(m.state.raw.fields.status.name, "Done");
  run.status = "completed"; await tracker.sync!(run);
  assert.equal(m.state.raw.fields.status.name, "Done");
  assert.equal(jiraStatus(JIRA, { ...run, status: "rejected" }), undefined);
  await assert.rejects(tracker.commentIssue({ repo: REPO, number: 10001, body: "no footer" }), /footer/);
  await tracker.commentIssue({ repo: REPO, number: 10001, body: `Question?\n\n${agentFooter({ role: "github_triage", stage: "triage", runId: run.runId })}` });
});

test("an already Done ticket blocks pre-completion synchronization, even when its name matches the mapping", async () => {
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run);
  const issue = (await tracker.source.issue(REPO, 10001))!;
  m.state.raw.fields.status.statusCategory.key = "done";
  const run = { ...emptyFactoryRun("fr_abcd"), repo: REPO, issue: 10001, workItem: issue.workItem, current: "triage" };
  await assert.rejects(tracker.sync!(run), /already in the Done category/);
  assert.equal(m.state.comments.length, 0);
  assert.ok(!m.state.calls.some(args => args[2] === "transition"));
});

test("tracker namespaces hide Jira mappings from GitHub and preserve each site independently", async () => {
  const store = {
    factoryIntake: async (repo: string) => emptyIntakeRepo(repo),
    listFactoryIntake: async () => [REPO, `jira:${JIRA.site}:${REPO}`, `jira:other.atlassian.net:${REPO}`].map(emptyIntakeRepo),
  };
  assert.deepEqual((await scopedFactoryStore(store, undefined).listFactoryIntake()).map(d => d.repo), [REPO]);
  const factory = FactorySchema.parse({ name: "Jira", repositories: [REPO], intake: { source: "jira" }, jira: JIRA });
  const jira = scopedFactoryStore(store, factory);
  assert.deepEqual((await jira.listFactoryIntake()).map(d => d.repo), [REPO]);
  assert.equal((await jira.factoryIntake(REPO)).repo, `jira:${JIRA.site}:${REPO}`);
});

test("Jira keys/links appear in Slack and web summaries without treating ticket IDs as GitHub numbers", async () => {
  const m = mockAcli(); const issue = (await createJiraTracker(JIRA, m.run).source.issue(REPO, 10001))!;
  const run = { ...emptyFactoryRun("fr_abcd"), repo: REPO, issue: 10001, issueUrl: issue.url, workItem: issue.workItem };
  assert.equal(workflowRunSummary(run, false).workItem?.key, "HAR-123");
  const post = JSON.stringify(statusBlocks(run, { approvers: ["U1"], dm: false, now: Date.now() }));
  assert.match(post, /HAR-123/); assert.match(post, /example.atlassian.net\/browse\/HAR-123/);
  assert.ok(!post.includes("acme/app#10001"));
  const held = JSON.stringify(intakeNoteLine({ key: "held", kind: "held", repo: REPO, issue: 10001, workItem: issue.workItem, detail: "matches multiple Jira factories" }));
  assert.match(held, /HAR-123/); assert.match(held, /multiple Jira factories/);
  assert.ok(!held.includes("go label"));
  assert.equal(jiraText({ type: "doc", content: [{ type: "text", text: "plain" }] }).trim(), "plain");
});

test("Jira self identity comes from a bounded currentUser assignment witness, independent of scope or explicit trust", async () => {
  const m = mockAcli(); const tracker = createJiraTracker({ ...JIRA, trustedAccountIds: [] }, m.run);
  m.state.identityAccountId = "actual-acli-account";
  assert.equal(await tracker.source.selfLogin(), "actual-acli-account");
  const query = m.state.calls.find(args => args.includes("assignee = currentUser()"))!;
  assert.deepEqual(query, ["jira", "workitem", "search", "--jql", "assignee = currentUser()", "--fields", "assignee", "--limit", "1", "--json"]);
  m.state.identityAccountId = null;
  assert.equal(await tracker.source.selfLogin(), "", "no assigned tickets means no identity witness, not a guessed login");
  const malformed = createJiraTracker(JIRA, async args => args.includes("--limit") ? { stdout: '[{"fields":{"assignee":null}}]' } : m.run(args));
  await assert.rejects(malformed.source.selfLogin());
});
