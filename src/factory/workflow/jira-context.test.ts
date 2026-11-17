import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test, type TestContext } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acliRunner, createJiraTracker } from "./jira.ts";
import { AcliError, acliFailure, acliStage, type AcliFailure } from "./jira-errors.ts";
import { createFactoryBackend, scopedFactoryStore } from "./backend.ts";
import { channelPathEnv } from "../../agent/sandbox.ts";
import { FactorySchema } from "../../config/schema.ts";
import { JIRA, mockAcli } from "./jira-test-support.ts";
import { pollIntake } from "./intake.ts";
import { fixture, openProcess, REPO } from "./test-support.ts";

const secret = "fixture-private-token-and-account";
async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jira-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function executable(bin: string, body: string, name = "acli") {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
}
const factory = FactorySchema.parse({ name: "Jira", repositories: [REPO], intake: { source: "jira" }, jira: JIRA });

test("backend resolves only its own channel wrapper, then global, then configured system PATH; GitHub behavior is unchanged", async t => {
  const root = await directory(t);
  const globalBin = join(root, "global"); const system = join(root, "system");
  const a = { factory, env: { PATH: system }, paths: { bin: join(root, "a") }, globalBin };
  const b = { ...a, paths: { bin: join(root, "b") } };
  for (const [bin, account] of [[a.paths.bin, "a"], [b.paths.bin, "b"], [globalBin, "global"], [system, "system"]]) {
    await executable(bin!, `console.log(process.argv[2] === 'jira' && process.argv[3] === 'auth' ? 'Logged in to ${JIRA.site}' : JSON.stringify([{fields:{assignee:{accountId:${JSON.stringify(account)}}}}]));`);
  }
  const env = { ...a.env };
  assert.equal(await createFactoryBackend(a).source!.selfLogin(), "a");
  assert.equal(await createFactoryBackend(b).source!.selfLogin(), "b");
  assert.deepEqual(a.env, env, "PATH composition must not mutate another runner's environment");
  await rm(join(a.paths.bin, "acli"));
  assert.equal(await createFactoryBackend(a).source!.selfLogin(), "global");
  await rm(join(globalBin, "acli"));
  assert.equal(await createFactoryBackend(a).source!.selfLogin(), "system");
  await executable(a.paths.bin, "console.log('channel-gh');", "gh");
  await executable(system, "console.log('system-gh');", "gh");
  assert.equal(await createFactoryBackend({ ...a, factory: undefined }).source!.selfLogin(), "system-gh");
});

test("sandbox-only credentials do not authenticate the host poller; provisioned host credentials allow a real subprocess poll", async t => {
  const f = fixture(t, { intake: { source: "jira", enabled: true, backfill: true }, factory: { jira: { ...JIRA, trustedAccountIds: [] } } });
  const root = await directory(t);
  const hostHome = join(root, "host-home"); const sandboxHome = join(root, "sandbox-home");
  await mkdir(hostHome); await mkdir(sandboxHome);
  const credentials = JSON.stringify({ site: JIRA.site, account: secret });
  await writeFile(join(sandboxHome, "credential.fixture"), credentials);
  const raw = mockAcli().state.raw;
  await executable(f.channel.paths.bin, `
const fs = require('node:fs');
const path = require('node:path');
let credential;
try { credential = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'credential.fixture'), 'utf8')); }
catch { console.error('Error: not logged in\\n${secret}'); process.exit(1); }
const args = process.argv.slice(2);
if (args[1] === 'auth') console.log('Logged in to ' + credential.site);
else if (args[2] === 'view') console.log(JSON.stringify(${JSON.stringify(raw)}));
else if (args.includes('--limit')) console.log(JSON.stringify([{fields:{assignee:{accountId:credential.account}}}]));
else if (args[args.indexOf('--fields') + 1] !== 'key') { console.error(\"✗ Error: fields 'created, updated, comment, components, project' are not allowed\"); process.exit(1); }
else console.log(JSON.stringify([{id:'10001',key:'HAR-123'}]));
`);
  f.channel.env = { PATH: join(root, "empty-path"), HOME: hostHome };
  // A channel bash sandbox has a different HOME. Its successful check proves nothing about the host.
  assert.match((await acliRunner({ ...channelPathEnv(f.channel), HOME: sandboxHome })(["jira", "auth", "status"])).stdout, /Logged in/);
  const backend = createFactoryBackend(f.channel);
  const p = await openProcess(f);
  const store = scopedFactoryStore(p.store, f.channel.factory);
  const audit: unknown[] = [];
  const poll = () => pollIntake({
    channelId: "C1", repositories: [REPO], settings: f.channel.factory!.intake!, store, source: backend.source!,
    start: async () => { assert.fail("untrusted ticket must remain held"); }, now: Date.now, audit: (...args) => { audit.push(args); },
  });
  assert.equal((await poll()).failed, true);
  assert.match((await store.factoryIntake(REPO)).lastError, /auth-status \[authentication-permission\].*harness host/);
  assert.ok(!JSON.stringify(audit).includes(secret));
  // A host check with the raw env still cannot find the wrapper.
  await assert.rejects(acliRunner(f.channel.env)(["jira", "auth", "status"]), /executable-unavailable/);
  await writeFile(join(hostHome, "credential.fixture"), credentials);
  const result = await poll();
  assert.equal(result.failed, false); assert.equal(result.repos[0]!.held, 1);
  assert.equal((await store.factoryIntake(REPO)).lastError, "");
  assert.equal((await p.store.listFactoryRuns()).length, 0);
});

