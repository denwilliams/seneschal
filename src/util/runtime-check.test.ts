import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSupportedNode, nodeVersionProblem } from "./runtime-check.ts";

test("Node versions below 22.19 are refused with an actionable message, newer ones pass", () => {
  for (const ok of ["22.19.0", "22.22.3", "23.0.0", "24.14.0", "30.1.0"]) assert.equal(nodeVersionProblem(ok), undefined, ok);
  for (const bad of ["22.18.9", "22.0.0", "20.19.0", "18.20.4"]) {
    assert.match(nodeVersionProblem(bad)!, /22\.19 or newer is required.*Dockerfile\.harness/s, bad);
  }
  assert.throws(() => assertSupportedNode("21.7.0"), /22\.19 or newer/);
  assert.doesNotThrow(() => assertSupportedNode());
});
