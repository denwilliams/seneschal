/**
 * The footer the factory agent puts on everything it writes to GitHub, and the one parser that reads it back.
 *
 * The roles and the harness post through the token of one GitHub account. When that account is a person's, their comments and the
 * harness's are the same login, so the text is the only way to tell them apart. The footer has two parts, both at the end:
 *
 *   *Sent by the factory agent (coder) · run abc123*
 *   <!-- harness:factory run=abc123 role=coder stage=implement -->
 *
 * The first is for people (it shows what is agent-written); the second is for the machine. The engine writes the exact text into
 * every stage's brief, so a role does not have to remember the format. See docs/FACTORY_WORKFLOW_DESIGN.md section 19.
 */

export type FooterParts = { role?: string; stage?: string; runId?: string };

/** Words every visible footer starts with. */
export const FOOTER_TEXT = "Sent by the factory agent";
export const FOOTER_MARKER = "harness:factory";

/** A value in the footer is a plain identifier, so the footer can be matched back exactly and never smuggles markup. */
const safe = (value: string | undefined): string => (value ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);

/** Just the hidden marker: for a post that already says in its own words that the agent wrote it (the provenance line of a filed issue). */
export function footerMarker(parts: FooterParts = {}): string {
  const fields = [parts.runId && `run=${safe(parts.runId)}`, parts.role && `role=${safe(parts.role)}`, parts.stage && `stage=${safe(parts.stage)}`].filter(Boolean).join(" ");
  return `<!-- ${FOOTER_MARKER}${fields ? ` ${fields}` : ""} -->`;
}

/** The visible line and the hidden marker, as the roles are asked to write them. */
export function agentFooter(parts: FooterParts = {}): string {
  const role = safe(parts.role);
  const runId = safe(parts.runId);
  return `*${FOOTER_TEXT}${role ? ` (${role})` : ""}${runId ? ` · run ${runId}` : ""}*\n${footerMarker(parts)}`;
}

/**
 * The two variables that switch the `gh` footer guard on for a shell (see gh-shim.ts). The guard reads the exact text from them, so the
 * format is written in one place and the shell script never copies it. Both are plain environment variables of the channel's own
 * shell, set by the harness when it builds a session; nothing a model writes reaches them.
 */
export const FOOTER_ENV = "HARNESS_AGENT_FOOTER";
export const FOOTER_MARKER_ENV = "HARNESS_AGENT_FOOTER_MARKER";

export function footerEnv(parts: FooterParts = {}): Record<string, string> {
  return { [FOOTER_ENV]: agentFooter(parts), [FOOTER_MARKER_ENV]: footerMarker(parts) };
}

/** The body with the footer after it. A footer already there is not added twice. */
export function withFooter(body: string, parts: FooterParts = {}): string {
  const trimmed = body.replace(/\s+$/, "");
  return parseFooter(trimmed) ? trimmed : `${trimmed}\n\n${agentFooter(parts)}`;
}

const MARKER_LINE = new RegExp(`^<!-- ${FOOTER_MARKER}((?: [a-z]+=[A-Za-z0-9_.:-]*)*) -->$`);
const VISIBLE_LINE = new RegExp(`^\\*${FOOTER_TEXT}(?: \\(([A-Za-z0-9_.:-]*)\\))?(?: · run ([A-Za-z0-9_.:-]+))?\\*$`);

export type ParsedFooter = { runId: string; role: string; stage: string; marker: boolean; visible: boolean };

/**
 * The footer at the very end of a body, or undefined. Only the last non-blank lines count, and only when they start the line: a
 * person's quote-reply copies the footer with `>` in front of it and then adds their own words after it, so neither matches. A
 * footer typed by hand at the end would match, but only the token's own account can post a comment this is asked about, and that is
 * the account whose comments are in question anyway.
 */
export function parseFooter(body: string): ParsedFooter | undefined {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length - 1;
  while (end >= 0 && lines[end]!.trim() === "") end--;
  if (end < 0) return undefined;
  const found: ParsedFooter = { runId: "", role: "", stage: "", marker: false, visible: false };
  const marker = MARKER_LINE.exec(lines[end]!);
  if (marker) {
    found.marker = true;
    for (const [, key, value] of (marker[1] ?? "").matchAll(/ ([a-z]+)=([A-Za-z0-9_.:-]*)/g) as Iterable<RegExpMatchArray>) {
      if (key === "run") found.runId = value!;
      else if (key === "role") found.role = value!;
      else if (key === "stage") found.stage = value!;
    }
    end--;
    while (end >= 0 && lines[end]!.trim() === "") end--;
  }
  const visible = end >= 0 ? VISIBLE_LINE.exec(lines[end]!) : null;
  if (visible) {
    found.visible = true;
    found.role ||= visible[1] ?? "";
    found.runId ||= visible[2] ?? "";
  }
  return found.marker || found.visible ? found : undefined;
}

/**
 * For the harness's own writes to GitHub (it posts nothing a person typed, so nothing may go out without the footer): a text that does
 * not end with one is a bug in the caller, and is refused rather than posted under a person's name unmarked.
 */
export function requireFooter(body: string, what: string): string {
  if (!parseFooter(body)) throw new Error(`refusing to post ${what} without the harness footer`);
  return body;
}

/** What to tell a role in its brief: the exact text, and where it goes. */
export function footerInstruction(parts: FooterParts): string {
  return [
    "Anything you write on GitHub for this job (a comment on the issue or the pull request, a review, an issue or pull request description) must end with this footer, exactly as written, on its own lines after your text. It lets people see what an agent wrote and lets the harness tell it from a person's reply on the same account. Do not change it, and do not put it on anything you do not post:",
    "",
    agentFooter(parts),
  ].join("\n");
}
