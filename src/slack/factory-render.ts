import type { KnownBlock } from "@slack/types";
import { humanChangesStage, pinnedWorkflow } from "../factory/workflow/definition.ts";
import type { Attempt, FactoryRunData, StageRun, StageStatus } from "../factory/workflow/docs.ts";
import { isTerminalRun } from "../factory/workflow/docs.ts";
import type { IntakeNote } from "../factory/workflow/intake.ts";
import { escapeSlack } from "./subagent-progress.ts";

/**
 * What a workflow run looks like in Slack: the status post and the replies in its thread. Pure functions of the run document, so
 * the same run always draws the same way and the posting code only has to decide when.
 *
 * Nothing a person or a role wrote reaches a place Slack interprets. An issue title, a report's summary and a run's reason are
 * untrusted (an issue is written by anyone): they only ever go in `plain_text` fields or the `header` block, which Slack does not
 * parse for mentions, links or formatting. The `text` Slack uses for notifications and as a fallback is built from the harness's
 * own words only. What is in mrkdwn is the harness's own structure, ids it validated, and links it checked.
 */

export const FACTORY_ACTION_PREFIX = "harness_factory";
export type FactoryButton = "approve" | "decline" | "request_changes" | "more_rounds" | "stop" | "retry" | "abort";
export const FACTORY_BUTTONS: readonly FactoryButton[] = ["approve", "decline", "request_changes", "more_rounds", "stop", "retry", "abort"];

const STAGE_ICON: Record<StageStatus, string> = { not_started: "⬜", in_progress: "🔄", success: "✅", failed: "❌", skipped: "⏭️" };

const HEADER_CHARS = 150;
const PLAIN_CHARS = 280;
const FINDINGS_CHARS = 1500;

/** A Slack user id, as Slack spells one. Anything else is not mentioned. */
const isUserId = (value: string): boolean => /^[UW][A-Z0-9]{2,}$/.test(value);
const mention = (id: string): string => (isUserId(id) ? `<@${id}>` : escapeSlack(id).slice(0, 40));

const clip = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const clipLines = (value: string, max: number): string => {
  const trimmed = value.replace(/\r/g, "").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
};

/** A github.com link only, for a mrkdwn link. Anything else is shown as text, never as a link. */
const runRef = (run: FactoryRunData): string => run.workItem?.key ?? `${run.repo}#${run.issue}`;

function githubLink(url: string, label: string, jiraSite?: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && (parsed.hostname === "github.com" || (!!jiraSite && /^[a-zA-Z0-9-]+\.atlassian\.net$/.test(jiraSite) && parsed.hostname === jiraSite)) && !parsed.username && !parsed.password && !/[<>|\s]/.test(parsed.href)) return `<${parsed.href}|${escapeSlack(label)}>`;
  } catch { /* not a URL */ }
  return escapeSlack(label);
}

/** A verdict word from a report: only the shape of one is trusted, never more. */
const verdictWord = (verdict: string): string => (/^[A-Za-z_]{1,30}$/.test(verdict) ? verdict : "");

const duration = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

