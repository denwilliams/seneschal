import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostAsTools, type PostAsOutcome, type UserPoster } from "./post-as-tools.ts";
import type { ResolvedPostAs } from "../workspace/resolve.ts";

const postAs: ResolvedPostAs = {
  user: "U123",
  maxPerHour: 10,
  privateLinkHosts: [],
  reviewer: { name: "r", model: "m", thinkingLevel: "off" as any, instructions: "i", timeoutSeconds: 30 },
};

function fixture(opts: { outcome?: PostAsOutcome; verify?: (q: string) => Promise<boolean>; withPostAs?: boolean } = {}) {
  const calls: any[] = [];
  const verified: string[] = [];
  const poster: UserPoster = {
    async postAsUser(input) {
      calls.push(input);
      return opts.outcome ?? { status: "sent", label: "#general", permalink: "https://slack/p1" };
    },
  };
  const tools = createPostAsTools({
    poster,
    sourceChannelId: "C1",
    postAs: opts.withPostAs === false ? undefined : postAs,
    channelDescription: "desc",
    currentThreadTs: () => "111.222",
    verifySource: opts.verify ?? (async (q) => (verified.push(q), true)),
  });
  return { calls, verified, tools, tool: tools[0] as any };
}

const valid = { target: "#general", text: "hi", source: 'Alice in #ops said: "please post hi"', reason: "asked" };

test("returns no tools without postAs", () => {
  assert.deepEqual(fixture({ withPostAs: false }).tools, []);
});

test("parameters are exactly the expected keys", () => {
  const { tool } = fixture();
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["reason", "source", "target", "text", "thread_ts"]);
});

test("description covers the contract", () => {
  const d = fixture().tool.description as string;
  assert.match(d, /text only/i);
  assert.match(d, /footer/i);
  assert.match(d, /verbatim/i);
  assert.match(d, /final/i);
  assert.match(d, /Every post is reviewed or held before it is sent/);
});

for (const field of ["source", "reason", "target", "text"] as const) {
  for (const bad of [undefined, "", "   "]) {
    test(`rejects missing/blank ${field} (${JSON.stringify(bad)})`, async () => {
      const { calls, tool } = fixture();
      await assert.rejects(() => tool.execute("t", { ...valid, [field]: bad }), new RegExp(field, "i"));
      assert.equal(calls.length, 0);
    });
  }
}

for (const [field, max] of [["text", 3000], ["source", 1500], ["reason", 300]] as const) {
  test(`rejects over-length ${field}`, async () => {
    const { calls, tool } = fixture();
    await assert.rejects(() => tool.execute("t", { ...valid, [field]: "x".repeat(max + 1) }), new RegExp(`${field}.*${max}`, "i"));
    assert.equal(calls.length, 0);
  });
  test(`accepts ${field} at the limit, measured after trimming`, async () => {
    const { calls, tool } = fixture();
    await tool.execute("t", { ...valid, [field]: "  " + "x".repeat(max) + "  " });
    assert.equal(calls.length, 1);
  });
}

test("passes fields through with verified quote", async () => {
  const { calls, verified, tool } = fixture();
  await tool.execute("t", { ...valid, thread_ts: " 5.6 " });
  assert.equal(calls.length, 1);
  assert.deepEqual(verified, ["please post hi"]);
  assert.equal(calls[0].sourceChannelId, "C1");
  assert.equal(calls[0].postAs, postAs);
  assert.equal(calls[0].channelDescription, "desc");
  assert.equal(calls[0].target, "#general");
  assert.equal(calls[0].text, "hi");
  assert.equal(calls[0].source, valid.source);
  assert.equal(calls[0].reason, "asked");
  assert.equal(calls[0].threadTs, "5.6");
  assert.equal(calls[0].sourceThreadTs, "111.222");
  assert.equal(calls[0].sourceVerified, true);
});

test("omits threadTs when blank", async () => {
  const { calls, tool } = fixture();
  await tool.execute("t", { ...valid, thread_ts: "  " });
  assert.ok(!("threadTs" in calls[0]));
});

