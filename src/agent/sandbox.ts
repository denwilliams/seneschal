import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxConfig } from "../config/schema.ts";
import { SandboxLifecycle, dockerCall, sandboxFingerprint } from "./sandbox-lifecycle.ts";
import { CONTAINER_GLOBAL_BIN } from "../workspace/collections.ts";
import { logger } from "../util/log.ts";
import { appleCall, appleRuntime, kiriCall, kiriRuntime, type ContainerBackend } from "./sandbox-runtime.ts";
import { APPLE_LAUNCHER, appleAvailable, appleConfigProblem, appleHostProblem, inspectAppleImage, pinAppleImage } from "./sandbox-apple.ts";
import { inspectKiriImage, kiriUnavailableReason } from "./sandbox-kiri.ts";
export { appleConfigProblem, appleHostProblem } from "./sandbox-apple.ts";

export function isContainerMode(mode: SandboxConfig["mode"] | undefined): mode is ContainerBackend {
  return mode === "docker" || mode === "macos-container" || mode === "kiri";
}

function backendCommand(mode: SandboxConfig["mode"]): string {
  return mode === "macos-container" ? "container" : mode === "kiri" ? "kiri" : "docker";
}

function backendCall(mode: SandboxConfig["mode"]) {
  return mode === "macos-container" ? appleCall : mode === "kiri" ? kiriCall : dockerCall;
}

export function containerBackendAvailable(mode: SandboxConfig["mode"]): boolean {
  return mode === "macos-container" ? !appleHostProblem() && appleAvailable() : mode === "kiri" ? !kiriUnavailableReason() : dockerAvailable();
}

function mountSource(opts: DockerSandboxOptions, target: string): string {
  if (opts.config.mode !== "macos-container") return dockerDataMountSource(target, opts.dataDir, opts.dockerDataDir);
  dockerDataMountSource(target, opts.dataDir, "", false);
  return dockerDataMountSource(realpathSync(target), realpathSync(opts.dataDir), "", false);
}

/**
 * Running `bash` inside a container, per Slack thread.
 *
 * Every other tool is confined by path checking, but a shell cannot be: once
 * `bash` is enabled, it can reach anything the harness process can, including
 * other channels' directories and the credential store. Giving each channel a
 * container with only its own workspace mounted restores the boundary for the
 * one tool that could otherwise step over it.
 *
 * By default a thread gets ONE long-lived container that commands `exec` into,
 * rather than a fresh container per command. That matters for real work:
 * anything the agent installs, builds or leaves running persists between
 * commands, and an exec costs milliseconds where a container start costs
 * hundreds. Set `reuse: false` for a throwaway container per command.
 */

export interface DockerSandboxOptions {
  config: SandboxConfig;
  /** Workspace path visible to the harness process. */
  workspace: string;
  /** The harness-visible data directory containing this workspace. */
  dataDir: string;
  /** Same data directory as the Docker daemon sees it (host path in Compose). */
  dockerDataDir?: string;
  /** Channel environment. Passed by name so values never appear in argv. */
  env: Record<string, string>;
  /** Channel identity owns the shared workspace. */
  channelId: string;
  /** Required stable session identity, never silently falls back to channel. */
  threadKey: string;
  /**
   * The channel's own Dockerfile, when it has one. Present means the image in
   * `config.image` is built from it on demand rather than by hand.
   */
  dockerfile?: string;
  /**
   * Extra bind mounts from the channel resolver: this channel's own skills,
   * its assigned skill collections and the operator's global bin, each at a
   * fixed in-container path. Never anything belonging to another channel; the
   * resolver is the only producer, and every host path is re-checked to lie
   * under `dataDir` here.
   */
  mounts?: SandboxMount[];
}

export interface SandboxMount {
  /** Absolute path as the harness sees it, under the data directory. */
  hostPath: string;
  /** Absolute path inside the container. */
  containerPath: string;
  /** `true` mounts with Docker's `readonly` flag: writes fail with EROFS. */
  readOnly: boolean;
}

/**
 * The workspace's `bin` directory, as the container sees it.
 *
 * Host and container disagree about the path — `/data/channels/C1/workspace/bin`
 * against `/workspace/bin` — so the two modes prepend it differently, but the
 * agent gets the same deal either way: anything executable in `bin/` is a
 * command it can run by name.
 */
