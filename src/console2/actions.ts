import type { IncomingMessage, ServerResponse } from "node:http";
import { MERGE_COOKIE, mergeBrowser } from "./merge-verification.ts";
import { z } from "zod";
import { controlTaskWorkflow, TaskWorkflowControlError } from "../tasks/workflow-controls.ts";
import { FactoryRunError } from "../factory/workflow/service.ts";
import { logger } from "../util/log.ts";
import { findChannel } from "./data.ts";
import type { ActionResponse, WorkflowActionName } from "./api-types.ts";
import { isDirect, type Console2Source } from "./source.ts";

/**
 * What the web console may do to a software factory run, when the operator turned `webConsole.actions` on. There is no login:
 * whoever can reach the console can do these, so everything here is about keeping a stray request out and keeping the sharp
 * things (direct merge, deploy consent, more rounds, filing issues) out of reach. Merge approval needs verified Slack identity.
 *
 * A request has to get past, in order: the feature switch, `application/json`, a custom header a cross-site form cannot send, an
 * Origin (and Fetch Metadata) that is this server's own, a rate limit, a small body, and a schema that refuses unknown keys. The
 * Host header was already checked by the server (DNS rebinding). The browser never gets a CORS answer, so a page on another origin
 * cannot send the header at all.
 */

export const ACTION_HEADER = "x-console-action";
export const MAX_BODY_BYTES = 16 * 1024;
export const ANSWER_MAX_CHARS = 4000;
export const NOTES_MAX_CHARS = 1000;

const NONE = z.object({}).strict();
const STAGE = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const RUN_ACTIONS = {
  verify_approver: NONE,
  approve: NONE,
  decline: NONE,
  retry: NONE,
  skip: NONE,
  restart_from: z.object({ stage: STAGE }).strict(),
  abort: NONE,
  recheck: NONE,
  answer: z.object({ text: z.string().min(1).max(ANSWER_MAX_CHARS) }).strict(),
} satisfies Record<WorkflowActionName, z.ZodType>;
const TASK_BODY = z.object({ revision: z.number().int().nonnegative() }).strict();
export const TASK_ACTIONS = { stop: TASK_BODY, bump: TASK_BODY };
export type TaskActionName = keyof typeof TASK_ACTIONS;
export const isTaskAction = (name: string): name is TaskActionName => Object.hasOwn(TASK_ACTIONS, name);
export const CHANNEL_ACTIONS = {
  start: z.object({ issue: z.string().min(1).max(200), notes: z.string().max(NOTES_MAX_CHARS).optional() }).strict(),
  poll: NONE,
} satisfies Record<string, z.ZodType>;

export type RunActionName = keyof typeof RUN_ACTIONS;
export type ChannelActionName = keyof typeof CHANNEL_ACTIONS;
export const isRunAction = (name: string): name is RunActionName => Object.hasOwn(RUN_ACTIONS, name);
export const isChannelAction = (name: string): name is ChannelActionName => Object.hasOwn(CHANNEL_ACTIONS, name);

export type ActionTarget = { channelId: string; action: RunActionName | TaskActionName; runId: string } | { channelId: string; action: ChannelActionName; runId?: undefined };

/** A sliding window per caller and overall, so a script or a stuck button cannot hammer GitHub through the harness. */
export class ActionLimiter {
  private readonly perRemote = new Map<string, number[]>();
  private all: number[] = [];
  private readonly options: { perRemote: number; global: number; windowMs: number };
  private readonly now: () => number;
  constructor(options: { perRemote: number; global: number; windowMs: number } = { perRemote: 20, global: 60, windowMs: 60_000 }, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
  }

  /** `undefined` when allowed, else how many seconds to wait. */
  take(remote: string): number | undefined {
    const now = this.now();
    const since = now - this.options.windowMs;
    this.all = this.all.filter((at) => at > since);
    const mine = (this.perRemote.get(remote) ?? []).filter((at) => at > since);
    const blocked = mine.length >= this.options.perRemote ? mine[0]! : this.all.length >= this.options.global ? this.all[0]! : undefined;
    if (blocked !== undefined) { this.perRemote.set(remote, mine); return Math.max(1, Math.ceil((blocked + this.options.windowMs - now) / 1000)); }
    mine.push(now); this.all.push(now);
    this.perRemote.set(remote, mine);
    if (this.perRemote.size > 500) for (const [key, times] of this.perRemote) if (times.every((at) => at <= since)) this.perRemote.delete(key);
    return undefined;
  }
}

