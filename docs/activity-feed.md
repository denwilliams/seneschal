# Cross-channel activity feed

The console home (`<baseUrl>/console2/#/`, or **Activity** in the header) is a single newest-first timeline. It mixes ordinary messages, scheduled and conversation updates, document/investigation publications, permission/config approvals, held-post decisions, canned responses, public browser-pairing prompts, and workflow updates. Attention markers do not change the chronological ordering. **Open in Slack** leads to the original post, or the originating thread for delivered conversation answers. File publications without a thread timestamp link to their Slack file permalink. Decisions still happen there; this feature adds no privileged action endpoint.

The page polls every ten seconds while the document is visible, also refreshes on console reconnect/tree changes, and offers manual refresh and **Load older activity**. Errors retain loaded entries with a warning. Reloading offline does not restore private activity from a browser cache.

## JSON API

`GET <baseUrl>/console2/api/v1/activity`

This is the same data consumed by the page, usable independently by a later widget. It inherits the existing console listener, base-URL prefix, Host/Origin checks and optional Cloudflare Access JWT validation. Responses are `application/json`, `Cache-Control: no-store`. POST is refused. No CORS bypass or new public listener is provided. If Access validation is disabled, the existing console requires external authentication; this change does **not** make an unprotected console safe to expose publicly.

The console is an operator surface, not a per-Slack-user membership proxy. The feed includes only known, currently resolvable non-DM channels. Rejected/removed channels and unknown on-disk directories are not read. Direct messages are excluded entirely, including snippets and links. `channelIds` describes current feed scope so clients can discard previously loaded channels after configuration changes.

Example with an existing Access session (never save the token with widget data):

```sh
curl --header "Cf-Access-Jwt-Assertion: $ACCESS_JWT" \
  "$BASE_URL/console2/api/v1/activity?limit=50"
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `limit` | Integer 1–100; default 50. Invalid values return 400. |
| `cursor` | Opaque `nextCursor` from the previous response. Preserves ordering boundary, initial time ceiling and incremental filter. Do not construct or edit it. Malformed values return 400. |
| `since` | Inclusive ISO UTC timestamp, e.g. `2026-11-01T10:00:00.000Z`. Selects entries whose **state changed**, including resolutions of older prompts, not only newly created entries. Invalid timestamps return 400. |

Example response:

```json
{
  "generatedAt": "2026-11-01T10:01:00.000Z",
  "watermark": "2026-11-01T10:01:00.000Z",
  "channelIds": ["C01234567"],
  "entries": [{
    "id": "948210c95b570ae739bbf9a3",
    "at": "2026-11-01T10:00:00.000Z",
    "updatedAt": "2026-11-01T10:00:00.000Z",
    "channel": { "id": "C01234567", "name": "general" },
    "kind": "approval",
    "title": "Deployment approval",
    "snippet": "Deploy the reviewed commit to staging.",
    "sourceUrl": "https://slack.com/archives/C01234567/p1793527200000100",
    "interaction": "pending"
  }],
  "nextCursor": "opaque-cursor"
}
```

- `id` is an opaque stable identifier scoped to the channel/source identity. Retries and status edits reuse it; a new published message or workflow wait gets its own entry.
- `at` is the immutable time first recorded by the harness, not an editable channel summary. Ordering is descending `(at, id)`; ties have deterministic pagination.
- `updatedAt` changes when snippet/state changes. Resolution does not move an old request above new activity.
- `kind` is `message`, `chat`, `scheduled`, `approval`, `prompt`, or `workflow`.
- `interaction` is `none`, `pending`, `resolved`, `expired`, or `unavailable`. Only `pending` means attention is outstanding. Accepted decisions settle entries even if replacing their Slack buttons fails. Expiring in-memory config/held/browser requests become expired at their deadline or unavailable after restart. A prompt without a valid source link is never reported pending.
- `sourceUrl` and channel `name` are optional. Links are constructed only from validated Slack channel/message identifiers, never supplied tool URLs (uploads may use a validated Slack-returned file permalink).

### Consumption

1. Fetch the first page and follow `nextCursor` to load older retained activity as needed. New entries created after that first page do not shift the pagination boundary.
2. Keep entries keyed by `id`, replacing them only with an equal/newer `updatedAt`; never sort by interaction urgency or `updatedAt`.
3. After initial loading, poll with `since=<watermark>` from the first response. Consume **all** pages of that incremental batch before advancing to its `watermark`. A failed batch can be replayed safely. Boundaries are inclusive, so deduplication by ID is required.
4. Remove cached entries whose channel is absent from `channelIds`. Periodically reload the retained feed if keeping a long-lived cache: there are no per-entry deletion tombstones for journal rotation.

Pagination is a live view, not a database snapshot: an entry can resolve while pages are being read. The fixed time ceiling excludes later creations; changes after that ceiling are picked up by the next incremental poll. Cursors do not grant access and are re-evaluated against current channel configuration on every request.

## Persistence, privacy, and retention

Each non-DM channel gets `activity.jsonl` beside `timeline.jsonl`, outside the agent's workspace/jail. This is a small append-only journal of bounded, sanitized public-facing snapshots, not a transcript or tool audit. It rotates at about 4 MiB, retaining one previous file (about 8 MiB/channel total). Readers collapse repeated snapshots by stable ID before paging. Torn lines are ignored. Writes are best-effort and cannot fail a Slack delivery. No background connector or Slack-history polling is added, and reading the feed does not open durable conversation stores.

Only explicit user-facing publication/delivery paths are recorded. Tool arguments/results, reasoning, uploaded file bytes/local paths, config diffs, held drafts, button values, OAuth challenges and credentials are not copied. Snippets are plain text, capped at 280 characters, with code blocks, common credential patterns and URL credentials/query strings removed before persistence. The UI renders text, not HTML/Markdown. Existing channel access protection still matters: ordinary user-facing Slack text can itself be sensitive.

Recording starts when this version runs; old Slack history/private transcripts are not backfilled. Existing journals survive restart. There is no guaranteed retention duration: busier channels rotate sooner, and an old incremental cursor cannot recover history already rotated away. Repeated workflow card edits update the corresponding entry; substantive thread posts and subsequent workflow waits are separate activity. Quiet scheduled work is represented when it publishes something; invisible tool-level work does not produce noise.

No configuration or database migration is required. Roll back by deploying the previous application version; it ignores the additional journal files. Keep them for a later upgrade, or remove them while the harness is stopped if their retained history is unwanted.

## Tests and screenshots

Backend contracts/delivery coverage: `src/console2/activity.test.ts`, `src/slack/activity.test.ts`, access and approval regression tests. Browser coverage includes polling merges, pagination, source links, state changes, errors, and the real API/CSP/offline boundary.

Regenerate mock screenshots:

```sh
cd web/console2
SCREENSHOTS=1 npx playwright test e2e/screenshots-activity.spec.ts
python3 scripts/shrink-pngs.py ../../docs/screenshots/activity  # Pillow required
```

Light, dark and 390px screenshots live in `docs/screenshots/activity/`.