export const CONTAINER_BIN = "/workspace/bin";
export { CONTAINER_GLOBAL_BIN };

/**
 * Resolve the source path passed to Docker for the channel workspace.
 *
 * A Docker daemon always resolves bind-mount sources in *its* filesystem. On a
 * host install that is the same path the harness sees. When the harness itself
 * is in Docker, `/app/data` is only a path in the service container, so the
 * Compose sandbox override supplies the host counterpart in
 * HARNESS_DOCKER_DATA_DIR. Never silently mount the service-container path in
 * that case: Docker would create or use a different host directory and the
 * channel would appear to have an empty/non-writable workspace.
 */
export function dockerWorkspaceMountSource(
  workspace: string,
  dataDir: string,
  daemonDataDir = process.env.HARNESS_DOCKER_DATA_DIR,
  inContainer = existsSync("/.dockerenv"),
): string {
  return dockerDataMountSource(workspace, dataDir, daemonDataDir, inContainer, "workspace");
}

/** Same translation for any path below the data directory (skills, global bin). */
export function dockerDataMountSource(
  target: string,
  dataDir: string,
  daemonDataDir = process.env.HARNESS_DOCKER_DATA_DIR,
  inContainer = existsSync("/.dockerenv"),
  label = "mount source",
): string {
  const localTarget = resolve(target);
  const localDataDir = resolve(dataDir);
  const rel = relative(localDataDir, localTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} ${target} is not below data directory ${dataDir}`);
  }

  if (!daemonDataDir) {
    if (inContainer) {
      throw new Error(
        "HARNESS_DOCKER_DATA_DIR is required when the harness runs in Docker; " +
          "start it with docker-compose.sandbox.yml so Docker sees the host data directory",
      );
    }
    return localTarget;
  }

  if (!isAbsolute(daemonDataDir)) {
    throw new Error("HARNESS_DOCKER_DATA_DIR must be an absolute host path");
  }
  return join(resolve(daemonDataDir), rel);
}

function workspaceMount(opts: DockerSandboxOptions): string {
  const source = mountSource(opts, opts.workspace);
  if (source.includes(",")) throw new Error("workspace mount source contains a comma");
  // Omission of `readonly` makes this a writable bind mount. rprivate prevents
  // any mount propagation made inside an untrusted channel container.
  return [
    "type=bind",
    `src=${source}`,
    "dst=/workspace",
    ...(opts.config.mode === "macos-container" ? [] : ["bind-propagation=rprivate"]),
  ].join(",");
}

/**
 * `--mount` flags for the resolver-supplied extra mounts. Read-only ones carry
 * Docker's `readonly` flag, so a write fails inside the container with EROFS
 * whatever the process there tries (shell, symlink, remount needs CAP_SYS_ADMIN
 * which the container does not have: `--cap-drop ALL`).
 */
export function extraMountArgs(opts: DockerSandboxOptions): string[] {
  const seen = new Set<string>(["/workspace"]);
  return (opts.mounts ?? []).flatMap((m) => {
    if (!isAbsolute(m.containerPath) || m.containerPath.includes("..") || /[,=\s]/.test(m.containerPath)) {
      throw new Error(`invalid container mount path ${JSON.stringify(m.containerPath)}`);
    }
    if (seen.has(m.containerPath) || m.containerPath === "/workspace" || m.containerPath.startsWith("/workspace/")) {
      throw new Error(`container mount path ${m.containerPath} is duplicated or inside /workspace`);
    }
    seen.add(m.containerPath);
    const src = mountSource(opts, m.hostPath);
    if (/[,]/.test(src)) throw new Error(`mount source ${src} contains a comma, which Docker's --mount cannot express`);
    return [
      "--mount",
      ["type=bind", `src=${src}`, `dst=${m.containerPath}`, ...(opts.config.mode === "macos-container" ? [] : ["bind-propagation=rprivate"]), ...(m.readOnly ? ["readonly"] : [])].join(","),
    ];
  });
}

