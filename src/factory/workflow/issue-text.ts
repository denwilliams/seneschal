/**
 * The text of an issue the harness files. It is written by the model from a request that may have come from anyone (a pasted
 * email, a support ticket, a web page), so it is treated as data on its way into GitHub: bounded, stripped of what hides or
 * misleads, and stripped of what would act on its own once it is there (a mention that notifies, a keyword that closes another
 * issue when the text is copied into a pull request, an image that fetches a remote URL when the page is opened).
 */
import { footerMarker } from "./footer.ts";


export const ISSUE_LIMITS = { titleChars: 200, bodyChars: 7_000 } as const;

/** Control characters other than tab and newline, and the bidirectional overrides that make text read other than it is written. */
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩﻿]/g;

/** `@name` and `@org/team` notify people. Put in a code span they are text. */
const MENTION = /(^|[^\w`@/])@([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?)/g;

/** "fixes #1", "closes owner/repo#2", "resolves https://github.com/o/r/issues/3": they close that issue when a pull request carries them. */
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?\s+)(#\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|https?:\/\/github\.com\/\S+)/gi;

/** Something that renders as an HTML tag or comment. GitHub sanitises HTML, but the text is a request, not markup. */
const TAG = /<(?=[A-Za-z!/?])/g;

const neutralise = (line: string): string =>
  line
    .replace(TAG, "&lt;")
    // A remote image loads when the issue is opened, and tells whoever hosts it who looked.
    .replace(/!\[/g, "!\\[")
    .replace(CLOSING, (_match, verb: string, gap: string, target: string) => `${verb}${gap}\`${target}\``)
    .replace(MENTION, (_match, before: string, name: string) => `${before}\`@${name}\``);

const cap = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

/** One line, bounded, safe. Undefined when nothing is left of it. */
export function sanitizeIssueTitle(raw: string): string | undefined {
  const flat = raw.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return neutralise(cap(flat, ISSUE_LIMITS.titleChars - 20)).slice(0, ISSUE_LIMITS.titleChars);
}

/**
 * The body, bounded and safe. Fenced code is kept as written apart from the hidden characters and the length, because escaping
 * inside a fence would show as literal `&lt;`. Undefined when nothing is left of it.
 */
export function sanitizeIssueBody(raw: string): string | undefined {
  const text = cap(raw.replace(/\r\n?/g, "\n").replace(HIDDEN, "").trim(), ISSUE_LIMITS.bodyChars);
  if (!text) return undefined;
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : neutralise(line);
  }).join("\n");
}

/** The words every footer starts with: intake looks for them (and for a recorded filing) to tell the harness's own issue from anyone's. */
export const PROVENANCE_MARKER = "Filed by the harness's software factory agent";

/** Public disclosure only. Source identifiers belong in the private audit/store, never in this text or its hidden marker. */
export function provenanceFooter(): string {
  return `\n\n---\n_${PROVENANCE_MARKER}. It was written from a request and has not been reviewed by a person._\n${footerMarker({ role: "filing", stage: "issue" })}`;
}

/** Titles compare equal when they differ only in case, spacing and punctuation: the same request asked twice. */
export const titleKey = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
