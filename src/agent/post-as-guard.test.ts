import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDraft, RateLimiter, BUILTIN_PRIVATE_LINK_HOSTS } from "./post-as-guard.ts";

const opts = { privateLinkHosts: ["wiki.example.com"] };
const held = (text: string, o = opts) => {
  const r = checkDraft(text, o);
  assert.equal(r.hold, true, text);
  return r.hold ? r.reason : "";
};

test("holds private links, including label-hidden, case and subdomain variants", () => {
  assert.match(held("see https://docs.google.com/document/d/1/edit"), /private link/i);
  assert.match(held("<https://DOCS.GOOGLE.COM/x|totally harmless>"), /private link/i);
  held("<https://docs.google.com/d/1|see notes>");
  held("<https://example.com/ok|https://example.com/ok> and <https://notion.so/x|y>");
  held("https://team.atlassian.net/wiki/x");
  held("https://a.b.sharepoint.com/x");
  held("https://wiki.example.com/page");
  held("https://eu.wiki.example.com/page");
  held("https://acme.slack.com/archives/C0123/p123");
  held("https://example.com@docs.google.com/x");
  held("docs.google.com/document/d/1");
  held("https://confluence.corp.example.net/x");
});

test("messy custom hosts are normalised; empties are ignored", () => {
  held("https://intranet.test/a", { privateLinkHosts: ["  HTTPS://Intranet.Test/path ", ""] });
  assert.equal(checkDraft("https://example.com/blog", { privateLinkHosts: ["", "  "] }).hold, false);
});

test("lookalike hosts and malformed urls do not match or throw", () => {
  assert.equal(checkDraft("https://notnotion.so/x", opts).hold, false);
  assert.equal(checkDraft("https://slack.com/archives/x", opts).hold, false);
  assert.equal(checkDraft("https://acme.slack.com/help", opts).hold, false);
  assert.doesNotThrow(() => checkDraft("http://[bad <http://|x> https://%zz.com", opts));
  assert.ok(BUILTIN_PRIVATE_LINK_HOSTS.includes("notion.so"));
});

test("holds secrets", () => {
  assert.match(held("AKIAABCDEFGHIJKLMNOP"), /secret|credential/i);
  held("xoxb-1234-abcd");
  held("-----BEGIN PRIVATE KEY-----");
  held("ghp_" + "a".repeat(36));
});

test("holds broadcast mentions", () => {
  for (const t of ["<!channel> hi", "<!here>", "<!everyone>", "<!subteam^S123>"]) {
    assert.match(held(t), /mention/i);
  }
});

test("passes plain text, ordinary links and a single-person mention", () => {
  for (const t of ["just a note", "read https://example.com/blog", "hi <@U123>"]) {
    assert.deepEqual(checkDraft(t, opts), { hold: false });
  }
});

test("RateLimiter is a sliding hour window with independent keys", () => {
  let now = 1_000_000;
  const rl = new RateLimiter(() => now);
  for (let i = 0; i < 10; i++) assert.equal(rl.take("a", 10), true);
  assert.equal(rl.take("a", 10), false);
  assert.equal(rl.take("b", 10), true);
  now += 3_600_001;
  assert.equal(rl.take("a", 10), true);
});

test("holds private URLs nested in another URL's path or query, including encoded", () => {
  held("https://www.google.com/url?q=https://docs.google.com/d/1");
  held("https://example.com/r?u=docs.google.com/d/1");
  held("https://example.com/r?u=https%3A%2F%2Fdocs.google.com%2Fd%2F1");
  held("https://a.com/r?u=https%3A%2F%2Fb.com%2Fr%3Fu%3Dhttps%253A%252F%252Fnotion.so%252Fx");
  assert.doesNotThrow(() => checkDraft("https://example.com/r?u=%E0%A4%A", opts));
});

test("holds credentials glued to other characters", () => {
  held("key_AKIAABCDEFGHIJKLMNOP");
  held("token_ghp_" + "a".repeat(36));
  held("x_xoxb-1234-abcd");
});

test("ordinary prose and lookalikes still pass", () => {
  for (const t of ["https://notnotion.so/x", "https://dropbox.com.evil.com/x", "https://inbox.com/x", "Node.js and README.md at v1.2.3", "https://example.com/r?u=https://example.org/x"]) {
    assert.deepEqual(checkDraft(t, opts), { hold: false }, t);
  }
});

