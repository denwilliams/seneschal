import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEnvValue, listSecretKeys, removeSecretValue, setSecretValue } from "./secretfile.ts";
import { parseEnvFile } from "./envfile.ts";

test("secret file helpers list names without values", () => {
  const content = "# comment\nexport BETA=two\nALPHA=one\nBAD-NAME=no\n";
  assert.deepEqual(listSecretKeys(content), ["ALPHA", "BETA"]);
});

test("setting a secret preserves comments, updates existing keys and appends new keys", () => {
  const updated = setSecretValue("# keep\nTOKEN=old\n", "TOKEN", "new value");
  assert.equal(updated, '# keep\nTOKEN="new value"\n');
  assert.equal(parseEnvFile(updated).TOKEN, "new value");

  const appended = setSecretValue(updated, "NEXT", "abc123");
  assert.equal(appended, '# keep\nTOKEN="new value"\nNEXT=abc123\n');
});

test("encoded values round-trip through the dotenv parser", () => {
  const value = "line 1\nline 2 with \"quote\" and backslash \\ here";
  const encoded = encodeEnvValue(value);
  assert.equal(parseEnvFile(`SECRET=${encoded}\n`).SECRET, value);
});

test("removing a secret deletes only that key", () => {
  const result = removeSecretValue("A=1\n# A=old\nB=2\n", "A");
  assert.equal(result.removed, true);
  assert.equal(result.content, "# A=old\nB=2\n");

  const missing = removeSecretValue(result.content, "C");
  assert.equal(missing.removed, false);
  assert.equal(missing.content, "# A=old\nB=2\n");
});
