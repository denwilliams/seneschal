# Write-only environment secrets and supervised restart

The web console's **Admin → Secrets and restart** lists environment **names and set status only**. It never returns existing secret values. An operator may add or replace a harness-wide variable; replacing an inherited or managed name requires explicit confirmation. Values are cleared from the input on every submission, including failure, and are not put in browser storage, task records, audit records or responses. Password managers, browser extensions and proxy request-body logging remain the operator's responsibility.

## Protect the Admin boundary first

There is **no built-in login**, just as for the configuration editor. All visitors allowed through your externally authenticated Admin boundary can manage harness credentials and interrupt the process. Protect both `/console2/` and `/console2/api/v1/*` (including `config` and `secrets`) with Cloudflare Zero Trust or an equivalent authenticating proxy. Do not expose an unauthenticated listener, and do not authenticate only the HTML page. `webConsole.actions` is **not** an Admin permission switch. The existing Host/origin checks, same-origin Fetch Metadata and custom `x-console-admin: 1` JSON-write header prevent browser cross-site requests; they are not a replacement for authentication. Responses use `Cache-Control: no-store`. Disable request-body capture at proxies/APM for this endpoint.

## Docker Compose (supported baseline)

1. Enable the web console and your external access protection in the normal way.
2. Create a private host directory, owned by the harness runtime user (normally `node`, UID/GID 1000):

   ```sh
   mkdir -p private-env
   chmod 700 private-env
   sudo chown 1000:1000 private-env
   docker compose -f docker-compose.yml -f docker-compose.secret-admin.yml up -d --build
   ```

3. Open Admin → Secrets and restart. Save a name and value. **Saved** means persisted, **not applied to this process**. Names with changed managed values say **Pending restart**.
4. Choose **Restart harness…**, acknowledge the interrupted work warning, then confirm. The API acknowledges first; the harness then starts graceful shutdown, bounded at 10 seconds. Compose's existing `restart: unless-stopped` brings it back. No Docker socket or arbitrary command execution is added.
5. Wait a few seconds and choose **Check service return**. A changed startup instance verifies a new process answered; it does not prove that each external integration accepts its new credential. Verify the affected integration separately. If you reload the page or leave Secrets and restart, the in-memory previous instance is lost; use supervisor logs/health to verify the restart instead.

The override mounts a **directory**, not a single file, so atomic replacement works. Store it on a local filesystem with atomic rename and directory fsync support. Never put it in `data`, a channel workspace, a shared directory or source control. Keep all directory components free of symlinks; the immediate parent must be owner-only (`0700`) and owned by the harness user. The file is owner-only (`0600`), not a symlink or hard link. No automatic backup of secret values is made. Back up this directory separately using your protected secret-backup procedure; normal harness data backups do not include it. A host-mode shell running as the harness user has the same underlying OS authority as the process; this is not a new sandbox boundary.

## Startup, precedence and format

`HARNESS_MANAGED_ENV_FILE` is a server-side, absolute file path selected by the operator. Unset by default: inherited names remain visible but saving is unavailable. The parent must already exist; the first save creates the file. The private **JSON string map** format is intentional: it round-trips quotes, backslashes, literal `${...}` and newline characters without dotenv interpolation, shell evaluation or generated code. Do not feed it to a shell or Compose `env_file`. Limits: 1 MiB file, 16 KiB per value; names are uppercase `[A-Z][A-Z0-9_]*`, up to 128 characters. Empty/NUL-containing values and deletion are not supported by the UI. Remove a name manually on the host while stopped if necessary.

Startup reads it before importing provider libraries, expanding YAML, or initializing Slack. Invalid/insecure storage fails startup with a generic diagnostic that contains no values. Precedence:

1. Inherited process environment (including container-injected variables / CLI `.env`).
2. Managed environment JSON, overriding the inherited names it contains.
3. Existing global and per-channel env files retain their existing higher-priority precedence when resolving channel-local secrets. No channel's env file is promoted into process.env or another channel.

Saved changes do not mutate live `process.env` or hot-reload credentials. A fresh process rereads the managed file, which is why the Compose restart works. **Editing Compose's host `.env` and restarting a container does not refresh container-injected variables**; use `docker compose up -d --force-recreate` for those changes. The protected managed-file path/restart opt-in themselves must be supplied by the host, not the UI or the managed file.

Runtime/bootstrap controls cannot be managed here: `HARNESS_*`, `NODE_*`, `LD_*`, `DYLD_*`, `BASH_*`, `GIT_*`, `NPM_*`, `LC_*`, `PYTHON*`, plus shell/path/home/user/temp, locale/timezone, proxy/CA settings and `LOG_LEVEL`. Manage those on the host. Slack/provider/integration keys can be managed. Existing OAuth credential stores and per-channel env-file editing are out of scope.

## Other supervisors and restart failure

For a persistent host service, set `HARNESS_MANAGED_ENV_FILE` to an equivalent private location. Set `HARNESS_ALLOW_RESTART=1` **only** when a supervisor is configured to restart even after a clean exit (for example systemd `Restart=always`, not merely `on-failure`). Without that opt-in, the API rejects restart and the UI shows it unavailable rather than just stopping an unsupervised process. The client cannot choose a file path, restart command, signal or timeout.

A restart acknowledgement is not proof of return. Lost connections have unknown outcome: refresh names/check service return before retrying. If the supervisor fails or the new configuration cannot start, recover on the host, repair/remove the managed entry, then start the service. If persistence fails after atomic rename, the save outcome may be uncertain; inspect names/status or the private file locally before retrying. Save requests are serialized within the process; do not edit this file concurrently from another process. Repeated restart requests are refused while one is pending.

## Rollback

Stop the service, restore/remove the relevant entries in the private JSON file (keep `0600`), and start it again. To disable the feature, remove the Compose override / `HARNESS_MANAGED_ENV_FILE` and `HARNESS_ALLOW_RESTART` from the supervisor environment and recreate/restart the service. Inherited env then applies again. Never paste the private file or secret values into an issue, log or agent task.

## Verification

- Backend: `node --experimental-strip-types --test src/config/managed-env.test.ts src/console2/secrets.test.ts src/util/shutdown.test.ts`
- UI: `npm run e2e --prefix web/console2 -- e2e/secrets.spec.ts`
- Regenerate documentation screenshots: `cd web/console2 && SCREENSHOTS=1 npm run e2e -- e2e/screenshots-secrets.spec.ts`.
