import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleConnectorOAuth } from "../agent/consoleConnectorOAuth.ts";

const COOKIE = "__Secure-harness-connector-oauth";
function browserCookie(req: IncomingMessage): string {
  const cookies = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter((c) => c.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return "";
  const value = cookies[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
function headers(script?: string): Record<string, string> {
  return {
    "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src ${script ? `'sha256-${createHash("sha256").update(script).digest("base64")}'` : "'none'"}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
function json(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...headers(), "content-type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(value));
}
function page(res: ServerResponse, content: string, script?: string) {
  res.writeHead(200, { ...headers(script), "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect a harness connector</title><body>${content}${script ? `<script>${script}</script>` : ""}</body></html>`);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Tiny bounded JSON bodies only; never log parsing errors or contents.
  if (req.headers["content-type"] !== "application/json" || Number(req.headers["content-length"] ?? 0) > 2048) throw new Error("invalid");
  return new Promise((resolve, reject) => {
    let data = "";
    const cleanup = () => { clearTimeout(timer); req.off("data", onData); req.off("end", end); req.off("error", fail); req.off("aborted", fail); };
    const fail = () => { cleanup(); reject(new Error("invalid")); req.resume(); };
    const timer = setTimeout(fail, 5_000); timer.unref();
    const onData = (chunk: Buffer) => { data += chunk.toString("utf8"); if (Buffer.byteLength(data) > 2048) fail(); };
    const end = () => {
      cleanup();
      try {
        const value: unknown = JSON.parse(data);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
        resolve(value as Record<string, unknown>);
      } catch { reject(new Error("invalid")); }
    };
    req.on("data", onData); req.once("end", end); req.once("error", fail); req.once("aborted", fail);
  });
}
function connectScript(prefix: string): string {
  return `(() => {
  const initial = new URL(location.href);
  const channel = initial.searchParams.get('channel');
  const connector = initial.searchParams.get('connector');
  let link = location.hash.slice(1);
  const web = !link && Boolean(channel && connector);
  history.replaceState(null, '', location.pathname);
  const prefix = ${JSON.stringify(prefix)};
  const message = document.getElementById('message');
  const button = document.getElementById('pair');
  if (web) button.textContent = 'Request Slack approval';
  const fail = () => { message.textContent = 'This authorization is unavailable, cancelled, expired, or already used. Start again from the channel page or the originating Slack thread.'; button.hidden = true; };
  const post = async (route, value) => {
    const res = await fetch(prefix + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!res.ok) throw new Error('unavailable');
    return res.json();
  };
  const poll = async () => {
    try {
      const result = await post('/poll', {});
      if (result.status === 'opening') { location.replace(result.authorizationUrl); return; }
      setTimeout(poll, 2000);
    } catch { fail(); }
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await post(web ? '/request' : '/claim', web ? { channelId: channel, connectorName: connector } : { link }); link = '';
      button.hidden = true;
      message.textContent = 'Browser pairing: ' + result.phrase + '. In the requested Slack channel, approve ONLY the prompt with this same challenge. An allowed Slack user confirming their own browser becomes the authorizing user. Do not approve someone else’s browser. Then continue here to provider consent. Credentials will be shared with this channel, not stored as personal credentials.';
      void poll();
    } catch { link = ''; fail(); }
  });
  if (!web && !/^[A-Za-z0-9_-]{43}$/.test(link)) fail();
})();`;
}

/** Explicit OAuth routes, separate from read-only console/artifact routing. No Host/X-Forwarded identity trust. */
export async function handleConsoleOAuth(req: IncomingMessage, res: ServerResponse, oauth: ConsoleConnectorOAuth): Promise<boolean> {
  const request = new URL(req.url ?? "/", "http://listener.invalid");
  const route = request.pathname.slice(oauth.prefix.length);
  if (!request.pathname.startsWith(`${oauth.prefix}/`) || !["/connect", "/claim", "/request", "/poll", "/callback", "/result"].includes(route)) return false;
  const method = ["/claim", "/request", "/poll"].includes(route) ? "POST" : "GET";
  if (req.method !== method) { json(res, 405, { error: "Method not allowed" }, { allow: method }); return true; }
  if (route === "/callback") {
    // Only the paired browser can submit state. Never render code, state or provider errors.
    const accepted = oauth.callback(browserCookie(req), request.searchParams);
    res.writeHead(303, { ...headers(), location: `${oauth.prefix}/result`,
      ...(accepted ? { "set-cookie": `${COOKIE}=; Path=${oauth.prefix}/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` } : {}) });
    res.end();
    return true;
  }
  if (route === "/result") {
    page(res, "<h1>Return to Slack</h1><p>The originating Slack thread reports completion or the reason to retry. If no completion appears, start a new authorization after the old session expires. No authorization codes or credentials are displayed here.</p>");
    return true;
  }
  if (route === "/connect") {
    page(res, '<h1>Connect a harness connector</h1><p id="message">Request browser pairing for this channel connector. An allowed Slack user must confirm their own matching browser challenge before provider consent can begin.</p><button id="pair" type="button">Pair this browser</button>', connectScript(oauth.prefix));
    return true;
  }
  // SameSite cookies alone are insufficient. Require exact browser Origin; ignore proxy identity headers.
  if (req.headers.origin !== oauth.origin) { json(res, 403, { error: "Origin not allowed" }); return true; }
  try {
    const value = await body(req);
    if (route === "/claim" || route === "/request") {
      let claimed: { browser: string; phrase: string };
      if (route === "/request") {
        if (Object.keys(value).length !== 2 || typeof value.channelId !== "string" || !/^[CDG][A-Z0-9]+$/.test(value.channelId)
          || typeof value.connectorName !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.connectorName)) throw new Error("invalid");
        claimed = await oauth.startBrowser(value.channelId, value.connectorName);
      } else {
        if (Object.keys(value).length !== 1 || typeof value.link !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.link)) throw new Error("invalid");
        claimed = await oauth.claim(value.link);
      }
      json(res, 200, { phrase: claimed.phrase }, { "set-cookie": `${COOKIE}=${claimed.browser}; Path=${oauth.prefix}/; Secure; HttpOnly; SameSite=Lax; Max-Age=${oauth.ttlSeconds}` });
    } else {
      if (Object.keys(value).length !== 0) throw new Error("invalid");
      json(res, 200, await oauth.poll(browserCookie(req)));
    }
  } catch { json(res, 400, { error: "Authorization unavailable. Start again in Slack." }); }
  return true;
}
