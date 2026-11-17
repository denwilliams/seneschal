import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { HarnessConfig } from "./schema.ts";
import { bootstrapName, channelId, secretName, type OpenBaoConfig, type SecretScope } from "./openbao-schema.ts";
import { protectedEnvName } from "./managed-env.ts";

/** Never include the response body, token, URL, value, or transport exception in diagnostics. */
export class OpenBaoError extends Error {
  constructor(message = "OpenBao request failed; check backend availability and policy on the host.") { super(message); }
}
const validName = (name: string) => secretName.test(name) && !protectedEnvName(name) && !bootstrapName(name);
function scopePath(scope: SecretScope): string {
  if (scope.kind === "channel") {
    if (!channelId.test(scope.channel)) throw new OpenBaoError("Use a Slack channel ID for an OpenBao channel scope.");
    return `channels/${scope.channel}`;
  }
  if (scope.kind !== "global-channel" && scope.kind !== "main-process") throw new OpenBaoError("Invalid OpenBao scope.");
  return scope.kind;
}
function outside(file: string, root: string): boolean {
  const path = relative(realpathSync(root), file);
  return !!path && (path === ".." || path.startsWith("../") || isAbsolute(path));
}

/** Host-only client. Never pass this object or its authentication credential to a channel. */
export class OpenBaoClient {
  #token: string;
  #config: OpenBaoConfig;
  #fetch: typeof fetch;
  constructor(config: OpenBaoConfig, options: { fetch?: typeof fetch; forbiddenRoots?: string[] } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    try {
      const file = realpathSync(config.tokenFile);
      if (file !== config.tokenFile || options.forbiddenRoots?.some((root) => !outside(file, root))) throw new Error();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error();
        this.#token = readFileSync(fd, "utf8").trim();
        if (!this.#token || /[\s\x00-\x1f\x7f]/.test(this.#token)) throw new Error();
      } finally { closeSync(fd); }
    } catch { throw new OpenBaoError("OpenBao requires an owner-only regular token file outside channel-accessible storage."); }
  }
  async #request(method: string, area: "data" | "metadata", scope: SecretScope, name?: string, body?: unknown): Promise<unknown> {
    const scopeName = scopePath(scope);
    if (name !== undefined && !validName(name)) throw new OpenBaoError("Invalid or protected OpenBao secret name.");
    const { address, mount, prefix, timeoutMs } = this.#config;
    const url = `${address.replace(/\/$/, "")}/v1/${mount}/${area}/${prefix}/${scopeName}${name === undefined ? "?list=true" : `/${name}`}`;
    try {
      const response = await this.#fetch(url, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "X-Vault-Token": this.#token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Missing required imports are errors; only an absent directory during CLI listing is empty.
      if (response.status === 404 && name === undefined) { await response.body?.cancel(); return { data: { keys: [] } }; }
      if (!response.ok) { await response.body?.cancel(); throw new OpenBaoError(response.status === 404 ? "A configured OpenBao secret is missing or deleted." : undefined); }
      if (method === "DELETE" || response.status === 204) { await response.body?.cancel(); return undefined; }
      const reader = response.body?.getReader();
      if (!reader) throw new OpenBaoError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new OpenBaoError(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) { throw error instanceof OpenBaoError ? error : new OpenBaoError(); }
  }
  async read(scope: SecretScope, name: string): Promise<string> {
    const result = await this.#request("GET", "data", scope, name) as { data?: { data?: { value?: unknown } } } | undefined;
    const value = result?.data?.data?.value;
    if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 16384) throw new OpenBaoError("OpenBao secret must contain a non-empty string value of at most 16 KiB without NUL characters.");
    return value;
  }
  async list(scope: SecretScope): Promise<string[]> {
    const result = await this.#request("GET", "metadata", scope) as { data?: { keys?: unknown } } | undefined;
    const keys = result?.data?.keys;
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && validName(key))) throw new OpenBaoError();
    return keys.sort();
  }
  async save(scope: SecretScope, name: string, value: string): Promise<void> {
    if (!value || value.includes("\0") || Buffer.byteLength(value) > 16384) throw new OpenBaoError("Supply a non-empty secret value of at most 16 KiB without NUL characters.");
    await this.#request("POST", "data", scope, name, { data: { value } });
  }
  /** Permanent deletion of all versions; explicit operator CLI only. */
  async remove(scope: SecretScope, name: string): Promise<void> { await this.#request("DELETE", "metadata", scope, name); }
}

type Snapshot = { main: Record<string, string>; global: Record<string, string>; channels: Map<string, Record<string, string>> };
// Not attached to config, ResolvedChannel, process.env, or any API response.
const snapshots = new WeakMap<OpenBaoConfig, Snapshot>();
function snapshot(config: HarnessConfig): Snapshot | undefined {
  if (!config.openbao) return undefined;
  const value = snapshots.get(config.openbao);
  if (!value) throw new OpenBaoError("OpenBao imports have not been initialized; restart the harness.");
  return value;
}

/** Atomic boot/reload import: on any failure publish nothing. No persistence, retries or fallback. */
export async function initializeOpenBao(config: HarnessConfig, options: { fetch?: typeof fetch; forbiddenRoots?: string[] } = {}): Promise<void> {
  if (!config.openbao) return;
  const bao = config.openbao;
  const client = new OpenBaoClient(bao, options);
  const read = async (scope: SecretScope, names: string[]) => {
    const values: Record<string, string> = Object.create(null);
    for (const name of names) values[name] = await client.read(scope, name);
    return values;
  };
  const main = await read({ kind: "main-process" }, bao.mainProcess);
  const global = await read({ kind: "global-channel" }, bao.globalChannel);
  const channels = new Map<string, Record<string, string>>();
  for (const [channel, names] of Object.entries(bao.channels)) channels.set(channel, await read({ kind: "channel", channel }, names));
  snapshots.set(bao, { main, global, channels });
}

/** No fallback if the main-process scope imports this name. It must have loaded successfully. */
export function mainProcessSecret(config: HarnessConfig, name: string): string | undefined {
  return snapshot(config)?.main[name];
}

/** Remove legacy copies of main-only/auth names, then explicitly overlay channel-visible scopes. */
export function openBaoChannelEnvironment(config: HarnessConfig, channel: string, legacy: Record<string, string>): Record<string, string> {
  const loaded = snapshot(config);
  if (!loaded) return legacy;
  const bao = config.openbao!;
  const hidden = new Set([...bao.mainProcess, ...bao.globalChannel, ...Object.values(bao.channels).flat()]);
  const clean = Object.fromEntries(Object.entries(legacy).filter(([name]) => !hidden.has(name) && !bootstrapName(name)));
  return { ...clean, ...loaded.global, ...loaded.channels.get(channel) };
}

/** SDK memory-only credentials, not auth.json or an inherited environment. Errors never retain credential-bearing causes. */
export async function applyOpenBaoProviderKeys(config: HarnessConfig, runtime: { setRuntimeApiKey(provider: string, value: string): Promise<void> }): Promise<void> {
  for (const [provider, name] of Object.entries(config.openbao?.providerKeys ?? {})) {
    try { await runtime.setRuntimeApiKey(provider, mainProcessSecret(config, name)!); }
    catch { throw new OpenBaoError("Could not configure an OpenBao model credential."); }
  }
}
