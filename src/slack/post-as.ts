import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { SlackUserTokenStore } from "../agent/slack-user-tokens.ts";
import { checkDraft, type RateLimiter } from "../agent/post-as-guard.ts";
import type { ReviewInput, Verdict } from "../agent/post-as-reviewer.ts";
import type { PostAsOutcome, UserPoster } from "../agent/post-as-tools.ts";
import type { ResolvedPostAs } from "../workspace/resolve.ts";
import { buildHeldAlertBlocks, buildReceiptBlocks, line, type HeldPost, type PendingHeldPosts } from "./held-posts.ts";
import { toMrkdwn } from "./format.ts";
import { logger } from "../util/log.ts";

/**
 * Posting to Slack as a real person.
 *
 * INVARIANT: no message is ever sent with a user token without the footer.
 * `sendAsUser` below is the only place in the codebase that posts with a user
 * token. It is not exported, it builds the message (body plus footer) itself
 * from the raw body and the user id, and nothing can hand it a finished
 * message. If the footer cannot be built, it throws before calling Slack.
 * A test fails if anything else posts with a user token.
 *
 * Everything else here decides whether `sendAsUser` runs: the token check, the
 * rate cap, the destination, the deterministic checks, the reviewer, and the
 * receipt (posted first, so nothing is sent that the source channel cannot see).
 */

const USER_ID = /^[UW][A-Z0-9]{2,}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Slack's limit for one section block's text. */
const SECTION_CHARS = 3000;
const EXCERPT_CHARS = 140;

/**
 * "Sent by <the app> on behalf of <the person>". The app is named by its Slack user id so it shows as the app's own
 * name. If that id is not known yet (the app learns it at start), the footer still goes out and says "Claude": the
 * footer is never skipped, and it never names anything the model wrote.
 */
function footerText(userId: string, botUserId?: string): string {
  if (!USER_ID.test(userId)) throw new Error("Cannot build the post footer: the configured user is not a valid Slack user id. Nothing was sent.");
  const sender = botUserId && USER_ID.test(botUserId) ? `<@${botUserId}>` : "Claude";
  return `Sent by ${sender} on behalf of <@${userId}>`;
}

/** One footer line exactly as `footerText` builds it: the app (or "Claude") as sender, then the person. */
const FOOTER_LINE = /^Sent by (?:<@[UW][A-Z0-9]{2,}>|Claude) on behalf of <@[UW][A-Z0-9]{2,}>$/;

/**
 * True for a message this harness itself posted as a person. Those are authored by the person (that is the point of
 * `post_as_user`), so to the Slack listeners they look like the person typing. They must never be treated as the
 * person's instruction: an injected agent could otherwise post as them into a channel that has its own agent, and
 * that agent would obey. Recognised by the footer, which only `sendAsUser` adds and which is always the last line,
 * so there is no race with Slack's event arriving before we know the message timestamp.
 */
export function carriesPostAsFooter(event: { text?: unknown; blocks?: unknown }): boolean {
  if (typeof event.text === "string") {
    const lastLine = event.text.trimEnd().split("\n").at(-1) ?? "";
    if (FOOTER_LINE.test(lastLine.trim())) return true;
  }
  if (Array.isArray(event.blocks)) {
    const last = event.blocks.at(-1) as { type?: unknown; elements?: { text?: unknown }[] } | undefined;
    const text = last?.type === "context" ? last.elements?.at(-1)?.text : undefined;
    if (typeof text === "string" && FOOTER_LINE.test(text.trim())) return true;
  }
  return false;
}

/** The message as the person sees it: the body, then the footer. The body is only ever body; the footer is built from two Slack user ids and a constant. */
export function userPostPayload(text: string, userId: string, botUserId?: string): { text: string; blocks: KnownBlock[] } {
  const footer = footerText(userId, botUserId);
  const body = toMrkdwn(text);
  // Whitespace and characters that render as nothing (zero-width spaces, joiners, soft hyphens) do not make a message.
  if (!body.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "")) throw new Error("The message is empty. Nothing was sent.");
  const pieces: string[] = [];
  let piece = "";
  for (const ch of body) {
    if (piece.length + ch.length > SECTION_CHARS) {
      pieces.push(piece);
      piece = "";
    }
    piece += ch;
  }
  pieces.push(piece);
  return {
    text: `${body}\n${footer}`,
    blocks: [
      ...pieces.map((p): KnownBlock => ({ type: "section", text: { type: "mrkdwn", text: p } })),
      { type: "context", elements: [{ type: "mrkdwn", text: footer }] },
    ],
  };
}

