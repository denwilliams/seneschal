---
name: website-update
description: "Keep the Seneschal public feature website accurate. Use whenever adding, changing, renaming or removing a harness feature, integration, permission boundary or setup requirement, and when reviewing such a PR, even if nobody asks for website changes. Not for operating the private web console."
---

A feature change is done when the public website describes its implemented behavior and the PR includes validation and rendered evidence.

1. Read `AGENTS.md`, `docs/website.md`, and the relevant entries in `website/features.json`. Check the actual implementation and tests: README examples and design documents can lag behind code. Do not advertise a proposed feature as available.
2. Add or revise the closest inventory entry. Keep its stable `id`, a plain-language `title`, a user-facing `description` including opt-in requirements/limits, and repository-relative `sources` that prove implementation. Retire removed capabilities; do not just accumulate cards. Example: a change to heartbeat cadence updates `heartbeats` under `automation` and cites `src/agent/heartbeat-tools.ts` plus `docs/heartbeats.md`.
3. Edit `website/build.mjs` only when the overview, setup instructions or page structure also need to change; edit `website/styles.css` for presentation. Inventory source paths are review evidence, not public links. Build copies only an explicit allowlist: never add runtime data, real config, transcripts, private screenshots or credentials to it.
4. Run `node website/build.mjs` and `node --test website/site.test.mjs`. For rendered checks, run `npm ci --prefix website`, `node website/node_modules/playwright/cli.js install chromium` (add `--with-deps` on a supported CI host), then `npm run test:browser --prefix website`. These checks include all pages at desktop, 390px and 320px, keyboard navigation, axe, and GitHub Pages project-subpath links.
5. Run `npm run screenshots --prefix website`, inspect the actual images under `docs/screenshots/website/`, and commit only useful changed views. Embed desktop and mobile views in the PR with commit-pinned GitHub blob URLs ending in `?raw=true`. State any checks that could not run. For an internal-only fix, say why public content is unchanged instead of inventing a feature card.
6. Re-read the public copy against the final diff. In review, require feature coverage and truthful limits, not just a passing build. Publishing is a separate owner-authorized action; do not claim a site is live without verifying its URL.