const money = (usd: number): string => (usd <= 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** The stage line: `✅ triage → ✅ implement → 🔄 review (round 2) → ⬜ merge → ⬜ deploy`. */
export function stageLine(stages: readonly StageRun[]): string {
  return stages.map((stage) => `${STAGE_ICON[stage.status]} ${escapeSlack(stage.name)}${stage.entries > 1 ? ` (round ${stage.entries})` : ""}`).join(" → ");
}

/** Who may press the buttons, for naming them: the ids that are real ids. */
export function mentionApprovers(approvers: readonly string[] | undefined): string {
  const ids = (approvers ?? []).filter(isUserId).slice(0, 10);
  return ids.length ? ids.map((id) => `<@${id}>`).join(" ") : "someone who may approve";
}

/** Which buttons the status post carries now, and the token each one carries: the run, the kind of wait and when it began. */
export function buttonsFor(run: FactoryRunData): FactoryButton[] {
  // A stage that failed, or was interrupted by a restart: try it again, or stop. Skipping it and going back to an earlier stage are said in words.
  if (run.status === "needs_decision") return run.wait.kind === "failed" || run.wait.kind === "decide" ? ["retry", "abort"] : [];
  if (run.status !== "waiting") return [];
  if (run.wait.kind === "merge") {
    const definition = pinnedWorkflow(run);
    const gate = definition?.stages.find((stage) => stage.kind === "gate" && stage.name === run.current);
    return definition && gate && humanChangesStage(definition, gate) ? ["approve", "request_changes", "decline"] : ["approve", "decline"];
  }
  if (run.wait.kind === "deploy") return ["approve", "decline"];
  if (run.wait.kind === "rounds") return ["more_rounds", "stop"];
  return [];
}

export const buttonValue = (run: FactoryRunData): string => `${run.runId}|${run.wait.kind}|${run.wait.since}`;

export function parseButtonValue(value: string): { runId: string; kind: string; since: number } | undefined {
  const match = /^(fr_[a-f0-9]{4,32})\|([a-z]{3,10})\|(\d{1,16})$/.exec(value);
  return match ? { runId: match[1]!, kind: match[2]!, since: Number(match[3]) } : undefined;
}

const BUTTON_LABEL: Record<FactoryButton, string> = { approve: "Approve", decline: "Decline", request_changes: "Request changes", more_rounds: "One more round", stop: "Stop", retry: "Retry", abort: "Abort" };

/** ` (attempt 2)` once the stage the run is at has been tried more than once. */
function attemptWords(run: FactoryRunData): string {
  const attempts = run.stages.find((stage) => stage.name === run.current)?.attempts.length ?? 0;
  return attempts > 1 ? ` (attempt ${attempts})` : "";
}

/** What the run is doing, in words. The reason is not here: it is untrusted and goes in its own plain-text block. */
function statusWords(run: FactoryRunData): string {
  switch (run.status) {
    case "running": return `:gear: Running (${escapeSlack(run.current || "starting")})`;
    case "waiting":
      return run.wait.kind === "rounds" ? ":hourglass_flowing_sand: Waiting: review is out of rounds"
        : run.wait.kind === "info" ? ":speech_balloon: Waiting for information on the issue"
        : run.wait.kind === "deploy" ? ":hourglass_flowing_sand: Waiting for approval to deploy"
          : ":hourglass_flowing_sand: Waiting for approval to merge";
    case "needs_decision":
      return run.wait.kind === "failed" ? `:warning: Stage failed: *${escapeSlack(run.current)}*${attemptWords(run)}, needs a person`
        : ":warning: Needs a decision: a stage was interrupted";
    case "completed": return ":white_check_mark: Completed";
    case "rejected": return ":no_entry_sign: Rejected";
    case "failed": return ":x: Failed";
    case "aborted": return ":stop_sign: Aborted";
  }
}

export interface StatusContext {
  now: number;
  /** Who may press the buttons. */
  approvers: readonly string[] | undefined;
  /** A direct message: the shape of the run is shown, not what was said (no issue title, summaries or reasons). */
  dm?: boolean;
  /** The autonomy level the run's repository runs at, in one line: how much it may do without a person. */
  autonomy?: string;
}

/** The decision someone made with a button that the task has not yet acted on, shown instead of the buttons. */
function pendingDecision(run: FactoryRunData): string | undefined {
  const decision = run.slack.decision;
  if (decision.kind === "" || (run.status !== "waiting" && run.status !== "needs_decision") || decision.since !== run.wait.since) return undefined;
  const words: Record<string, string> = { approve: "Approved", decline: "Declined", request_changes: "Changes requested", more_rounds: "Another round allowed", stop: "Stopped", retry: "Retrying", abort: "Aborted" };
  return `${words[decision.kind] ?? "Decided"} by ${mention(decision.by)}.`;
}

function gateLine(run: FactoryRunData): string | undefined {
  if (!run.gate.decided) return undefined;
  return run.gate.by === "auto" ? "Merge: automatic, within the risk limit." : `Merge: approved by ${mention(run.gate.by)}.`;
}

function riskText(run: FactoryRunData): string | undefined {
  if (run.risk.model < 0) return undefined;
  const model = run.risk.scored ? `${run.risk.model}` : `${run.risk.model} (not scored)`;
  return run.risk.final >= 0 && run.risk.final !== run.risk.model ? `${model} → ${run.risk.final}` : model;
}

export function statusBlocks(run: FactoryRunData, ctx: StatusContext): { text: string; blocks: KnownBlock[] } {
  const fields: string[] = [`*Status*\n${statusWords(run)}`];
  const risk = riskText(run);
  if (risk) fields.push(`*Risk (1–5)*\n${risk}`);
  if (run.pr.number > 0) fields.push(`*Pull request*\n${githubLink(run.pr.url, `#${run.pr.number}`)}`);
  fields.push(`*${isTerminalRun(run.status) ? "Took" : "Elapsed"}*\n${duration((run.endedAt > 0 ? run.endedAt : ctx.now) - run.startedAt)} · ${money(run.costUsd)}`);

  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: clip(ctx.dm ? runRef(run) : `${runRef(run)} ${run.issueTitle}`, HEADER_CHARS), emoji: false } },
    { type: "section", text: { type: "mrkdwn", text: stageLine(run.stages) } },
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn" as const, text })) },
  ];
  if (!ctx.dm && run.reason && (run.status === "waiting" || isTerminalRun(run.status) || run.status === "needs_decision")) {
    blocks.push({ type: "section", text: { type: "plain_text", text: clip(run.reason, PLAIN_CHARS), emoji: false } });
  }
  const context: string[] = [];
  const decided = pendingDecision(run);
  if (decided) context.push(decided);
  const gate = gateLine(run);
  if (gate) context.push(gate);
  const buttons = decided ? [] : buttonsFor(run);
  if (buttons.length) context.push(`Waiting for ${mentionApprovers(ctx.approvers)}${run.wait.kind === "failed" ? ". Fix the cause first (a token, a label, the role's setup, more detail on the issue), then Retry. To skip an optional stage or go back to an earlier one, say so in this thread" : ""}`);
  if (ctx.autonomy) context.push(`Autonomy: ${escapeSlack(ctx.autonomy)}`);
  context.push(`Run \`${escapeSlack(run.runId)}\` · ${githubLink(run.issueUrl, run.workItem?.key ?? "the issue", run.workItem?.site)} · reply in this thread to ask about it or steer it`);
  blocks.push({ type: "context", elements: context.map((text) => ({ type: "mrkdwn" as const, text })) });
  if (buttons.length) {
    blocks.push({
      type: "actions",
      block_id: `factory_${run.runId}`,
      elements: buttons.map((button) => ({
        type: "button" as const,
        action_id: `${FACTORY_ACTION_PREFIX}_${button}`,
        text: { type: "plain_text" as const, text: BUTTON_LABEL[button], emoji: false },
        value: buttonValue(run),
        ...(button === "approve" || button === "more_rounds" || button === "retry" ? { style: "primary" as const } : button === "request_changes" ? {} : { style: "danger" as const }),
      })),
    });
  }
  return { text: `Workflow run ${run.runId} for ${runRef(run)}: ${run.status.replace("_", " ")}`, blocks };
}

