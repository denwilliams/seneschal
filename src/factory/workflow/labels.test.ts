import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../../config/load.ts";
import { createLabels, type GhRun } from "./github.ts";
import {
  CREATED_LABEL_COLOR, CREATED_LABEL_DESCRIPTION, ensureRepoLabels, factoryLabels, FACTORY_STATUS_LABELS, isLabelMissingError, LABELS_RETRY_MS, LabelKeeper, wantsLabels,
} from "./labels.ts";
import { FakeLabels, REPO } from "./test-support.ts";

const ALL = factoryLabels({ issues: { create: true, labels: ["status:triage"], maxPerHour: 10, requireApproval: false }, intake: undefined });

test("a factory's labels: the filing labels, the go label and the status set, once each however they are spelt", () => {
  assert.deepEqual(factoryLabels({}), ["status:triage", "factory:go", ...FACTORY_STATUS_LABELS.slice(1)]);
  const custom = factoryLabels({ issues: { create: true, labels: ["status:Triage", "from-slack"], maxPerHour: 10, requireApproval: false }, intake: { goLabel: "ok-to-build" } as never });
  assert.deepEqual(custom, ["status:Triage", "from-slack", "ok-to-build", ...FACTORY_STATUS_LABELS.slice(1)], "GitHub names are case-insensitive: status:triage is not listed twice");
});

test("labels are kept only for a factory that files issues or watches for them", () => {
  assert.equal(wantsLabels(undefined), false);
  assert.equal(wantsLabels({}), false);
  assert.equal(wantsLabels({ issues: { create: false } as never, intake: { enabled: false } as never }), false);
  assert.equal(wantsLabels({ issues: { create: true } as never }), true);
  assert.equal(wantsLabels({ intake: { enabled: true } as never }), true);
});

test("the status labels the roles use are the ones kept, so the skills and the constant cannot drift apart", () => {
  const named = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) for (const found of readFileSync(path, "utf8").matchAll(/status:[a-z][a-z-]*/g)) named.add(found[0]);
    }
  };
  walk(join(REPO_ROOT, "agent-set-skills", "software_factory"));
  walk(join(REPO_ROOT, "factory-skills"));
  assert.ok(named.size >= 5, "the skills were found");
  assert.deepEqual([...named].filter((label) => !FACTORY_STATUS_LABELS.includes(label)), [], "a status label a skill names is not in FACTORY_STATUS_LABELS");
  assert.deepEqual(FACTORY_STATUS_LABELS.filter((label) => !named.has(label)), [], "a label in FACTORY_STATUS_LABELS that no skill names");
});

test("GitHub's complaint about a missing label is recognised, and other failures are not", () => {
  assert.equal(isLabelMissingError("could not add label: 'status:triage' not found"), true);
  assert.equal(isLabelMissingError("GraphQL: Could not resolve to a Label with the name 'x'"), false);
  assert.equal(isLabelMissingError("label 'factory:go' does not exist"), true);
  assert.equal(isLabelMissingError("HTTP 403: Resource not accessible by personal access token"), false);
});

test("missing labels are created, existing ones are left exactly as they are, and matching ignores case", async () => {
  const api = new FakeLabels();
  api.existing = new Set(["Status:Triage", "status:ready", "bug"]);
  const outcome = await ensureRepoLabels(api, REPO, ALL, () => 7);
  assert.equal(outcome.error, "");
  assert.equal(outcome.checkedAt, 7);
  assert.deepEqual(outcome.created, ALL.filter((name) => !["status:triage", "status:ready"].includes(name.toLowerCase())));
  assert.ok(api.made.every((label) => label.color === CREATED_LABEL_COLOR && label.description === CREATED_LABEL_DESCRIPTION && label.repo === REPO), "neutral, and says where it came from");
  assert.ok(CREATED_LABEL_DESCRIPTION.length <= 100, "GitHub's limit");
  assert.ok(!api.made.some((label) => ["status:triage", "status:ready", "bug"].includes(label.name.toLowerCase())), "nothing that existed was touched");
});

test("nothing is created, and nothing reported, when every label is there", async () => {
  const api = new FakeLabels();
  api.existing = new Set(ALL);
  const outcome = await ensureRepoLabels(api, REPO, ALL, () => 1);
  assert.deepEqual([outcome.created, outcome.error, api.made.length], [[], "", 0]);
});

