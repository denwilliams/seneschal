import type { HarnessConfig } from "./schema.ts";

/** Same-user host execution can reach Keychain regardless of secret import scopes. */
export function keychainIsolationIssues(config: Pick<HarnessConfig, "defaults" | "channels" | "keychain">): string[] {
  if (config.keychain?.acceptHostExecutionRisk === true) return [];
  const entries = [config.defaults, ...Object.values(config.channels).map((channel) => ({
    tools: channel.tools ?? config.defaults.tools,
    sandbox: { ...config.defaults.sandbox, ...channel.sandbox },
    share: channel.share,
  }))];
  const issues: string[] = [];
  if (entries.some((entry) => entry.tools.includes("exec"))) {
    issues.push("Keychain forbids host CLI execution (exec); use bash inside Docker or Apple Containers (macos-container) or Kiri instead. To keep using .env, leave Keychain unconfigured.");
  }
  if (entries.some((entry) => Object.keys(entry.share.sharedTools).length > 0)) {
    issues.push("Keychain forbids host shared-tool execution (share.sharedTools), including hash-pinned scripts; use container bash instead. To keep using .env, leave Keychain unconfigured.");
  }
  if (entries.some((entry) => entry.tools.includes("bash") && entry.sandbox.mode === "host")) {
    issues.push("Keychain is unavailable with host bash: it has the harness OS identity. Docker or Apple Containers (macos-container) or Kiri is required for bash-enabled channels. You can keep using .env without container isolation; leave Keychain unconfigured.");
  }
  return issues;
}

/** Warning is independent of backend availability and remains visible without active host tools. */
export function keychainRiskWarning(config: Pick<HarnessConfig, "keychain">): string | undefined {
  if (config.keychain?.acceptHostExecutionRisk !== true) return undefined;
  return "Keychain host-execution risk accepted (keychain.acceptHostExecutionRisk: true). Same-user host execution is trusted and may invoke the helper directly to access Keychain secrets outside configured channel scopes. Container channels do not isolate their secrets from the host. Scoped imports still apply, but are not an OS-enforced boundary against host execution.";
}
