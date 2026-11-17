# webConsole2

A read-only console for the harness: a workspace tree (channels → `main`, threads, subagent runs, scheduled and dream
forks), a numbered transcript with tool-call cards, and five side-panel tabs (Session, State, Tasks, Tools, Extend). It
is the console: the original server-rendered overview and channel list redirect here. Its timeline, artifacts-list and factory pages remain, linked from each channel as "Older views", until they are ported.

Stack: Vite, React, TypeScript, Tailwind and shadcn/ui (stock neutral theme, light and dark). The browser app only talks to
`<prefix>/console2/api/v1/*`; the wire types are `src/console2/api-types.ts`, imported with `import type` only.

## Develop

```sh
npm ci                                   # or: npm run console2:install   (from the repo root)
npm run mock                             # fake API + the built app on http://127.0.0.1:4010/console2/
CONSOLE2_TARGET=http://127.0.0.1:4010 npm run dev    # hot reload at http://localhost:5173/console2/
npm run dev                              # same, against a real harness (default http://127.0.0.1:3012)
```

The dev server serves the app at `/console2/` and proxies `/console2/api` to `CONSOLE2_TARGET`, so the app's relative
URLs resolve exactly as they do in production.

## Build and test

```sh
npm run build        # tsc --noEmit + vite build -> dist/ (relative URLs: works under any reverse-proxy prefix)
npm test             # vitest: route parsing and the live-transcript reducers
npm run e2e          # Playwright against the mock serving dist/ under a /proxy/harness prefix; screenshots in e2e/screenshots
```

First run of the e2e needs a browser: `npx playwright install chromium`.

## Layout

- `src/App.tsx`: three resizable panes (tree | tabs | transcript); tree and details become drawers below 1024px.
- `src/lib/api.ts`: API root derived from the page URL. `route.ts`: hash routes (`#/c/<channel>/t/<thread>?tab=tasks`).
- `src/lib/live.ts`: pure reducers that fold live events into a streaming draft and merge transcript pages.
- `src/lib/hooks.ts`: fetching, the one `EventSource` (reopened per watched thread, with backoff), theme.
- `src/components/ui/`: the shadcn components in use. `src/tabs/`: one file per tab.
- `mock/server.mjs`: the fixture API and a fake event stream, matching `api-types.ts`.

## Execution boundaries

Session and Tools distinguish **configured sandbox** (Docker, Apple Containers, or outside channel sandboxes) from
**bash routing** in the open runtime. A closed store shows configuration only. Only bash and its child commands use
that sandbox: file tools, restricted exec/`cli__` tools, job execution, connectors and orchestration are harness-side
or remote. “Outside” does not imply bare metal: the harness itself may be in a service container, and remote server
isolation is not known to the console.

Session can inspect a selected Slack thread's reusable container with the backend's read-only `inspect` command.
The check has a two-second timeout, a five-second cache and an observation timestamp; it never starts a container or
runs guest code. Ownership must match this installation before running/stopped is reported. Missing tools, daemon
access, malformed responses or ownership evidence produce **unknown/unavailable**, not “stopped”. Channel summaries,
per-command containers and routes without an exposed sandbox identity (including parent-sharing subagents and quiet
schedules) remain unknown. A running container does not prove an active command or that current config was applied.
No additional daemon access is granted by this visibility feature.

Regenerate the opt-in screenshots against the mock fixtures (Docker light, Apple Containers dark, host at 390px):

```sh
SCREENSHOTS=1 npx playwright test e2e/screenshots-execution.spec.ts
python3 scripts/shrink-pngs.py ../../docs/screenshots/execution-boundaries
```

## Contract notes

- The event stream is opened as `events?channel=<id>&thread=<key>` so the server knows which thread to stream; the
  `main` conversation is the thread key `main`.
- `text_delta` is never expected for direct messages; entries there arrive with `redacted: true` and no text.
