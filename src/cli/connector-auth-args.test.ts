import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnectorAuthArgs } from "./connector-auth-args.ts";

test("connector-auth reset is explicit, target-specific and exclusive of completion", () => {
  assert.deepEqual(parseConnectorAuthArgs(["--config", "config/test.yaml", "--reset", "C123", "redbark"]), {
    config: "config/test.yaml", noWait: false, reset: true, positional: ["C123", "redbark"],
  });
  for (const argv of [
    ["--reset", "--result", "secret-payload", "C123", "redbark"],
    ["--reset", "--no-wait", "C123", "redbark"],
    ["--reset", "C123"], ["--unknown=secret-payload", "C123", "redbark"],
    ["--result", "--reset", "C123", "redbark"], ["--config=", "C123", "redbark"],
  ]) assert.throws(() => parseConnectorAuthArgs(argv), { message: "Invalid connector-auth arguments" });
});

test("connector-auth existing start and completion forms remain supported", () => {
  assert.equal(parseConnectorAuthArgs(["C123", "redbark"]).reset, false);
  assert.equal(parseConnectorAuthArgs(["--result=private-payload", "C123", "redbark"]).result, "private-payload");
  assert.equal(parseConnectorAuthArgs(["--no-wait", "C123", "redbark"]).noWait, true);
});
