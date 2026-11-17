---
name: factory-implementation
description: "Implement a GitHub Issue safely in a factory-enabled channel. Use after scope and acceptance criteria are established."
---

1. Work from the configured repository and a branch whose name refers to the issue when one exists.
2. Do not stop to ask. When something is ambiguous, pick the most reasonable reading, record it under an `Assumptions` heading in the pull request description, and carry on; the reviewer and the issue's author can correct it. Report `blocked` only when you cannot build it at all (no access, or the issue cannot be done).
3. Make the smallest coherent change that meets the acceptance criteria. Keep secrets, generated local state, and unrelated formatting out of the change.
4. For merge-conflict rework, continue the existing PR branch in an isolated checkout, never a replacement PR. Fetch the PR head and actual target base and record both SHAs. Confirm conflicts with GitHub CONFLICTING/DIRTY or unmerged local Git paths; UNKNOWN needs at most two refreshes, then report blocked. Merge the base into the branch without rewriting published history. Resolve semantically, preserve both changes, and do not force-push or blindly choose ours/theirs. If intent is ambiguous, report blocked with paths and alternatives rather than guessing. Before pushing, inspect the full diff, unmerged paths and new conflict markers; run tests, typecheck and build. Report the exact pushed head/base SHAs, resolved paths, rationale and check results. Recheck mergeability; a changed head requires fresh independent review and authorization.
5. Add or update focused tests and run the relevant checks. Report what actually ran and any gap. If the target repository has `website/features.json`, read its `factory-skills/website-update/SKILL.md` when adding, changing or removing a feature: update the public site in the same PR, validate it and include actual desktop/mobile screenshots. For an internal-only change, explain why website content is unchanged.
6. Update the issue with meaningful progress or blockers; use the issue as the task system, not private scratch notes. End every comment you post with the footer given in your brief, exactly as written.
7. Do not merge, deploy, or broaden permissions without the explicit approval required by the channel's policy.
