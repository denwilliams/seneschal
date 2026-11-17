import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { REPO_ROOT } from "./load.ts";
import type { HarnessConfig } from "./schema.ts";
import { channelId, SecretScopeSchema, validSecretName, type KeychainConfig, type SecretScope } from "./keychain-schema.ts";

export class KeychainError extends Error {
  readonly code: "unsupported" | "helper" | "missing" | "denied" | "locked" | "timeout" | "invalid" | "unauthorized";
  constructor(code: "unsupported" | "helper" | "missing" | "denied" | "locked" | "timeout" | "invalid" | "unauthorized") {
    super({ unsupported: "Keychain requires a native macOS main process.", helper: "Keychain helper unavailable; check its private installation and permissions.", missing: "A configured Keychain entry is missing.", denied: "Keychain access was denied; check the OS user's Keychain permissions.", locked: "Keychain is locked or needs interactive authorization; unlock or authorize it outside the harness.", timeout: "Keychain lookup timed out; no stale value was returned.", invalid: "Invalid Keychain request or value.", unauthorized: "This Keychain scope or name is not authorized for this caller." }[code]);
    this.code = code;
  }
}
export type KeychainPrincipal = { kind: "main-process" } | { kind: "channel"; channel: string };
export type KeychainOperation = "read" | "save" | "delete";
export type KeychainTransport = (operation: KeychainOperation, service: string, account: string, value?: string) => string;