/** Translate harness workspace facts from the host mount to the container mount. */
export function containerEnvironment(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    HARNESS_CHANNEL_WORKSPACE: "/workspace",
    HARNESS_CHANNEL_WORKSPACE_ATTACHMENTS: "/workspace/attachments",
    HARNESS_CHANNEL_ARTIFACTS: "/workspace/artifacts",
  };
}

/**
 * Put the workspace's `bin` first on PATH, then the operator's global bin.
 *
 * Order is channel bin, global bin, then system: a channel can override a
 * tool the host or image ships (the point of having the directory at all),
 * and the operator's global tools sit ahead of the system's but behind the
 * channel's own. A missing PATH means nothing inherited it, so the bins alone
 * are the honest answer.
 */
export function withBinOnPath(
  env: Record<string, string>,
  binDir: string,
  globalBinDir?: string,
): Record<string, string> {
  const current = env.PATH;
  const prefix = globalBinDir ? `${binDir}:${globalBinDir}` : binDir;
  return { ...env, PATH: current ? `${prefix}:${current}` : prefix };
}

/**
 * The environment every host-side exec route (bash, exec tools, shared tools)
 * gives a channel's commands: its own env with channel bin, then global bin,
 * ahead of the system PATH. One function so no route can forget the order.
 */
export function channelPathEnv(channel: {
  env: Record<string, string>;
  paths: { bin: string };
  globalBin?: string;
}): Record<string, string> {
  return withBinOnPath(channel.env, channel.paths.bin, channel.globalBin);
}

/**
 * Prefix a command with the PATH export.
 *
 * The container's PATH comes from the image and cannot be composed with host
 * side (see HOST_ONLY), so the shell does it: `bash -lc` reads the profile
 * first, and this runs after it, which a `--env PATH=` would not.
 */
function withBinOnContainerPath(command: string): string {
  return `export PATH="${CONTAINER_BIN}:${CONTAINER_GLOBAL_BIN}:$PATH"\n${command}`;
}

/** Variables that would be meaningless or unsafe inside the container. */
const HOST_ONLY = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "SHELL",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "HOSTNAME",
  "NODE_ENV",
  // The container only receives the workspace mount, never its host parent.
  "HARNESS_CHANNEL_ROOT",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
]);

/** Managers survive session eviction; their records survive process restart. */
const lifecycles = new Map<string, SandboxLifecycle>();
const cancellations = new Set<() => void>();
let shuttingDown = false;

function sandboxLifecycle(dataDir: string, mode: ContainerBackend = "docker"): SandboxLifecycle {
  if (shuttingDown) throw new Error("Harness sandbox lifecycle is shutting down");
  const key = `${resolve(dataDir)}:${mode}`;
  let lifecycle = lifecycles.get(key);
  if (!lifecycle) {
    lifecycle = new SandboxLifecycle(dataDir, dockerCall, Date.now, mode === "macos-container" ? appleRuntime() : mode === "kiri" ? kiriRuntime() : undefined);
    lifecycles.set(key, lifecycle);
  }
  lifecycle.start();
  return lifecycle;
}

/** Explicit app startup re-enables cleanup after shutdown in embedded uses. */
export function startSandboxCleanup(dataDir: string): SandboxLifecycle {
  shuttingDown = false;
  sandboxLifecycle(dataDir, "macos-container");
  sandboxLifecycle(dataDir, "kiri");
  return sandboxLifecycle(dataDir);
}

function safeNamePart(value: string): string {
  if (!value.trim()) throw new Error("Docker sandbox requires a non-empty stable channel and thread identity");
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  // Normal Slack identities stay legible; lossy conversions get a hash so
  // punctuation/truncation cannot cause two sessions to share a container.
  return safe === value ? safe : `${safe}-${dockerfileFingerprint(value)}`;
}

export function containerNameFor(channelId: string, threadKey: string, mode: ContainerBackend = "docker"): string {
  const channel = safeNamePart(channelId);
  const thread = safeNamePart(threadKey);
  if (mode === "macos-container") return `harness-apple-${sandboxFingerprint([channelId, threadKey]).slice(0, 40)}`;
  if (mode === "kiri") return `harness-kiri-${sandboxFingerprint([channelId, threadKey]).slice(0, 40)}`;
  const simple = channel === channelId && thread === threadKey && !channel.includes("-") && !thread.includes("-");
  // Hash the tuple whenever separators or lossy conversion are involved: a
  // crafted safe string must not impersonate a sanitized one or shift the
  // channel/thread delimiter. Ordinary Slack IDs/timestamps stay unchanged.
  const suffix = simple ? "" : `-${sandboxFingerprint([channelId, threadKey]).slice(0, 32)}`;
  return `harness-${channel}-${thread}${suffix}`;
}

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A channel that drops a `Dockerfile` in its directory gets an image built
 * from it, under a tag derived from the channel id.
 *
 * Image references must be lowercase, and Slack channel ids are not.
 */
