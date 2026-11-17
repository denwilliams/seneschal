---
name: factory-handoffs
description: "What to put in a brief to each factory subagent, and what each subagent's report must contain so the next one can act without re-deriving anything. Use when briefing or reporting in the software factory (triage, coder, reviewer, Cloudflare deployer)."
---

The team passes work through short written reports. Whoever writes one is writing for the next reader, who has no other context. Be exact: numbers, links, commit SHAs, commands. A report starts with the two header lines the subagent prompt requires (`STATUS:` and `NEXT:`), then the body below.

## Briefs (channel assistant → subagent)

Every brief states the repository (`owner/name`), the target (issue or PR number, or the environment and commit), the constraints the user gave, and what finished looks like. Then, per role:

- **github_triage**: which issues (a label such as `status:triage`, specific numbers, or "everything opened since <date>"), and any priorities or rules the user stated.
- **coder**: the issue number and link, the acceptance criteria as written in the issue, the base branch, and anything the user said that is not in the issue. If this is a second round, the reviewer's findings, verbatim.
- **reviewer**: the PR number and link, the issue it should satisfy, the coder's report (especially the tests they ran), and any area the user is worried about.
- **cloudflare_deployer**: the environment (`staging` or `production`), the exact commit SHA or merged PR to deploy, and the user's approval in their own words with who gave it and when.

## Reports (subagent → channel assistant)

**github_triage**
- Repository and what was looked at.
- One line per issue: `#n — decision — labels now set — reason`. Decisions: `ready`, `needs-info` (and who was asked, and what), `duplicate of #m`, `wontfix`, `defer`.
- `READY:` the ready issue numbers in the order to build them, with priority.
- `NEXT: coder` when anything is ready, otherwise `none`.
- When the brief is about one issue, end with a line of its own saying which way it goes: `VERDICT: READY`, `VERDICT: NEEDS_INFO` (you asked its author something on the issue; the workflow then waits for a trusted person to answer there and runs you again with the answer) or `VERDICT: REJECT` (a duplicate, won't fix, or deferred). A workflow that is driving the issue reads that line, so spell it exactly.

**coder**
- Issue number, branch name, and the PR number and its full URL (`https://github.com/owner/name/pull/42`) on a line of its own. A workflow that is driving the issue finds the pull request from that URL.
- What changed and why, in a few lines, and the files touched.
- Tests: the exact commands run and their results. Say plainly if something could not be run.
- Anything in the issue not done, anything done that was not asked for, and any decision you made that a reviewer should look at.
- For conflict repair, give the existing PR branch, exact fetched target base/head SHAs, conflicting paths, resolution rationale, tests/typecheck/build results and exact pushed head SHA. Recheck mergeability and report any remaining conflict/unknown status; do not claim approval. If safe resolution needs a decision, report blocked with paths and alternatives.
- `NEXT: reviewer`.

**reviewer**
- PR number and the verdict on its own line: `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.
- Findings as a list, each with severity (`blocker`, `should-fix`, `nit`), `file:line`, and what to change. Blockers first.
- What was verified and how: the tests run and their results, and what was read but not run.
- Recheck mergeability against the current target base at the end of review before requesting approval. Report head/base SHAs and raw GitHub evidence. CONFLICTING/DIRTY returns CHANGES_REQUESTED to coder on the existing PR; never fix it as reviewer. UNKNOWN gets at most two refreshes, then blocked, not approval or an invented conflict. Include conflicting paths if established locally; the PR changed-files list is not a list of conflicts.
- Residual risk: what the review could not establish.
- Two lines for every review, whatever the verdict: `RISK: <1-5>` and `RISK_REASON: <one line>`. How risky is it to merge this change? Score it honestly; it decides whether the change may merge without a person.
  - `1`: comments, docs, or text only.
  - `2`: small, tested and contained to one place.
  - `3`: a behaviour change in one area.
  - `4`: touches shared code, a data shape, authentication, or several areas.
  - `5`: a migration, security, billing or infrastructure change, or anything hard to undo.
  If you cannot tell, say `5` and say why. A missing or invalid score counts as `5`.
- `NEXT: coder` for changes requested; `NEXT: none` for approved. Whether an approved change merges by itself or waits for a person is decided by the factory's merge rules, not by you.

**cloudflare_deployer**
- Environment, the full commit SHA deployed, the version ID that was live before and the one live now, and the URL.
- The checks run after deploying and their results.
- How to roll back, as a command or steps the user could run.
- `NEXT: none`.

## Status labels: every role moves the issue on, and removes the label it replaces

An issue carries exactly one `status:` label. Whoever moves it on adds the new one and removes the old one in the same command, so nobody has to guess where an issue stands:

| When | Who | Command |
|---|---|---|
| Triage decides it is ready | github_triage | `gh issue edit N --add-label status:ready --remove-label status:triage` |
| Work starts | coder | `gh issue edit N --add-label status:in-progress --remove-label status:ready` |
| The pull request is open | coder | `gh issue edit N --add-label status:in-review --remove-label status:in-progress` |
| Review approves | reviewer | `gh issue edit N --add-label status:approved --remove-label status:in-review` |
| Review asks for changes | reviewer | `gh issue edit N --add-label status:changes-requested --remove-label status:in-review` |
| The coder picks it up again | coder | `gh issue edit N --add-label status:in-progress --remove-label status:changes-requested` |

If you are not sure what the current label is, read it first (`gh issue view N --json labels`) and remove whichever `status:` label is there. An issue that needs more information keeps `status:triage` and gets `needs-info`. Say in your report which label you set.

## The footer on everything you post

Your brief ends with a footer: a short italic line saying the factory agent sent it, and a hidden `<!-- harness:factory ... -->` line. Put it, exactly as given, at the end of every comment, review, issue or pull request description you write on GitHub, on its own lines after your text. People use it to see what an agent wrote, and the harness uses it to tell your comments from a person's replies when both come from the same GitHub account. Do not change it, do not copy it onto anything you did not write, and do not leave it out because a comment is short. The `gh` command also adds it for you when it is missing, so you may see it on the end of what you posted; a footer that is already there is not added twice. If `gh` refuses a command with "harness footer guard" (an editor, `--fill`, a template, a GraphQL mutation), do what its message says: give the text with `--body` or `--body-file`. Labels and the report you give back do not need it.

## Rules for everyone

- Put real identifiers in. "The PR" is not a report; "PR #42, https://github.com/org/repo/pull/42" is.
- Say what you did not do. A missing test run or an unreadable file belongs in the report, not in silence.
- Never claim an action another tool did not perform. Nobody on this team can message the user.
