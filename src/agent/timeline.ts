import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { logger } from "../util/log.ts";

/**
 * A channel's timeline: an append-only record of what its agents did, in order, for the web console to draw as a
 * graph. The channel agent is the main line; every subagent run is a branch that forks from it when the run starts
 * and merges back when its report arrives.
 *
 * It lives in the channel's own directory, outside the agent's jail, like the dream logs: it is a record OF the
 * agent, which makes it a poor thing to hand back as context, and nothing the agent can reach may rewrite it.
 *
 * What is kept is deliberately thin: who, what kind of step, tool NAMES (never arguments or output), status, timing
 * and cost, plus short excerpts of requests and reports. Excerpts are left out entirely for direct messages.
 */

export type TimelineKind =
  | "turn.start"
  | "turn.end"
  | "tool"
  | "run.start"
  | "run.end"
  | "approval.requested"
  | "approval.decided"
  /** A `post_as_user` outcome: sent, held, unblocked or dismissed. */
  | "post";

export type TimelineStatus = "ok" | "error" | "done" | "blocked" | "needs_input" | "failed" | "interrupted" | "granted" | "denied";

export interface TimelineEvent {
  /** Short git-style identifier, unique enough to point at one step. */
  id: string;
  at: string;
  kind: TimelineKind;
  /** `channel` for the channel agent, otherwise the subagent's name. */
  actor: string;
  threadKey?: string;
  /** The subagent run this belongs to: its branch. Absent on the main line. */
  runKey?: string;
  /** A short, safe label: what happened. */
  title: string;
  /** A bounded excerpt (a request, a task, a report). Never present for direct messages. */
  detail?: string;
  status?: TimelineStatus;
  /** For `run.end`: the role the subagent suggested should act next. */
  next?: string;
  userId?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: number;
  /** For `run.end`: how many tool calls the run made. */
  steps?: number;
  model?: string;
}

export type TimelineInput = Omit<TimelineEvent, "id" | "at"> & { at?: string };

/** Where agents report what they do. Recording must never be able to fail a turn. */
export interface TimelineSink {
  record(event: TimelineInput): void;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EXCERPT = 280;

/** One line of plain text, bounded, with the same URL redaction the web console task status applies applied by the caller. */
export function excerpt(text: string | undefined, max = MAX_EXCERPT): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class ChannelTimelineLog implements TimelineSink {
  private readonly file: string;
  private readonly rotated: string;
  private readonly redactText: boolean;
  private readonly now: () => number;

  /**
   * `root` is the channel's own directory. `redactText` drops every excerpt (direct messages), keeping the shape of
   * what happened without the content.
   */
  constructor(root: string, options: { redactText?: boolean; now?: () => number } = {}) {
    this.file = join(root, "timeline.jsonl");
    this.rotated = join(root, "timeline.1.jsonl");
    this.redactText = options.redactText === true;
    this.now = options.now ?? Date.now;
  }

  record(input: TimelineInput): void {
    try {
      const at = input.at ?? new Date(this.now()).toISOString();
      const id = createHash("sha1").update(`${at}${input.kind}${input.runKey ?? ""}${randomBytes(4).toString("hex")}`).digest("hex").slice(0, 7);
      const { detail, ...rest } = input;
      const event: TimelineEvent = {
        ...rest,
        id,
        at,
        title: excerpt(input.title, 160) ?? input.kind,
        ...(detail && !this.redactText ? { detail: excerpt(detail) } : {}),
      };
      mkdirSync(join(this.file, ".."), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > MAX_FILE_BYTES) renameSync(this.file, this.rotated);
      appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    } catch (error) {
      // A full disk or a permissions problem is worth a line in the log, never a failed reply.
      logger.warn(`timeline: could not record ${input.kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The newest `limit` events in time order (oldest first). Unreadable lines are skipped. */
  read(limit = 500): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    for (const file of [this.rotated, this.file]) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as TimelineEvent;
          if (parsed && typeof parsed.id === "string" && typeof parsed.at === "string" && typeof parsed.kind === "string") events.push(parsed);
        } catch { /* a torn last line after a crash */ }
      }
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    return events.slice(-limit);
  }
}

/** The log for a channel's root directory, opening nothing until something is recorded. */
export function timelineFor(root: string, isDm: boolean): ChannelTimelineLog {
  return new ChannelTimelineLog(root, { redactText: isDm });
}

/**
 * The timeline for a resolved channel. Without a channel directory there is nowhere to record, and a turn must never
 * depend on that, so the answer is a sink that records nothing.
 */
export function timelineForChannel(channel: { paths?: { root?: string }; ref: { isDm: boolean } }): TimelineSink & { read(limit?: number): TimelineEvent[] } {
  const root = channel.paths?.root;
  return root ? timelineFor(root, channel.ref.isDm) : { record: () => undefined, read: () => [] };
}

/**
 * Close the branch of every run a restart cut off. Such a run is abandoned, not resumed, and it will never report, so
 * without this its branch would hang open on the timeline. A run that already has an end is left alone.
 */
export function closeInterruptedRuns(log: Pick<ChannelTimelineLog, "read" | "record">, runKeys: readonly string[], now = Date.now()): number {
  if (runKeys.length === 0) return 0;
  const known = log.read(2000);
  let closed = 0;
  for (const key of runKeys) {
    if (known.some((event) => event.runKey === key && event.kind === "run.end")) continue;
    const start = known.find((event) => event.runKey === key && event.kind === "run.start");
    log.record({
      kind: "run.end", actor: start?.actor ?? "subagent", runKey: key, ...(start?.threadKey ? { threadKey: start.threadKey } : {}),
      title: `${start?.actor ?? "subagent"} interrupted`, status: "interrupted",
      detail: "The harness restarted before this run finished. It was not resumed.",
      ...(start ? { durationMs: Math.max(0, now - Date.parse(start.at)) } : {}),
    });
    closed++;
  }
  return closed;
}
