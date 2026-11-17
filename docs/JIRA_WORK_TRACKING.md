# Jira work tracking (ACLI, Jira Cloud)

A software factory can use Jira tickets instead of GitHub Issues. GitHub still hosts
branches, pull requests, required checks and merges. No mirrored GitHub issue is
created. The same durable task runs triage → implementation → independent review →
merge gate → configured deployment. Existing GitHub factories need no changes.

## Configuration

Configure **one target repository per Jira factory**. Multiple factories can use the
same Jira site. Components are **names**, matched with OR across projects; a component
ID is not portable between projects. Projects are optional and there is exactly one
required intake label, not a fixed pair of labels.

```yaml
channels:
  factory-harness:
    agentSet: software_factory
    factory:
      name: Harness
      repositories: [denwilliams/seneschal]
      intake:
        enabled: true
        source: jira
        intervalSeconds: 120
        maxStartsPerPoll: 5
        maxPerHour: 20
      jira:
        site: example.atlassian.net
        projects: []                 # omitted/empty = all accessible projects
        components: [seneschal, harness-platform]
        intakeLabel: agent_ready     # agent_managed is an alternative, not an extra requirement
        trustedAccountIds: ["your-jira-account-id"]
        statuses:
          triage: To Do
          implement: In Progress
          review: In Review          # also merge/approval and deployment
          completed: Done
      merge:
        approvers: [U0123456789]      # Slack IDs, NOT Jira account IDs
```

All Jira calls use `acli`; there is no Jira HTTP client or API fallback. The selection
JQL above is:

```jql
component IN ("seneschal", "harness-platform")
AND labels = "agent_ready"
AND assignee = currentUser()
AND statusCategory != Done
```

A non-empty project list adds `project IN (...)`. The search runs in the authenticated
ACLI context. It does not admit unassigned tickets or tickets assigned to someone
else. Authentication/site and full eligibility are checked again immediately before
dispatch. Selected old tickets are eligible even when GitHub's `backfill` setting is
off (the initial poll establishes a baseline; the next finds selected Jira work).

Selection is **not trust**. `trustedAccountIds` is a separate allowlist of Jira
account IDs: trusted creators can enter automatically and trusted commenters can
answer triage. With an empty list, tickets are held until a Slack approver explicitly
releases them with `factory_intake_release`. Release does not bypass scope,
assignment, non-Done state or ambiguous routing. GitHub's `goLabel` and ignore-label
policy are not used for Jira: the configured label selects work but never establishes
trust. Jira labels, descriptions and comments cannot approve a merge or deployment.
Existing reviewed-head, conflict repair, check and approver gates remain in charge.

A ticket matching several components creates one run. A ticket matching several
configured, enabled Jira factories is held with a routing reason. Clarify the
project/component/label configuration (or the ticket), then poll again. Release is
not a repository-selection override. If another candidate's ACLI context cannot be
checked, admission fails closed rather than guessing that the other factory cannot
match. A configured Jira channel known only by name must be resolved by Slack first;
otherwise routing is unverifiable and admissions are blocked.

## ACLI installation and authentication

The background poller always runs in the **harness host process**, even for channels
whose bash tool uses Docker. Its PATH is the resolved channel's **host channel bin →
host global bin → channel environment PATH**, the same order as host-side channel
commands. A channel wrapper takes precedence over global/system ACLI; it must be
executable and usable on the host (including its interpreter and credential paths).
Only that channel's environment is passed; no sibling channel bin is added.

A successful `acli jira auth status` in channel **sandbox bash is not poller readiness**:
that container has a different executable, HOME, filesystem and possibly credential
store. The poller does not enter the sandbox or copy its credentials. Provision ACLI
and authenticate the intended service account on the harness host/container, as the
harness OS user with that channel's resolved env/HOME/credential store. A host `HOME`
override must be a host path, not a sandbox-only path. Do not rotate tokens merely
because the old generic error mentioned authentication.

