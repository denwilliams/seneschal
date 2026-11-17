import { test } from "node:test";
import assert from "node:assert/strict";
import { usage } from "./slack-user-token-help.ts";

test("help keeps the search guidance and lists the posting scopes", () => {
  const text = usage();
  assert.match(text, /search:read/);
  for (const s of ["chat:write", "im:write", "users:read", "channels:read", "groups:read", "im:read", "mpim:read"]) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /share\.postAs/);
  assert.match(text, /postAs\.user/);
});
