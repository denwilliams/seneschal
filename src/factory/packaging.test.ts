import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "../config/load.ts";

/**
 * Factory skills load from disk, rather than being compiled into the service.
 * Keep this packaging assertion close to the factory code so Docker releases
 * cannot silently omit lifecycle skills selected by a channel configuration.
 */
test("the harness runtime image includes reviewed factory lifecycle skills", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile.harness"), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:${NODE_VERSION}-bookworm-slim AS runtime"));

  assert.match(runtime, /^COPY factory-skills \.\/factory-skills$/m);
});

test("the harness runtime image includes the skills shipped with agent sets", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile.harness"), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:${NODE_VERSION}-bookworm-slim AS runtime"));

  assert.match(runtime, /^COPY agent-set-skills \.\/agent-set-skills$/m);
});