/** Refuse agent-visible locations, symlinks and writable-by-others helper/ancestors. */
export function assertKeychainHelper(path: string, forbiddenRoots: string[]): void {
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw new Error();
    for (const root of forbiddenRoots) {
      const location = relative(existsSync(root) ? realpathSync(root) : root, path);
      if (!location || location !== ".." && !location.startsWith("../") && !isAbsolute(location)) throw new Error();
    }
    let current = path;
    for (;;) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) || ![0, process.getuid?.()].includes(stat.uid)) throw new Error();
      if (current === path && (!stat.isFile() || !(stat.mode & 0o100) || stat.nlink !== 1)) throw new Error();
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch { throw new KeychainError("helper"); }
}
export function nativeKeychainTransport(config: KeychainConfig, forbiddenRoots: string[]): KeychainTransport {
  return (operation, service, account, value) => {
    if (process.platform !== "darwin") throw new KeychainError("unsupported");
    assertKeychainHelper(config.helperPath, forbiddenRoots);
    // Only non-secret routing metadata in argv. No shell, inherited secrets, unlock password or stderr diagnostics.
    const result = spawnSync(config.helperPath, [operation, service, account], {
      input: value ?? "", encoding: "utf8", timeout: config.timeoutMs, killSignal: "SIGKILL", maxBuffer: 32768,
      env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.signal) throw new KeychainError((result.error as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ? "timeout" : "helper");
    if (result.status !== 0 || result.stdout === null) throw new KeychainError(result.status === 42 ? "missing" : result.status === 43 ? "denied" : result.status === 44 ? "locked" : "helper");
    return result.stdout;
  };
}
function validValue(value: string): boolean { return !!value && !value.includes("\0") && Buffer.byteLength(value) <= 16384; }

/** Main-process-only; never attach the client or cache to config or a resolved channel. */
export class KeychainClient {
  #cache = new Map<string, { value: string; expires: number }>();
  #config: KeychainConfig;
  #transport: KeychainTransport;
  #now: () => number;
  constructor(config: KeychainConfig, transport = nativeKeychainTransport(config, [REPO_ROOT]), now = () => performance.now()) {
    this.#config = config; this.#transport = transport; this.#now = now;
  }
  #target(scope: SecretScope, name: string) {
    if (!SecretScopeSchema.safeParse(scope).success || !validSecretName(name)) throw new KeychainError("invalid");
    const area = scope.kind === "channel" ? `channel/${scope.channel}` : scope.kind;
    const service = `ai.slack-harness.keychain.v1.${this.#config.namespace}`;
    return { service, account: `${area}/${name}`, key: JSON.stringify(["macos-keychain", service, scope.kind, scope.kind === "channel" ? scope.channel : null, name]) };
  }
  #authorize(principal: KeychainPrincipal, scope: SecretScope, name: string): void {
    if (principal.kind === "channel" && !channelId.test(principal.channel)) throw new KeychainError("unauthorized");
    const allowed = scope.kind === "main-process" ? principal.kind === "main-process" && this.#config.mainProcess.includes(name)
      : principal.kind === "channel" && (scope.kind === "global-channel" ? this.#config.globalChannel.includes(name)
        : principal.channel === scope.channel && !!this.#config.channels[scope.channel]?.includes(name));
    if (!allowed) throw new KeychainError("unauthorized");
  }
  read(principal: KeychainPrincipal, scope: SecretScope, name: string): string {
    const { service, account, key } = this.#target(scope, name);
    this.#authorize(principal, scope, name); // Always before a cache hit, even after policy changes.
    const now = this.#now();
    for (const [entry, cached] of this.#cache) if (cached.expires <= now) this.#cache.delete(entry);
    const cached = this.#cache.get(key);
    if (cached && this.#config.cache.ttlMs > 0 && this.#config.cache.maxEntries > 0 && this.#config.cache.maxBytes > 0) return cached.value;
    this.#cache.delete(key);
    let value: string;
    try { value = this.#transport("read", service, account); }
    catch (error) { throw error instanceof KeychainError ? error : new KeychainError("helper"); }
    if (!validValue(value)) throw new KeychainError("invalid");
    const { ttlMs, maxEntries, maxBytes } = this.#config.cache;
    const bytes = Buffer.byteLength(value);
    if (ttlMs > 0 && maxEntries > 0 && bytes <= maxBytes) {
      let resident = [...this.#cache.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.value), 0);
      while (this.#cache.size >= maxEntries || resident + bytes > maxBytes) {
        const oldest = this.#cache.keys().next().value!;
        resident -= Buffer.byteLength(this.#cache.get(oldest)!.value);
        this.#cache.delete(oldest);
      }
      this.#cache.set(key, { value, expires: this.#now() + ttlMs });
    }
    return value;
  }
  /** Admin authority is checked by the shared Admin service; allowlists do not limit provisioning. */
  write(operation: "save" | "delete", scope: SecretScope, name: string, value?: string): void {
    const { service, account, key } = this.#target(scope, name);
    if (!this.#config.adminWrites) throw new KeychainError("unauthorized");
    if (operation === "save" && (typeof value !== "string" || !validValue(value))) throw new KeychainError("invalid");
    this.#cache.delete(key);
    try { this.#transport(operation, service, account, value); }
    catch (error) { throw error instanceof KeychainError ? error : new KeychainError("helper"); }
    finally { this.#cache.delete(key); } // Global entries are shared by all authorized channel callers.
  }
}
const clients = new WeakMap<KeychainConfig, KeychainClient>();
/** Startup/reload validation only; no secret lookup or interactive authorization. */
export function validateKeychainHost(config: HarnessConfig, dataDir: string): void {
  if (!config.keychain) return;
  if (process.platform !== "darwin") throw new KeychainError("unsupported");
  assertKeychainHelper(config.keychain.helperPath, [REPO_ROOT, dataDir]);
}
export function keychainClient(config: KeychainConfig, dataDir?: string): KeychainClient {
  let client = clients.get(config);
  if (!client) { client = new KeychainClient(config, nativeKeychainTransport(config, [REPO_ROOT, ...(dataDir ? [dataDir] : [])])); clients.set(config, client); }
  return client;
}
export function keychainMainSecret(config: HarnessConfig, name: string): string | undefined {
  if (!config.keychain?.mainProcess.includes(name)) return undefined;
  return keychainClient(config.keychain, resolve(REPO_ROOT, config.dataDir)).read({ kind: "main-process" }, { kind: "main-process" }, name);
}
export function keychainChannelEnvironment(config: HarnessConfig, channel: string, legacy: Record<string, string>, dataDir = resolve(REPO_ROOT, config.dataDir)): Record<string, string> {
  const kc = config.keychain;
  if (!kc) return legacy;
  const hidden = new Set([...kc.mainProcess, ...Object.values(kc.channels).flat(), ...kc.globalChannel]);
  const env = Object.fromEntries(Object.entries(legacy).filter(([name]) => !hidden.has(name)));
  const principal = { kind: "channel", channel } as const;
  const client = keychainClient(kc, dataDir);
  for (const name of kc.globalChannel) env[name] = client.read(principal, { kind: "global-channel" }, name);
  for (const name of kc.channels[channel] ?? []) env[name] = client.read(principal, { kind: "channel", channel }, name);
  return env;
}
export async function applyKeychainProviderKeys(config: HarnessConfig, runtime: { setRuntimeApiKey(provider: string, value: string): Promise<void> }): Promise<void> {
  for (const [provider, name] of Object.entries(config.keychain?.providerKeys ?? {})) {
    const value = keychainMainSecret(config, name)!;
    try { await runtime.setRuntimeApiKey(provider, value); }
    catch { throw new KeychainError("invalid"); }
  }
}