test("a label someone made a moment ago is success, not an error and not counted as created", async () => {
  const api = new FakeLabels();
  api.existing = new Set(ALL.filter((name) => name !== "factory:go"));
  api.existing.delete("factory:go");
  api.raced.add("factory:go");
  const outcome = await ensureRepoLabels(api, REPO, ALL, () => 1);
  assert.deepEqual([outcome.created, outcome.error], [[], ""]);
});

test("a failure is the outcome's error, bounded, and never thrown", async () => {
  const listing = new FakeLabels();
  listing.listError = `HTTP 404: Not Found ${"x".repeat(500)}\nsecond line`;
  const one = await ensureRepoLabels(listing, REPO, ALL, () => 1);
  assert.match(one.error, /^HTTP 404: Not Found/);
  assert.ok(one.error.length <= 300 && !one.error.includes("\n"));
  const creating = new FakeLabels();
  creating.createError = "HTTP 403: Resource not accessible by personal access token";
  const two = await ensureRepoLabels(creating, REPO, ALL, () => 1);
  assert.match(two.error, /HTTP 403/);
  assert.deepEqual(two.created, [], "what was not made is not claimed");
});

// ── The gh calls ─────────────────────────────────────────────────────────────────────────────────────────

test("listing follows every page and reads one name per line; creating never forces, so an existing label is never changed", async () => {
  const calls: string[][] = [];
  const names = Array.from({ length: 250 }, (_, i) => `label-${i}`);
  const run: GhRun = async (args) => { calls.push(args); return { stdout: `${names.join("\n")}\n` }; };
  const api = createLabels(run);
  assert.deepEqual(await api.list(REPO), names, "250 labels: more than one page of 100");
  assert.deepEqual(calls[0], ["api", "--paginate", `repos/${REPO}/labels?per_page=100`, "--jq", ".[].name"]);
  await api.create(REPO, { name: "factory:go", color: "ededed", description: "d" });
  assert.deepEqual(calls[1], ["label", "create", "factory:go", "--repo", REPO, "--color", "ededed", "--description", "d"]);
  assert.ok(!calls[1]!.includes("--force"));
});

test("creating a label that exists is `exists`, and any other failure is rethrown", async () => {
  const exists = createLabels(async () => { throw Object.assign(new Error("Command failed"), { stderr: 'label with name "factory:go" already exists; use `--force` to update its color and description' }); });
  assert.equal(await exists.create(REPO, { name: "factory:go", color: "ededed", description: "d" }), "exists");
  const denied = createLabels(async () => { throw Object.assign(new Error("Command failed"), { stderr: "HTTP 403: Resource not accessible by personal access token" }); });
  await assert.rejects(denied.create(REPO, { name: "x", color: "ededed", description: "d" }), /Command failed/);
});

// ── When to look ─────────────────────────────────────────────────────────────────────────────────────────

function keeper() {
  const clock = { now: 1_000_000 };
  const audit: { channelId: string; event: string; fields: Record<string, unknown> }[] = [];
  const recorded: unknown[] = [];
  const k = new LabelKeeper({ now: () => clock.now, audit: (channelId, event, fields) => audit.push({ channelId, event, fields }) });
  const ask = (api: FakeLabels, extra: { repositories?: string[]; labels?: string[]; force?: boolean; channelId?: string } = {}) =>
    k.ensure({ channelId: extra.channelId ?? "C1", repositories: extra.repositories ?? [REPO], labels: extra.labels ?? ALL, api, ...(extra.force ? { force: true } : {}), record: (outcome) => { recorded.push(outcome); } });
  return { k, clock, audit, recorded, ask };
}

test("a repository is checked once per process while what it needs stays the same", async () => {
  const { ask, audit, recorded } = keeper();
  const api = new FakeLabels();
  assert.equal((await ask(api)).length, 1);
  assert.equal(api.listCalls, 1);
  assert.deepEqual(audit.map((line) => [line.event, line.fields.repo]), [["labels_created", REPO]]);
  assert.deepEqual((audit[0]!.fields.labels as string[]).length, ALL.length);
  assert.equal(recorded.length, 1);
  assert.deepEqual(await ask(api), [], "asked again: nothing to do");
  assert.deepEqual(await ask(api), []);
  assert.equal(api.listCalls, 1);
});