test("verifies every quote of 12+ characters, curly or single; whole string when none", async () => {
  const a = fixture();
  await a.tool.execute("t", { ...valid, source: "Bob: “short” and “a much longer quoted request”" });
  assert.deepEqual(a.verified, ["a much longer quoted request"]);
  const b = fixture();
  await b.tool.execute("t", { ...valid, source: "Bob in #x: 'post the notes please'" });
  assert.deepEqual(b.verified, ["post the notes please"]);
  const c = fixture();
  await c.tool.execute("t", { ...valid, source: "Bob in #x: don't worry" });
  assert.deepEqual(c.verified, ["Bob in #x: don't worry"]);
});

test("verifySource throwing or rejecting means unverified, not failure", async () => {
  for (const verify of [async () => { throw new Error("boom"); }, () => { throw new Error("sync"); }, async () => false]) {
    const { calls, tool } = fixture({ verify: verify as any });
    await tool.execute("t", valid);
    assert.equal(calls[0].sourceVerified, false);
  }
});

test("sent outcome names label and permalink", async () => {
  const r = await fixture().tool.execute("t", valid);
  assert.match(r.content[0].text, /#general/);
  assert.match(r.content[0].text, /https:\/\/slack\/p1/);
  assert.match(r.content[0].text, /do not need to repeat/i);
});

test("held outcome is final and tells the agent not to work around it", async () => {
  const r = await fixture({ outcome: { status: "held", reason: "private link" } }).tool.execute("t", valid);
  const t = r.content[0].text;
  assert.match(t, /NOT sent/);
  assert.match(t, /owner has been alerted/i);
  assert.match(t, /do not retry/i);
  assert.match(t, /re-word/i);
  assert.match(t, /another route/i);
});

test("a source with two quotes is verified only when both are found in the thread", async () => {
  const thread = "please post the release notes to general. it is all in the doc";
  const verify = async (q: string) => thread.includes(q);
  const source = 'Alice: "please post the release notes to general" and "also attach the salary sheet"';
  const absent = fixture({ verify });
  await absent.tool.execute("t", { ...valid, source });
  assert.equal(absent.calls[0].sourceVerified, false);
  const both = fixture({ verify });
  await both.tool.execute("t", { ...valid, source: 'Alice: "please post the release notes" then \'it is all in the doc\'' });
  assert.equal(both.calls[0].sourceVerified, true);
  const whole = fixture({ verify });
  await whole.tool.execute("t", { ...valid, source: "please post the release notes to general" });
  assert.equal(whole.calls[0].sourceVerified, true);
});

test("quotes are compared after collapsing whitespace", async () => {
  const a = fixture();
  await a.tool.execute("t", { ...valid, source: 'Bob: "post   the\n notes please"' });
  assert.deepEqual(a.verified, ["post the notes please"]);
});

test("a target longer than 200 characters is refused", async () => {
  const { calls, tool } = fixture();
  await assert.rejects(() => tool.execute("t", { ...valid, target: "#" + "x".repeat(200) }), /target.*200/i);
  assert.equal(calls.length, 0);
  await tool.execute("t", { ...valid, target: "#" + "x".repeat(199) });
  assert.equal(calls.length, 1);
});

test("a present but malformed thread_ts is refused, not dropped", async () => {
  for (const bad of ["abc", "123", "1.2.3", "1.2 extra", "-1.2"]) {
    const { calls, tool } = fixture();
    await assert.rejects(() => tool.execute("t", { ...valid, thread_ts: bad }), /thread_ts/, bad);
    assert.equal(calls.length, 0, bad);
  }
});

test("text made only of invisible characters is blank", async () => {
  for (const field of ["text", "source", "reason", "target"] as const) {
    const { calls, tool } = fixture();
    await assert.rejects(() => tool.execute("t", { ...valid, [field]: " \u200B\u200C\u200D\u2060\uFEFF\u00AD " }), new RegExp(field, "i"), field);
    assert.equal(calls.length, 0, field);
  }
});