For initial provisioning, run these on the host in that exact service-account context
(not an interactive user's unrelated shell or the channel bash sandbox):

```sh
acli jira auth login --web
# Or feed an API token on stdin, never commit it or put it in YAML/argv:
acli jira auth login --site example.atlassian.net --email you@example.com --token < /secure/token.txt
acli jira auth status
acli jira workitem search --jql 'assignee = currentUser() AND statusCategory != Done' --json --paginate
```

The expected site must appear in successful `jira auth status` output. The harness
refuses unverifiable or mismatched sites. It never changes the shared active ACLI
account with `auth switch`. For different accounts/sites use separately provisioned
ACLI credential homes in each channel's environment or separate harness processes;
verify `auth status` under that exact environment first. Do not switch the account
while the harness is running. Credentials remain ACLI-managed and are not recorded
in run state, errors or comments. The child runner inherits only the resolved
channel environment; CLI errors are sanitized (do not paste raw credential logs).

### Poller-context diagnostic

From the repository root **inside the harness service host/container**, using its OS
user and the same startup environment (`HARNESS_CONFIG`, process env and `.env`), run
the following. Replace the ID with the affected Slack channel ID; the registry supplies
its known name for name-keyed configuration. This resolves the actual channel env
files and host wrapper PATH through the same code as polling. It performs only auth,
identity and scoped intake searches, prints no account/ticket data, and neither starts
workflows nor switches accounts. Wrappers themselves must be trusted host programs.

```sh
node --env-file-if-exists=.env --experimental-strip-types --input-type=module <<'JS'
import { loadConfig } from './src/config/load.ts';
import { resolveChannel } from './src/workspace/resolve.ts';
import { ChannelRegistry } from './src/workspace/registry.ts';
import { createFactoryBackend } from './src/factory/workflow/backend.ts';
import { AcliError } from './src/factory/workflow/jira-errors.ts';
try {
  const { config, dataDir } = loadConfig(process.env.HARNESS_CONFIG);
  const { channel } = resolveChannel(config, dataDir,
    { id: 'C_REPLACE_WITH_CHANNEL_ID', isDm: false }, new ChannelRegistry(dataDir));
  if (channel?.factory?.intake?.source !== 'jira') {
    console.error('Resolve the configured Jira channel before checking readiness.');
    process.exit(1);
  }
  const source = createFactoryBackend(channel).source;
  await source.selfLogin();
  await source.changedSince(channel.factory.repositories[0], 0, 1);
  console.log('Host ACLI auth/site, identity query and scoped search succeeded; writes untested.');
} catch (error) {
  console.error(error instanceof AcliError ? error.message : 'Host diagnostic failed; inspect configuration privately.');
  process.exitCode = 1;
}
JS
```

Run it without shell tracing; do not publish raw stdout/stderr from manual ACLI calls
or env/credential dumps. Success does not prove comment/transition permissions or
cross-factory routing availability. An empty identity witness remains subject to the
mapped-ticket fail-closed rules below.

Poller errors identify a fixed command stage (`auth-status`, `identity-search`,
`workitem-search`, `workitem-view`, `comment-list`, `comment-create`, `transition`) and safe category:

- `executable-unavailable` / `executable-not-permitted`: host executable, wrapper or
  interpreter resolution/permissions; not proof of bad Jira credentials.
- `timeout` / `output-limit`: execution exceeded 30 seconds / 4 MB; partial data is
  never accepted.
- `cli-compatibility` / `authentication-permission`: an explicit recognized CLI error
  indicated an unknown command/flag or auth/permission failure. Unrecognized wording
  stays `command-failed` (nonzero exit) or `unknown`; exit 1 alone is not an auth diagnosis.
- `malformed-output` / `site-validation`: output failed schema/normalization checks or
  did not establish the configured active site. Intake remains closed.

Messages contain no raw stdout/stderr, argv values, env values, credential paths or
account details. Inspect any additional CLI evidence privately in the exact host
context; do not change shared login state or broaden JQL scope to diagnose a failure.

Commands/flags checked against the installed ACLI **1.3.39-stable**:

- `jira auth status` (text; this version has no JSON flag)
- `jira workitem search --jql ... --fields key --paginate --json` (key discovery only)
- `jira workitem search --jql 'assignee = currentUser()' --fields assignee --limit 1 --json`
  (identity witness for shared-account comment suppression, independent of ticket scope/status)
- `jira workitem view KEY --fields summary,description,creator,reporter,labels,created,updated,status,comment,assignee,components,project --json`
  (full details required by polling/revalidation; the default view fields are insufficient)
- `jira workitem comment list --key KEY --paginate --json`
- `jira workitem comment create --key KEY --body-file FILE --json`
- `jira workitem transition --key KEY --status NAME --yes --json`

Polling/synchronization uses search by stable numeric Jira ID to resolve the current
key. Search `--fields` is a CLI allowlist, **not arbitrary Jira fields**: ACLI
1.3.39-stable rejects `created,updated,comment,components,project` in search. The
reporter reproduced that exact failure on a host-only deployment with a matching
site; it was not proof of bad credentials or a Docker mismatch. Every discovered
key is hydrated with `view` and explicit detail fields before validation. IDs/keys
must agree between search and view. Scope/assignment search and local scope checks
are retained immediately before dispatch, including cross-factory ambiguity checks.
Identity uses supported `--fields assignee --limit 1`, without a scope restriction.
Hydration adds one view call per unique search result; no Jira API fallback is used.
Descriptions and comments support plain text and ADF. Output must have the
expected issue/comment JSON shape and valid IDs/dates; malformed output blocks the
operation. Calls use argv arrays (no shell interpolation), a 30-second timeout and
4 MB output bound. Pagination is requested from ACLI; output exceeding the bound
fails rather than accepting a partial intake list. Verify these flags on upgrades.

The implementation environment had ACLI installed but **no Jira authentication**.
Real site permissions, successful auth output and transitions were not live-tested;
automated tests use mocked CLI execution and controlled executable/credential-home
fixtures (including a successful host-side poll and a sandbox-only login mismatch).
The reporter confirmed the search-field rejection; successful authenticated
search/view output and end-to-end recovery on that live channel remain unverified.
Before enabling on production work, test
one ticket in a non-production project using the exact service login, including
comment creation and every configured status transition.

## Lifecycle and operations

- Start manually with a Jira key (`HAR-123`) or configured site's browse URL in
  `start_factory_run`, or the web console's start input. MCP `start_task` accepts
  `issue_ref` for a Jira key/browse URL; legacy `issue_number` remains for GitHub.
- Triage/implementation/review briefs identify Jira explicitly, include its current
  description/acceptance criteria and direct the roles to ACLI for Jira comments.
  Branches/PRs reference the key and ticket URL, never `Closes #<Jira numeric ID>`.
  The harness, not the roles, owns Jira status transitions.
- New comments from configured trusted accounts resume information waits. Agent
  footer comments are ignored as answers. Unmarked comments from the authenticated
  ACLI account during an agent stage (including the clock-skew window) are also
  suppressed. Human replies from that same account outside the window still require
  explicit inclusion in `trustedAccountIds`; token possession confers no trust.
  ACLI has no profile JSON command, so identity comes from an accessible ticket
  assigned to `currentUser()` (any scope/status, one result). With no such ticket an
  idle poll succeeds, but comment intake on mapped tickets fails closed visibly
  until identity can be verified. Description/label edits have no authenticated
  editor identity in this adapter, so they cannot wake an information wait. Label changes never grant Jira trust.
  The existing Slack/web answer and issue-recheck tools also work with Jira.
- Jira receives idempotent milestone comments and PR links, including merge and
  deployment approval blockers before parking. Publishing those waits has its own
  durable checkpoint; publication failures/retries cannot rerun successful work or
  authorize an action. Milestone markers are
  checked before publication after restarts. Jira keys/links appear in Slack run
  cards and web Workflow runs. The separate GitHub repository snapshot dashboard
  still describes the code host; it is not a Jira backlog browser.
- Mapping keys include tracker/site/repository; stable numeric Jira IDs map to
  durable runs atomically with creation. Component duplication, repeated polls and
  restarts do not create a second run. Historical GitHub mappings/runs are retained.
- Status mappings are exact destination names. No automatic workflow creation,
  guessed alternate transition, `--ignore-errors`, or forced bypass is used.
  Pre-completion destinations must belong to a non-Done Jira status category;
  configure these correctly before enabling intake (ACLI has no status-catalog
  command to preflight an unused destination). Reusing the completed/Done name
  before completion is rejected by config validation. Successful transitions are
  read back, including a check for unexpected Done categories. Forbidden/missing transitions and comments
  block progress visibly in harness state (`needs_decision`, Jira sync reason).
  Fix auth/permissions/mapping, then **Retry**: only the durable tracker effect is
  repeated, not a successful coder, merge or deployment. Tracker effects cannot be
  skipped or restarted from an earlier stage. Intake failures are visible in its
  last-error field, Slack intake status and web console.
- `Done` is attempted only after the configured workflow completes, including
  deployment when present. Merge alone is not completion. Rejection/abort does not
  mark tickets Done. An unavailable Jira service can therefore leave an already
  merged/deployed change waiting for tracker synchronization; inspect the recorded
  PR/commit before taking operational action.

Operational limits: Jira Cloud only; filing new Jira tickets is deliberately not
provided (`factory.issues.create` is rejected for Jira). Polls scan the selected
scope and sweep up to five unseen active mappings each poll for scope removal or
comments; large scopes cost CLI calls. Intake caps still apply. Short-lived exact
comment publication races can duplicate a visibility comment, but cannot create
extra durable runs or authorize a merge/deployment. Ticket edits during an active
agent stage are conservatively treated by the existing lifecycle rules; if an
answer was missed, ask an approver to recheck the issue. Changing a live Jira run's
site/tracker cannot silently retarget it: restore its original context to retry.

## UI verification

Regenerate the fixture-based screenshots with:

```sh
cd web/console2
SCREENSHOTS=1 npm exec -- playwright test e2e/screenshots-jira.spec.ts
```

This checks Jira links, intake holds and the start dialog in light/dark themes and at
390px, including no horizontal overflow. Captures are under
`docs/screenshots/jira-workflows/`; the capture test is opt-in, not a normal e2e test.

## Rollback

Disable Jira intake first (`factory.intake.enabled: false`) to stop new admissions.
Do not erase the durable store. Restore prior configuration/code for GitHub-only
factories; Jira runs require Jira-capable code and their original site context to
resume. An operator should explicitly finish or abort those runs before removing
Jira support. GitHub runs and their mappings need no migration.
