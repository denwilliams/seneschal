import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SharedPaths } from "../workspace/paths.ts";
// Text-similarity helpers, reused rather than reimplemented: "the same
// limitation, said twice" is the same problem as "the same fact, said twice",
// and one crude matcher that behaves predictably beats two that differ.
import { entryId, isSameFact } from "./memory-store.ts";

/**
 * What the harness could not do, in the agent's own words.
 *
 * Every other channel of feedback here runs the wrong way round: an operator
 * decides what the agent gets, and the agent silently fails whenever that guess
 * was wrong. The failure is invisible — the agent apologises in a thread nobody
 * reviews, the person asks someone else, and the same wall is hit again next
 * week. Nothing in `data/` records that it happened.
 *
 * So the agent can file it. One shared log across the whole account, because
 * the useful signal is not "#home wanted a PDF reader" but "four channels
 * wanted a PDF reader" — the count is what turns a complaint into a backlog
 * item.
 *
 * Three properties keep this from becoming another thing to maintain:
 *
 * - **Append-only JSONL is the record.** Every report and every resolution is a
 *   line, so the history is intact and the file feeds a backlog with `jq`.
 * - **`FEEDBACK.md` is generated from it**, so the thing an operator actually
 *   reads is always current, sorted by how often each item has bitten. It is
 *   rewritten on every change and says so at the top.
 * - **It is delivered, not filed.** A digest goes to a channel on a schedule,
 *   leading with what changed since the last one and saying nothing at all in a
 *   week where nothing did. The file is where the detail lives; the digest is
 *   what makes anyone open it.
 * - **Repeats strengthen rather than pile up.** Reporting something already
 *   filed bumps its count and records the channel, exactly as memory does with
 *   a fact — otherwise the file would be a wall of near-duplicates within a
 *   week, which is the state in which nobody reviews it.
 *
 * It lives outside every channel's jail. The only route in is the tool, which
 * is what stamps the channel onto a report; a `write` pointed at the file would
 * let a channel file feedback in another's name.
 */

