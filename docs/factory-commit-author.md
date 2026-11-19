# Factory Git commit identity

GitHub API authentication (tokens or GitHub Apps) does not select a Git commit
email. An operator can configure attribution separately for each factory channel:

```yaml
channels:
  engineering:
    factory:
      name: Engineering
      repositories: [example/project]
      commitAuthor:
        name: Factory Automation
        email: automation@example.com
```

`commitAuthor` is optional. When present, **both** `name` and `email` are required;
unknown fields are rejected. The name is trimmed, 1–200 characters, with no angle
brackets or ASCII control characters. The email must pass the configuration's
email-address validation and be at most 254 characters. Use an identity you control;
no account lookup, ownership verification, guessed address or noreply fallback is
performed. The restricted admin-agent config editor cannot change this setting;
an operator can edit YAML or use the operator-authorized harness configurator.

## Execution and precedence

For every new `coder` subagent session in that channel, including manual runs,
workflow retries, review rework and merge-conflict repair, the harness sets
`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
`GIT_COMMITTER_EMAIL` after layering channel and per-run environments. This wins
over conflicting inherited identity variables, `EMAIL`, and Git `user.*` /
`author.*` / `committer.*` configuration. New ordinary `git commit` operations
therefore use the configured author **and committer** rather than an image's or
host's incidental identity. Both fields are explicit so the name cannot drift
with machine configuration. The same execution environment reaches host bash,
exec/shared tools, and Docker, macOS container and Kiri sandbox bash commands
(including reusable and throwaway containers).

No global or repository Git configuration is written. Other factories, the parent
channel agent, reviewers and deployers retain their own environments. It works
independently of the supported GitHub authentication paths and does not grant
permissions, prove account ownership, or change review/merge safety gates.

**Unset:** no identity variables are added or removed; Git uses the existing
execution environment and configuration, or fails if it cannot determine an
identity. This preserves existing installations, but does not guarantee attribution.
Configure the setting for predictable factory authorship. The harness never
fabricates a GitHub noreply identity as a fallback.

This is an execution default, not a security barrier against arbitrary shell code:
explicit `git commit --author`, shell environment overrides, amend/cherry-pick and
other operations preserving an existing contribution's author retain Git's normal
semantics. Do not override legitimate third-party attribution or add guessed
co-author trailers. The setting does not sanitize commit messages or trailers.

## Applying changes and rollback

Apply configuration through the normal config reload path (or restart the harness).
New coder sessions use the loaded configuration; already-running sessions keep
their captured environment. Remove `commitAuthor` and reload to restore the unset
behavior for future sessions.

Changes affect **future commits only**. They do not rewrite existing branches,
author metadata, squash co-author trailers, or GitHub's cached contributor display.
Any historical correction is a separate, explicitly authorized operation. This
feature neither rewrites history nor removes third-party contributions.
