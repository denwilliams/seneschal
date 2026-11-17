import { spawn } from "node:child_process";

/**
 * Run one executable directly, with no shell: no pipes, redirects, glob
 * expansion or command substitution. Shared by every restricted command
 * runner (`exec`'s configured commands, the shared-tool bin) so the timeout,
 * output-capping and result-formatting behaviour is identical wherever an
 * agent gets argv-checked access to a command line.
 */

export interface RestrictedCommandOptions {
  /** Executable to spawn directly. Never passed through a shell. */
  command: string;
  /** Full argv for the child process. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export interface RestrictedCommandResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}

/** What a run of a restricted command amounted to, with the exit code kept as a number rather than only as text. */
export interface RestrictedCommandOutcome {
  /** The same text the tools return: the command line, the exit status, then the (capped) output. */
  text: string;
  /** Just the (capped) output, with stderr lines marked `[stderr] `. */
  output: string;
  /** The exit code; null when the process was killed by a signal or never started. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the process could not be started at all. */
  startError?: string;
  /** Set when the caller cancelled the run. */
  aborted?: boolean;
}

function appendCapped(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, cap: number): boolean {
  if (state.bytes >= cap) return false;
  const remaining = cap - state.bytes;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    state.bytes += chunk.length;
    return true;
  }
  chunks.push(chunk.subarray(0, remaining));
  state.bytes = cap;
  return false;
}

export function runRestrictedCommandDetailed(opts: RestrictedCommandOptions & { signal?: AbortSignal }): Promise<RestrictedCommandOutcome> {
  const { command, argv, cwd, env, timeoutSeconds, maxOutputBytes } = opts;
  const child = spawn(command, argv, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  const state = { bytes: 0 };
  let truncated = false;
  let timedOut = false;
  let aborted = false;

  const kill = () => {
    if (child.killed) return;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutSeconds * 1000);
  timer.unref?.();
  const onAbort = () => { aborted = true; kill(); };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const onData = (prefix: string) => (chunk: Buffer) => {
    const kept = appendCapped(chunks, Buffer.concat([Buffer.from(prefix), chunk]), state, maxOutputBytes);
    if (!kept) {
      truncated = true;
      kill();
    }
  };
  child.stdout?.on("data", onData(""));
  child.stderr?.on("data", onData("[stderr] "));

  return new Promise((resolve) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ text: `failed to start ${command}: ${err.message}`, output: "", exitCode: null, signal: null, timedOut: false, truncated: false, startError: err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const body = Buffer.concat(chunks).toString("utf-8");
      const notes = [
        `command: ${command} ${argv.map((a) => JSON.stringify(a)).join(" ")}`,
        `exit: ${code ?? "signal " + signal}`,
        timedOut ? `[terminated after ${timeoutSeconds}s]` : undefined,
        truncated ? `[output truncated at ${maxOutputBytes} bytes]` : undefined,
      ].filter(Boolean);
      resolve({
        text: `${notes.join("\n")}\n\n${body}`.trimEnd(), output: body,
        exitCode: code, signal, timedOut, truncated, ...(aborted ? { aborted: true } : {}),
      });
    });
  });
}

export async function runRestrictedCommand(opts: RestrictedCommandOptions): Promise<RestrictedCommandResult> {
  const outcome = await runRestrictedCommandDetailed(opts);
  return { content: [{ type: "text", text: outcome.text }], details: undefined };
}