export interface ReplyEvent {
  /** What makes this reply this reply: stable across restarts, so it is said once. */
  key: string;
  text: string;
  blocks: KnownBlock[];
}

const say = (headline: string, body?: string): KnownBlock[] => [
  { type: "section", text: { type: "mrkdwn", text: headline } },
  ...(body ? [{ type: "section", text: { type: "plain_text", text: body, emoji: false } } as KnownBlock] : []),
];

/**
 * The attempts of a stage that count as its finishing: the last one of each entry, since an earlier one was asked again. A FAILED
 * attempt is not one: a stage that failed is told once, by the reply about the run needing a decision (or by the run's ending), which
 * carries the reason, and a retry that comes later must not make the old failure be told again.
 */
function finishedAttempts(stage: StageRun): { attempt: Attempt; index: number }[] {
  return stage.attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt, index }) =>
      attempt.status === "done" && !stage.attempts.slice(index + 1).some((later) => later.entry === attempt.entry));
}

const isGithubLogin = (value: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);

/** The moments worth a reply in the run's thread, oldest first. Tool calls and progress are not among them. */
export function replyEvents(run: FactoryRunData, ctx: { approvers: readonly string[] | undefined; dm?: boolean }): ReplyEvent[] {
  const quiet = ctx.dm === true;
  const events: (ReplyEvent & { at: number })[] = [];
  const loopTarget = (stageName: string): string => {
    const index = run.stages.findIndex((stage) => stage.name === stageName);
    return index > 0 ? run.stages[index - 1]!.name : "the previous stage";
  };
  for (const stage of run.stages) {
    for (const { attempt, index } of finishedAttempts(stage)) {
      const verdict = verdictWord(attempt.verdict);
      const conflicted = stage.name === "merge" && verdict.toUpperCase() === "CONFLICTS";
      const humanChanges = stage.name === "merge" && verdict.toUpperCase() === "CHANGES_REQUESTED";
      const looped = conflicted || humanChanges || (stage.name === "review" && verdict.toUpperCase() === "CHANGES_REQUESTED");
      const words = `${STAGE_ICON.success} *${escapeSlack(stage.name)}* finished`;
      const headline = conflicted
        ? ":repeat: *merge* found conflicts: return to *implement* for resolution (subject to round limits)"
        : humanChanges
        ? ":repeat: A human reviewer requested changes: return to *implement* (subject to round limits), then fresh independent review"
        : looped
        ? `:repeat: *review* asked for changes: back to *${escapeSlack(loopTarget(stage.name))}* (round ${stage.entries + 1})`
        : `${words}${verdict ? ` — \`${verdict}\`` : ""}`;
      const body = quiet ? "" : looped ? clipLines(attempt.report || attempt.summary, FINDINGS_CHARS) : clip(attempt.summary, PLAIN_CHARS);
      events.push({ key: `a:${stage.name}:${index}:${attempt.entry}`, at: attempt.endedAt, text: `Workflow run ${run.runId}: ${stage.name} finished`, blocks: say(headline, body || undefined) });
    }
  }
  events.sort((a, b) => a.at - b.at);
  const result: ReplyEvent[] = events.map(({ at: _at, ...event }) => event);

  // What trusted people added to the issue since the run began. Only they are told here: an update from anyone else is in the console.
  for (const update of run.updates) {
    if (!update.trusted || update.kind === "slack" || update.kind === "console" || isTerminalRun(run.status)) continue; // an answer given in the thread needs no echo there
    result.push({
      key: `u:${update.at}:${update.kind}:${update.author}`,
      text: `Workflow run ${run.runId}: the issue was updated`,
      blocks: say(`:speech_balloon: New on the issue: *${escapeSlack(update.kind)}*${update.author && isGithubLogin(update.author) ? ` by ${escapeSlack(update.author)}` : ""}`, quiet ? undefined : clip(update.excerpt, PLAIN_CHARS)),
    });
  }

  if (run.status === "waiting" && run.wait.kind !== "") {
    const who = mentionApprovers(ctx.approvers);
    const what = run.wait.kind === "rounds" ? "Review is out of rounds. Allow one more, or stop the run."
      : run.wait.kind === "info" ? "Triage needs more information. Reply in this thread with the answer (I will put it on the issue), or comment on the issue yourself. Answered already and nothing happened? Ask me to recheck the issue."
      : run.wait.kind === "deploy" ? "Ready to deploy; it needs an approval." : "Ready to merge; it needs an approval, for the reason below. Approve it here, or merge the pull request on GitHub yourself and the run carries on.";
    result.push({
      key: `w:${run.wait.kind}:${run.wait.since}`,
      text: `Workflow run ${run.runId} is waiting`,
      blocks: say(`:hourglass_flowing_sand: ${what} ${who}`, !quiet && run.reason ? clip(run.reason, PLAIN_CHARS) : undefined),
    });
  }
  if (run.status === "needs_decision" && run.wait.kind === "failed") {
    const earlier = run.stages.slice(0, Math.max(0, run.stages.findIndex((stage) => stage.name === run.current))).map((stage) => stage.name);
    const optional = run.current === "deploy";
    const choices = ["*retry* it", ...(optional ? ["*skip* it"] : []), ...(earlier.length ? [`*restart from* ${earlier.map((name) => `\`${escapeSlack(name)}\``).join(", ")}`] : []), "or *abort* the run"];
    result.push({
      key: `d:${run.wait.since}`,
      text: `Workflow run ${run.runId}: ${run.current} failed`,
      blocks: say(`${STAGE_ICON.failed} *${escapeSlack(run.current)}* failed${attemptWords(run)}, and the run is waiting, not over. Fix the cause (a token, a label, the role's setup, more detail on the issue), then ${mentionApprovers(ctx.approvers)} can press Retry, or say in this thread: ${choices.join(", ")}.`, !quiet && run.reason ? clip(run.reason, PLAIN_CHARS) : undefined),
    });
  } else if (run.status === "needs_decision") {
    result.push({
      key: `d:${run.wait.since}`,
      text: `Workflow run ${run.runId} needs a decision`,
      blocks: say(`:warning: *${escapeSlack(run.current)}* was interrupted and may or may not have taken effect. Someone who may decide (${mentionApprovers(ctx.approvers)}) should look at the issue and the pull request, then press Retry or Abort, or say skip, in this thread.`, !quiet && run.reason ? clip(run.reason, PLAIN_CHARS) : undefined),
    });
  }
  if (isTerminalRun(run.status)) {
    const where = run.pr.number > 0 ? ` ${githubLink(run.pr.url, `Pull request #${run.pr.number}`)}${run.pr.mergeCommit ? " was merged." : "."}` : "";
    const headline: Record<string, string> = {
      completed: `:white_check_mark: Done: *${escapeSlack(runRef(run))}* is finished.${where}`,
      rejected: `:no_entry_sign: Rejected: the workflow decided not to proceed with *${escapeSlack(runRef(run))}*.${where}`,
      failed: `:x: Failed: *${escapeSlack(runRef(run))}* did not complete.${where}`,
      aborted: `:stop_sign: Aborted.${where}`,
    };
    result.push({
      key: `e:${run.status}`,
      text: `Workflow run ${run.runId} ${run.status}`,
      blocks: say(headline[run.status] ?? `Run ${run.status}`, !quiet && run.reason ? clip(run.reason, PLAIN_CHARS) : undefined),
    });
  }
  return result;
}