export function channelImageTag(channelId: string): string {
  return `harness-channel-${channelId.replace(/[^a-zA-Z0-9_.-]/g, "_").toLowerCase()}:latest`;
}

/**
 * Label recording which Dockerfile the image was built from, so a rebuild
 * happens when the file changes and not on every command.
 */
const FINGERPRINT_LABEL = "harness.dockerfile-sha";

export function dockerfileFingerprint(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

/**
 * The build context is the channel's *workspace*, not its directory — so a
 * `COPY` can pick up something the agent produced, and cannot pick up the
 * channel's env file and bake its tokens into an image layer.
 */
export function buildImageArgs(
  dockerfile: string,
  context: string,
  tag: string,
  fingerprint: string,
): string[] {
  return [
    "build",
    "--file",
    dockerfile,
    "--tag",
    tag,
    "--label",
    `${FINGERPRINT_LABEL}=${fingerprint}`,
    context,
  ];
}

function imageFingerprint(tag: string, mode: ContainerBackend): string | undefined {
  try {
    if (mode === "macos-container") return inspectAppleImage(tag).labels[FINGERPRINT_LABEL];
    if (mode === "kiri") return inspectKiriImage(tag).labels[FINGERPRINT_LABEL];
    const out = execFileSync(
      backendCommand(mode),
      ["image", "inspect", "-f", `{{index .Config.Labels "${FINGERPRINT_LABEL}"}}`, tag],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    ).trim();
    return out && out !== "<no value>" ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the channel's image if it is missing or its Dockerfile has changed.
 * Returns whether a build actually ran, since the caller must then replace a
 * container still running the old image.
 *
 * Only the Dockerfile is fingerprinted, not the context: editing a file the
 * Dockerfile COPYs will not trigger a rebuild on its own. Touch the Dockerfile
 * or delete the image to force one.
 */
export function ensureChannelImage(dockerfile: string, context: string, tag: string, mode: ContainerBackend = "docker"): boolean {
  const fingerprint = dockerfileFingerprint(readFileSync(dockerfile, "utf-8"));
  if (imageFingerprint(tag, mode) === fingerprint) return false;

  logger.info(`building ${tag} from ${dockerfile}`);
  const args = buildImageArgs(dockerfile, context, tag, fingerprint);
  if (mode === "macos-container") args.splice(1, 0, "--platform", "linux/arm64");
  execFileSync(backendCommand(mode), args, {
    stdio: ["ignore", "ignore", "pipe"],
    // A first build installs packages over a slow home connection; a
    // per-command timeout would be the wrong budget entirely.
    timeout: 900_000,
  });
  logger.info(`built ${tag}`);
  return true;
}

export function sandboxImageExists(image: string, mode: ContainerBackend = "docker"): boolean {
  try {
    execFileSync(backendCommand(mode), ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Translate a host working directory to its path inside the container.
 *
 * pi tracks cwd across bash calls, so `cd subdir` is meant to persist into the
 * next command. Ignoring the argument would make `cd` silently do nothing.
 */
export function containerCwd(workspace: string, hostCwd: string | undefined): string {
  if (!hostCwd) return "/workspace";
  const rel = relative(workspace, hostCwd);
  if (!rel) return "/workspace";
  // Outside the workspace nothing is mounted, so fall back to the root rather
  // than naming a path the container does not have.
  if (rel.startsWith("..") || isAbsolute(rel)) return "/workspace";
  return `/workspace/${rel}`;
}

function envFlags(env: Record<string, string>): string[] {
  // `--env NAME` without a value inherits from this process, so secrets never
  // appear in the command line where `ps` could read them. Workspace facts are
  // translated because the mounted path is always /workspace in the container.
  return Object.keys(containerEnvironment(env))
    .filter((k) => !HOST_ONLY.has(k))
    .flatMap((k) => ["--env", k]);
}

function limitFlags(config: SandboxConfig, env: Record<string, string>): string[] {
  if (config.mode === "macos-container") {
    const problem = appleConfigProblem(config, env);
    if (problem) throw new Error(problem);
    return [
      "--platform", "linux/arm64",
      "--network", config.network === "none" ? "none" : "default",
      "--memory", config.memory, "--cpus", String(config.cpus),
      "--cap-drop", "ALL", "--read-only",
      "--tmpfs", "/tmp:size=64m,mode=1777", "--tmpfs", "/repos:size=256m,mode=1777",
      ...(config.user ? ["--user", config.user] : []), ...envFlags(env),
    ];
  }
  return [
    "--network",
    config.network,
    "--memory",
    config.memory,
    "--cpus",
    String(config.cpus),
    ...(config.pidsLimit === null ? [] : ["--pids-limit", String(config.pidsLimit)]),
    // The workspace bind is deliberately the sole writable persistent mount.
    // Drop ambient Linux capabilities and prevent setuid/file-capability
    // escalation even if a channel writes an executable in its workspace.
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    ...(config.readOnlyRoot ? ["--read-only", "--tmpfs", "/tmp:rw,size=64m",
      "--tmpfs", "/repos:rw,mode=1777,size=256m"] : []),
    ...(config.user ? ["--user", config.user] : []),
    ...envFlags(env),
  ];
}

/** Arguments that create a channel's long-lived container. */
export function buildCreateArgs(opts: DockerSandboxOptions, name: string, labels: Record<string, string> = {}): string[] {
  const { config } = opts;
  return [
    "run",
    "--detach",
    "--name",
    name,
    ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--entrypoint", config.mode === "macos-container" ? APPLE_LAUNCHER[0]! : "/bin/sh",
    // Only this channel's workspace is visible. Other channels, data/, the
    // credential store and the harness source are not in this filesystem.
    "--mount",
    workspaceMount(opts),
    ...extraMountArgs(opts),
    "--workdir",
    "/workspace",
    ...limitFlags(config, {}),
    config.image,
    ...(config.mode === "macos-container" ? [...APPLE_LAUNCHER.slice(1), "/bin/sh"] : []),
    // Idle forever; commands arrive via `docker exec`.
    "-c",
    "exec sleep infinity",
  ];
}

/** Arguments that run one command in an existing container. */
export function buildExecArgs(
  opts: DockerSandboxOptions,
  name: string,
  command: string,
  hostCwd?: string,
): string[] {
  return [
    "exec",
    "--workdir",
    containerCwd(opts.workspace, hostCwd),
    ...envFlags(opts.env),
    name,
    ...(opts.config.mode === "macos-container" ? APPLE_LAUNCHER : []),
    "bash",
    "-lc",
    withBinOnContainerPath(command),
  ];
}

/** Arguments for a throwaway container running a single command. */
export function buildRunArgs(
  opts: DockerSandboxOptions,
  name: string,
  command: string,
  hostCwd?: string,
): string[] {
  const { config, workspace, env } = opts;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--mount",
    workspaceMount(opts),
    ...extraMountArgs(opts),
    "--workdir",
    containerCwd(workspace, hostCwd),
    ...limitFlags(config, env),
    "--entrypoint", config.mode === "macos-container" ? APPLE_LAUNCHER[0]! : "bash",
    config.image,
    ...(config.mode === "macos-container" ? [...APPLE_LAUNCHER.slice(1), "bash"] : []),
    "-lc",
    withBinOnContainerPath(command),
  ];
}

function resolvedImage(image: string, mode: ContainerBackend): string {
  if (mode === "macos-container") return pinAppleImage(image);
  if (mode === "kiri") return inspectKiriImage(image).id;
  const info = (JSON.parse(backendCall(mode)(["image", "inspect", image])) as {
    Id: string; Config: { Volumes?: Record<string, unknown> | null };
  }[])[0];
  if (!info) throw new Error(`Image ${image} is missing`);
  if (Object.keys(info.Config.Volumes ?? {}).length) {
    throw new Error("Sandbox images must not declare VOLUME: anonymous/external volumes would outlive container-local repos");
  }
  return info.Id;
}

/** Validation also runs before exec into an already-used container. Preparation
 * is fresh-container-only: root creates an absent directory and reports its
 * numeric owner; that owner (not capability-less root) can chmod an existing
 * directory. No capability is added, even for setup. Linux stat (GNU/BusyBox)
 * is required for owner discovery; path/mount guards run before every mutation.
 */
export function repositoryStorageScript(
  readOnlyRoot: boolean,
  operation: "validate" | "prepare" | "chmod" = "validate",
): string {
  return `set -eu
${operation !== "validate" && !readOnlyRoot ? 'PATH=/usr/bin:/bin; export PATH' : ''}
fail() { echo 'sandbox /repos must be a real writable container-local directory: symlinks, non-directories and durable mount redirects are forbidden' >&2; exit 1; }
[ ! -L /repos ] || fail
if [ -e /repos ] && [ ! -d /repos ]; then fail; fi
(cd -P /workspace && [ "$(pwd -P)" = /workspace ]) || fail
repos_mount=0
workspace_mount=0
while read -r id parent device root point rest; do
  case "$point" in
    /workspace) workspace_mount=1 ;;
    /repos)
      ${readOnlyRoot ? 'case "$rest" in *" - tmpfs "*) repos_mount=1 ;; *) fail ;; esac' : 'fail'}
      ;;
    /repos/*) fail ;;
  esac
done < /proc/self/mountinfo
[ "$workspace_mount" = 1 ] || fail
[ "$repos_mount" = ${readOnlyRoot ? "1" : "0"} ] || fail
${operation === "prepare" && !readOnlyRoot ? 'if [ ! -d /repos ]; then mkdir /repos; fi' : '[ -d /repos ] || fail'}
${operation === "prepare" && !readOnlyRoot ?
    '# /repos is a guarded single root entry; its owner checks canonical traversal before chmod.' :
    '(cd -P /repos && [ "$(pwd -P)" = /repos ]) || fail'}
${!readOnlyRoot && operation === "prepare" ? "stat -c '%u' /repos" :
    !readOnlyRoot && operation === "chmod" ? 'chmod 1777 /repos' : '[ -w /repos ] || fail'}
`;
}

function repositoryStorageArgs(opts: DockerSandboxOptions, name: string): string[] {
  const security = opts.config.mode === "macos-container" ? `nnp=0; caps=0
while read -r key value rest; do
  case "$key$value" in
    NoNewPrivs:1) nnp=1 ;;
    CapBnd:0000000000000000) caps=1 ;;
  esac
done < /proc/self/status
[ "$nnp:$caps" = 1:1 ] || { echo 'Apple sandbox requires working setpriv --no-new-privs and --cap-drop ALL' >&2; exit 1; }
` : "";
  return ["exec", name, ...(opts.config.mode === "macos-container" ? APPLE_LAUNCHER : []),
    "/bin/sh", "-c", security + repositoryStorageScript(opts.config.readOnlyRoot)];
}

function prepareRepositoryStorage(opts: DockerSandboxOptions, name: string): void {
  if (opts.config.readOnlyRoot) return; // Docker supplies mode-1777 tmpfs; no root exec.
  const call = backendCall(opts.config.mode);
  const owner = call(["exec", "--user", "0", name, "/bin/sh", "-c",
    repositoryStorageScript(false, "prepare")]).trim();
  // Never accept usernames, groups, signs, extra output or CLI options from
  // image tools. UID -1 (UINT32_MAX) is not a valid Linux inode owner.
  if (!/^(0|[1-9][0-9]*)$/.test(owner) || Number(owner) >= 4_294_967_295) {
    throw new Error("Sandbox /repos owner discovery did not return a valid numeric UID");
  }
  call(["exec", "--user", owner, name, "/bin/sh", "-c",
    repositoryStorageScript(false, "chmod")]);
}

/**
 * Pi forwards BashOperations.timeout unchanged in seconds. Match its local
 * backend's validation before converting to Node timer milliseconds; only
 * omission selects the harness fallback (not null or coercible values).
 */
export function sandboxTimeoutMs(defaultSeconds: number, overrideSeconds?: number): number {
  const seconds = overrideSeconds === undefined ? defaultSeconds : overrideSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Sandbox timeout must be a positive finite number of seconds");
  }
  const ms = seconds * 1000;
  // Larger delays (including multiplication overflow) would become 1 ms in
  // Node, so fail closed instead of silently cancelling almost immediately.
  if (ms > 2_147_483_647) {
    throw new Error("Sandbox timeout must be within the Node timer range (maximum 2147483.647 seconds)");
  }
  return ms;
}

/** Container backend adapter. The historical Docker name remains an API alias. */
export function createContainerBashOperations(opts: DockerSandboxOptions): BashOperations {
  const { config, env, channelId, threadKey } = opts;
  const containerEnv = containerEnvironment(env);
  const mode = isContainerMode(config.mode) ? config.mode : "docker";
  const call = backendCall(mode);
  // Apple names are DNS labels, at most 63 characters; hash the full tuple.
  const name = containerNameFor(channelId, threadKey, mode);

  return {
    exec: async (command, cwd, options) => {
      let lifecycle: SandboxLifecycle | undefined;
      try {
        const timeout = sandboxTimeoutMs(config.timeoutSeconds, options.timeout);
        if (options.signal?.aborted) throw new Error("Sandbox command cancelled before start");
        if (mode === "macos-container") {
          const problem = appleConfigProblem(config, env) ?? appleHostProblem();
          if (problem) throw new Error(problem);
          if (!appleAvailable()) throw new Error("Apple container 1.6.1+ (1.x) client/server required; install it and run container system start");
        }
        if (mode === "kiri") {
          const problem = kiriUnavailableReason();
          if (problem) throw new Error(problem);
        }
        lifecycle = sandboxLifecycle(opts.dataDir, mode);
        const leaseName = config.reuse ? name : mode === "macos-container"
          ? `harness-apple-once-${sandboxFingerprint([channelId, threadKey, randomUUID()]).slice(0, 40)}`
          : `${name}-${randomUUID()}`;
        return await lifecycle.withLease(leaseName, async () => {
          if (shuttingDown) throw new Error("Harness is shutting down");
          if (opts.dockerfile) ensureChannelImage(opts.dockerfile, opts.workspace, config.image, mode);
          const imageId = resolvedImage(config.image, mode);
          const commandName = leaseName;
          let args: string[];
          const imageOpts = { ...opts, config: { ...config, image: imageId } };
          const create = (container: string, labels: Record<string, string>) => {
            call(buildCreateArgs(imageOpts, container, labels), { ...process.env, ...containerEnv });
            // Trusted setup only for a new container; no agent code, channel
            // environment or added capabilities. /repos stays container-local.
            prepareRepositoryStorage(opts, container);
            // Verify writability as the actual configured user before the
            // lifecycle commits readyContainerId, not merely as root.
            call(repositoryStorageArgs(opts, container));
          };
          const fingerprint = sandboxFingerprint({ version: 2, ...(mode !== "docker" ? { backend: mode } : {}), imageId, args: buildCreateArgs(imageOpts, name) });
          if (config.reuse) {
            lifecycle!.ensure(name, fingerprint, config.idleSeconds, (labels) => create(name, labels));
            args = buildExecArgs(opts, name, command, cwd);
          } else {
            // Create synchronously before exec: cancellation cannot merely kill
            // a docker-run client while the daemon is still creating a container.
            lifecycle!.ensure(commandName, fingerprint, config.idleSeconds, (labels) => create(commandName, labels));
            args = buildExecArgs(opts, commandName, command, cwd);
          }
          let executionUncertain = mode !== "docker";
          try {
            // Never privileged on reuse. Reject path/mount redirects introduced
            // by earlier commands rather than following them or repairing them.
            call(repositoryStorageArgs(opts, commandName));
            return await new Promise<{ exitCode: number | null }>((resolveResult) => {
              const child = spawn(backendCommand(mode), args, { env: { ...process.env, ...containerEnv },
                stdio: ["ignore", "pipe", "pipe"] });
              let killed = false;
              let settled = false;
              const kill = () => {
                if (killed || settled) return;
                killed = true;
                try {
                  lifecycle!.cancel(commandName);
                } catch (err) {
                  // Keep Docker-derived activity protection; CLI termination is
                  // never evidence that an in-container command has stopped.
                  options.onData(Buffer.from(`sandbox cancellation could not be confirmed: ${String(err)}\n`));
                }
                child.kill("SIGKILL");
              };
              cancellations.add(kill);
              const timer = setTimeout(kill, timeout);
              timer.unref();
              const done = (exitCode: number | null) => {
                if (settled) return;
                settled = true;
                executionUncertain = mode !== "docker" && exitCode !== 0;
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", kill);
                cancellations.delete(kill);
                if (killed) options.onData(Buffer.from(config.reuse
                  ? "\n[sandbox command cancelled; thread container retained]\n"
                  : "\n[sandbox command cancelled; one-shot container will be removed]\n"));
                resolveResult({ exitCode: killed ? 137 : exitCode });
              };
              options.signal?.addEventListener("abort", kill, { once: true });
              if (options.signal?.aborted) kill();
              child.stdout?.on("data", (d: Buffer) => options.onData(d));
              child.stderr?.on("data", (d: Buffer) => options.onData(d));
              child.on("error", (err) => { options.onData(Buffer.from(`sandbox failed to start: ${err.message}\n`)); done(127); });
              child.on("close", done);
            });
          } finally {
            if (!config.reuse) {
              try { lifecycle!.discard(commandName); }
              catch (err) { logger.warn(`one-shot sandbox cleanup deferred for ${commandName}`, err); }
            } else {
              try { lifecycle!.finish(name, executionUncertain); }
              catch (err) { logger.warn(`sandbox activity remains protected for ${name}`, err); }
            }
          }
        }, options.signal);
      } catch (err) {
        options.onData(Buffer.from(`sandbox unavailable: ${String(err)}\nCheck ${backendCommand(mode)}, the image${mode === "macos-container" ? " (requires /usr/bin/setpriv)" : ""} and stable thread identity; no host fallback was attempted.\n`));
        return { exitCode: options.signal?.aborted ? 137 : 127 };
      }
    },
  };
}

export const createDockerBashOperations = createContainerBashOperations;

/** Stop background cleanup and cancel active commands, but retain containers. */
export function stopAllSandboxes(): void {
  shuttingDown = true;
  for (const cancel of [...cancellations]) cancel();
  for (const lifecycle of lifecycles.values()) lifecycle.stop();
}

export function describeSandbox(config: SandboxConfig, dockerfile?: string): string {
  if (config.mode === "host") return "host (no isolation for bash)";
  return (
    `${config.mode === "macos-container" ? "Apple container" : config.mode} ${config.image}${dockerfile ? " (built from the channel's Dockerfile)" : ""}, ` +
    `${config.reuse ? "persistent per-thread container" : "container per command"}, ` +
    `network=${config.network}, mem=${config.memory}, cpus=${config.cpus}` +
    (config.mode === "macos-container" ? ", no PID limit; read-only image; /repos tmpfs is lost on stop" : "")
  );
}

export function warnIfUnavailable(label: string, config: SandboxConfig, dockerfile?: string): void {
  if (!isContainerMode(config.mode)) return;
  if (config.mode === "macos-container") {
    const problem = appleConfigProblem(config) ?? appleHostProblem();
    if (problem) { logger.warn(`${label}: ${problem}`); return; }
  }
  if (config.mode === "kiri") {
    const problem = kiriUnavailableReason();
    if (problem) { logger.warn(`${label}: ${problem}`); return; }
  }
  if (!containerBackendAvailable(config.mode)) {
    logger.warn(
      `${label}: sandbox.mode is "${config.mode}" but ${backendCommand(config.mode)} is not available/compatible. bash commands will fail.`,
    );
    return;
  }
  if (sandboxImageExists(config.image, config.mode)) return;

  // Not a warning when the channel owns a Dockerfile: the image is supposed to
  // be absent until the first command builds it.
  if (dockerfile) {
    logger.info(`${label}: ${config.image} will be built from ${dockerfile} on first use.`);
    return;
  }
  logger.warn(
    `${label}: sandbox image "${config.image}" is not present. Build it from the ` +
      `Dockerfile you defined it in, or drop a Dockerfile in the channel's ` +
      `directory to have the harness build one.`,
  );
}
