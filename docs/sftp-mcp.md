# SFTP MCP connector

This integration uses [wpfyorg/mcp-server-sftp](https://github.com/wpfyorg/mcp-server-sftp),
version `1.1.0` at commit `590944a4ca4b32636ba1fa0df8159597d6feb536`.
It is an MIT-licensed, stdio MCP server that uses the SFTP subsystem only and
provides the file operations needed here: list, read/write, rename/move, and
file/directory deletion. It does not execute a remote shell.

The server's `SFTP_ALLOWED_PREFIX` protects mutating calls, but its upstream
read-only tools are not prefix-guarded. Therefore **a dedicated SFTP-only,
chrooted account is mandatory**. The SFTP service, rather than prompt wording
or MCP configuration, is the security boundary which makes every operation
(including reads and a rename source) stay under the one configured remote
root.

## Install the pinned MCP server

Install the reviewed revision on the harness host in an operator-owned location.
Do not install it with a floating `npx` package version.

```bash
git clone https://github.com/wpfyorg/mcp-server-sftp.git <mcp-server-directory>
git -C <mcp-server-directory> checkout 590944a4ca4b32636ba1fa0df8159597d6feb536
npm --prefix <mcp-server-directory> ci --omit=dev
```

Set `SFTP_MCP_SERVER_PATH` in the enabled channel's private env file to the
absolute path of that checkout's `index.mjs`. The path is configuration, not a
key; do not put private-key material in any YAML or env file value.

Before changing the pinned revision, review its dependency lockfile and source,
then update the commit in both this document and the checkout command.

## Required harness configuration

Copy [`config/sftp-mcp.example.yaml`](../config/sftp-mcp.example.yaml) into the
real `harness.yaml` (merging its `connectors` and channel `share.connectors`
sections). The connector is opt-in: defining it alone grants no channel access.

The enabled channel's private env file must supply these names:

| Name | Required value |
| --- | --- |
| `SFTP_MCP_SERVER_PATH` | Absolute path to the installed, pinned `index.mjs`. |
| `SFTP_HOST` | The approved SFTP endpoint, supplied only in this private file. |
| `SFTP_PORT` | The approved SFTP port. |
| `SFTP_USER` | The dedicated, non-login SFTP account. |
| `SFTP_PRIVATE_KEY_PATH` | Absolute path, readable only by the harness service account, to that account's private key. |
| `SFTP_REMOTE_ROOT` | Exactly one absolute path inside the chroot, such as the dedicated data subtree. |
| `SFTP_MAX_READ_BYTES` | A bounded text-read limit appropriate for the service. |

Do not set `SFTP_PASSWORD`. The configured launcher removes that variable before
starting the MCP process, so authentication succeeds only when the configured
private key works. Keep the channel env file mode `0600` and keep the private
key owned/readable only by the harness service account.

The supplied connector allowlist intentionally excludes `sftp_upload`,
`sftp_download`, `sftp_sync_dir`, and all batch operations. The upstream
transfer tools take arbitrary absolute host-local paths, so exposing them would
let a connector reach files outside the channel workspace. The remaining tools
cover remote text-file management and do not expose an SSH command tool. The
upstream `SFTP_ALLOWED_PREFIX` must equal `SFTP_REMOTE_ROOT`; it is a second
guard on all mutations, not a substitute for the chroot.

## Required SFTP-server boundary

Create a dedicated account with one distinct authorized public key. Configure
OpenSSH so that account has all of the following properties:

- key authentication only; password and keyboard-interactive authentication are
  disabled for this account;
- `ForceCommand internal-sftp`, with no shell, forwarding (including Unix
  socket forwarding), X11 forwarding, agent forwarding, tunnels, or TTY;
- `ChrootDirectory` set to an administrator-owned directory (not writable by
  the SFTP account);
- one administrator-created writable data subtree inside that chroot, and
  `SFTP_REMOTE_ROOT` set to that subtree's absolute _chroot-visible_ path;
- filesystem ownership/ACLs that let the account access only that subtree.

Use a `Match User` block scoped only to this account. Replace every angle-bracket
placeholder with the values for the target server; do not copy an account name,
host, or directory from another service.

```text
Match User <dedicated-sftp-account>
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PubkeyAuthentication yes
    ChrootDirectory <administrator-owned-chroot-directory>
    ForceCommand internal-sftp
    DisableForwarding yes
    PermitTunnel no
    PermitTTY no
```

OpenSSH requires every path component of the chroot directory to be root-owned
and not writable by group or others. Make only the selected data subtree writable
by the SFTP account.
Validate the SSH configuration before reloading it, using the platform's normal
`sshd` configuration test command, and test the dedicated account with a
separate SFTP client first. Confirm attempts to list, read, rename, and delete
outside `SFTP_REMOTE_ROOT` fail.

The pinned upstream server does not currently expose a strict `known_hosts`
setting. Use it only over an authenticated private network/overlay with a
narrow firewall rule to the approved endpoint; do not treat this connector as
safe for an untrusted network path until host-key verification is available
upstream. This does not weaken the remote-root requirement: the chroot and
SFTP account permissions remain mandatory.

## Validate before enabling the connector

1. Start a new harness session with the connector enabled and run `!connectors`.
   It should list `sftp-files`; failure should be investigated before any file
   action.
2. List the configured root, then create and remove a disposable text file below it.
3. Attempt an operation on an absolute sibling path outside the configured root.
   It must fail at the SFTP server boundary.
4. Confirm the agent has only `sftp-files__...` connector tools, with no upload,
   download, or remote command-execution tool.
5. Keep destructive requests reviewed in Slack. `sftp_delete` and recursive
   `sftp_rmdir` are intentionally capable operations.