export interface ActionContext {
  source: Console2Source;
  /** Whether a browser `Origin` header names a host this server answers to. */
  originAllowed: (origin: string) => boolean;
  limiter: ActionLimiter;
  /** Actions in flight, so a double click runs once. Shared by the server. */
  inflight: Set<string>;
}

function reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string | "too_large"> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) return "too_large";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Where the request came from, for the record: the connection, and what a proxy said about it (which can be made up, so it is only noted). */
export function remoteOf(req: IncomingMessage): string {
  const direct = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45);
  return first ? `${direct} (forwarded for ${first})` : direct;
}

/** Is this a request the browser's own page made, as far as the headers can tell? The custom header and `application/json` already stop a simple cross-site form. */
export function sameSite(req: IncomingMessage, originAllowed: (origin: string) => boolean): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin === "string" && !originAllowed(origin)) return "Origin not allowed";
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return "Cross-site request refused";
  return undefined;
}

/** A refusal the person is told plainly; in a direct message channel only the fixed sentence, because a refusal can quote the issue. */
const GENERIC_REFUSAL = "That could not be done now: the run is not in a state that allows it, or a limit applies.";

export async function handleConsoleAction(target: ActionTarget, req: IncomingMessage, res: ServerResponse, ctx: ActionContext): Promise<void> {
  const { source } = ctx;
  if (!source.actions || source.actionsEnabled !== true) return reply(res, 403, { error: "Console actions are turned off. The operator turns them on with webConsole.actions." });
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") return reply(res, 415, { error: "Send application/json." });
  if (req.headers[ACTION_HEADER] !== "1") return reply(res, 403, { error: `Missing the ${ACTION_HEADER} header.` });
  const crossSite = sameSite(req, ctx.originAllowed);
  if (crossSite) return reply(res, 403, { error: crossSite });
  const remote = remoteOf(req);
  const key = req.socket.remoteAddress ?? "unknown";
  const wait = ctx.limiter.take(key);
  if (wait !== undefined) return reply(res, 429, { error: "Too many actions; wait a moment." }, { "retry-after": String(wait) });

  // Early exit from the body iterator can detach req.socket before the response finishes.
  const socket = req.socket;
  const text = await readBody(req);
  if (text === "too_large") {
    // Answer first, then drop the connection: the rest of a body this size is never read.
    res.once("finish", () => { if (!socket.destroyed) socket.destroySoon(); });
    return reply(res, 413, { error: "That request is too large." }, { connection: "close" });
  }
  let parsed: unknown;
  try { parsed = text.trim() === "" ? {} : JSON.parse(text); } catch { return reply(res, 400, { error: "That is not valid JSON." }); }
  const taskAction = target.runId?.startsWith("workflow_") === true;
  const schema = taskAction ? TASK_ACTIONS[target.action as TaskActionName] : target.runId !== undefined ? RUN_ACTIONS[target.action as RunActionName] : CHANNEL_ACTIONS[target.action as ChannelActionName];
  if (!schema) return reply(res, 400, { error: "That action does not apply to this workflow kind." });
  const checked = (schema as z.ZodType).safeParse(parsed);
  if (!checked.success) return reply(res, 400, { error: `Not understood: ${checked.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; ").slice(0, 200)}` });
  const body = checked.data as Record<string, string | undefined>;

  const channel = findChannel(source, target.channelId);
  if (!channel) return reply(res, 404, { error: "That channel is not known to this harness." });
  const direct = isDirect(channel);
  const identity = target.runId && (target.action === "approve" || target.action === "decline")
    ? (await source.actions.mergeApprovals?.status(mergeBrowser(req), channel.id, target.runId))?.identity : undefined;
  if ((target.action === "approve" || target.action === "decline") && !identity) return reply(res, 403, { error: "Verify this browser with a Slack approver for this run before approving or declining its merge." });
  const service = taskAction ? undefined : source.actions.service(channel.id, remote, identity);
  if (!taskAction && !service) return reply(res, 404, { error: "This channel is not a software factory." });

  const lock = `${channel.id}:${target.runId ?? "channel"}:${target.action}`;
  if (ctx.inflight.has(lock)) return reply(res, 409, { error: "That is already being done." });
  ctx.inflight.add(lock);
  const audit = (outcome: "ok" | "refused" | "error", fields: Record<string, unknown> = {}) =>
    source.actions?.audit(channel.id, "console_action", { actor: "console", remote, action: target.action, ...(target.runId ? { runId: target.runId } : {}), outcome, ...fields });
  try {
    let message: string;
    let runId = target.runId;
    if (taskAction) {
      const runtime = source.runtime(channel.id);
      if (!runtime) return reply(res, 409, { error: "The channel store is not open." });
      if (target.action === "bump" && !source.actions.inspectTaskWorkflow) return reply(res, 409, { error: "Task inspection is unavailable; use the owning conversation in Slack." });
      message = await controlTaskWorkflow({ store: runtime.store, channelId: channel.id, workflowId: target.runId!,
        revision: (checked.data as { revision: number }).revision, action: target.action as TaskActionName,
        inspect: (workflow) => source.actions!.inspectTaskWorkflow!(channel.id, workflow) });
    } else switch (target.action) {
      case "verify_approver": {
        if (!source.actions.mergeApprovals) return reply(res, 409, { error: "Console merge verification is unavailable. Use the run's Slack approval buttons." });
        const verified = await source.actions.mergeApprovals.request(channel.id, target.runId!);
        const prefix = new URL(source.baseUrl ?? "http://localhost").pathname.replace(/\/$/, "");
        const secure = source.baseUrl?.startsWith("https:") ? "; Secure" : "";
        res.setHeader("set-cookie", `${MERGE_COOKIE}=${verified.browser}; Path=${prefix}/console2/api/v1/; HttpOnly; SameSite=Strict; Max-Age=600${secure}`);
        message = "Verification requested. Confirm only your matching browser challenge in Slack, then return here to approve or decline.";
        break;
      }
      case "approve": await service!.approve(target.runId!); message = "Merge authorized for the reviewed commit. The merge gate will re-check it before merging."; break;
      case "decline": await service!.decline(target.runId!); message = "Merge declined."; break;
      case "retry": await service!.decide(target.runId!, "retry"); message = "Retrying."; break;
      case "skip": await service!.decide(target.runId!, "skip"); message = "Skipped."; break;
      case "restart_from": await service!.decide(target.runId!, "restart_from", body.stage); message = `Going back to ${body.stage}.`; break;
      case "abort": await service!.abort(target.runId!); message = "Aborted."; break;
      case "recheck": await service!.recheckIssue(target.runId!); message = "Reading the issue again."; break;
      case "answer": await service!.answer(target.runId!, body.text!); message = "Answer recorded on the issue. The run carries on."; break;
      case "start": {
        const started = await service!.start(body.issue!, body.notes);
        runId = started.runId;
        message = "Run started.";
        break;
      }
      case "stop": case "bump": throw new TaskWorkflowControlError("That action only applies to a task workflow.");
      case "poll":
        if (!source.actions.pollNow(channel.id)) return reply(res, 409, { error: "Issue intake is not on for this channel." });
        message = "Polling now.";
        break;
    }
    audit("ok", runId && !target.runId ? { runId } : {});
    const result: ActionResponse = { ok: true, message, ...(runId ? { runId } : {}) };
    return reply(res, 200, result);
  } catch (error) {
    if (error instanceof FactoryRunError || error instanceof TaskWorkflowControlError) {
      audit("refused", direct ? {} : { reason: error.message.slice(0, 300) });
      const missing = /^(There is no workflow run |No task workflow in this channel)/.test(error.message);
      return reply(res, missing ? 404 : 409, { error: direct ? GENERIC_REFUSAL : error.message });
    }
    logger.warn(`console action ${target.action}: ${error instanceof Error ? error.message : String(error)}`);
    audit("error");
    return reply(res, 500, { error: "That failed. See the harness log." });
  } finally {
    ctx.inflight.delete(lock);
  }
}
