# Public feature website

The public website is a **separate static product/documentation site**, not the
private operator console in `web/console2/`. It uses no harness API, runtime data,
JavaScript, analytics, third-party fonts, or production npm dependencies.

## Content and inventory

- `website/features.json`: implemented capabilities grouped by user-facing area.
  Each entry has a stable anchor, title, description, and implementation evidence
  in `sources`. Evidence is repository-relative and is **not published**.
- `website/build.mjs`: overview, generated feature directory, setup guide, shared
  navigation and metadata. Text from the inventory is escaped, not trusted HTML.
- `website/styles.css`, `icon.svg`: presentation and local favicon.
- `factory-skills/website-update/SKILL.md`: procedure for feature authors/reviewers.
  `AGENTS.md` / `CLAUDE.md` and the implementation/review lifecycle skills point here.

The initial inventory was checked against README feature sections, registered tool
implementations in `src/agent/`, `src/tasks/`, Slack integrations, the factory
workflow and console handlers, plus current operational documentation. It covers
conversation, memory/skills/documents, tooling, automation, factory, console and
control/self-hosting. Planned designs (including a new hierarchical memory
architecture) are not treated as implemented features. Tests ensure every source
path exists, IDs stay unique and every capability renders. Existence alone does
not prove a claim: authors and reviewers still check behavior against code.

Use only synthetic, public-safe illustrations. Do not reuse private console
screenshots, channel names, real hosts or transcripts. The named channels in the
homepage diagram are illustrative. Build output is a short explicit allowlist:
three HTML pages, CSS, SVG and `.nojekyll`. No recursive repo/doc copying.

## Build, preview, validate

From the repository root, on Node 22.19+ (Node 24 LTS recommended):

```sh
node website/build.mjs
node website/preview.mjs          # http://127.0.0.1:4173; Ctrl-C to stop
node --test website/site.test.mjs

# Browser/accessibility checks and opt-in screenshot capture:
npm ci --prefix website
node website/node_modules/playwright/cli.js install chromium
# On CI / a supported Linux machine that needs browser libraries:
# node website/node_modules/playwright/cli.js install --with-deps chromium
npm run test:browser --prefix website
npm run screenshots --prefix website
```

The browser check serves the built site under `/seneschal/` (the GitHub Pages project path), checks all
pages at 1440px, 390px and 320px for overflow, keyboard skip navigation and axe
WCAG 2.1 AA/best-practice violations, and checks category navigation plus no-JS
navigation. Automated accessibility checks do not replace human review.
Screenshots are actual rendered PNGs at 1x under `docs/screenshots/website/`.
Only `--screenshots` writes evidence; normal browser tests do not alter tracked
images. The PR should embed commit-pinned desktop/mobile images using:

```text
https://github.com/denwilliams/seneschal/blob/<sha>/docs/screenshots/website/overview-desktop.png?raw=true
```

Blob links are review evidence, not public website assets. Keep evidence small
(roughly 150 KB/image or less) and inspect layout, clipping and readable contrast yourself. `website/dist/` is
ignored and must not be committed. The website CI validates and uploads the
built static output as a review artifact without publishing it.

## Hosting decision and owner actions

**GitHub Pages is the preferred target.** This is a static site with relative
links, and both repository-root and project-subpath hosting are supported. No
Cloudflare service is needed if Pages is available.

The site is published from this repository to
<https://denwilliams.github.io/seneschal/>. Do not report it as live without
loading that URL.

To set up or re-create publishing, a repository owner must:

1. Enable Actions if necessary, then Settings → Pages → Source: **GitHub Actions**.
2. Configure the `github-pages` environment to allow **main only**, with the
   appropriate required reviewers. Allow the workflow's Pages and OIDC token
   permissions. No long-lived hosting secret is needed.
3. After review and merge, manually dispatch **Publish feature website** from
   `main`. The workflow refuses any other branch, rebuilds/validates the site,
   uploads only `website/dist/`, and publishes using the protected environment.
   It does not deploy on a PR or automatically on push.
4. Read the `deploy-pages` output URL and verify `/`, `features.html`, and
   `getting-started.html` anonymously on desktop and mobile, including category
   anchors and CSS/icons. Only then report the real public URL as live.

Workflow artifacts and deployments contain only the generated allowlisted files.
The Pages deploy job gets `pages: write` and `id-token: write`; validation runs
with `contents: read`. No harness deploy permissions or services are reused.

### Cloudflare Pages fallback

If GitHub Pages is unavailable, Cloudflare Pages can host the same output.
The same static output needs no code or source-visibility change. Do not run the
GitHub publishing workflow in that case.

An authorized owner can create a **Direct Upload Pages project** (no GitHub source
access required), or authorize Cloudflare's Git integration for only this repo.
For Git integration use build command `node website/build.mjs`, output directory
`website/dist`, and Node 24. Review preview-deployment exposure before enabling
automatic branch builds. Use a new website-only project, not the harness console
or an existing private service.

For explicit Direct Upload, after review/approval and checking out the exact
approved commit, with a reviewed Wrangler installation and owner-provisioned
`CLOUDFLARE_ACCOUNT_ID` / Pages-scoped `CLOUDFLARE_API_TOKEN` in the environment:

```sh
node website/build.mjs
node --test website/site.test.mjs
# One-time owner setup; replace the project name if desired:
wrangler pages project create seneschal-website --production-branch main
wrangler pages deploy website/dist --project-name seneschal-website --branch main
```

Record the returned deployment URL and verify it anonymously as above. Custom
domains/DNS and account authorization remain owner actions. No Cloudflare project,
credentials or deployment is created by this PR. Do not use the Worker's deployer
skill/commands for Pages: this is a separate static Pages project.

## Updates and rollback

Feature PRs update the inventory/copy in the same branch, run validation and show
rendered evidence. After merge, a separately authorized publish updates the site.
For GitHub Pages rollback, revert the website commit on `main` through normal
review and dispatch the workflow again. For Cloudflare Pages, an authorized
owner can roll back to the previously verified production deployment in the Pages
dashboard (or deploy an approved prior commit's static output). Verify all three
pages after rollback. Disabling this public site does not affect the harness.
