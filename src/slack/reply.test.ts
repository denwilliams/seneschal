import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * A turn can produce several assistant messages: the agent answers, calls a
 * tool, then adds a closing remark. All of it is the reply.
 *
 * The bug this guards against: taking only the *last* assistant message as the
 * final text, which overwrote the streamed answer with the trailing remark —
 * the agent appeared to say "done!" while the actual content vanished.
 *
 * This mirrors the accumulation in HarnessApp.runAgent.
 */
function collectReply(
  events: Array<{ type: "assistant_start" } | { type: "delta"; text: string }>,
): string {
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };

  for (const event of events) {
    if (event.type === "assistant_start") flush();
    else current += event.text;
  }
  flush();
  return parts.join("\n\n");
}

test("a single-message reply is unchanged", () => {
  const reply = collectReply([
    { type: "assistant_start" },
    { type: "delta", text: "Why do Java developers wear glasses? " },
    { type: "delta", text: "Because they can't C#." },
  ]);
  assert.equal(reply, "Why do Java developers wear glasses? Because they can't C#.");
});

test("content before a tool call survives the closing remark", () => {
  const reply = collectReply([
    { type: "assistant_start" },
    { type: "delta", text: "Why do Java developers wear glasses? Because they can't C#." },
    // ... remember() runs here ...
    { type: "assistant_start" },
    { type: "delta", text: "That's joke #4 on the channel's list." },
  ]);

  assert.ok(reply.includes("can't C#"), "the joke must not be lost");
  assert.ok(reply.includes("joke #4"), "the closing remark is kept too");
  assert.equal(
    reply,
    "Why do Java developers wear glasses? Because they can't C#.\n\nThat's joke #4 on the channel's list.",
  );
});

test("empty assistant messages around tool calls add no blank sections", () => {
  const reply = collectReply([
    { type: "assistant_start" },
    // Tool-only message: no text at all.
    { type: "assistant_start" },
    { type: "delta", text: "Done." },
  ]);
  assert.equal(reply, "Done.");
});

test("three messages across two tool calls all survive", () => {
  const reply = collectReply([
    { type: "assistant_start" },
    { type: "delta", text: "First." },
    { type: "assistant_start" },
    { type: "delta", text: "Second." },
    { type: "assistant_start" },
    { type: "delta", text: "Third." },
  ]);
  assert.equal(reply, "First.\n\nSecond.\n\nThird.");
});

test("a reply with no text at all collapses to empty", () => {
  assert.equal(collectReply([{ type: "assistant_start" }]), "");
});
