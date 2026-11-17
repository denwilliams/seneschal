import type { IncomingMessage, ServerResponse } from "node:http";
import { ChannelLists, ListError, MAX_ITEM_BYTES } from "../lists/store.ts";
import { ACTION_HEADER, readBody, sameSite, type ActionLimiter } from "./actions.ts";
import { findChannel } from "./data.ts";
import type { Console2Source } from "./source.ts";

// Leave room for op, a 48-character list name, ID and the values wrapper; other console actions keep their 16 KiB bound.
export const MAX_LIST_BODY_BYTES = MAX_ITEM_BYTES + 1024;

export async function handleLists(channelId: string, req: IncomingMessage, res: ServerResponse, ctx: { source: Console2Source; originAllowed: (origin: string) => boolean; limiter: ActionLimiter }, query: URLSearchParams): Promise<void> {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
  const crossSite = sameSite(req, ctx.originAllowed);
  if (crossSite) return reply(403, { error: crossSite });
  const channel = findChannel(ctx.source, channelId);
  if (!channel) return reply(404, { error: "Unknown channel." });
  // No names, schemas or values from DMs, including on mutations and errors.
  if (channel.isDm) return reply(403, { error: "Lists are hidden for direct messages." });
  const resolved = ctx.source.resolve(channel);
  if (!resolved) return reply(403, { error: "Channel is not available." });
  const store = new ChannelLists(resolved.paths.root);
  try {
    if (req.method !== "POST") {
      return reply(200, { ...store.read(query.get("list") || undefined, query.has("offset") ? Number(query.get("offset")) : 0), writable: ctx.source.listsWritable === true });
    }
    if (ctx.source.listsWritable !== true) return reply(403, { error: "Console actions are turned off. Enable webConsole.actions to edit lists." });
    if (String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return reply(415, { error: "Send application/json." });
    if (req.headers[ACTION_HEADER] !== "1") return reply(403, { error: "Missing x-console-action header." });
    if (ctx.limiter.take(req.socket.remoteAddress ?? "unknown") !== undefined) return reply(429, { error: "Too many actions; wait a moment." });
    const socket = req.socket;
    const body = await readBody(req, MAX_LIST_BODY_BYTES);
    if (body === "too_large") {
      res.once("finish", () => { if (!socket.destroyed) socket.destroySoon(); });
      return reply(413, { error: "That request is too large." });
    }
    let input: unknown;
    try { input = JSON.parse(body); } catch { return reply(400, { error: "Invalid JSON." }); }
    return reply(200, store.mutate(input));
  } catch (error) {
    if (error instanceof ListError) return reply(400, { error: error.message });
    throw error;
  }
}