test("runner differentiates bounded subprocess failures without retaining output, env, arguments or causes", async t => {
  const root = await directory(t);
  const check = async (body: string, category: AcliFailure, limits = {}) => {
    await executable(root, body);
    await assert.rejects(acliRunner({ PATH: root, PRIVATE_TOKEN: secret }, limits)(["jira", "workitem", "comment", "create", "--body-file", secret]), error => {
      assert.ok(error instanceof AcliError); assert.equal(error.stage, "comment-create"); assert.equal(error.category, category);
      assert.match(error.message, /harness host \(not channel sandbox\)/);
      assert.ok(error.message.length <= 300); assert.ok(!inspect(error).includes(secret));
      assert.equal((error as Error).cause, undefined); assert.ok(!("stderr" in error)); assert.ok(!("stdout" in error));
      return true;
    });
  };
  await check(`console.error('Error: unknown flag: --private-${secret}'); process.exit(1);`, "cli-compatibility");
  await check(`console.error(\"✗ Error: fields 'created, updated, comment, components, project' are not allowed\"); process.exit(1);`, "cli-compatibility");
  await check(`console.error('Error: forbidden\\n${secret}'); process.exit(1);`, "authentication-permission");
  await check(`console.error('${secret}'); process.exit(1);`, "command-failed");
  await check(`console.log('${secret}'.repeat(1000));`, "output-limit", { maxBuffer: 64 });
  await check("setTimeout(() => {}, 10000);", "timeout", { timeout: 100 });
  await executable(root, "console.log('unused');"); await chmod(join(root, "acli"), 0o600);
  await assert.rejects(acliRunner({ PATH: root })(["jira", "auth", "status"]), /auth-status \[executable-not-permitted\]/);
  await assert.rejects(acliRunner({ PATH: join(root, "absent") })(["jira", secret, secret]), error => {
    assert.ok(error instanceof AcliError); assert.equal(error.stage, "command"); assert.equal(error.category, "executable-unavailable");
    assert.ok(!inspect(error).includes(secret)); return true;
  });
  assert.equal(acliFailure(new Error(secret)), "unknown");
  assert.equal(acliFailure({ code: 1 }), "command-failed", "exit 1 alone does not mean authentication");
  assert.equal(acliFailure({ code: 1, stderr: `ticket text says forbidden ${secret}` }), "command-failed");
  for (const [args, stage] of [
    [["jira", "workitem", "search", "--limit", "1"], "identity-search"],
    [["jira", "workitem", "search"], "workitem-search"],
    [["jira", "workitem", "view", "HAR-123"], "workitem-view"],
    [["jira", "workitem", "comment", "list"], "comment-list"],
    [["jira", "workitem", "transition"], "transition"],
  ] as const) assert.equal(acliStage([...args]), stage);
});

test("malformed identity/search/comments and site mismatch have sanitized, stage-specific diagnostics", async () => {
  const safeError = (stage: string, category = "malformed-output") => (error: unknown) => {
    assert.ok(error instanceof AcliError); assert.equal(error.stage, stage); assert.equal(error.category, category);
    assert.ok(!inspect(error).includes(secret)); return true;
  };
  const m = mockAcli();
  for (const stdout of [secret, JSON.stringify({ [secret]: secret }), JSON.stringify([{ ...m.state.raw, key: secret }])]) {
    const tracker = createJiraTracker(JIRA, async args => args[2] === "search" ? { stdout } : m.run(args));
    await assert.rejects(tracker.source.changedSince(REPO, 0, 1), safeError("workitem-search"));
  }
  for (const stdout of [secret, JSON.stringify({ [secret]: secret }), JSON.stringify({ ...m.state.raw, fields: { ...m.state.raw.fields, created: secret } })]) {
    const tracker = createJiraTracker(JIRA, async args => args[2] === "view" ? { stdout } : m.run(args));
    await assert.rejects(tracker.source.changedSince(REPO, 0, 1), safeError("workitem-view"));
  }
  const identity = createJiraTracker(JIRA, async args => args.includes("--limit") ? { stdout: JSON.stringify([{ fields: { assignee: { accountId: { [secret]: secret } } } }]) } : m.run(args));
  await assert.rejects(identity.source.selfLogin(), safeError("identity-search"));
  const comments = createJiraTracker(JIRA, async args => args[2] === "comment" ? { stdout: JSON.stringify([{ author: { accountId: secret }, body: secret, created: secret, updated: secret }]) } : m.run(args));
  await assert.rejects(comments.source.comments(REPO, 10001, 0), safeError("comment-list"));
  m.state.wrongSite = true;
  await assert.rejects(createJiraTracker(JIRA, m.run).source.selfLogin(), safeError("auth-status", "site-validation"));
});