/** What kind of wall the agent hit. Coarse on purpose — this is triage, not taxonomy. */
export const FEEDBACK_KINDS = ["tool", "data", "permission", "knowledge", "harness"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const KIND_DESCRIPTIONS: Record<FeedbackKind, string> = {
  tool: "there was no tool or command for the job",
  data: "the information existed but this channel could not reach it",
  permission: "a permission, the jail, or the sandbox stood in the way",
  knowledge: "nobody had written down what the agent needed to know",
  harness: "the harness itself behaved badly — a limit, a bug, an awkward shape",
};

/** Long enough to say what broke, short enough to stay a headline. */
const MAX_SUMMARY = 200;
const MAX_DETAIL = 1000;
/** Recent examples kept per entry. Older ones stay in the log. */
const MAX_DETAILS = 5;

export interface ReportRecord {
  type: "report";
  at: string;
  id: string;
  kind: FeedbackKind;
  summary: string;
  detail?: string;
  channelId: string;
  /** Channel label as it read when reported, e.g. "#ops". For humans. */
  channelLabel: string;
  /** Slack user in the conversation where it came up, when there was one. */
  userId?: string;
}

export interface ResolveRecord {
  type: "resolved";
  at: string;
  id: string;
  by: string;
  note?: string;
}

export type FeedbackRecord = ReportRecord | ResolveRecord;

export interface FeedbackChannel {
  id: string;
  label: string;
}

export interface FeedbackDetail {
  at: string;
  channelLabel: string;
  text: string;
}

export interface FeedbackEntry {
  id: string;
  kind: FeedbackKind;
  /** The wording of the first report. Later ones add detail, not headlines. */
  summary: string;
  firstAt: string;
  lastAt: string;
  /** How many times this has been filed, across all channels. */
  reports: number;
  channels: FeedbackChannel[];
  details: FeedbackDetail[];
  status: "open" | "resolved";
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
}

export interface FeedbackChanges {
  /** Limitations nobody had filed before. */
  created: FeedbackEntry[];
  /** Already known, and hit again since. `added` is how many times. */
  climbing: { entry: FeedbackEntry; added: number }[];
  resolved: FeedbackEntry[];
  /** Called fixed, then hit again. The most interesting line in any digest. */
  reopened: FeedbackEntry[];
  /** Everything still open, worst first. Context for the above. */
  open: FeedbackEntry[];
  /** False when nothing has moved, which is when a digest should stay quiet. */
  anything: boolean;
}

export interface ReportInput {
  summary: string;
  kind: FeedbackKind;
  detail?: string;
  channelId: string;
  channelLabel: string;
  userId?: string;
}

export interface ReportResult {
  entry: FeedbackEntry;
  /** True when this joined something already filed rather than opening a new item. */
  repeat: boolean;
  /** True when it reopened an item an operator had marked resolved. */
  reopened: boolean;
  /** How many *other* channels have hit the same thing. Never says which. */
  otherChannels: number;
}

/** Thrown for things the agent can fix by rewording; the message reaches it. */
export class FeedbackError extends Error {}

function clamp(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The account-wide feedback log, plus the review file rendered from it.
 *
 * Reads never write, so a listing is safe from anywhere. Writes are an append
 * to the log followed by a re-render; the append is what must not fail, and the
 * render is bookkeeping.
 */
export class FeedbackLog {
  /** Append-only record. The truth. */
  readonly logPath: string;
  /** Generated review file. Overwritten on every change. */
  readonly reviewPath: string;

  constructor(shared: SharedPaths) {
    this.logPath = shared.feedbackLog;
    this.reviewPath = shared.feedbackFile;
  }

  records(): FeedbackRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.logPath, "utf-8");
    } catch {
      return [];
    }
    const out: FeedbackRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as FeedbackRecord;
        if (parsed && (parsed.type === "report" || parsed.type === "resolved")) out.push(parsed);
      } catch {
        // A truncated last line — a power cut mid-append on a Pi — costs that
        // one record, not the file.
      }
    }
    return out;
  }

  /**
   * The log folded into one entry per limitation, in the order first reported.
   *
   * `asOf` replays only what had happened by then, which is how the digest
   * works out what is new: fold twice and compare, rather than keeping a second
   * copy of the state that could drift from the log.
   */
  entries(asOf?: string): FeedbackEntry[] {
    const byId = new Map<string, FeedbackEntry>();

    for (const rec of this.records()) {
      if (asOf && rec.at > asOf) continue;
      if (rec.type === "report") {
        const existing = byId.get(rec.id);
        if (!existing) {
          byId.set(rec.id, {
            id: rec.id,
            kind: rec.kind,
            summary: rec.summary,
            firstAt: rec.at,
            lastAt: rec.at,
            reports: 1,
            channels: [{ id: rec.channelId, label: rec.channelLabel }],
            details: rec.detail
              ? [{ at: rec.at, channelLabel: rec.channelLabel, text: rec.detail }]
              : [],
            status: "open",
          });
          continue;
        }

        existing.reports += 1;
        existing.lastAt = rec.at;
        if (!existing.channels.some((c) => c.id === rec.channelId)) {
          existing.channels.push({ id: rec.channelId, label: rec.channelLabel });
        }
        if (rec.detail) {
          existing.details.push({ at: rec.at, channelLabel: rec.channelLabel, text: rec.detail });
          if (existing.details.length > MAX_DETAILS) existing.details.shift();
        }
        // Hitting it again after it was closed is the strongest evidence there
        // is that it was not actually fixed, so the item comes back.
        existing.status = "open";
        delete existing.resolvedAt;
        delete existing.resolvedBy;
        delete existing.resolution;
        continue;
      }

      const entry = byId.get(rec.id);
      if (!entry) continue;
      entry.status = "resolved";
      entry.resolvedAt = rec.at;
      entry.resolvedBy = rec.by;
      if (rec.note) entry.resolution = rec.note;
    }

    return [...byId.values()];
  }

  /** Open items worst first: what has bitten most, most recently. */
  open(): FeedbackEntry[] {
    return this.entries()
      .filter((e) => e.status === "open")
      .sort((a, b) => b.reports - a.reports || b.lastAt.localeCompare(a.lastAt));
  }

  /** What one channel has filed, newest first. Never shows another channel's items. */
  forChannel(channelId: string): FeedbackEntry[] {
    return this.entries()
      .filter((e) => e.channels.some((c) => c.id === channelId))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  find(id: string): FeedbackEntry | undefined {
    return this.entries().find((e) => e.id === id);
  }

  /**
   * What has happened since a moment in time.
   *
   * The unit of the review loop. A digest that just restated the whole file
   * every week would be ignored by the second week; what an operator needs to
   * see is the delta — what is new, what is getting worse, and what came back
   * after being called fixed.
   */
  changesSince(since?: string): FeedbackChanges {
    const before = new Map(since ? this.entries(since).map((e) => [e.id, e]) : []);
    const now = this.entries();

    const created: FeedbackEntry[] = [];
    const climbing: { entry: FeedbackEntry; added: number }[] = [];
    const resolved: FeedbackEntry[] = [];
    const reopened: FeedbackEntry[] = [];

    for (const entry of now) {
      const was = before.get(entry.id);
      if (!was) {
        // Filed and closed between two digests: the news is that it was dealt
        // with, not that it is outstanding. Listing it as new would put an
        // item in the "here is what needs doing" column that needs nothing.
        if (entry.status === "resolved") resolved.push(entry);
        else created.push(entry);
        continue;
      }
      if (entry.reports > was.reports) {
        climbing.push({ entry, added: entry.reports - was.reports });
      }
      if (was.status === "open" && entry.status === "resolved") resolved.push(entry);
      if (was.status === "resolved" && entry.status === "open") reopened.push(entry);
    }

    // Reopening is also a report, so a reopened item would otherwise appear
    // twice — once as news and once as a number that went up. The sets are kept
    // disjoint here rather than in whatever renders them, so every reader gets
    // the same story.
    const cameBack = new Set(reopened.map((e) => e.id));

    return {
      created,
      // Worst first, so the top line of a digest is the thing to act on.
      climbing: climbing
        .filter((c) => !cameBack.has(c.entry.id))
        .sort((a, b) => b.entry.reports - a.entry.reports),
      resolved,
      reopened,
      open: this.open(),
      anything: created.length + climbing.length + resolved.length + reopened.length > 0,
    };
  }

  private append(record: FeedbackRecord): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
  }

  report(input: ReportInput, now = new Date()): ReportResult {
    const summary = clamp(input.summary ?? "", MAX_SUMMARY);
    if (summary.length < 8) {
      throw new FeedbackError(
        "Say what got in the way in a sentence — a few words is not something an operator can act on.",
      );
    }

    const existing = this.entries();
    const match = existing.find((e) => isSameFact(e.summary, summary));
    const id = match?.id ?? entryId(summary);
    const detail = input.detail ? clamp(input.detail, MAX_DETAIL) : "";

    this.append({
      type: "report",
      at: now.toISOString(),
      id,
      kind: input.kind,
      summary,
      ...(detail ? { detail } : {}),
      channelId: input.channelId,
      channelLabel: input.channelLabel,
      ...(input.userId ? { userId: input.userId } : {}),
    });

    const entry = this.find(id)!;
    this.render(now);

    return {
      entry,
      repeat: Boolean(match),
      reopened: match?.status === "resolved",
      otherChannels: entry.channels.filter((c) => c.id !== input.channelId).length,
    };
  }

  /** Close an item. Reporting it again reopens it, which is the point of doing this by log. */
  resolve(id: string, by: string, note?: string, now = new Date()): FeedbackEntry | undefined {
    if (!this.find(id)) return undefined;
    this.append({
      type: "resolved",
      at: now.toISOString(),
      id,
      by,
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    const entry = this.find(id);
    this.render(now);
    return entry;
  }

  /**
   * Rewrite `FEEDBACK.md` from the log.
   *
   * Generated rather than maintained, so it cannot drift from the record — the
   * cost is that notes written into it by hand are lost, which is why it says
   * so in its own header and why resolving is a command rather than an edit.
   */
  render(now = new Date()): void {
    const entries = this.entries();
    const open = this.open();
    const resolved = entries
      .filter((e) => e.status === "resolved")
      .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));

    const lines: string[] = [
      "# Harness feedback",
      "",
      "Limitations the channel agents ran into: a tool that was missing, data they",
      "could not reach, a permission in the way. Filed by the agents themselves with",
      "`report_limitation`, so this is the harness seen from the inside.",
      "",
      "Generated from `feedback.jsonl` — **edits here are overwritten**. Close an item",
      "from Slack with `!feedback resolve <id>` or the reviewer-only `resolve_feedback` tool;",
      "reporting it again reopens it.",
      "",
      `_Updated ${now.toISOString().slice(0, 16).replace("T", " ")} — ${open.length} open, ${resolved.length} resolved._`,
      "",
    ];

    lines.push("## Open", "");
    if (open.length === 0) {
      lines.push("_Nothing outstanding._", "");
    } else {
      for (const entry of open) lines.push(...renderEntry(entry), "");
    }

    if (resolved.length > 0) {
      lines.push("## Resolved", "");
      for (const entry of resolved) {
        lines.push(
          `- \`${entry.id}\` ${entry.summary}`,
          `  _closed ${(entry.resolvedAt ?? "").slice(0, 10)} by ${entry.resolvedBy ?? "someone"}${
            entry.resolution ? ` — ${entry.resolution}` : ""
          }_`,
        );
      }
      lines.push("");
    }

    try {
      mkdirSync(dirname(this.reviewPath), { recursive: true });
      const tmp = `${this.reviewPath}.tmp`;
      writeFileSync(tmp, `${lines.join("\n").trimEnd()}\n`);
      renameSync(tmp, this.reviewPath);
    } catch {
      // The log is the record; a failed render loses the view, not the reports,
      // and the next one puts it back. Never fail a report over it.
    }
  }
}

