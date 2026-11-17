# Memory pressure investigation (#265)

## Findings and limits

The reported macOS memory-pressure drop after restarting is real operator evidence, **not proof of a JavaScript heap leak**. The deployment revision, per-process memory series, exact uptime/workload/concurrency, container state, and before/after-restart process identities are still missing. No production connector credentials or Slack/model services were used here.

A narrower retention bug is reproduced: when MCP initialization succeeds but `tools/list` fails, `openConnectors` previously kept the failed client until its owning session closed. A stdio server therefore remained alive without offering any usable tools. The fix closes that client immediately and publishes a connector's tools only after successful discovery/construction. Other connectors in the session are unaffected. This is unnecessary resource retention, **not demonstrated unbounded multi-day heap growth**: normal session capacity/idle eviction already bounds ordinary warm sessions, while recovered bindings can live until their channel store retires.

### Reproducible local evidence

Captured on 2026-11-01, Node **v24.22.0**, Linux arm64, isolated coding sandbox. Baseline code is **d6012b09947cbaff6539b1e6cf84d807749377da**; the after run uses this change's connector lifecycle fix. Both use identical investigation script, memory sampler, fixture, and installed lockfile dependencies. Raw aggregate measurements: [before](investigations/265/before.jsonl), [after](investigations/265/after.jsonl). Times, uptime, process IDs and separate memory categories are in each row. No real Gmail connector or production screenshot was reproduced. Other repository tests were running in the same sandbox: these are scoped lifecycle measurements, not an idle-host memory benchmark.

Workload: one request stream (concurrency 1), six failed discovery attempts with sessions deliberately kept warm; then dispose them. Three batches of six fresh successful sessions, four 64 KiB tool results per session (72 calls total), through the real `SessionPool` configured for two warm sessions. Each batch ends by disposing the pool and waiting 2.5 seconds for SDK close-grace timers. This simulates tool-set/session lifecycles, **not full model turns, recovery, HTTP OAuth, or multi-day operation**. `after-gc` rows use explicit GC in the experiment only; ordinary idle rows do not.

| Checkpoint | Before: live fixture children / descendant RSS | After: live fixture children / descendant RSS |
| --- | --- | --- |
| Before work | 0 / 0 | 0 / 0 |
| After six failed discoveries, owners still warm | 6 / 429.4 MiB | 0 / 0 |
| After failed-session disposal | 0 / 0 | 0 / 0 |
| Successful batches 1 / 2 / 3, warm | 2 / 143.1, 144.5, 144.9 MiB | 2 / 142.3, 144.4, 142.3 MiB |
| After each successful batch's disposal + idle | 0 / 0 | 0 / 0 |

After the fix, cumulative async process starts still reach **24**, but current running children return to **0**. Those measurements answer different questions. Post-GC heap-used after successful batches is **75.72 / 75.85 / 75.87 MiB**; external memory returns to about **14.07 MiB**, array buffers to **0.21 MiB**. Harness RSS remains about **252 MiB**, rather than returning to zero. Small short-run heap differences or RSS retained by an allocator are not leak proof. The failure-phase growth is attributable to the fixture MCP server processes, not a corresponding 429 MiB increase in harness heap. RSS sums can double-count shared pages.

Run from the repository root after `npm ci`:

```sh
LOG_LEVEL=error node --expose-gc --experimental-strip-types scripts/investigate-memory.ts > memory-local.jsonl
node --experimental-strip-types --test --test-timeout=120000 src/agent/connectors-lifecycle.test.ts src/util/memory-diagnostics.test.ts
```

The script is fixed-size (24 connector attempts), cleans up its own sessions/processes, and records no tool content. Omit `--expose-gc` to collect only natural measurements. To compare against baseline without changing another checkout, create a **separate detached worktree** at the baseline SHA, copy `scripts/investigate-memory.ts`, `src/util/memory-diagnostics.ts` and `src/agent/fixtures/memory-connector.mjs` into their corresponding paths, and install the baseline lockfile dependencies there. Run the same command. The sampler/fixture are measurement apparatus, not changes to baseline connector behavior. Do not run this synthetic fixture as a production connector.

Regression tests first failed on baseline (four failed-discovery processes still alive, plus the mixed-session cleanup check); all now pass. Tests also cover repeated successful large outputs/disposal, independent channel owners, owner/PID attribution, duplicate disposal, process-start failure versus successful starts, sync exclusions, timer shutdown, and numeric process-tree parsing.

