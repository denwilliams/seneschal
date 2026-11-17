import assert from "node:assert/strict";
import { test } from "node:test";
import { argsAllowed, patternMatches } from "./argv-patterns.ts";

test("wildcards match positional argv tokens, not option-shaped tokens", () => {
  assert.equal(patternMatches(["open", "*"], ["open", "https://example.com"]), true);
  assert.equal(patternMatches(["open", "*"], ["open", "--config=/tmp/evil.json"]), false);
  assert.equal(patternMatches(["open", "*"], ["open", "--headed"]), false);
  assert.equal(patternMatches(["search", "**"], ["search", "one", "two"]), true);
  assert.equal(patternMatches(["search", "**"], ["search", "--config=/tmp/evil.json"]), false);
  assert.equal(patternMatches(["search", "**"], ["search", "one", "-q"]), false);
});

test("literal option tokens remain explicitly allowlisted", () => {
  assert.equal(argsAllowed([["open", "--headed"]], ["open", "--headed"]), true);
  assert.equal(argsAllowed([["open", "--config=/safe/config.json"]], ["open", "--config=/safe/config.json"]), true);
});
