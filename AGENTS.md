# Working in this repo

> `CLAUDE.md` and `AGENTS.md` are copies of each other, for different tools. Whichever agent you are, if you change one, make the same change to the other in the same commit, so the two never differ. This note stays in both.

## Feature changes keep the public website current

When adding, changing or removing a user-facing harness capability, read
`factory-skills/website-update/SKILL.md` and update the public website in the same
PR. Its inventory is `website/features.json`; build/hosting instructions are in
`docs/website.md`. Validate the site and include actual desktop/mobile screenshots
of changed pages. For an internal-only fix, explain why the website is unchanged.
The website is separate from the private operator console; never publish runtime
data, real config, secrets or private console screenshots.

## UI changes need screenshots

Any pull request that changes what a person sees in webConsole2 (`web/console2/`) shows it in the PR description, so it can be reviewed without checking out the branch.

- Take them with Playwright against the mock fixtures, so they can be regenerated. Keep the capture script out of the normal e2e run (opt-in, for example behind an environment variable).
- Cover the new or changed screen in light and dark, and at 390px wide. For anything that opens (a sheet, a dialog), show it open.
- Save optimised PNGs under `docs/screenshots/<feature>/`: a few small files (under about 150 KB each, 1x scale). They stay in git history, so do not commit more than a review needs.
- Embed them in the PR body with a GitHub blob URL at the pushed commit and `?raw=true`: `https://github.com/denwilliams/seneschal/blob/<sha>/docs/screenshots/<feature>/<file>.png?raw=true`. Relative paths do not render in PR descriptions.
- Look at them yourself before opening the PR: layout, clipping, contrast, no horizontal scroll at 390px.