test("nothing is audited when nothing was missing, but the check is still recorded for the console", async () => {
  const { ask, audit, recorded } = keeper();
  const api = new FakeLabels();
  api.existing = new Set(ALL);
  await ask(api);
  assert.deepEqual(audit, []);
  assert.equal(recorded.length, 1);
});

test("it checks again when the repositories or the labels change, as after a config reload, and forgets a channel that stopped wanting them", async () => {
  const { k, ask } = keeper();
  const api = new FakeLabels();
  await ask(api);
  await ask(api, { repositories: [REPO, "acme/other"] });
  assert.equal(api.listCalls, 2, "the new repository is checked; the old one is not");
  await ask(api, { repositories: [REPO, "acme/other"], labels: [...ALL, "needs-design"] });
  assert.equal(api.listCalls, 4, "a changed label set checks every repository again");
  assert.ok(api.made.some((label) => label.name === "needs-design"));
  k.forget("C1");
  await ask(api, { repositories: [REPO, "acme/other"], labels: [...ALL, "needs-design"] });
  assert.equal(api.listCalls, 6, "turned off and on again");
  assert.equal((await ask(new FakeLabels(), { channelId: "C2" })).length, 1, "another channel is its own");
});

test("a repository dropped from the configuration stops being kept, and coming back checks it again", async () => {
  const { ask } = keeper();
  const api = new FakeLabels();
  await ask(api, { repositories: [REPO, "acme/other"] });
  await ask(api, { repositories: [REPO] });
  await ask(api, { repositories: [REPO, "acme/other"] });
  assert.equal(api.listCalls, 3);
});

test("a failure is audited and left alone for a while, then tried again, never in a tight loop", async () => {
  const { ask, clock, audit, recorded } = keeper();
  const api = new FakeLabels();
  api.listError = "HTTP 403: Resource not accessible";
  const first = await ask(api);
  assert.match(first[0]!.error, /HTTP 403/);
  assert.deepEqual(audit.map((line) => line.event), ["labels_failed"]);
  assert.match(String(audit[0]!.fields.error), /HTTP 403/);
  assert.equal(recorded.length, 1);
  assert.deepEqual(await ask(api), [], "asked straight away: not tried again");
  clock.now += LABELS_RETRY_MS - 1;
  assert.deepEqual(await ask(api), [], "still inside the wait");
  assert.equal(api.listCalls, 1);
  clock.now += 1;
  api.listError = undefined;
  const again = await ask(api);
  assert.deepEqual([again[0]!.error, again[0]!.created.length], ["", ALL.length]);
  assert.deepEqual(audit.map((line) => line.event), ["labels_failed", "labels_created"]);
  assert.deepEqual(await ask(api), [], "and then it is done");
});

test("`force` checks again after a success (an operation just failed on a missing label) but not straight after a failure", async () => {
  const { ask, clock } = keeper();
  const api = new FakeLabels();
  await ask(api);
  api.existing.delete("status:ready");
  const forced = await ask(api, { force: true });
  assert.deepEqual(forced[0]!.created, ["status:ready"], "someone deleted a label: it is made again");
  const failing = new FakeLabels();
  failing.listError = "HTTP 500";
  await ask(failing, { channelId: "C3" });
  assert.deepEqual(await ask(failing, { channelId: "C3", force: true }), [], "a recent failure is still left alone");
  clock.now += LABELS_RETRY_MS;
  assert.equal((await ask(failing, { channelId: "C3", force: true })).length, 1);
});

test("several asks at once share one check", async () => {
  const { ask } = keeper();
  const api = new FakeLabels();
  const results = await Promise.all([ask(api), ask(api), ask(api, { force: true })]);
  assert.equal(api.listCalls, 1);
  assert.equal(api.made.length, ALL.length, "each label made once");
  assert.ok(results.every((outcomes) => outcomes.length <= 1));
});

test("a failure to record the outcome does not fail the check", async () => {
  const k = new LabelKeeper({ now: () => 1, audit: () => {} });
  const api = new FakeLabels();
  const outcomes = await k.ensure({ channelId: "C1", repositories: [REPO], labels: ALL, api, record: () => { throw new Error("store closed"); } });
  assert.equal(outcomes[0]!.error, "");
});
