/** Safe diagnostic vocabulary: never retain CLI output, argv, paths, env or an error cause. */
export type AcliStage = "auth-status" | "identity-search" | "workitem-search" | "workitem-view" | "comment-list" | "comment-create" | "transition" | "command";
export type AcliFailure = "executable-unavailable" | "executable-not-permitted" | "timeout" | "output-limit" | "cli-compatibility" | "authentication-permission" | "command-failed" | "unknown" | "malformed-output" | "site-validation";

const hints: Record<AcliFailure, string> = {
  "executable-unavailable": "Provision ACLI on the channel host PATH, including its bin wrappers.",
  "executable-not-permitted": "Check host executable permissions.",
  timeout: "Check host CLI responsiveness/connectivity; execution exceeded its time bound.",
  "output-limit": "CLI output exceeded its size bound; no partial results accepted.",
  "cli-compatibility": "Check installed ACLI commands/flags against the Jira setup guide.",
  "authentication-permission": "Verify ACLI authentication/permissions in the poller host context, not sandbox login.",
  "command-failed": "Cause unverified; check host auth, permissions, connectivity and CLI compatibility privately.",
  unknown: "Cause unverified; run the host-context diagnostic in the Jira setup guide.",
  "malformed-output": "CLI output did not match the required schema; intake is closed.",
  "site-validation": "ACLI active site cannot be verified against factory.jira.site; intake is closed.",
};

export class AcliError extends Error {
  readonly stage: AcliStage;
  readonly category: AcliFailure;
  constructor(stage: AcliStage, category: AcliFailure) {
    super(`ACLI ${stage} [${category}] on harness host (not channel sandbox). ${hints[category]}`);
    this.name = "AcliError";
    this.stage = stage;
    this.category = category;
  }
}

/** Only fixed command names become diagnostics; never interpolate user arguments. */
export function acliStage(args: string[]): AcliStage {
  if (args[0] !== "jira") return "command";
  if (args[1] === "auth" && args[2] === "status") return "auth-status";
  if (args[1] !== "workitem") return "command";
  if (args[2] === "search") return args.includes("--limit") ? "identity-search" : "workitem-search";
  if (args[2] === "view") return "workitem-view";
  if (args[2] === "transition") return "transition";
  if (args[2] === "comment" && args[3] === "list") return "comment-list";
  if (args[2] === "comment" && args[3] === "create") return "comment-create";
  return "command";
}

export function acliFailure(error: unknown): AcliFailure {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
  if (e.code === "ENOENT") return "executable-unavailable";
  if (e.code === "EACCES" || e.code === "EPERM") return "executable-not-permitted";
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
  if (e.killed === true && e.signal === "SIGTERM") return "timeout";
  // A generic exit code (including 1) is NOT proof of bad auth. Only explicit CLI
  // diagnostics support these categories. The original text never leaves this function.
  if (typeof e.code === "number" && e.code !== 0) {
    const lines = typeof e.stderr === "string" ? e.stderr.split(/\r?\n/).map(line => line.trim().replace(/^(?:✗\s*)?Error:\s*/i, "")) : [];
    if (lines.some(line => /^(?:unknown flag:|unknown command\b|unknown shorthand flag:)/i.test(line) || /^fields '[^'\r\n]+' are not allowed$/i.test(line))) return "cli-compatibility";
    if (lines.some(line => /^(?:not authenticated|not logged in|authentication failed|unauthorized|forbidden|permission denied)[.!]?$/i.test(line))) return "authentication-permission";
    return "command-failed";
  }
  return "unknown";
}

/** Parsing/normalization failures may contain sensitive received values (e.g. Zod). */
export function acliOutput<T>(stage: AcliStage, parse: () => T): T {
  try { return parse(); }
  catch { throw new AcliError(stage, "malformed-output"); }
}
