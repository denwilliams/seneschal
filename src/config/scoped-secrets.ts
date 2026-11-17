import { bootstrapName, type OpenBaoConfig } from "./openbao-schema.ts";
import { OpenBaoClient } from "./openbao.ts";
import { openBaoRiskWarning } from "./openbao-policy.ts";
import { SecretAdminError, protectedEnvName } from "./managed-env.ts";
import { channelId, SecretScopeSchema, validSecretName, type SecretScope } from "./keychain-schema.ts";
import { keychainClient } from "./keychain.ts";
import { keychainIsolationIssues, keychainRiskWarning } from "./keychain-policy.ts";
import type { HarnessConfig } from "./schema.ts";

/** One write-only Admin boundary; each backend registers capabilities, never another form/API. */
export interface SecretBackendWriter {
  id: string;
  label: string;
  enabled(): boolean;
  unavailableReason?(): string | undefined;
  warning?(): string | undefined;
  save(scope: SecretScope, name: string, value: string): Promise<void>;
  remove?(scope: SecretScope, name: string): Promise<void>;
}
export class ScopedSecretAdmin {
  #writers: SecretBackendWriter[];
  #channels: () => { id: string; name?: string }[];
  constructor(writers: SecretBackendWriter[], channels: () => { id: string; name?: string }[]) {
    this.#writers = writers; this.#channels = channels;
  }
  snapshot() {
    return { backends: this.#writers.map((writer) => ({ id: writer.id, label: writer.label, enabled: writer.enabled(), unavailableReason: writer.unavailableReason?.(), warning: writer.warning?.(), canDelete: !!writer.remove })),
      channels: this.#channels().filter((channel) => channelId.test(channel.id)).map(({ id, name }) => ({ id, name })) };
  }
  #validate(backend: string, scope: SecretScope, name: string, overwrite: boolean): SecretBackendWriter {
    const writer = this.#writers.find((entry) => entry.id === backend && entry.enabled());
    if (!writer) throw new SecretAdminError(503, "This backend is not enabled for Admin writes on the host.");
    if (!overwrite) throw new SecretAdminError(422, "Confirm replacement or deletion of this scoped secret.");
    if (!validSecretName(name) || protectedEnvName(name) || bootstrapName(name)) throw new SecretAdminError(422, "Use an uppercase secret name that is not a protected runtime or authentication variable.");
    if (!SecretScopeSchema.safeParse(scope).success) throw new SecretAdminError(422, "Select a valid secret scope.");
    if (scope.kind === "channel" && !this.#channels().some((channel) => channel.id === scope.channel)) throw new SecretAdminError(422, "Select a known Slack channel ID.");
    return writer;
  }
  async save(backend: string, scope: SecretScope, name: string, value: string, overwrite: boolean): Promise<void> {
    const writer = this.#validate(backend, scope, name, overwrite);
    if (!value || value.includes("\0") || Buffer.byteLength(value) > 16384) throw new SecretAdminError(422, "Supply a non-empty secret value of at most 16 KiB without NUL characters.");
    try { await writer.save(scope, name, value); }
    catch { throw new SecretAdminError(503, "Backend secret write failed. Check its private credentials, permissions and availability on the host."); }
  }
  async remove(backend: string, scope: SecretScope, name: string, confirm: boolean): Promise<void> {
    const writer = this.#validate(backend, scope, name, confirm);
    if (!writer.remove) throw new SecretAdminError(422, "Deletion is unavailable for this backend.");
    try { await writer.remove(scope, name); }
    catch { throw new SecretAdminError(503, "Backend secret deletion failed. Check its private credentials, permissions and availability on the host."); }
  }
}
/** Runtime credentials remain read-only; provisioning is opt-in and rereads the private file. */
export function openBaoWriter(config: () => OpenBaoConfig | undefined, forbiddenRoots: string[]): SecretBackendWriter {
  return {
    id: "openbao", label: "OpenBao", enabled: () => Boolean(config()?.adminTokenFile),
    warning: () => openBaoRiskWarning({ openbao: config() }),
    unavailableReason: () => !config() ? "OpenBao is not configured." : !config()?.adminTokenFile ? "OpenBao Admin writes require a private provisioning-token file on the host." : undefined,
    save: async (scope, name, value) => {
      const current = config();
      if (!current?.adminTokenFile) throw new Error("disabled");
      await new OpenBaoClient({ ...current, tokenFile: current.adminTokenFile }, { forbiddenRoots }).save(scope, name, value);
    },
  };
}
export function keychainWriter(config: () => HarnessConfig, dataDir: string): SecretBackendWriter {
  const unavailableReason = () => {
    const value = config();
    const issues = keychainIsolationIssues(value);
    if (issues.length) return issues.join(" ");
    if (process.platform !== "darwin") return "Keychain requires a native macOS main process. You can keep using .env instead.";
    if (!value.keychain) return "Keychain is not configured. You can keep using .env instead.";
    if (!value.keychain.adminWrites) return "Keychain Admin writes are disabled by the operator.";
    return undefined;
  };
  const current = () => {
    const value = config().keychain;
    if (!value || unavailableReason()) throw new Error();
    return value;
  };
  return { id: "macos-keychain", label: "macOS Keychain", enabled: () => !unavailableReason(), unavailableReason, warning: () => keychainRiskWarning(config()),
    save: async (scope, name, value) => keychainClient(current(), dataDir).write("save", scope, name, value),
    remove: async (scope, name) => keychainClient(current(), dataDir).write("delete", scope, name) };
}
