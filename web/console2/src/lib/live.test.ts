import { describe, expect, it } from "vitest";
import type { ThreadLiveEvent, TranscriptEntry } from "@api/api-types";
import { firstOwnEntry, hasDraftContent, mergeEntries, reduceDraft, replaceNewest, type Draft } from "./live";

const run = (events: ThreadLiveEvent[]) => events.reduce<Draft | undefined>(reduceDraft, undefined);
const entry = (id: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ key: String(id), id, role: "assistant", ...extra });

describe("reduceDraft", () => {
  it("accumulates streamed text", () => {
    const draft = run([{ kind: "message_start" }, { kind: "text_delta", delta: "Hel" }, { kind: "text_delta", delta: "lo" }]);
    expect(draft).toEqual({ text: "Hello", toolCalls: [], done: false });
  });
  it("tracks a tool call from pending to its outcome", () => {
    const pending = run([{ kind: "tool_start", callId: "a", name: "bash" }]);
    expect(pending?.toolCalls).toEqual([{ callId: "a", name: "bash", status: "pending" }]);
    const done = reduceDraft(pending, { kind: "tool_end", callId: "a", name: "bash", isError: true });
    expect(done?.toolCalls).toEqual([{ callId: "a", name: "bash", status: "error" }]);
  });
  it("records a tool end that was never seen starting", () => {
    expect(reduceDraft(undefined, { kind: "tool_end", callId: "z", name: "read", isError: false })?.toolCalls).toEqual([
      { callId: "z", name: "read", status: "ok" },
    ]);
  });
  it("keeps tool cards when the next message starts, but not its text", () => {
    const draft = run([
      { kind: "message_start" }, { kind: "text_delta", delta: "one" }, { kind: "tool_start", callId: "a", name: "bash" },
      { kind: "message_end" }, { kind: "message_start" },
    ]);
    expect(draft).toEqual({ text: "", done: false, toolCalls: [{ callId: "a", name: "bash", status: "pending" }] });
  });
  it("starts fresh text after a finished message even without message_start", () => {
    const draft = run([{ kind: "text_delta", delta: "a" }, { kind: "message_end" }, { kind: "text_delta", delta: "b" }]);
    expect(draft?.text).toBe("b");
  });
  it("ignores compaction and retry, and message_end with nothing open", () => {
    expect(reduceDraft(undefined, { kind: "compaction" })).toBeUndefined();
    expect(reduceDraft(undefined, { kind: "retry", attempt: 1 })).toBeUndefined();
    expect(reduceDraft(undefined, { kind: "message_end" })).toBeUndefined();
  });
  it("hasDraftContent is false for an empty draft", () => {
    expect(hasDraftContent(undefined)).toBe(false);
    expect(hasDraftContent({ text: "", toolCalls: [], done: false })).toBe(false);
    expect(hasDraftContent({ text: "x", toolCalls: [], done: false })).toBe(true);
  });
});

describe("mergeEntries", () => {
  it("dedupes by id, sorts ascending and lets the newer copy win", () => {
    const merged = mergeEntries([entry(3, { text: "old" }), entry(1)], [entry(2), entry(3, { text: "new" })]);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(merged[2]?.text).toBe("new");
  });
  it("finds where a fork's own history starts", () => {
    expect(firstOwnEntry([entry(1, { inherited: true }), entry(2, { inherited: true }), entry(3)])).toBe(2);
    expect(firstOwnEntry([entry(1, { inherited: true })])).toBe(-1);
  });
});

describe("entries that share a durable id", () => {
  const two = [entry(7, { role: "user", text: "q" }), entry(7, { key: "7.1", text: "a" })];

  it("keeps every message of a multi-message entry when merging", () => {
    const merged = mergeEntries([entry(5)], [...two, entry(9)]);
    expect(merged.map((e) => e.key)).toEqual(["5", "7", "7.1", "9"]);
    expect(mergeEntries(merged, two).map((e) => e.key)).toEqual(["5", "7", "7.1", "9"]);
  });

  it("orders messages within an entry by their suffix", () => {
    const merged = mergeEntries([entry(7, { key: "7.2" }), entry(7, { key: "7.10" })], [entry(7, { key: "7.1" }), entry(7)]);
    expect(merged.map((e) => e.key)).toEqual(["7", "7.1", "7.2", "7.10"]);
  });
});

describe("replaceNewest", () => {
  it("drops entries the server no longer has and keeps older pages", () => {
    const current = [entry(1), entry(2), entry(3), entry(4)];
    expect(replaceNewest(current, [entry(3, { text: "new" }), entry(5)]).map((e) => [e.id, e.text])).toEqual([[1, undefined], [2, undefined], [3, "new"], [5, undefined]]);
  });

  it("empties the list when the conversation was reset", () => {
    expect(replaceNewest([entry(1), entry(2)], [])).toEqual([]);
  });

  it("replaces every message of an entry that now holds fewer", () => {
    const current = [entry(7, { role: "user" }), entry(7, { key: "7.1" }), entry(8)];
    expect(replaceNewest(current, [entry(7, { role: "user" })]).map((e) => e.key)).toEqual(["7"]);
  });
});