function renderEntry(entry: FeedbackEntry): string[] {
  const channels = entry.channels.map((c) => c.label).join(", ");
  const out = [
    `### ${entry.summary}`,
    "",
    `\`${entry.id}\` · ${entry.kind} — ${KIND_DESCRIPTIONS[entry.kind]}`,
    `_Reported ${entry.reports}× from ${channels}. First ${entry.firstAt.slice(0, 10)}, last ${entry.lastAt.slice(0, 10)}._`,
  ];
  if (entry.details.length > 0) {
    out.push("");
    for (const d of entry.details) out.push(`- (${d.at.slice(0, 10)}, ${d.channelLabel}) ${d.text}`);
  }
  return out;
}

/** Where the digest records what it has already reported on. */
export function digestStatePath(logPath: string): string {
  return `${logPath.replace(/\.jsonl$/i, "")}.digest.json`;
}

interface DigestStateFile {
  /** ISO time of the last digest that was actually posted. */
  lastDigestAt?: string;
}

/**
 * How far the review loop has got.
 *
 * Kept beside the log rather than derived from it, because "what has an
 * operator already been told about" is not something the log knows. Losing it
 * costs one digest that repeats itself, so nothing here fails loudly.
 */
export class DigestState {
  private readonly path: string;

  constructor(log: FeedbackLog) {
    this.path = digestStatePath(log.logPath);
  }

