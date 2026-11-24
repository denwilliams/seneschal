# Check-only GitHub Actions deploy stage

For repositories that already deploy through Actions, the factory can **observe**
that deployment instead of running its optional Cloudflare deployer. There is
still exactly one deploy stage, after the existing review and merge gates. It is
not a substitute for pre-merge required checks.

## Configuration

```yaml
channels:
  engineering:
    factory:
      name: Example
      repositories: [acme/app, acme/other]
      deploy:
        mode: github-actions
        workflow: .github/workflows/deploy.yml # or deploy.yml or a numeric workflow ID
        pollIntervalSeconds: 15               # default 15; integer 1–300
        timeoutSeconds: 1800                  # default 1800; integer 1–86400
      repositoryRules:
        acme/other:
          deploy: { mode: agent }            # keep the existing deployer for this repository
```

Deployment selection is operator-only configuration, not editable by the admin
agent. The `deploy` object on a repository overrides the entire factory-level object;
it does not merge individual fields. With no `deploy` setting, or with
`mode: agent`, existing behavior is unchanged: the optional `cloudflare_deployer`
role runs only when assigned and with its existing approval requirements.

Actions mode requires an explicit workflow **filename/path or numeric ID**, not
a display name. Select the workflow that represents the deployment's final
outcome. The workflow must already be triggered by repository automation; it
must run against the exact **full merged commit SHA**. A PR-head run, another
repository's run, or a workflow that checks out a different commit cannot serve
as proof. Configure the workflow to report failure when deployment fails, rather
than masking a failed deploy job with an overall success.

The monitor runs in the harness, using the channel's GitHub credentials (`gh`),
not inside an agent's sandbox. Grant **Actions: read** for the selected repository
to a fine-grained token/GitHub App; ordinary factory issue/PR/merge operations
still need their existing permissions. The monitor needs no Cloudflare secrets,
agent role, deployment permissions or deploy approval: it performs only GETs.
Existing review, risk, merge approval, required-check and reviewed-head gates are
unchanged. Selecting monitoring never authorizes a deployment.

## Polling and outcomes

- Resolve the configured workflow to its ID and list its runs filtered by the
  merged SHA; locally verify repository, workflow ID and full SHA too. Paginate
  up to 1,000 candidates; overflow/malformed responses fail explicitly.
- If several runs match, select the newest (highest run ID) and pin that ID and
  attempt. Future polls read that run directly, not an unrelated newer success.
  An externally rerun attempt changing under the monitor fails clearly; an
  authorized operator can retry monitoring to select the new attempt.
- Poll missing, queued, waiting or running deployments until the overall deadline.
  The deadline begins when the deploy stage starts and includes discovery and API
  time, not review/merge time. Workflow ID, selected run/attempt, next poll and
  deadline survive a harness restart; it never dispatches or reruns anything.
- Only `completed` with conclusion `success` completes the deploy stage. Failure,
  cancellation, timeout, skipped, neutral, missing/unknown conclusions, and other
  completed non-success results fail, with the Actions run link in the attempt.
- A deadline distinguishes **no matching run appeared** from **a selected run did
  not finish**. API/auth/access errors fail immediately (including 401/403/404,
  rate limits and network errors); there are no hidden API-error retries. Each
  CLI request has a 30-second cap and the monitor also bounds API wait by its
  overall deadline.

An unsuccessful observation uses the existing failed-stage flow:
`needs_decision` at `deploy`, not a successful deployment. An authorized factory
operator can fix access/automation then `retry`, explicitly `skip`, or `abort`.
A retry observes again with a fresh deadline; it does not redeploy or repeat
implementation/review/merge. Read-only stages can also use the factory's existing
bounded automatic retry policy, with a fresh deadline per attempt. The default
cautious policy has no automatic retries. A link is retained whenever a run has
been selected.

## Rollout and rollback

Change operator configuration and start a new factory run. Deployment selection
and polling settings are pinned into each run's workflow definition: a reload
cannot turn an in-flight monitor into an active deployer, or vice versa. Existing
runs retain their previous deploy behavior. Revert the setting to `mode: agent`
(or remove it) for future runs to restore the existing option. Skip/abort a stuck
monitor through existing authorized controls; do not dispatch a workflow merely
to satisfy it. This feature does not change repository settings, Actions workflow
files, actual deployments, or existing deployment rollback procedures.
