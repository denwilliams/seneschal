import type { ExecutionEnvironment, SandboxMode } from "@api/api-types";
import type { ReactNode } from "react";
import { Section } from "@/components/common";

function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right font-medium">{children}</dd></div>;
}

export const ENVIRONMENT_LABEL: Record<SandboxMode | "outside", string> = {
  host: "Outside channel sandboxes", docker: "Docker", kiri: "Kiri", "macos-container": "Apple Containers", unknown: "Unknown / unavailable", outside: "Outside sandbox",
};
const STATUS_LABEL = { running: "Running", stopped: "Stopped", absent: "Not found", "not-applicable": "Not applicable", unknown: "Unknown / unavailable" };

export function ExecutionBoundary({ execution, sandbox }: { execution?: ExecutionEnvironment; sandbox?: string }) {
  const configured = execution?.configuredMode ?? (sandbox === "host" || sandbox === "docker" || sandbox === "macos-container" || sandbox === "kiri" ? sandbox : "unknown");
  return (
    <Section title="Execution environment">
      <dl className="space-y-1.5 text-sm">
        <KeyValue label="Configured sandbox">{ENVIRONMENT_LABEL[configured]}</KeyValue>
        {execution && <KeyValue label="Bash routing">{ENVIRONMENT_LABEL[execution.toolMode]} ({execution.source === "runtime" ? "open runtime" : "configuration only"})</KeyValue>}
        {execution?.reuse !== undefined && <KeyValue label="Container lifetime">{execution.reuse ? "Reused per thread" : "Per command"}</KeyValue>}
        <KeyValue label="Container status">{execution?.status ? STATUS_LABEL[execution.status.state] : execution?.toolMode === "host" ? "Not applicable" : "Unknown / unavailable"}</KeyValue>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">{execution?.status?.detail ?? "Configuration is not evidence of a running container. Inspect a thread in Session for runtime status."}</p>
      {execution?.status?.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Observed {new Date(execution.status.checkedAt).toLocaleTimeString()} (snapshot; refresh to recheck).</p>}
      <p className="mt-2 text-xs text-muted-foreground">A channel sandbox applies only to bash and commands it launches. File tools (read/write/edit/find/grep/ls), restricted exec and cli__ tools, jobs, connectors, and agent orchestration run outside it. Scheduled or delegated agents follow their own bash routing; they are not wholly containerised.</p>
      <p className="mt-2 text-xs text-muted-foreground">Outside means the harness process, its host or service container, or a remote connector server—not necessarily bare metal. The harness's own deployment isolation and remote server isolation are unknown here.</p>
    </Section>
  );
}
