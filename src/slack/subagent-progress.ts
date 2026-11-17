import type { SubagentProgress, SubagentProgressSink } from "../agent/subagent-tools.ts";
import { redactTaskUrls } from "../tasks/store.ts";
import { toMrkdwn } from "./format.ts";

/**
 * What people in the thread are told while a subagent works: who the job was handed to and what it is, the subagent's own
 * commentary as it comes in, and a closing line when it is done. Each is its own message, ahead of the channel agent's
 * answer, which still says what it all means.
 *
 * What a subagent says can come from anything it read (an issue, a web page), so it is escaped before it reaches Slack:
 * `<!channel>` and `<@U123>` in it must stay text, never become a mention.
 */

const TASK_EXCERPT = 400;
const UPDATE_EXCERPT = 500;

/** Slack's own escaping for the three characters that carry meaning in a message. */
export const escapeSlack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const FINISHED: Record<string, { icon: string; word: string }> = {
  done: { icon: ":white_check_mark:", word: "finished" },
  blocked: { icon: ":no_entry_sign:", word: "is blocked" },
  needs_input: { icon: ":raised_hand:", word: "needs an answer" },
  failed: { icon: ":x:", word: "failed" },
  interrupted: { icon: ":warning:", word: "was interrupted" },
};

/** A subagent's name is a config key (`[a-z][a-z0-9_]*`), safe in a message; anything else is escaped all the same. */
const name = (agent: string): string => `*${escapeSlack(agent)}*`;

export function formatProgress(update: SubagentProgress): string {
  switch (update.kind) {
    case "started":
      return `:handshake: Handing this to ${name(update.agent)}:\n> ${toMrkdwn(escapeSlack(excerpt(redactTaskUrls(update.task), TASK_EXCERPT)))}`;
    case "update":
      return `${name(update.agent)}: ${toMrkdwn(escapeSlack(excerpt(redactTaskUrls(update.text), UPDATE_EXCERPT)))}`;
    case "finished": {
      const how = FINISHED[update.status] ?? FINISHED.done!;
      const bits = [duration(update.durationMs), `${update.steps} step${update.steps === 1 ? "" : "s"}`];
      const next = update.next && update.next !== "none" ? ` It suggests ${name(update.next)} next.` : "";
      return `${how.icon} ${name(update.agent)} ${how.word} (${bits.join(" · ")}).${next}`;
    }
  }
}

/** The part of a response stream this needs: posting ahead of the reply, and the live status line. */
export interface ProgressStream {
  postInterjection(text: string): Promise<void>;
  setStatus(status: string): void;
}

export interface ProgressOptions {
  /** Commentary closer together than this is dropped, so a chatty subagent does not flood the thread. */
  minUpdateGapMs?: number;
  /** The most commentary posts for one run. The hand-off and the closing line are always posted. */
  maxUpdatesPerRun?: number;
  /** Commentary shorter than this is not worth a message. */
  minUpdateChars?: number;
  /** Show the subagent's own updates. Off, only the hand-off and the closing line are posted. Default on. */
  updates?: boolean;
  now?: () => number;
}

export class SubagentProgressPoster {
  private readonly stream: ProgressStream;
  private readonly minGap: number;
  private readonly maxUpdates: number;
  private readonly minChars: number;
  private readonly now: () => number;
  private readonly updates: boolean;
  private readonly runs = new Map<string, { updates: number; lastAt: number; lastText: string }>();

  constructor(stream: ProgressStream, options: ProgressOptions = {}) {
    this.stream = stream;
    this.minGap = options.minUpdateGapMs ?? 10_000;
    this.maxUpdates = options.maxUpdatesPerRun ?? 6;
    this.minChars = options.minUpdateChars ?? 24;
    this.now = options.now ?? Date.now;
    this.updates = options.updates ?? true;
  }

  /** Hand this to the session; it is called as the subagent reports. Never throws and never blocks the run. */
  readonly sink: SubagentProgressSink = (update) => {
    const state = this.runs.get(update.runKey) ?? { updates: 0, lastAt: 0, lastText: "" };
    if (update.kind === "update") {
      if (!this.updates) return;
      const text = update.text.trim();
      const now = this.now();
      if (text.length < this.minChars || text === state.lastText) return;
      if (state.updates >= this.maxUpdates || now - state.lastAt < this.minGap) return;
      state.updates++;
      state.lastAt = now;
      state.lastText = text;
    } else {
      // The status line is a courtesy; a failure to set it must not cost the post.
      try { this.stream.setStatus(update.kind === "started" ? `waiting on ${update.agent}…` : "thinking…"); } catch { /* cosmetic */ }
    }
    this.runs.set(update.runKey, state);
    void this.stream.postInterjection(formatProgress(update)).catch(() => undefined);
  };
}
