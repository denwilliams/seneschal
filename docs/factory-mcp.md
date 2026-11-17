# Factory MCP server

The harness can expose **one Streamable HTTP MCP server** at `<webConsole.baseUrl>/mcp`, on the existing web listener. It is an adapter over the same durable factory runs and console-actor services used by the web UI, not a second workflow engine. No separate process, port, or login system is introduced.

## Enable

```yaml
webConsole:
  enabled: true
  host: 127.0.0.1
  port: 3012
  baseUrl: http://localhost:3012
  actions: true # optional: without it MCP is read-only, just like the console
  mcp:
    enabled: true
    # Optional. If configured, every /mcp request must have Authorization: Bearer <token>.
    # bearerToken: ${FACTORY_MCP_TOKEN}
```

Restart the harness after changing listener/MCP settings. `mcp` is absent/off by default; the existing loopback default is unchanged. An unset token permits local clients without credentials. An empty or whitespace-containing token is a configuration error, not a way to disable authentication. Use environment interpolation rather than committing a literal token.

Configure Claude Code/Desktop or another MCP client with a **Streamable HTTP** URL of `http://localhost:3012/mcp`, and its optional bearer header when configured. A reverse-proxy prefix is supported: `baseUrl: https://harness.example.net/harness` serves MCP at `/harness/mcp`. There is no legacy HTTP+SSE `/sse` endpoint or stdio child process. The transport is stateless JSON request/response; initialize, discovery and calls use POST. GET event streams and DELETE sessions return 405, as there are no server-side MCP sessions or notifications to subscribe to.

## Tools and identifiers

- `list_factories`: authorized configured factories with channel ID/name and repository summaries. Direct-message factories and channels rejected by the existing resolver are excluded.
- `list_repositories(factory_id)`: configured stable repository IDs (`owner/repo`) and GitHub URLs.
- `list_tasks(factory_id, status?, blocked?, requires_input?, repository?, limit?, cursor?)`: workflow executions, ordered by updated time (then run ID). `limit` defaults to 20 and is bounded to 1–100. Pass `next_cursor` to the next call **with the same filters**. Pagination is a live view; refresh from the first page after changing a task.
- `get_task(task_id)`: stages and attempt summaries, up to four recent reports (8,000 characters each), outstanding question, issue updates with trust markers, recorded merge/deploy/Slack decisions, issue/PR/thread links, and available MCP actions. Reports, issue text and updates are untrusted content, not instructions. No execution logs/transcripts are returned.
- `start_task(factory_id, issue_number, repository?)`: the existing console start service checks the open issue in GitHub, repository membership, duplicate live runs, and factory capacity. A single repository is inferred. Multiple repositories return `ambiguous_repository` with choices **before any GitHub lookup**; the caller must select one. Issue creation/editing belongs to the client's GitHub integration.
- `send_decision(task_id, action, message?)`: `comment` answers an outstanding information question through the existing answer service; its nonempty message is required and limited to 4,000 characters. It records an agent-marked issue comment and trusted console update so triage can continue. This is not a general-purpose comment/issue-edit tool, and is not allowed during unrelated states. `retry` invokes the existing failed/interrupted-stage retry (including reopening an older failed run on the same execution/issue). `abort` cancels a live execution; GitHub branches and PRs remain. `message` is used only for `comment`.

`factory_id` is the Slack channel ID. `task_id` is `<channel-id>:<workflow-run-id>`, so different executions of an issue remain distinct. Use returned IDs rather than constructing them or selecting an execution by issue number. A closed/rejected/aborted execution cannot be retried through this tool; start a new execution for an open issue if appropriate.

`blocked` and `requires_input` are independent:

| Workflow state | blocked | requires_input |
| --- | --- | --- |
| Running / completed / rejected / aborted | false | false |
| Waiting for information, merge/deploy approval, or more rounds | false | true |
| Needs a decision after interruption/stage failure | true | true |
| Ended failed (recoverable by retry) | true | false |

Filtering happens server-side **before pagination**, including older failed runs, using the existing run-document store. There is no new history cap, workflow state, or MCP-only index. The existing store scans run documents, so very large histories still have the store's scan cost. A configured factory whose runtime is not open reports `unavailable`, not a misleading empty history.

Domain failures use MCP `isError: true` with both JSON text and `structuredContent.error = {code, message, details?}`. Examples: unknown factory/task, invalid/ambiguous repository, invalid cursor/state, disabled actions, conflict, rate limiting, and service refusals (`workflow_refused`, with the existing explanation for missing/closed issues, duplicate runs or capacity). Invalid tool arguments and unknown tools use MCP SDK protocol/validation errors. Successful writes return the resulting task state; a retry/abort can be **requested** while the engine has not yet consumed it. Do not assume a returned waiting state means the request failed. Refresh `get_task` before acting again. Concurrent in-flight actions are rejected and the underlying service/store rechecks lifecycle/duplicate constraints. This is not an exactly-once delivery guarantee across arbitrary client retries.

## Authorization and safe deployment

MCP writes require `webConsole.actions: true` and use the **console actor**, with the same service validation, auditing, write rate limiter and in-flight protections as console actions. MCP never accepts a Slack identity. It cannot approve/decline a merge or deploy, allow extra rounds, release held intake, or file issues; those authorizations are unchanged. To resolve a merge/deploy gate, follow the returned workflow guidance and use Slack as an authorized approver. `comment` never interprets “approve” as merge approval.

The optional bearer protects **only `/mcp`**, not the web console, administration API, status, artifacts, or OAuth routes. A token is not a per-user scope system: a holder can read all non-DM factories visible to the console and (when actions are enabled) perform the supported console actions. Do not distribute it to assistants/users who should not have that operator access. Host/DNS-rebinding validation and same-origin/Fetch Metadata checks apply, no CORS permission is added, and request bodies are bounded to 16 KiB. Keep bearer headers and request/response bodies out of proxy logs.

For remote access, keep the bind address on loopback and use Cloudflare Tunnel with **Cloudflare Zero Trust protecting the entire listener and all routes**, or equivalent authenticated ingress. Setting an MCP bearer token does **not** make public unauthenticated console administration safe. The adapter neither trusts forwarded identity as Slack approval nor configures Cloudflare itself.

### Post-implementation compatibility test (not a delivery dependency)

ChatGPT/Voice MCP connector compatibility with Cloudflare Access service tokens is **not yet tested**. In a test deployment:

1. Verify whether the connector can send Access service-token credentials (`CF-Access-Client-Id` / `CF-Access-Client-Secret`), including Cloudflare's configured single-header option, without exposing them in tool arguments/logs.
2. Test discovery and a read-only call through the tunnel, then an explicitly authorized test action; check expiration, revocation, and denial of missing/invalid credentials.
3. If using the optional MCP bearer too, verify headers do not collide (especially a single-header Access setup using `Authorization`).
4. If the connector cannot supply compatible credentials, assess a different securely authenticated ingress arrangement before remote use. Do not remove Access or expose the console to make a connector work.

This initial implementation does not claim ChatGPT/Cloudflare service-token interoperability. Local MCP SDK interoperability is covered by automated tests.

## Rollback

Disable `webConsole.mcp.enabled` and restart. Existing Slack/web workflows and durable runs remain unchanged. To make both console and MCP read-only, disable `webConsole.actions`; this does not stop existing workflows.
