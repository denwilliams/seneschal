import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { inspectOperatorConfig, OperatorConfigError, patchOperatorConfig, readOperatorConfig, saveOperatorConfig, validateOperatorConfig } from "../config/operator.ts";
import { ConfigEditError } from "../config/edit.ts";
import { remoteOf } from "./actions.ts";
import type { Console2Context } from "./handler.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const Edit = z.object({ path: z.array(z.string()).min(2).max(4), value: z.unknown().optional(), remove: z.boolean().optional(), yaml: z.string().max(MAX_BYTES).optional(), create: z.boolean().optional() }).strict();
const Request = z.object({
  operation: z.enum(["inspect", "patch", "validate", "save"]), text: z.string().max(MAX_BYTES),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(), edits: z.array(Edit).max(2000).optional(),
}).strict();
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
export async function handleConfigAdmin(req: IncomingMessage, res: ServerResponse, ctx: Console2Context): Promise<void> {
  const service = ctx.source.admin;
  if (!service) return reply(res, 503, { error: "Configuration administration is unavailable in this process." });
  const origin = req.headers.origin;
  if (typeof origin === "string" && !ctx.originAllowed(origin)) return reply(res, 403, { error: "Origin not allowed" });
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return reply(res, 403, { error: "Cross-site request refused" });
  try {
    if (req.method === "GET" || req.method === "HEAD") return reply(res, 200, readOperatorConfig(service));
    if (req.method !== "POST") { res.writeHead(405, { allow: "GET, HEAD, POST" }); return void res.end(); }
    if (req.headers["x-console-admin"] !== "1") return reply(res, 403, { error: "Missing x-console-admin header." });
    if (String(req.headers["content-type"]).split(";")[0]?.trim().toLowerCase() !== "application/json") return reply(res, 415, { error: "Send application/json." });
    const wait = ctx.actions?.limiter.take(req.socket.remoteAddress ?? "unknown");
    if (wait !== undefined) return reply(res, 429, { error: "Too many requests; wait a moment." });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BYTES) {
        const socket = req.socket;
        res.once("finish", () => socket.destroySoon());
        return reply(res, 413, { error: "Configuration request exceeds 2 MiB." });
      }
      chunks.push(buffer);
    }
    let json: unknown;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return reply(res, 400, { error: "Invalid JSON request." }); }
    const checked = Request.safeParse(json);
    if (!checked.success) return reply(res, 400, { error: checked.error.issues.map((i) => i.path.join(".") + ": " + i.message).join("\n") });
    const body = checked.data;
    if (body.operation === "inspect") return reply(res, 200, inspectOperatorConfig(body.text));
    if (body.operation === "patch") {
      const text = patchOperatorConfig(body.text, body.edits ?? []);
      return reply(res, 200, { text, ...inspectOperatorConfig(text) });
    }
    // The exact startup loader: environment references, removed blocks, schema and cross-reference checks.
    validateOperatorConfig(body.text);
    if (body.operation === "validate") return reply(res, 200, { ok: true, message: "Valid configuration. Nothing saved or applied." });
    if (!body.revision) return reply(res, 400, { error: "A loaded config revision is required to save." });
    return reply(res, 200, await saveOperatorConfig(service, body.text, body.revision, remoteOf(req)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const io = typeof code === "string" && /^E[A-Z]+$/.test(code);
    return reply(res, error instanceof OperatorConfigError ? error.status : io || error instanceof ConfigEditError ? 500 : 422, {
      error: io ? "Could not read/write the configured harness file or backup. Check the harness file/directory permissions and writable Docker mount." : error instanceof Error ? error.message : "Configuration request failed.",
    });
  }
}
