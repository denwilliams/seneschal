---
name: factory-review
description: "Review a factory change against its GitHub Issue, tests, security boundaries, and operational impact. Use before approval or merge."
---

1. Read the linked issue and PR description first; confirm the change satisfies the stated acceptance criteria and no undocumented scope has crept in.
2. Inspect the diff for correctness, tests, secrets, access-control changes, migrations, rollback impact, and documentation/config changes.
3. Check PR mergeability against its actual current target base at the start AND end of review, before requesting merge approval. Record head/base SHAs and raw GitHub mergeable/mergeStateStatus evidence. CONFLICTING or DIRTY means CHANGES_REQUESTED and NEXT: coder; include branch, base and conflicting paths when known. Do not resolve conflicts yourself. UNKNOWN is neither a conflict nor conflict-free: refresh at most twice, then report blocked rather than approve. Do not mistake failed checks, permissions, protection or a behind branch for confirmed conflicts. A repaired head needs fresh independent review.
4. Run or verify appropriate tests. State evidence and residual risks, not just a verdict. If the target repository has `website/features.json`, read its `factory-skills/website-update/SKILL.md`: verify that feature changes have accurate public coverage, validation and actual desktop/mobile screenshots, or a justified internal-only exemption. Check opt-in and security limits against the implementation, not just the inventory's source-path existence.
5. Put actionable findings on the PR, ending each review or comment you post with the footer given in your brief, exactly as written. Address sensible review feedback, then re-run affected checks.
6. Request changes only for what must change before this merges: a blocker (a bug, a failing or missing test, a security or data problem, the acceptance criteria not met) or a should-fix that would be a real problem later. Style, naming and other nits go in the review as nits and do not block: approve with them listed. Every round of changes costs a full coder run, and the loop stops after a few, so spend them on what matters.
7. Always end the report with `RISK: <1-5>` and `RISK_REASON:`, whatever the verdict: without a score the change counts as the riskiest and waits for a person.
8. Approval is not deployment authority. Keep merge and release decisions separate unless an operator explicitly delegates them.
