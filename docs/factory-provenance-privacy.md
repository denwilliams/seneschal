# Factory issue provenance privacy

New issues filed by `create_factory_issue` disclose that the software factory agent
wrote them from a request and that a person has not reviewed them. The footer does
not publish Slack user IDs, channel IDs, thread timestamps, permalinks, or even
whether the source was a channel or a DM. The hidden filing marker contains only
`role=filing stage=issue`, not source attribution. This is the default for every
repository, including private repositories; there is no opt-in to publish source
identifiers.

Attribution remains local: the channel's private
`shared/audit/factory-runs.jsonl` records `issue_created` with `channelId`, `userId`,
`threadKey` and the repository/issue reference. Available requester/thread details
also remain on run starter records in private workflow storage when a run starts.
Protect these stores, exports and backups as private operational data; do not paste
them into public issues. Missing requester or thread details do not prevent filing.

Intake still requires the stable disclosure phrase
`Filed by the harness's software factory agent` **and** a locally recorded filing
(`filedByHarness`). A copied footer alone does not authorize intake. Deduplication
and filing limits still use the local audit ledger, not the public footer.

This change limits the automatically appended footer. It does not scrub Slack
identifiers or other private information deliberately included in a request's
title or description; review that content before publishing it too.

## Identify and redact legacy public issues

This change does **not** edit existing issues. An operator with repository edit
access should review and redact them deliberately:

1. Inventory both open and closed issues in each affected public repository. Look
   for the older disclosure followed by `from Slack channel`, `requested by`, a
   `[thread]` link, or `slack.com/archives/`. DMs previously omitted channel links
   but could still publish a requester ID. Inspect the raw Markdown, including
   hidden HTML comments, not just the rendered page. For a paginated candidate
   list that prints only issue numbers (replace `OWNER/REPO`):

   ```sh
   gh api --paginate 'repos/OWNER/REPO/issues?state=all&per_page=100' --jq '.[] | select(.pull_request == null) | select((.body // "") | contains("software factory agent")) | .number'
   ```

   This is a starting list, not a guarantee: previously edited disclosure text
   might no longer match. Also review issues identified in private filing records
   and relevant issue comments or other places where the old footer was copied.
2. Open each candidate's body editor and remove source IDs, timestamps and links
   from the provenance block. Do not move them to hidden HTML comments: those are
   still public via raw Markdown and the API. Keep the substantive issue content,
   agent/non-human-reviewed disclosure and existing attribution to other authors.
   Use this replacement for the legacy provenance block:

   ```markdown
   ---
   _Filed by the harness's software factory agent. It was written from a request and has not been reviewed by a person._
   <!-- harness:factory role=filing stage=issue -->
   ```

   Keep the exact disclosure phrase above so legacy and new filings remain
   recognizable alongside the private filing record. Keep any separate factory
   agent footer/marker that has no source details. Do not erase local audit or
   intake records as part of public redaction.
3. Save and re-open the raw body to verify that no source identifiers remain in
   the footer, including comments and link destinations. Review descriptions and
   copied comments separately; avoid repeating removed values in public comments,
   PRs, screenshots or redaction reports. Store any required pre-edit evidence only
   in approved private storage.
4. Record completion privately by repository and issue number, without republishing
   the removed details. There is no automatic bulk-edit or migration in this fix.

**Editing is not erasure.** GitHub revision history, email notifications, API
consumers, caches, search indexes and other copied versions may retain the old
content. Follow your organization's privacy process and contact GitHub Support
when removal from revision history is needed; neither an edit nor a support
request guarantees removal of all copies. Slack IDs and links do not bypass
Slack access controls and are not credentials. Their exposure alone is not proof
of account compromise and does not, by itself, require credential rotation. This
fix does not change Slack authentication or factory approval boundaries.
