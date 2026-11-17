import { defineDocFamily } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";

/**
 * Issue intake's records, in the channel's durable store. They are ENGINE-OWNED: written only by the intake code and the store's
 * methods, never through the channel's state object (`state_update`), which the agent can write. A prompt-injected agent must not
 * be able to edit which issues map to which runs. See docs/FACTORY_WORKFLOW_DESIGN.md section 15.
 */

/** `open`: mapped to a run. `queued`: eligible, waiting for a free slot. `held`: not trusted, waiting for a person. `ignored`: not for the factory. `closed`: the issue closed. */
export type IntakeStatus = "open" | "queued" | "held" | "ignored" | "closed";

export type IntakeEntry = {
  workItem?: import("./source.ts").WorkItem;
  number: number;
  title: string;
  url: string;
  author: string;
  association: string;
  /** Why it may start (author_association, harness_filed, go_label, released), or "" when it may not. */
  trust: string;
  status: IntakeStatus;
  /** Why it is held, queued, ignored or closed, bounded. */
  reason: string;
  /** The run the issue is mapped to, or "" when there is none. After a reopen it is the new run. */
  runId: string;
  /** Every run this issue has had, oldest first, so a reopen keeps the history. */
  runs: string[];
  createdAt: number;
  /** GitHub's `updated_at` as last processed. */
  lastUpdatedAt: number;
  /** The newest comment time seen, so only newer ones are fetched. */
  commentWatermark: number;
  comments: number;
  /** Fingerprints of the body and the labels, to tell an edit from nothing. */
  bodyHash: string;
  labelsKey: string;
  /** A person released it (go label or tool): the trust rule no longer applies. */
  released: boolean;
  /** When this mapping was last checked on GitHub by itself (not from the list), for the idle sweep. */
  checkedAt: number;
  firstSeen: number;
  closedAt: number;
  /** A person (or an upgrade) asked for the comments since the run began to be read again; the next poll does it and clears this. */
  recheck?: boolean;
  /** What the last read of this issue's comments found, as counts only: how a stuck run can be told from a quiet issue. */
  lastScan?: CommentScan;
};

/** Counts from one read of an issue's comments. `skippedOwn` are the agent's (a footer, or made while one of its stages ran). */
export type CommentScan = { at: number; fetched: number; delivered: number; untrusted: number; skippedOwn: number; skippedByFooter: number; duplicates: number; changesInStage: number; rechecked: boolean };

export const emptyIntakeEntry = (number: number): IntakeEntry => ({
  number, title: "", url: "", author: "", association: "", trust: "", status: "ignored", reason: "", runId: "", runs: [], createdAt: 0,
  lastUpdatedAt: 0, commentWatermark: 0, comments: 0, bodyHash: "", labelsKey: "", released: false, checkedAt: 0, firstSeen: 0, closedAt: 0,
});

export type IntakeRepoData = {
  repo: string;
  /** When intake first polled this repository: issues created before it are not started unless `backfill`. 0 = not yet polled. */
  enabledAt: number;
  /** Polls ask for issues updated since this, less an overlap. */
  since: number;
  lastPollAt: number;
  lastOkAt: number;
  lastError: string;
  /** When each automatic start happened in the last hour, for `maxPerHour`. */
  starts: number[];
  /** Issues the harness filed itself, recorded when it filed them: the proof a footer alone cannot give. Bounded. */
  filedByHarness: number[];
  entries: Record<string, IntakeEntry>;
  /** Told once that the circuit breaker tripped, until the next quiet poll. */
  breaker: boolean;
  /** The version of the rules that sort an issue's comments (intake.ts COMMENT_RULES_VERSION) the last poll applied. Older or absent: the comments of waiting runs are read again once. */
  commentRules?: number;
  /** The last check that the factory's labels exist in the repository (labels.ts). Absent before the first check, and in older documents. */
  labels?: { checkedAt: number; /** The names created by that check. */ created: string[]; /** Why it failed, or "". */ error: string };
};

export const MAX_INTAKE_ENTRIES = 1500;
export const MAX_FILED_BY_HARNESS = 500;
export const CLOSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const emptyIntakeRepo = (repo: string): IntakeRepoData => ({
  repo, enabledAt: 0, since: 0, lastPollAt: 0, lastOkAt: 0, lastError: "", starts: [], filedByHarness: [], entries: {}, breaker: false,
});

/** The document key for a repository: its lower-cased name, hashed, so no character of it matters to the store. */
export const intakeKey = (repo: string): string => `r_${createHash("sha256").update(repo.toLowerCase()).digest("hex").slice(0, 16)}`;

/** One per repository, session-scoped, like the run documents. */
export const FactoryIntakeFamily = defineDocFamily<IntakeRepoData, IntakeRepoData>({
  kind: "slack.factory-intake", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

/**
 * The channel's rolling intake note in Slack: one top-level post a day, edited with counts, and a line in its thread for each thing
 * that happened. Written by the Slack presence; kept here so a restart does not post a second note or repeat a line.
 */
export type IntakeNoteData = {
  /** UTC day the post is for, `YYYY-MM-DD`. */
  day: string;
  channel: string;
  ts: string;
  counts: Record<string, number>;
  /** Keys of the lines already said, oldest first, bounded. */
  events: string[];
};
export const emptyIntakeNote = (): IntakeNoteData => ({ day: "", channel: "", ts: "", counts: {}, events: [] });
export const MAX_NOTE_EVENTS = 400;

export const FactoryIntakeNoteFamily = defineDocFamily<IntakeNoteData, IntakeNoteData>({
  kind: "slack.factory-intake-note", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});
export const INTAKE_NOTE_KEY = "note";