// ── The rolling intake note ─────────────────────────────────────────────────────────────────────────────

const NOTE_LABEL: Record<string, string> = {
  started: "started", rejected: "rejected at triage", needs_info: "waiting for information", failed: "failed", aborted: "aborted", stale: "stale",
  held: "held", queued: "queued", closed: "closed", breaker: "breaker", released: "released",
};

/** The day's top-level intake post: a heading and running counts. The harness's own words only. */
export function intakeNoteBlocks(day: string, counts: Record<string, number>): { text: string; blocks: KnownBlock[] } {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${NOTE_LABEL[kind] ?? kind}`);
  const summary = parts.length ? parts.join(" · ") : "nothing yet";
  return {
    text: `Factory intake ${day}: ${summary}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `Factory intake · ${day}`, emoji: false } },
      { type: "section", text: { type: "mrkdwn", text: `Issues the harness found today: ${summary}. Each is a line in this thread.` } },
    ],
  };
}

export type IntakeLine = { key: string; kind: string; text: string; blocks: KnownBlock[] };

/** One thing the poll did, as a line in the intake thread. Titles are untrusted and only ever go in plain text. */
export function intakeNoteLine(note: IntakeNote, options: { dm?: boolean } = {}): IntakeLine {
  const ref = note.workItem ? githubLink(note.workItem.url, note.workItem.key, note.workItem.site) : note.issue ? `${escapeSlack(note.repo)}#${note.issue}` : escapeSlack(note.repo);
  const title = options.dm || !note.title ? undefined : clip(note.title, PLAIN_CHARS);
  const label = note.detail && /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,49}$/.test(note.detail) ? note.detail : "the go label";
  const headline: Record<IntakeNote["kind"], string> = {
    held: note.workItem ? `:lock: *${ref}* was not started: ${escapeSlack(clip(note.detail ?? "an approver must release it", 200))}. Labels do not grant trust or override routing; ask an approver to release it after resolving the hold.` : `:lock: *${ref}* was not started: its author is not an owner, member or collaborator. A person can add the label \`${escapeSlack(label)}\` to it, or ask me to release it.`,
    queued: `:hourglass_flowing_sand: *${ref}* is queued: it starts when a run finishes and frees a slot.`,
    closed: `:wastebasket: *${ref}* was closed on ${note.workItem ? "Jira" : "GitHub"}; ${escapeSlack(clip(note.detail ?? "its run was stopped", 80))}.`,
    released: `:unlock: *${ref}* was released and is queued.`,
    breaker: `:rotating_light: Too many new issues at once: ${escapeSlack(clip(note.detail ?? "the newest were held", 200))}. They wait for the go label or a release.`,
  };
  return { key: note.key, kind: note.kind, text: `Factory intake: ${note.kind} ${note.workItem?.key ?? `${note.repo}${note.issue ? `#${note.issue}` : ""}`}`, blocks: say(headline[note.kind], title) };
}

