---
name: factory-commit-pr
description: "Prepare clean commits and a reviewable pull request for a factory change. Use when committing, opening, or updating a PR."
---

1. Check the diff and status before committing; include only files for the issue at hand.
2. Write an imperative commit subject that describes the change. Do not put credentials, customer data, or private Slack content in commits or PR text.
3. Open a PR that links the GitHub Issue and explains behaviour, tests run, operational/config changes, limitations, and rollback notes where relevant. End the PR description, and every comment you add on the PR or the issue, with the footer given in your brief, exactly as written (for example by putting it at the end of the file you pass to `gh pr create --body-file`).
4. Request the configured review path before merge. Do not self-merge around required review.
5. Keep the issue, PR, and any public task/status links current so the factory dashboard can show useful state.
