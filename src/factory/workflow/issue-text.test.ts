import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUE_LIMITS, provenanceFooter, sanitizeIssueBody, sanitizeIssueTitle, titleKey } from "./issue-text.ts";

test("a title is one bounded line: whitespace collapses, hidden and bidirectional characters go, nothing left is no title", () => {
  assert.equal(sanitizeIssueTitle("  Login   fails\n on\tempty password "), "Login fails on empty password");
  assert.equal(sanitizeIssueTitle("a\u0000b\u0007c‮d⁦e﻿f"), "abcdef");
  assert.equal(sanitizeIssueTitle(" \n\t\u0000 "), undefined);
  const long = sanitizeIssueTitle("x".repeat(500))!;
  assert.ok(long.length <= ISSUE_LIMITS.titleChars && long.endsWith("…"), `${long.length}`);
});

test("a mention is text, not a notification: users and teams are put in a code span, an email address and an existing code span are left alone", () => {
  assert.equal(sanitizeIssueTitle("Ask @alice and @acme/security about it"), "Ask `@alice` and `@acme/security` about it");
  assert.equal(sanitizeIssueBody("cc @bob\n@carol-x please look"), "cc `@bob`\n`@carol-x` please look");
  assert.equal(sanitizeIssueBody("write to me@example.com or `@already`"), "write to me@example.com or `@already`");
  assert.equal(sanitizeIssueBody("@channel @here @everyone"), "`@channel` `@here` `@everyone`");
});

test("a closing keyword cannot close another issue: its target is put in a code span", () => {
  assert.equal(sanitizeIssueBody("This fixes #12 and Closes acme/app#3, resolved: https://github.com/acme/app/issues/9."), "This fixes `#12` and Closes `acme/app#3`, resolved: `https://github.com/acme/app/issues/9.`");
  assert.equal(sanitizeIssueBody("See #12 for background"), "See #12 for background", "a plain reference is still a reference");
});

test("markup that would act on its own is made text: HTML tags and comments, and images that load a remote URL", () => {
  assert.equal(sanitizeIssueBody("<script>alert(1)</script> <!-- hidden --> a < b"), "&lt;script>alert(1)&lt;/script> &lt;!-- hidden --> a < b");
  assert.equal(sanitizeIssueBody("![tracker](https://evil.example/pixel.png)"), "!\\[tracker](https://evil.example/pixel.png)");
});

test("fenced code is kept as written, so a snippet does not show escapes", () => {
  const body = "Steps:\n```html\n<div id=\"a\">@x fixes #1</div>\n```\nthen <b>this</b>";
  assert.equal(sanitizeIssueBody(body), "Steps:\n```html\n<div id=\"a\">@x fixes #1</div>\n```\nthen &lt;b>this&lt;/b>");
  assert.equal(sanitizeIssueBody("~~~\n<i>x</i>\n~~~"), "~~~\n<i>x</i>\n~~~");
});

test("a body is bounded, has its line endings made plain, and is nothing when nothing is left", () => {
  assert.equal(sanitizeIssueBody("a\r\nb\rc"), "a\nb\nc");
  assert.equal(sanitizeIssueBody(" \u0000 \n"), undefined);
  assert.ok(sanitizeIssueBody("y".repeat(20_000))!.length <= ISSUE_LIMITS.bodyChars);
});

test("the public footer discloses agent authorship and lack of human review without source attribution", () => {
  assert.equal(provenanceFooter(), "\n\n---\n_Filed by the harness's software factory agent. It was written from a request and has not been reviewed by a person._\n<!-- harness:factory role=filing stage=issue -->");
});

test("two titles are the same request when they differ only in case, spacing and punctuation", () => {
  assert.equal(titleKey("Login fails: empty password!"), titleKey("  login FAILS - empty   password"));
  assert.notEqual(titleKey("Login fails"), titleKey("Logout fails"));
});