## Connector multiplication, authentication and reuse

Source tracing confirms **more than one instance per channel is possible**, even without reconnects:

- `buildThreadToolSet` opens the channel's allowed connectors **per thread session**, not once per account or channel. Multiple warm threads coexist; repeated turns on the same warm session reuse its clients.
- `createSubagentRunner` builds a separate, permission-narrowed tool set for each subagent. Normal completion/failure disposes it in `finally`.
- Schema-template construction can transiently open another set, disposed after the channel runtime has been acquired. These events are tagged `template`.
- On restart, recovery can rebuild bindings without a live session. They are tagged `recovery`; their disposers belong to the channel runtime and run when that store retires. Ordinary idle session eviction is not a lifetime bound for those recovered clients.
- Capacity eviction and the 30-minute idle sweeper dispose normal idle sessions; active-turn leases protect running work. Configuration invalidation disposes idle owners immediately and active owners when their turns finish; store retirement and shutdown run the recovered-owner disposers.
- Each new HTTP client initializes a transport and can start its own stream. OAuth files are channel-scoped (`FileConnectorOAuthProvider`); clients in one channel can read the same stored token, but new client creation is **not itself evidence of a fresh interactive authentication or token refresh**. Stdio connectors may implement their own authentication and cache policy outside this harness.

Thus concurrent duplicate processes, extra initialization/list requests and separate in-process caches are possible by design. The same configured name in different channels does **not** establish the same account, credentials, environment, workspace, allowlist or execution boundary. The operator's repeated Gmail authentication may additionally involve reconnects, retries or server behavior; no auth-refresh trace, cache-hit data or rate-limit response was supplied. We cannot quantify Gmail rate-limit/cache impact from the synthetic fixture.

Safe reuse was evaluated but **not implemented**. Pooling globally by connector name would mix channel secrets, OAuth state, cwd, attachment routing and role-specific permissions. Even within a channel, per-run environment and tool allowlists can differ, and some MCP servers have mutable session state. A pooling change needs an explicit full isolation-equivalence key, reference-counted ownership, permission-filtered views, concurrent-request/cancellation rules, refresh serialization and reload/recovery draining tests. The demonstrated failed-discovery cleanup is safe without changing those boundaries. Normal concurrent successful instances remain intentional; their new lifecycle evidence can establish whether reuse is worth a separate design change.

## Production capture: bounded, opt-in visibility

Set **in the actual harness service environment**, then restart once to enable observation:

```sh
HARNESS_MEMORY_SAMPLE_SECONDS=60
LOG_LEVEL=info
```

For LaunchDaemon, set the service's environment, not merely an interactive shell's; for Docker, pass the variable into the harness container. See `.env.example`. Unset the sampling variable and restart to disable. Valid sampling periods are integer seconds **1–3600**; invalid values warn and disable diagnostics rather than blocking startup. Prefer 60 seconds: process-tree collection has overhead. Samples are emitted immediately and periodically at info level. There is no new HTTP endpoint, in-memory sample history, database, heap snapshot, or forced production GC. Use existing service log rotation/size limits; these events do not configure disk retention. Disable after the observation window (for example 72 hours).

Log records are JSON following the usual timestamp/level prefix:

### `kind: "harness.memory"`

