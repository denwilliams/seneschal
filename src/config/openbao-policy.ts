import type { HarnessConfig } from "./schema.ts";

/** Host execution has the same OS identity as the process holding backend credentials. */
export function openBaoIsolationIssues(config: Pick<HarnessConfig, "defaults" | "channels" | "openbao">): string[] {
  if (!config.openbao || config.openbao.acceptHostExecutionRisk === true) return [];
  const entries = [config.defaults, ...Object.values(config.channels).map((channel) => ({
    tools: channel.tools ?? config.defaults.tools,
    sandbox: { ...config.defaults.sandbox, ...channel.sandbox },
    share: channel.share,
  }))];
  const issues: string[] = [];
  if (entries.some((entry) => entry.tools.includes("bash") && entry.sandbox.mode === "host")) {
    issues.push("OpenBao requires container isolation for channels with bash; host bash can read harness credentials. Strict mode is active unless the operator sets openbao.acceptHostExecutionRisk: true on the host.");
  }
  if (entries.some((entry) => entry.tools.includes("exec") || Object.keys(entry.share.sharedTools).length)) {
    issues.push("OpenBao forbids host CLI execution (exec) and host shared-tool execution (share.sharedTools); use container bash instead. Strict mode is active unless the operator sets openbao.acceptHostExecutionRisk: true on the host.");
  }
  return issues;
}

/** Independent of Admin-write availability and whether host tools are currently selected. */
export function openBaoRiskWarning(config: Pick<HarnessConfig, "openbao">): string | undefined {
  if (config.openbao?.acceptHostExecutionRisk !== true) return undefined;
  return "OpenBao host-execution risk accepted (openbao.acceptHostExecutionRisk: true). Same-user host execution is trusted and may read the token file or process memory, obtain backend credentials and access backend secrets outside configured channel scopes. Container channels do not isolate their secrets from the host. Scoped imports still apply, but are not an OS-enforced boundary against host execution.";
}