test("holds private links hidden by repeated percent-encoding", () => {
  held("https://a.com/r?u=https%253A%252F%252Fdocs.google.com%252Fd%252F1");
  held("https://a.com/r?u=https%25253A%25252F%25252Fdocs.google.com%25252Fd%25252F1");
  held("https://a.com/r?u=https%253A%252F%252Fdocs%25252Egoogle%25252Ecom%252Fd");
  held("100% sure: https://a.com/r?u=https%253A%252F%252Fdocs.google.com%252Fd%252F1");
});

test("holds private links with an encoded or lookalike dot in the host", () => {
  held("https://docs%2egoogle%2ecom/d/1");
  held("https://docs%2Egoogle%2Ecom/d/1");
  held("100% sure https://docs%2egoogle%2ecom/d/1 %zz");
  held("https://docs．google．com/d/1");
  held("https://docs。google。com/d/1");
  held("https://docs｡google｡com/d/1");
  held("https://docs﹒google﹒com/d/1");
  held("https://docs%E3%80%82google%E3%80%82com/d/1");
  held("https://a.com/r?u=https%3A%2F%2Fdocs%EF%BC%8Egoogle%EF%BC%8Ecom%2Fd");
  held("https://ｄｏｃｓ.google.com/d/1");
});

test("holds private links and secrets with invisible characters inside", () => {
  held("https://docs.goo​gle.com/d/1");
  held("https://docs.goo­gle.com/d/1");
  held("https://docs.goo⁠gle.com/d/1");
  held("https://docs.goo﻿gle.com/d/1");
  held("https://docs.goo‍gle.com/d/1");
  held("https://docs.goo⁡gle.com/d/1");
  held("https://docs.goo️gle.com/d/1");
  held("https://docs.goo᠎gle.com/d/1");
  assert.match(held("AKIA​ABCDEFGHIJKLMNOP"), /secret|credential/i);
  assert.match(held("xox­b-1234-abcd"), /secret|credential/i);
});

test("normalisation and decoding never throw on hostile input", () => {
  for (const t of ["%", "%%%", "%E0%A4%A", "%25".repeat(50) + "zz", "．".repeat(100), "https://" + "%25".repeat(10) + "2e.com", "\uD800 https://x.com"]) {
    assert.doesNotThrow(() => checkDraft(t, opts), t);
  }
});

test("holds the wider set of credential shapes", () => {
  const cases: [string, string][] = [
    ["anthropic", "sk-ant-api03-" + "a".repeat(30)],
    ["google api key", "AIza" + "B".repeat(35)],
    ["google oauth", "ya29." + "c".repeat(30)],
    ["aws sts", "ASIA" + "ABCDEFGHIJ012345"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["slack app token", "xapp-1-ABC-123-def"],
    ["slack refresh token", "xoxe-1-abc"],
    ["slack rotated token", "xoxe.xoxp-1-abc"],
    ["github fine-grained", "github_pat_" + "D".repeat(30)],
    ["openai project", "sk-proj-" + "e".repeat(24)],
    ["stripe live", "sk-live_" + "f".repeat(24)],
    ["stripe test", "sk-test_" + "g".repeat(24)],
    ["bare sk-", "sk-" + "h".repeat(24)],
  ];
  for (const [name, t] of cases) assert.match(held(`here: ${t}`), /secret|credential/i, name);
});

test("holds OneDrive links", () => {
  held("https://onedrive.live.com/edit?id=1");
  held("https://1drv.ms/w/s!abc");
});

test("ordinary prose with secret-like words still passes", () => {
  for (const t of ["The task-force has a skill-based plan for asking about it.", "We met at the sk-8 park and discussed ASIAN markets.", "Our desk-booking flow is fine."]) {
    assert.deepEqual(checkDraft(t, opts), { hold: false }, t);
  }
});

test("an invalid byte in an encoded run does not leave the rest of it encoded", () => {
  held("https://a.com/r?u=https%3A%2F%2F%FF%40docs.google.com%2Fd%2F1");
  held("https://a.com/r?u=https%3A%2F%2F%FF%40%64%6F%63%73%E3%80%82%67oogle.com");
  held("https://a.com/r?u=%FF" + encodeURIComponent("https://docs.google.com/d/1"));
});

test("a draft of tens of thousands of escapes is scanned quickly", () => {
  const big = "https://a.com/r?u=" + "%41%FF".repeat(19_500);
  const started = Date.now();
  assert.equal(checkDraft(big, opts).hold, false);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});