- `pid`, `uptimeSeconds`, `observedSinceUptimeSeconds`, `timestamp`: identify the harness and observation window. Counters reset on harness restart and start before app/model/connector startup.
- `harness.rssBytes`, `heapUsedBytes`, `heapTotalBytes`, `externalBytes`, `arrayBuffersBytes`: **this Node process only**. `arrayBuffersBytes` overlaps `externalBytes`; these fields must not be added together to estimate total memory. RSS includes more than heap, including native allocations/mappings.
- `asyncChildren.started`: cumulative **successfully spawned direct asynchronous Node child processes since observation began** (Node's `child_process` diagnostic channel: spawn/exec/execFile/fork, including the MCP SDK). `exited` counts observed exits; `failedStarts` counts observed launch attempts that close without spawning. `running` counts observed spawned children not yet exited. This is not a count of processes ever launched by the entire installation.
- **Not in start counters:** synchronous spawn/exec, grandchildren/shell commands, daemon-launched container workloads, starts before observation, other harness processes, or historical starts before this revision/restart. No process command line/environment is collected. Detached/reparented async children remain in the observed-running count until their exit is observed, but may disappear from the descendant tree.
- `descendants.available`, `count`, `rssBytes`: **current visible descendants** of this harness PID, excluding the harness and the `ps` collector. Linux uses numeric `/proc` metadata (bounded process count/time); other hosts use a numeric-only `ps` table (2-second timeout, 2 MiB output cap). Unsupported/failed capture reports `available:false` and omits counts, **not zero**. This is a best-effort, non-atomic snapshot; exiting/inaccessible processes may be missed. The process tree can include grandchildren, unlike direct async start counters. Its RSS includes external memory of those processes but cannot separate their JS/native allocations.
- Container/VM memory and processes owned by Docker/Apple container services are generally **not descendants of the harness**, especially across PID namespaces. Remote HTTP MCP server memory is also unavailable. Neither is silently included in harness RSS or claimed to be covered by process counters.

### `kind: "harness.connector"`

Events `opening`, `ready`, `failed`, `closed` identify `pid` (harness), `instanceId` (unique within that process lifetime), `channelId`, connector's configured name, transport, and owner category `thread` / `subagent` / `template` / `recovery` (`unspecified` for direct callers). `processPid` is the local stdio server PID **when available after initialization**; HTTP instances do not have a local server PID. `instanceAttemptsStarted` is cumulative **MCP client construction attempts**, including failures and HTTP clients, not OS process starts. `instancesOwned` counts current unclosed owner records, including initialization, not confirmed live processes or shared accounts. A server can exit while its session still owns a handle. `cleanupFailed:true` means release failed and resources may remain even after logical ownership ended; correlate with process samples. Repeated disposal emits no duplicate close event.

Group by harness PID and instance ID to match openings to terminal events and by channel/name/owner to distinguish simultaneous thread/subagent instances from repeated reconnect/reload attempts. These events never log URLs, tokens, headers, environment values, command arguments, thread/user content or tool outputs. They do not count authentication refreshes, cache hits or individual connector requests; no sensitive auth instrumentation was added.

### Capture the missing long-running evidence

1. Record `git rev-parse HEAD`, `node --version`, deployment mode, exact service start time and sampling interval. Do not substitute the investigation's base SHA for the production revision. Keep only aggregate workload notes: completed turns, connector calls/errors, concurrency and whether subagents/reload/recovery occurred; omit message/tool content.
2. Collect a baseline before work, samples during repeated representative tool/connector calls and completed turns, and after work finishes plus **more than 31 minutes idle** (normal 30-minute session eviction plus sweep). Compare the same workload again. Preserve a sample before and after any restart and note exactly which child/container services it stopped. Use OS-wide process inspection to catch reparented children.
3. Separately capture container IDs, running state, current processes and memory using the **actual configured backend**. For Docker, `docker stats --no-stream --format '{{.ID}} {{.MemUsage}} {{.PIDs}}'` supplies current container memory/process counts, not cumulative starts. Check `docker top <id>` locally but do not post arguments/secrets. For Apple Containers, use the installed CLI's supported statistics/inspection commands and Activity Monitor's runtime/VM processes; availability varies, so record unavailable fields rather than inventing numbers. Do not force-stop active/uncertain sandboxes just to lower memory.
4. If post-idle harness heap grows across batches, investigate retained bindings/profiles/tasks/connections with a controlled local heap profile; heap dumps can contain **all secrets and private content**, so do not collect or upload production dumps by default. If only external/RSS grows, examine buffers/native allocations and allocator behavior. If descendants or containers grow while harness heap is stable, investigate those owners first. Ten connector/auth events alone cannot distinguish ten concurrent servers from ten sequential retries.

Remaining gaps: multi-day production/macOS samples; real Gmail auth/cache/request traces; HTTP stream/pending-request behavior under cancellation/reconnect; recovered-binding retirement under the reported workload; orphan/daemon/container memory. This PR does not claim to resolve those unmeasured causes or introduce cross-channel sharing. Rollback: unset the opt-in diagnostic variable (no schema/data migration); revert the PR to undo code changes. Failed connectors would again remain until owner disposal if the fix is reverted.
