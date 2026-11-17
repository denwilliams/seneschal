import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { SecretScopeSchema } from "../config/keychain-schema.ts";
import { SecretAdminError } from "../config/managed-env.ts";
import type { Console2Context } from "./handler.ts";

const MAX_BYTES = 100 * 1024;
const Request = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("backend-save"), backend: z.string().max(64), scope: SecretScopeSchema, name: z.string().max(128), value: z.string().max(16384), overwrite: z.boolean() }).strict(),
  z.object({ operation: z.literal("backend-delete"), backend: z.string().max(64), scope: SecretScopeSchema, name: z.string().max(128), confirm: z.literal(true) }).strict(),
  z.object({ operation: z.literal("save"), name: z.string().max(128), value: z.string().max(16 * 1024), overwrite: z.boolean() }).strict(),
  z.object({ operation: z.literal("restart"), confirm: z.literal(true) }).strict(),
]);
function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
/** Same external Admin trust boundary as config: never expose this API without an authenticating proxy. */
export async function handleSecretAdmin(req: IncomingMessage, res: ServerResponse, ctx: Console2Context): Promise<void> {
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if ((typeof origin === "string" && !ctx.originAllowed(origin)) || (typeof site === "string" && site !== "same-origin" && site !== "none")) return reply(res, 403, { error: "Cross-site request refused." });
  const service = ctx.source.admin && ctx.source.secrets;
  if (!service) return reply(res, 503, { error: "Secret administration is unavailable in this process." });
  try {
    if (req.method === "GET" || req.method === "HEAD") return reply(res, 200, { ...service.snapshot(), scoped: ctx.source.scopedSecrets?.snapshot() });
    if (req.method !== "POST") return reply(res, 405, { error: "Use GET, HEAD or POST." });
    if (req.headers["x-console-admin"] !== "1") return reply(res, 403, { error: "Missing x-console-admin header." });
    if (String(req.headers["content-type"]).split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(res, 415, { error: "Send application/json." });
    if (ctx.actions?.limiter.take(req.socket.remoteAddress ?? "unknown") !== undefined) return reply(res, 429, { error: "Too many requests; wait a moment." });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BYTES) {
        const socket = req.socket;
        res.once("finish", () => socket.destroySoon());
        return reply(res, 413, { error: "Secret request is too large." });
      }
      chunks.push(buffer);
    }
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return reply(res, 400, { error: "Invalid JSON request." }); }
    const checked = Request.safeParse(json);
    // Never echo parser diagnostics, input keys, supplied values or exception messages.
    if (!checked.success) return reply(res, 400, { error: "Invalid secret administration request." });
    const body = checked.data;
    if (body.operation === "backend-save" || body.operation === "backend-delete") {
      if (!ctx.source.scopedSecrets) return reply(res, 503, { error: "Backend secret administration is unavailable." });
      if (body.operation === "backend-save") await ctx.source.scopedSecrets.save(body.backend, body.scope, body.name, body.value, body.overwrite);
      else await ctx.source.scopedSecrets.remove(body.backend, body.scope, body.name, body.confirm);
      return reply(res, 200, { saved: true, applied: false, message: "Backend updated. Add or remove matching config imports if needed; reload channels or restart main-process clients to apply." });
    }
    if (body.operation === "save") {
      service.save(body.name, body.value, body.overwrite);
      return reply(res, 200, { saved: true, applied: false, message: "Saved for the next startup. Existing running work has not changed." });
    }
    const begin = service.prepareRestart();
    res.once("finish", () => setTimeout(begin, 100));
    return reply(res, 202, { accepted: true, instance: service.instance, message: "Restart requested. Work will be interrupted; return to service is not yet verified." });
  } catch (error) {
    return reply(res, error instanceof SecretAdminError ? error.status : 500, { error: error instanceof SecretAdminError ? error.message : "Secret administration failed. Check private storage permissions on the host; the operation may need to be retried." });
  }
}
