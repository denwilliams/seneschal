import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiraTracker, jiraJql } from "./jira.ts";
import { AcliError } from "./jira-errors.ts";
import { JIRA, mockAcli } from "./jira-test-support.ts";

const REPO = "acme/app";
test("key-only paginated search hydrates required fields via view for polling, numeric lookup and revalidation", async () => {
  const m = mockAcli(); const tracker = createJiraTracker(JIRA, m.run);
  assert.equal(await tracker.source.selfLogin(), "agent", "identity query uses the supported assignee field");
  assert.equal((await tracker.source.changedSince(REPO, 0, 1)).issues[0]?.number, 10001);
  assert.equal(await tracker.resolve!(REPO, "HAR-123"), 10001);
  assert.equal((await tracker.source.issue(REPO, 10001))?.selection?.eligible, true);
  const searches = m.state.calls.filter(args => args[2] === "search" && !args.includes("--limit"));
  for (const search of searches) {
    assert.equal(search[search.indexOf("--fields") + 1], "key");
    assert.ok(search.includes("--paginate") && search.includes("--json"));
  }
  for (const query of [jiraJql(JIRA), 'key = "HAR-123"', "id = 10001", `id = 10001 AND (${jiraJql(JIRA)})`]) {
    assert.ok(searches.some(args => args.includes(query)), `missing query: ${query}`);
  }
  const views = m.state.calls.filter(args => args[2] === "view");
  assert.equal(views.length, searches.length);
  for (const view of views) {
    assert.equal(view[3], "HAR-123"); assert.ok(view.includes("--json"));
    const fields = view[view.indexOf("--fields") + 1]!.split(",");
    for (const field of ["created", "updated", "components", "project", "assignee", "labels", "status"]) assert.ok(fields.includes(field));
  }
});

test("hydration never substitutes mismatched keys/IDs and required scope fields remain fail-closed", async () => {
  for (const change of [
    { id: "20002" }, { key: "OTHER-1" },
    { fields: { summary: "missing required scope fields" } },
  ]) {
    const m = mockAcli(); const tracker = createJiraTracker(JIRA, async args => args[2] === "view" ? { stdout: JSON.stringify({ ...m.state.raw, ...change }) } : m.run(args));
    await assert.rejects(tracker.source.changedSince(REPO, 0, 1), error => error instanceof AcliError && error.stage === "workitem-view" && error.category === "malformed-output");
  }
  // JSON key-only results may omit id; the fully validated view provides it.
  const m = mockAcli();
  const tracker = createJiraTracker(JIRA, async args => args[2] === "search" && !args.includes("--limit") ? { stdout: '[{"key":"HAR-123"}]' } : m.run(args));
  assert.equal((await tracker.source.changedSince(REPO, 0, 1)).issues[0]?.number, 10001);
  await assert.rejects(tracker.source.issue(REPO, 99999), /malformed-output/, "numeric lookup cannot return a different stable ID");
  // Deduplicate discovery before hydration, not by weakening local scope validation.
  const duplicates = mockAcli(); duplicates.state.duplicate = true;
  await createJiraTracker(JIRA, duplicates.run).source.changedSince(REPO, 0, 1);
  assert.equal(duplicates.state.calls.filter(args => args[2] === "view").length, 1);
});

test("cross-factory ambiguity uses compatible search/detail and preserves project, component and currentUser checks", async () => {
  const a = mockAcli(); const b = mockAcli();
  const other = createJiraTracker({ ...JIRA, projects: ["HAR"], components: ["platform"] }, b.run);
  const tracker = createJiraTracker(JIRA, a.run, { ambiguous: async id => (await other.source.issue(REPO, id))?.selection?.eligible ?? false });
  assert.equal((await tracker.source.changedSince(REPO, 0, 1)).issues[0]?.selection?.ambiguous, true);
  assert.ok(b.state.calls.some(args => args.includes(`id = 10001 AND (${jiraJql({ ...JIRA, projects: ["HAR"], components: ["platform"] })})`)));
  b.state.eligible = false;
  assert.equal((await tracker.source.changedSince(REPO, 0, 1)).issues[0]?.selection?.eligible, true, "other-account assignment cannot establish ambiguity");
  const unavailable = createJiraTracker(JIRA, a.run, { ambiguous: async id => {
    const failing = createJiraTracker(JIRA, async args => args[2] === "view" ? { stdout: '{}' } : b.run(args));
    return (await failing.source.issue(REPO, id))?.selection?.eligible ?? false;
  } });
  await assert.rejects(unavailable.source.changedSince(REPO, 0, 1), /workitem-view \[malformed-output\]/);
});
