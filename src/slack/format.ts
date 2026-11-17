/**
 * Slack's mrkdwn is not markdown. The model is told to use mrkdwn, but models
 * reach for `**bold**` and `## headings` out of habit, so we normalise before
 * posting. Fenced code blocks are passed through untouched.
 */

const MAX_MESSAGE = 3800;

function convertSegment(text: string): string {
  return (
    text
      // Headings have no mrkdwn equivalent; bold the line instead.
      .replace(/^#{1,6}\s+(.+)$/gm, (_m, heading: string) => `*${heading.trim()}*`)
      // **bold** -> *bold* (before single-asterisk handling)
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      // __italic__ -> _italic_
      .replace(/__([^_\n]+)__/g, "_$1_")
      // Markdown links -> Slack links
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
      // Bullet normalisation: "- " and "* " both render, but "•" is tidier.
      .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
  );
}

/** Convert markdown-ish model output to Slack mrkdwn, preserving code fences. */
export function toMrkdwn(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => (part.startsWith("```") ? part : convertSegment(part)))
    .join("")
    .trim();
}

/**
 * Split a long reply into Slack-sized chunks, breaking on paragraph then line
 * boundaries so code blocks and lists survive.
 */
export function chunk(text: string, limit = MAX_MESSAGE): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  // A chunk boundary can land inside a fenced block; reopen it so each message
  // renders as code rather than as stray backticks.
  return balanceFences(chunks);
}

function balanceFences(chunks: string[]): string[] {
  const out: string[] = [];
  let openFence: string | undefined;

  for (const raw of chunks) {
    let body = raw;
    if (openFence) body = `${openFence}\n${body}`;

    const fences = body.match(/```[^\n]*/g) ?? [];
    const unbalanced = fences.length % 2 === 1;
    if (unbalanced) {
      openFence = fences[fences.length - 1]!.startsWith("```") ? "```" : "```";
      body = `${body}\n\`\`\``;
    } else {
      openFence = undefined;
    }
    out.push(body);
  }
  return out;
}

/** Strip the bot mention from the start of a message. */
export function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}