/** The single send chokepoint. Private on purpose: see the invariant at the top of this file. */
async function sendAsUser(userWeb: WebClient, channelId: string, text: string, userId: string, botUserId: string | undefined, threadTs?: string): Promise<string> {
  const payload = userPostPayload(text, userId, botUserId); // throws before any Slack call if the footer cannot be built
  const res = await userWeb.chat.postMessage({
    channel: channelId,
    text: payload.text,
    blocks: payload.blocks,
    // Belt and braces: plain "@channel" or "#name" in the text is never turned into a live mention or link by Slack.
    link_names: false,
    parse: "none",
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return res.ts as string;
}

/**
 * The production client for a person's token. Never retries: a post whose response was lost would be sent again,
 * and a second copy would go out as the person.
 */
export function createUserClient(token: string): WebClient {
  return new WebClient(token, { retryConfig: { retries: 0 } });
}

// ---------- Slack errors ----------

const AUTH_CODES = new Set(["not_authed", "invalid_auth", "token_revoked", "token_expired", "account_inactive"]);

/** A plain description of a known user-token problem, or undefined. Never includes the token. */
function tokenProblem(err: unknown, userId: string, scope: string): string | undefined {
  const data = (err as { data?: { error?: string; needed?: string } })?.data;
  const code = data?.error;
  if (code === "missing_scope") {
    const needed = data?.needed || scope;
    return `The Slack user token for <@${userId}> is missing the \`${needed}\` scope; re-issue it with that scope.`;
  }
  if (code && AUTH_CODES.has(code)) return `The Slack user token for <@${userId}> is not valid; re-authenticate it.`;
  return undefined;
}

const scrub = (s: string): string => s.replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "[token]");

function mapSlackError(err: unknown, userId: string, scope: string): Error {
  const known = tokenProblem(err, userId, scope);
  if (known) return new Error(known);
  const code = (err as { data?: { error?: string } })?.data?.error;
  if (code) return new Error(`Slack refused the request (${scrub(code)}).`);
  return new Error(`Slack request failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
}

const errMessage = (err: unknown): string => scrub(err instanceof Error ? err.message : String(err));

// ---------- destinations ----------

interface Destination {
  id: string;
  label: string;
  isDm: boolean;
}

function checkTarget(target: string): string {
  if (CONTROL.test(target)) throw new Error("The target contains a line break or control character. Give a single channel name, channel id or user id.");
  const t = target.trim();
  if (!t) throw new Error("The target is empty. Give a channel name, channel id or user id.");
  return t;
}

/** Target to channel id, through the user's own token. An unknown target is a refusal. */
async function resolveTarget(userWeb: WebClient, target: string, userId: string): Promise<string> {
  if (USER_ID.test(target)) {
    let opened: { channel?: { id?: string } };
    try {
      opened = await userWeb.conversations.open({ users: target });
    } catch (err) {
      throw mapSlackError(err, userId, "im:write");
    }
    const id = opened.channel?.id;
    if (!id) throw new Error(`I could not open a direct message with ${target}.`);
    return id;
  }
  if (CHANNEL_ID.test(target)) return target;

  const bare = target.replace(/^#/, "");
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    let res: Awaited<ReturnType<WebClient["conversations"]["list"]>>;
    try {
      res = await userWeb.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
    } catch (err) {
      throw mapSlackError(err, userId, "channels:read");
    }
    const match = (res.channels ?? []).find((c) => c.name === bare && c.id);
    if (match?.id) return match.id;
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  throw new Error(`I could not find Slack channel ${target} that <@${userId}> can see. Use its channel id, or a user id for a DM.`);
}

interface ChannelInfo {
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_ext_shared?: boolean;
  num_members?: number;
  user?: string;
}
interface UserInfo {
  name?: string;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string };
  team_id?: string;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
}

async function userInfo(userWeb: WebClient, user: string): Promise<UserInfo> {
  const res = await userWeb.users.info({ user });
  const u = res.user as UserInfo | undefined;
  if (!u) throw new Error("no user");
  return u;
}

/** A readable description for the reviewer, and a short label for receipts. Throws when the destination cannot be described. */
async function describe(userWeb: WebClient, id: string, posterId: string): Promise<{ label: string; description: string; isDm: boolean }> {
  const res = await userWeb.conversations.info({ channel: id, include_num_members: true });
  const ch = res.channel as ChannelInfo | undefined;
  if (!ch) throw new Error("no channel");

  if (ch.is_im) {
    if (!ch.user) throw new Error("no DM peer");
    const peer = await userInfo(userWeb, ch.user);
    const name = peer.real_name || peer.profile?.real_name || peer.profile?.display_name || peer.name || ch.user;
    const tags: string[] = [];
    if (peer.is_restricted || peer.is_ultra_restricted) tags.push("guest");
    let external = peer.is_stranger === true;
    if (!external && peer.team_id) {
      const poster = await userInfo(userWeb, posterId);
      external = !!poster.team_id && poster.team_id !== peer.team_id;
    }
    if (external) tags.push("external");
    const label = `DM with ${name}${tags.length ? ` (${tags.join(", ")})` : ""}`;
    return { label, description: label, isDm: true };
  }

  if (ch.is_mpim) {
    const parts = ["group DM"];
    if (typeof ch.num_members === "number") parts.push(`${ch.num_members} members`);
    if (ch.is_ext_shared) parts.push("Slack Connect (includes another organisation)");
    return { label: "group DM", description: parts.join(", "), isDm: true };
  }

  const label = ch.name ? `#${ch.name}` : id;
  const parts = [label, ch.is_private ? "private" : "public"];
  if (typeof ch.num_members === "number") parts.push(`${ch.num_members} members`);
  if (ch.is_ext_shared) parts.push("Slack Connect (shared with another organisation)");
  return { label, description: parts.join(", "), isDm: false };
}

// ---------- the service ----------

export interface PostAsServiceDeps {
  /** Source-channel receipts and alerts only. Never used to post as the person. */
  botClient: WebClient;
  /** Injectable for tests. */
  userClient: (token: string) => WebClient;
  tokens: (channelId: string) => SlackUserTokenStore;
  /** The Slack app's own user id, named in the footer. Read when a post is sent, because the app learns it after it starts. */
  botUserId?: () => string | undefined;
  /** `sourceChannelId` is the channel the post came from, for accounting the reviewer's usage. */
  review: (input: ReviewInput, postAs: ResolvedPostAs, sourceChannelId: string) => Promise<Verdict>;
  held: PendingHeldPosts;
  limiter: RateLimiter;
  now?: () => number;
  onHeld?: (e: { channelId: string; id: string; ts: string; expiresAt: number }) => void;
  onHeldConsumed?: (channelId: string, id: string) => void;
  onEvent?: (e: { channelId: string; status: "sent" | "held" | "unblocked" | "dismissed"; title: string; detail: string; userId: string }) => void;
}

/** Facts about a held post the store does not keep, needed when it is unblocked. Pruned with the item. */
interface HeldMeta {
  maxPerHour: number;
  capHold: boolean;
  sourceVerified: boolean;
  isDm: boolean;
  /** The raw target, when the hold happened before the destination was resolved (a rate-cap hold). */
  unresolvedTarget?: string;
}

type PostInput = Parameters<UserPoster["postAsUser"]>[0];

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
};

export class PostAsService implements UserPoster {
  private readonly deps: PostAsServiceDeps;
  private readonly meta = new Map<string, HeldMeta>();

  constructor(deps: PostAsServiceDeps) {
    this.deps = deps;
  }

  async postAsUser(input: PostInput): Promise<PostAsOutcome> {
    const userId = input.postAs.user;
    const target = checkTarget(input.target);
    // Refuse up front, before any lookup, receipt or rate-limit slot, if the message could never be built: no valid
    // footer, or a body that is empty or invisible.
    userPostPayload(input.text, userId, this.deps.botUserId?.());

    // 1. No token is a refusal. There is no fallback to the bot token.
    const token = this.deps.tokens(input.sourceChannelId).tokenFor(userId);
    if (!token) {
      throw new Error(`There is no Slack user token stored for <@${userId}>, so nothing can be posted as them. Store one first.`);
    }

    // 2. Rate cap, before any reviewer call or destination lookup. The deterministic checks are pure, so they still run and
    // the alert shows what they found; the reviewer does not. An id is kept as given, so unblock sends where the alert said;
    // only a bare name is looked up at unblock.
    if (!this.deps.limiter.take(input.sourceChannelId, input.postAs.maxPerHour)) {
      const check = checkDraft(input.text, { privateLinkHosts: input.postAs.privateLinkHosts });
      const isId = USER_ID.test(target) || CHANNEL_ID.test(target);
      return this.hold(
        input,
        // Not described, so treated as private: the timeline gets no draft words (a group DM or a bare name could be one).
        { id: isId ? target : "", label: target, isDm: true },
        `this channel is over its limit of ${input.postAs.maxPerHour} posts an hour` + (check.hold ? `; it also ${check.reason}` : ""),
        { kind: "rate-cap", capHold: true, ...(isId ? {} : { unresolvedTarget: target }) },
      );
    }

    const userWeb = this.deps.userClient(token);

    // 3. Resolve (unknown is a refusal), then describe (failure is a hold).
    const id = await resolveTarget(userWeb, target, userId);
    let dest: Destination;
    let description: string;
    try {
      const d = await describe(userWeb, id, userId);
      dest = { id, label: d.label, isDm: d.isDm };
      description = d.description;
    } catch (err) {
      const why = tokenProblem(err, userId, id.startsWith("D") ? "im:read" : "channels:read");
      return this.hold(
        input,
        { id, label: target, isDm: true }, // not described, so treated as private
        `could not describe the destination${why ? ` (${why})` : ""}`,
        { kind: "describe" },
      );
    }

    // 4. Deterministic checks, then the reviewer.
    const check = checkDraft(input.text, { privateLinkHosts: input.postAs.privateLinkHosts });
    if (check.hold) return this.hold(input, dest, check.reason, { kind: "check" });

    let verdict: Verdict;
    try {
      verdict = await this.deps.review(
        {
          draft: input.text,
          destination: description,
          source: input.source,
          reason: input.reason,
          sourceVerified: input.sourceVerified,
          ...(input.channelDescription ? { channelDescription: input.channelDescription } : {}),
          ...(input.postAs.rules ? { rules: input.postAs.rules } : {}),
        },
        input.postAs,
        input.sourceChannelId,
      );
    } catch {
      return this.hold(input, dest, "reviewer unavailable", { kind: "reviewer-error" });
    }
    if (verdict.verdict !== "send") {
      return this.hold(input, dest, `reviewer: ${verdict.reason || "held"}`, { kind: "reviewer" });
    }

    // 5 and 6. Receipt first, then the send.
    const { permalink } = await this.send({
      userWeb,
      userId,
      sourceChannelId: input.sourceChannelId,
      sourceThreadTs: input.sourceThreadTs,
      dest,
      text: input.text,
      source: input.source,
      reason: input.reason,
      sourceVerified: input.sourceVerified,
      threadTs: input.threadTs,
    });
    this.audit("sent", { sourceChannelId: input.sourceChannelId, dest, userId, text: input.text, outcome: "send", permalink, reviewerReason: verdict.reason });
    return { status: "sent", label: dest.label, ...(permalink ? { permalink } : {}) };
  }

  /** A copy of a held post, to redraw its alert after a click. Read-only: deciding it is `unblock` or `dismiss`. */
  peekHeld(id: string): HeldPost | undefined {
    const item = this.deps.held.peek(id);
    return item ? { ...item } : undefined;
  }

  async unblock(id: string, clickerId: string): Promise<{ ok: true; permalink?: string } | { ok: false; message: string }> {
    // Nothing below awaits until the item is taken, so two concurrent clicks cannot both get it.
    const item = this.deps.held.peek(id);
    if (!item) return { ok: false, message: "This held post was already decided or has expired." };
    if (clickerId !== item.postAsUser) return { ok: false, message: `Only <@${item.postAsUser}> can unblock this post.` };
    const meta = this.meta.get(id) ?? { maxPerHour: 0, capHold: false, sourceVerified: false, isDm: true };

    const token = this.deps.tokens(item.sourceChannelId).tokenFor(item.postAsUser);
    if (!token) return { ok: false, message: `There is no Slack user token stored for <@${item.postAsUser}>, so nothing can be posted as them.` };
    // The held attempt already used a slot. Only a rate-cap hold takes another one now.
    if (meta.capHold && !this.deps.limiter.take(item.sourceChannelId, meta.maxPerHour)) {
      return { ok: false, message: `This channel is still over its limit of ${meta.maxPerHour} posts an hour. Try again later.` };
    }

    const taken = this.deps.held.take(id);
    this.meta.delete(id);
    if (!taken) return { ok: false, message: "This held post was already decided or has expired." };
    this.deps.onHeldConsumed?.(taken.sourceChannelId, taken.id);

    const userWeb = this.deps.userClient(token);
    try {
      // A channel id is sent to as it is; a user id opens the DM now; a bare name (a cap hold only) is looked up now.
      const stored = taken.targetChannelId;
      const destId = CHANNEL_ID.test(stored) ? stored : await resolveTarget(userWeb, stored || meta.unresolvedTarget || taken.targetLabel, taken.postAsUser);
      const dest: Destination = { id: destId, label: taken.targetLabel, isDm: meta.isDm || destId.startsWith("D") };
      const { permalink } = await this.send({
        userWeb,
        userId: taken.postAsUser,
        sourceChannelId: taken.sourceChannelId,
        sourceThreadTs: taken.sourceThreadTs,
        dest,
        text: taken.text,
        source: taken.source,
        reason: taken.reason,
        sourceVerified: meta.sourceVerified,
        threadTs: taken.threadTs,
        unblockedBy: clickerId,
      });
      this.audit("unblocked", { sourceChannelId: taken.sourceChannelId, dest, userId: taken.postAsUser, text: taken.text, outcome: `unblocked by ${clickerId}`, permalink });
      return { ok: true, ...(permalink ? { permalink } : {}) };
    } catch (err) {
      logger.warn(`post_as_user unblock failed: source=${taken.sourceChannelId} dest=${taken.targetLabel} user=${taken.postAsUser}: ${errMessage(err)}`);
      return { ok: false, message: errMessage(err) };
    }
  }

  dismiss(id: string, clickerId: string): { ok: boolean; message?: string } {
    const item = this.deps.held.peek(id);
    if (!item) return { ok: false, message: "This held post was already decided or has expired." };
    if (clickerId !== item.postAsUser) return { ok: false, message: `Only <@${item.postAsUser}> can dismiss this post.` };
    const meta = this.meta.get(id);
    this.deps.held.take(id);
    this.deps.onHeldConsumed?.(item.sourceChannelId, item.id);
    this.meta.delete(id);
    const dest: Destination = { id: item.targetChannelId, label: item.targetLabel, isDm: meta?.isDm ?? true };
    this.audit("dismissed", { sourceChannelId: item.sourceChannelId, dest, userId: item.postAsUser, text: item.text, outcome: `dismissed by ${clickerId}` });
    return { ok: true };
  }

  /** Receipt in the source channel first (if it fails, nothing is sent), then the send, then the permalink on the receipt. */
  private async send(a: {
    userWeb: WebClient;
    userId: string;
    sourceChannelId: string;
    sourceThreadTs: string | undefined;
    dest: Destination;
    text: string;
    source: string;
    reason: string;
    sourceVerified: boolean;
    threadTs: string | undefined;
    unblockedBy?: string;
  }): Promise<{ permalink?: string }> {
    const bot = this.deps.botClient;
    const receipt = {
      label: a.dest.label,
      reason: a.reason,
      source: a.source,
      text: a.text,
      sourceVerified: a.sourceVerified,
      ...(a.unblockedBy ? { unblockedBy: a.unblockedBy } : {}),
    };
    const where = { channel: a.sourceChannelId, ...(a.sourceThreadTs ? { thread_ts: a.sourceThreadTs } : {}) };

    let receiptTs: string | undefined;
    try {
      const res = await bot.chat.postMessage({ ...where, text: `Sending to ${line(a.dest.label)}…`, blocks: buildReceiptBlocks(receipt) });
      receiptTs = res.ts as string | undefined;
    } catch (err) {
      logger.warn(`post_as_user receipt failed: source=${a.sourceChannelId} dest=${a.dest.label} user=${a.userId}: ${errMessage(err)}`);
      throw new Error("The receipt could not be posted in this channel, so nothing was sent.");
    }

    let ts: string;
    try {
      ts = await sendAsUser(a.userWeb, a.dest.id, a.text, a.userId, this.deps.botUserId?.(), a.threadTs);
    } catch (err) {
      const mapped = mapSlackError(err, a.userId, "chat:write");
      if (receiptTs) {
        try {
          const failed = `:x: Could not send to ${line(a.dest.label)}: ${line(mapped.message)}`;
          await bot.chat.update({ channel: a.sourceChannelId, ts: receiptTs, text: failed, blocks: [{ type: "section", text: { type: "mrkdwn", text: failed } }] });
        } catch (updateErr) {
          logger.warn(`post_as_user receipt update failed: ${errMessage(updateErr)}`);
        }
      }
      throw mapped;
    }

    let permalink: string | undefined;
    try {
      const link = await a.userWeb.chat.getPermalink({ channel: a.dest.id, message_ts: ts });
      permalink = link.permalink as string | undefined;
    } catch (err) {
      logger.warn(`post_as_user permalink failed: dest=${a.dest.label}: ${errMessage(err)}`);
    }
    if (receiptTs) {
      // Always moved off "Sending…": the message went out, with or without a link to it.
      try {
        await bot.chat.update({
          channel: a.sourceChannelId,
          ts: receiptTs,
          text: `Sent to ${line(a.dest.label)}${permalink ? "" : " (no link)"}`,
          blocks: buildReceiptBlocks(permalink ? { ...receipt, permalink } : { ...receipt, noLink: true }),
        });
      } catch (err) {
        logger.warn(`post_as_user receipt update failed: ${errMessage(err)}`);
      }
    }
    return permalink ? { permalink } : {};
  }

  /** Store the held post and alert the source channel. If the alert cannot be posted, the post is dropped and the caller gets an error. */
  private async hold(
    input: PostInput,
    dest: Destination,
    heldBecause: string,
    opts: { kind: string; capHold?: boolean; unresolvedTarget?: string },
  ): Promise<PostAsOutcome> {
    this.prune();
    const userId = input.postAs.user;
    const item = this.deps.held.add({
      postAsUser: userId,
      sourceChannelId: input.sourceChannelId,
      ...(input.sourceThreadTs ? { sourceThreadTs: input.sourceThreadTs } : {}),
      targetChannelId: dest.id,
      targetLabel: dest.label,
      text: input.text,
      source: input.source,
      reason: input.reason,
      heldBecause,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    });
    this.meta.set(item.id, {
      maxPerHour: input.postAs.maxPerHour,
      capHold: opts.capHold === true,
      sourceVerified: input.sourceVerified,
      isDm: dest.isDm,
      ...(opts.unresolvedTarget ? { unresolvedTarget: opts.unresolvedTarget } : {}),
    });

    try {
      const sent = await this.deps.botClient.chat.postMessage({
        channel: input.sourceChannelId,
        ...(input.sourceThreadTs ? { thread_ts: input.sourceThreadTs } : {}),
        text: `A post to ${line(dest.label)} was held: ${line(heldBecause)}`,
        blocks: buildHeldAlertBlocks(item),
      });
      if (sent.ts) this.deps.onHeld?.({ channelId: input.sourceChannelId, id: item.id, ts: sent.ts, expiresAt: item.expiresAt });
    } catch (err) {
      this.deps.held.take(item.id);
      this.meta.delete(item.id);
      logger.warn(`post_as_user alert failed: source=${input.sourceChannelId} dest=${dest.label} user=${userId}: ${errMessage(err)}`);
      throw new Error("The post was held, but the alert could not be posted in this channel, so it was dropped. Nothing was sent.");
    }

    this.audit("held", { sourceChannelId: input.sourceChannelId, dest, userId, text: input.text, outcome: `hold (${opts.kind})`, heldBecause });
    return { status: "held", reason: heldBecause };
  }

  private prune(): void {
    for (const id of this.meta.keys()) if (!this.deps.held.peek(id)) this.meta.delete(id);
  }

  /** One log line and one timeline event per outcome. The log never carries the draft; a DM's event carries no words at all. */
  private audit(
    status: "sent" | "held" | "unblocked" | "dismissed",
    a: { sourceChannelId: string; dest: Destination; userId: string; text: string; outcome: string; permalink?: string; heldBecause?: string; reviewerReason?: string },
  ): void {
    logger.info(
      `post_as_user ${status}: source=${a.sourceChannelId} dest=${a.dest.label} user=${a.userId} verdict=${a.outcome}` +
        (a.permalink ? ` permalink=${a.permalink}` : ""),
    );
    const titles = {
      sent: `Posted as <@${a.userId}> to ${a.dest.label}`,
      held: `Held a post as <@${a.userId}> to ${a.dest.label}`,
      unblocked: `Unblocked and posted as <@${a.userId}> to ${a.dest.label}`,
      dismissed: `Dismissed a held post as <@${a.userId}> to ${a.dest.label}`,
    } as const;
    const detail = a.dest.isDm
      ? ""
      : a.heldBecause
        ? `${excerpt(a.text)} (held: ${excerpt(a.heldBecause)})`
        : a.reviewerReason
          ? `${excerpt(a.text)} (reviewer: ${excerpt(a.reviewerReason)})`
          : excerpt(a.text);
    try {
      this.deps.onEvent?.({ channelId: a.sourceChannelId, status, title: titles[status], detail, userId: a.userId });
    } catch (err) {
      logger.warn(`post_as_user event hook failed: ${errMessage(err)}`);
    }
  }
}
