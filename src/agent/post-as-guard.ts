// Deterministic pre-send checks for post_as_user, and an in-memory rate limiter.
// Pure module: no Slack or model dependency.

export const BUILTIN_PRIVATE_LINK_HOSTS: readonly string[] = [
  "docs.google.com",
  "drive.google.com",
  "sheets.google.com",
  "slides.google.com",
  "notion.so",
  "atlassian.net",
  "sharepoint.com",
  "dropbox.com",
  "box.com",
  "onedrive.live.com",
  "1drv.ms",
  "confluence",
];

export type DraftCheck = { hold: false } | { hold: true; reason: string };

// A hostname-ish token with optional scheme and path. Slack `<url|label>` is
// covered because both the URL part and the label are scanned, so a label can
// neither hide the real URL nor shadow it.
const HOST_TOKEN = /(?:[a-z][a-z0-9+.-]*:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?(?:\/[^\s<>|]*)?/gi;

const SECRET_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/,
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/,
  /(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/,
  /(?<![A-Za-z0-9])ASIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]+/,
  /(?<![A-Za-z0-9])xoxe(?:\.xox[a-z])?-[A-Za-z0-9-]+/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{20,}/,
];

const BROADCAST = /<!(?:channel|here|everyone|subteam\^[^>]*)(?:\|[^>]*)?>/i;

function normaliseHost(entry: string): string {
  let h = entry.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#]/)[0] ?? "";
  h = h.replace(/^.*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return h;
}

function matchesHost(host: string, h: string): boolean {
  if (h === "confluence") return host.split(".").includes("confluence");
  return host === h || host.endsWith("." + h);
}

// Characters a URL parser drops from a hostname (zero-width spaces, soft
// hyphens, joiners, variation selectors, ...). They are stripped before
// scanning so `docs.goo\u200Bgle.com` is seen as the host it opens.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
// Dot lookalikes a URL parser treats as a label separator.
const DOT_LOOKALIKE = /[\u3002\uFF0E\uFF61]/g;
const MAX_DECODE_ROUNDS = 3;

function normalise(text: string): string {
  try {
    return text.replace(INVISIBLE, "").replace(DOT_LOOKALIKE, ".").normalize("NFKC").replace(DOT_LOOKALIKE, ".");
  } catch {
    return text;
  }
}

// Decode every run of %XX escapes on its own, so one malformed sequence cannot stop the rest of the text from being decoded.
// A run that is not valid UTF-8 is decoded leniently, the way URLSearchParams (and so many redirectors) does: each invalid
// byte becomes U+FFFD and every valid character around it is still decoded.
const LENIENT = new TextDecoder("utf-8", { fatal: false });

function tolerantDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      try {
        return LENIENT.decode(Uint8Array.from(run.match(/%[0-9a-f]{2}/gi) ?? [], (h) => parseInt(h.slice(1), 16)));
      } catch {
        return run.replace(/%2e/gi, ".");
      }
    }
  });
}

// The text, its normalised copy, and each round of decoding the normalised
// copy up to a fixed point (at most MAX_DECODE_ROUNDS rounds), each round
// normalised again so an encoded lookalike dot is caught too.
function variants(text: string): string[] {
  const out = new Set<string>([text]);
  let cur = normalise(text);
  out.add(cur);
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    const next = normalise(tolerantDecode(cur));
    if (next === cur) break;
    out.add(next);
    cur = next;
  }
  return [...out];
}

function candidates(text: string, depth = 0): { host: string; path: string }[] {
  const out: { host: string; path: string }[] = [];
  for (const m of text.matchAll(HOST_TOKEN)) {
    const token = m[0];
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(token) ? token : "https://" + token);
      out.push({ host: u.hostname.toLowerCase().replace(/\.$/, ""), path: u.pathname });
      if (depth < 3) {
        // A URL can carry another one in its path or query (redirectors),
        // possibly encoded several times over.
        const inner = u.pathname + u.search + u.hash;
        for (const v of variants(inner)) out.push(...candidates(v, depth + 1));
      }
    } catch {
      // malformed: ignore, never throw
    }
  }
  return out;
}

export function checkDraft(text: string, opts: { privateLinkHosts: readonly string[] }): DraftCheck {
  const custom = opts.privateLinkHosts.map(normaliseHost).filter((h) => h.length > 0);
  const hosts = [...BUILTIN_PRIVATE_LINK_HOSTS, ...custom];

  // Scan the raw text and every normalised / decoded copy of it, so neither
  // encoding nor invisible or lookalike characters can hide a link or secret.
  const texts = variants(text);
  for (const t of texts) {
    for (const { host, path } of candidates(t)) {
      if (hosts.some((h) => matchesHost(host, h))) {
        return { hold: true, reason: `contains a private link (${host})` };
      }
      if (host.endsWith(".slack.com") && path.toLowerCase().startsWith("/archives/")) {
        return { hold: true, reason: `contains a private link (Slack permalink on ${host})` };
      }
    }
  }
  if (texts.some((t) => SECRET_PATTERNS.some((r) => r.test(t)))) {
    return { hold: true, reason: "contains what looks like a secret or credential" };
  }
  if (BROADCAST.test(text)) {
    return { hold: true, reason: "contains a broadcast mention (@channel, @here, @everyone or a user-group mention)" };
  }
  return { hold: false };
}

const WINDOW_MS = 60 * 60 * 1000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  take(key: string, maxPerHour: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= maxPerHour) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