  read(): DigestStateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as DigestStateFile;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Never digested, or the file went missing. Both mean "start from the top".
    }
    return {};
  }

  record(at: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastDigestAt: at } satisfies DigestStateFile, null, 2));
      renameSync(tmp, this.path);
    } catch {
      // A digest that goes out twice is better than one that fails to.
    }
  }
}

/** Lists in a digest are capped: a wall of items is read as a wall, not a list. */
const DIGEST_LIST_CAP = 5;

function digestLine(entry: FeedbackEntry, extra = ""): string {
  const channels = entry.channels.map((c) => c.label).join(", ");
  return `• \`${entry.id}\` ${entry.summary}\n   _${entry.kind}, ${entry.reports}× from ${channels}${extra}_`;
}

function capped(lines: string[]): string[] {
  if (lines.length <= DIGEST_LIST_CAP) return lines;
  return [...lines.slice(0, DIGEST_LIST_CAP), `_…and ${lines.length - DIGEST_LIST_CAP} more._`];
}

/**
 * The periodic digest: what the harness could not do, delivered rather than
 * filed.
 *
 * The whole point of the feedback log is that the harness gets better, and a
 * file nobody opens does not make anything better. So the digest goes to
 * whoever maintains this, on a schedule, and it leads with the delta — new
 * items, items getting worse, items that came back after being called fixed —
 * because that is what a decision gets made from.
 *
 * Returns undefined when nothing has moved. Silence when there is no news is
 * what keeps the noisy weeks worth reading.
 */
