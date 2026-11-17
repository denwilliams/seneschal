import { readdirSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * On-disk layout. Everything is plain files: markdown for anything a human may
 * want to read or edit, plus SQLite for durable conversations and channel lists.
 * Back up a stopped deployment to capture consistent databases and sidecars.
 *
 *   data/
 *     shared/
 *       knowledge/*.md          account brain, read by every channel by default
 *       skills/<collection>/<skill>/SKILL.md
 *                               operator-curated skill collections; a skill belongs to exactly
 *                               one collection, collections are assigned to channels read-only
 *                               or read-write (share.skillCollections)
 *       global-bin/<name>       operator-owned executables, on PATH for EVERY channel (host and
 *                               container, read-only there). Not the agent-published `bin/`.
 *       audit/skill-writes.jsonl provenance of every write to a collection or another channel's skills
 *       library/<name>/         skills channels published for each other
 *       bin/<name>              executable tools channels published for each other
 *       bin/.meta/<name>.json   provenance for each one: publisher, version, sha256
 *       documents/<id>/         the document library: text, original, metadata
 *       documents/INDEX.md      the shelf, rendered for a human; regenerated
 *       memory/MEMORY.md        account memory, written only by permitted channels
 *       usage/usage.jsonl       model token/cost records, one line per observed model response
 *       notifications/notifications.jsonl queued batched notifications from channels
 *       feedback/feedback.jsonl what the harness could not do, one line per report
 *       feedback/FEEDBACK.md    the same, rendered for review; regenerated
 *       tasks/tasks.json        durable web console task status/history (JSON, atomically rewritten)
 *     channels/<channelId>/
 *       workspace/              tool sandbox (cwd) — the jail root
 *       workspace/tmp/          disposable scratch files (no automatic cleanup)
 *       workspace/bin/          on PATH for bash; the channel's own CLI tools
 *       workspace/attachments/  text pulled out of files people attached here
 *       workspace/artifacts/    browser-served public artifacts when artifact hosting is enabled
 *       attachments/            those files as uploaded, plus what they were
 *       Dockerfile              optional; if present, the image bash runs in
 *       skills/<name>/SKILL.md  channel-private skills, always active
 *       memory/MEMORY.md        channel memory, never leaves without config
 *       memory/DREAMS.md        journal of the nightly consolidation pass
 *       sessions/<thread>.jsonl one transcript per Slack thread
 *       lists.sqlite            channel lists; one physical table per list
 *       recent-conversations.json last few thread ids and one-line summaries
 *       agent/                  pi's own per-channel config/state dir
 *       channel.json            metadata (slack id, name, last seen)
 *       dream.json              when this channel last dreamt
 *       dreams/log.jsonl        one line per consolidation run, kept forever
 *       dreams/<stamp>.jsonl    recent full dream transcripts, for debugging
 *       schedules.json           scheduled task definitions and latest status
 *       schedule-runs.jsonl      append-only scheduled-run outcome ledger
 *
 * Note which side of the jail the dream logs sit on: under the channel root
 * rather than in `memory/`, so they are readable with a shell and not by the
 * agent. They are a record *of* the agent, which is a poor thing to hand back
 * to it as context.
 */

export interface SharedPaths {
  root: string;
  knowledge: string;
  /** Skill collections: `<skills>/<collection>/<skill>/SKILL.md`. */
  skills: string;
  /**
   * Operator-owned global bin. On PATH for every channel (after the channel's
   * own `workspace/bin`), mounted read-only into every container at
   * `/global/bin`. Deliberately NOT `bin` below: that is agent-published and
   * never on any PATH. Nothing the agent can reach writes here.
   */
  globalBin: string;
  /** Append-only provenance of skill writes (collections, admin writes into channels). */
  audit: string;
  skillWriteLog: string;
  /** Agent-published skills, opt-in by installing rather than by config. */
  library: string;
  /**
   * Agent-published executable scripts. Never in any channel's filesystem
   * jail: the only way in is `publish_shared_tool`, and the only way to run
   * one is a `shared__<name>` tool the operator named in a channel's own
   * `share.sharedTools`.
   */
  bin: string;
  /** Provenance for each `bin/<name>` entry: publisher, version, sha256. */
  binMeta: string;
  /** The document library: one directory per document, account-wide. */
  documents: string;
  memory: string;
  memoryFile: string;
  usage: string;
  /** Append-only model token/cost accounting, one line per observed model response. */
  usageLog: string;
  notifications: string;
  /** Append-only record of batched notification submissions and collections. */
  notificationsLog: string;
  feedback: string;
  /** Append-only record of what the harness could not do. The truth. */
  feedbackLog: string;
  /** Rendered from the log for a human to review. Regenerated, never edited. */
  feedbackFile: string;
}

export interface ChannelPaths {
  root: string;
  workspace: string;
  /** `workspace/tmp`: disposable temporary files, never automatically cleaned up. */
  tmp: string;
  /**
   * `workspace/bin`, prepended to PATH for this channel's shell. Inside the
   * jail, so the agent can write a script here and run it by name tomorrow;
   * an operator can drop a binary in without touching the harness.
   */
  bin: string;
  /** `workspace/artifacts`: the only files exposed by the web server (with `webConsole.artifacts`). */
  artifacts: string;
  /**
   * Optional per-channel sandbox image definition. Deliberately a sibling of
   * `workspace/` rather than inside it: `bin` is the agent's to fill, but a
   * file deciding what the agent's container is made of belongs to the
   * operator.
   */
  dockerfile: string;
  /**
   * Files attached in this channel, exactly as they were uploaded, plus the
   * manifest saying what each one is. Deliberately outside the workspace: the
   * agent has no use for a PDF's bytes, and the original is the record the
   * library keeps — it should not be editable between arriving and being
   * filed. What the agent reads is the extracted text in `attachmentText`.
   */
  attachments: string;
  /** `workspace/attachments`: the text of those files, inside the jail. */
  attachmentText: string;
  skills: string;
  memory: string;
  memoryFile: string;
  sessions: string;
  agentDir: string;
  /** Rolling one-line summaries of this channel's recently updated Slack threads. */
  recentConversationsFile: string;
  metaFile: string;
}

/** documentsDir, when supplied, is an absolute path resolved by the configuration caller. */
export function sharedPaths(dataDir: string, documentsDir?: string): SharedPaths {
  const root = join(dataDir, "shared");
  return {
    root,
    knowledge: join(root, "knowledge"),
    skills: join(root, "skills"),
    globalBin: join(root, "global-bin"),
    audit: join(root, "audit"),
    skillWriteLog: join(root, "audit", "skill-writes.jsonl"),
    library: join(root, "library"),
    bin: join(root, "bin"),
    binMeta: join(root, "bin", ".meta"),
    documents: documentsDir ?? join(root, "documents"),
    memory: join(root, "memory"),
    memoryFile: join(root, "memory", "MEMORY.md"),
    usage: join(root, "usage"),
    usageLog: join(root, "usage", "usage.jsonl"),
    notifications: join(root, "notifications"),
    notificationsLog: join(root, "notifications", "notifications.jsonl"),
    feedback: join(root, "feedback"),
    feedbackLog: join(root, "feedback", "feedback.jsonl"),
    feedbackFile: join(root, "feedback", "FEEDBACK.md"),
  };
}

export function channelPaths(dataDir: string, channelId: string): ChannelPaths {
  const root = join(dataDir, "channels", channelId);
  const workspace = join(root, "workspace");
  return {
    root,
    workspace,
    tmp: join(workspace, "tmp"),
    bin: join(workspace, "bin"),
    artifacts: join(workspace, "artifacts"),
    dockerfile: join(root, "Dockerfile"),
    attachments: join(root, "attachments"),
    attachmentText: join(workspace, "attachments"),
    skills: join(root, "skills"),
    memory: join(root, "memory"),
    memoryFile: join(root, "memory", "MEMORY.md"),
    sessions: join(root, "sessions"),
    agentDir: join(root, "agent"),
    recentConversationsFile: join(root, "recent-conversations.json"),
    metaFile: join(root, "channel.json"),
  };
}

export function ensureSharedDirs(dataDir: string, documentsDir?: string): SharedPaths {
  const p = sharedPaths(dataDir, documentsDir);
  for (const dir of [p.root, p.knowledge, p.skills, p.globalBin, p.audit, p.library, p.bin, p.binMeta, p.documents, p.memory, p.usage, p.notifications, p.feedback]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(p.memoryFile)) {
    writeFileSync(
      p.memoryFile,
      "# Account memory\n\nFacts that every channel is allowed to know. Channels only write here when `share.memoryWrite` is enabled.\n",
    );
  }
  return p;
}

export function ensureChannelDirs(dataDir: string, channelId: string): ChannelPaths {
  const p = channelPaths(dataDir, channelId);
  for (const dir of [p.root, p.workspace, p.tmp, p.bin, p.artifacts, p.skills, p.memory, p.sessions, p.agentDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(p.memoryFile)) {
    writeFileSync(
      p.memoryFile,
      "# Channel memory\n\nWhat this channel has learned. Private to this channel unless the config shares it.\n",
    );
  }
  return p;
}

/** Slack thread timestamps contain a dot; keep directory names boring and safe. */
export function safeThreadName(threadKey: string): string {
  return threadKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Directory holding one thread's transcripts. */
export function threadSessionDir(sessionsDir: string, threadKey: string): string {
  return join(sessionsDir, safeThreadName(threadKey));
}

/**
 * Whether the bot is taking part in this thread.
 *
 * The session directory is the record: if the bot has ever handled a message
 * in a thread, that thread has a directory, and replies there no longer need
 * an @mention. Deriving this from the filesystem rather than tracking it
 * separately means there is one source of truth and it survives a restart for
 * free.
 *
 * Deliberately pure — no mkdir — so the message handler can ask about any
 * channel without creating state for channels it is about to ignore.
 */
export function isThreadActive(dataDir: string, channelId: string, threadKey: string): boolean {
  return existsSync(threadSessionDir(channelPaths(dataDir, channelId).sessions, threadKey));
}

/** Record that the bot is taking part in this thread. */
export function markThreadActive(sessionsDir: string, threadKey: string): string {
  const dir = threadSessionDir(sessionsDir, threadKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether this thread has a transcript from before conversations moved into the per-channel store. Nothing
 * reads or writes those files any more; their presence only marks a thread that was already in use, whose
 * first turn on the store deserves a larger Slack backfill.
 */
export function hasLegacyTranscript(sessionsDir: string, threadKey: string): boolean {
  try {
    return readdirSync(threadSessionDir(sessionsDir, threadKey)).some((name) => name.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