/** A run that stopped at triage, as a line in the intake thread (it never gets a status post of its own). */
export function intakeRunLine(run: FactoryRunData, options: { dm?: boolean } = {}): IntakeLine | undefined {
  const ref = escapeSlack(runRef(run));
  const body = options.dm ? undefined : clip(`${run.issueTitle}${run.reason ? ` — ${run.reason}` : ""}`, PLAIN_CHARS);
  if (run.status === "waiting" && run.wait.kind === "info") {
    return { key: `run:${run.runId}:info:${run.wait.since}`, kind: "needs_info", text: `Factory intake: ${runRef(run)} needs information`, blocks: say(`:speech_balloon: *${ref}* needs information from its author: triage asked on the issue. A comment from someone who may add to it carries it on.`, body) };
  }
  if (run.status === "rejected") {
    const stale = run.reason.startsWith("stale");
    return { key: `run:${run.runId}:${run.status}`, kind: stale ? "stale" : "rejected", text: `Factory intake: ${runRef(run)} ${stale ? "went stale" : "rejected"}`, blocks: say(`:no_entry_sign: *${ref}* ${stale ? "went stale waiting for an answer" : "was rejected at triage"}.`, body) };
  }
  if (run.status === "failed" || run.status === "aborted") {
    return { key: `run:${run.runId}:${run.status}`, kind: run.status, text: `Factory intake: ${runRef(run)} ${run.status}`, blocks: say(`${run.status === "failed" ? ":x:" : ":stop_sign:"} *${ref}* ${run.status === "failed" ? "failed in triage" : "was stopped"}.`, body) };
  }
  return undefined;
}