export function buildDigest(
  log: FeedbackLog,
  opts: { since?: string; now?: Date } = {},
): string | undefined {
  const changes = log.changesSince(opts.since);
  if (!changes.anything) return undefined;

  const now = opts.now ?? new Date();
  const headline = [
    changes.created.length > 0 ? `${changes.created.length} new` : "",
    changes.climbing.length > 0 ? `${changes.climbing.length} hit again` : "",
    changes.reopened.length > 0 ? `${changes.reopened.length} back open` : "",
    changes.resolved.length > 0 ? `${changes.resolved.length} closed` : "",
  ].filter(Boolean);

  const sections: string[] = [
    `*What I couldn't do${opts.since ? ` since ${opts.since.slice(0, 10)}` : ""}* — ${headline.join(", ")}`,
  ];

  if (changes.reopened.length > 0) {
    // First, deliberately: something closed and then hit again says the fix
    // did not land, which is the one thing here that cannot wait a week.
    sections.push(
      ["*Back open after being closed*", ...capped(changes.reopened.map((e) => digestLine(e)))].join("\n"),
    );
  }
  if (changes.created.length > 0) {
    sections.push(["*New*", ...capped(changes.created.map((e) => digestLine(e)))].join("\n"));
  }
  if (changes.climbing.length > 0) {
    sections.push(
      [
        "*Hit again*",
        ...capped(changes.climbing.map((c) => digestLine(c.entry, `, +${c.added} since last time`))),
      ].join("\n"),
    );
  }
  if (changes.resolved.length > 0) {
    sections.push(
      [
        "*Closed*",
        ...capped(
          changes.resolved.map(
            (e) => `• \`${e.id}\` ${e.summary}${e.resolution ? ` — _${e.resolution}_` : ""}`,
          ),
        ),
      ].join("\n"),
    );
  }

  // The standing list, so a digest is also a snapshot of where things are.
  const worst = changes.open.slice(0, DIGEST_LIST_CAP);
  if (worst.length > 0) {
    sections.push(
      [
        `*Open, most reported first* (${changes.open.length} in total)`,
        ...worst.map(
          (e) => `${e.reports}× \`${e.id}\` ${e.summary} _(${e.channels.length} channel(s))_`,
        ),
      ].join("\n"),
    );
  }

  sections.push(
    `_${now.toISOString().slice(0, 10)} · full list in \`${log.reviewPath}\` · close one with_ \`!feedback resolve <id>\` _or_ \`resolve_feedback\``,
  );

  return sections.join("\n\n");
}

/** One line per item, for `!feedback`. */
export function describeFeedback(entry: FeedbackEntry): string {
  const state = entry.status === "resolved" ? " _(resolved)_" : "";
  return (
    `• \`${entry.id}\` — ${entry.summary}${state}\n` +
    `   _${entry.kind}, reported ${entry.reports}×, last ${entry.lastAt.slice(0, 10)}_`
  );
}
