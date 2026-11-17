import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessConfigSchema } from "../config/schema.ts";
import { resolveChannel } from "../workspace/resolve.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { createJobDeps } from "./deps.ts";
import { JobDefinitionSchema } from "./definition.ts";

test("jobs honor whole-CLI opt-in in both preflight and execution without broadening other commands", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "whole-cli-jobs-"));
  const command = { command: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "fixed"], allowArgs: [["**"]] };
  const config = HarnessConfigSchema.parse({
    cliTools: { trusted: { ...command, allowAllArgs: true }, restricted: command },
    channels: { jobs: { tools: ["exec"], exec: { shared: ["trusted", "restricted"] } } },
  });
  const channel = resolveChannel(config, dataDir, { id: "CJOBS", name: "jobs", isDm: false }, new ChannelRegistry(dataDir)).channel!;
  const deps = createJobDeps(channel);
  for (const name of ["trusted", "restricted"]) {
    const phase = JobDefinitionSchema.parse({ phases: [{ name: "run", kind: "exec", command: name, args: ["a", "--json"] }] }).phases[0]!;
    if (name === "trusted") {
      assert.equal(deps.phaseProblem(phase), undefined);
      const result = await deps.exec({ command: name, args: ["a", "--json"], signal: new AbortController().signal });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output.trim(), '["fixed","a","--json"]');
    } else {
      assert.match(deps.phaseProblem(phase)!, /not allowed/);
      await assert.rejects(() => deps.exec({ command: name, args: ["a", "--json"], signal: new AbortController().signal }), /arguments refused/);
    }
  }
  await assert.rejects(() => deps.exec({ command: "other", args: ["--help"], signal: new AbortController().signal }), /no command/);
  channel.tools = [];
  const phase = JobDefinitionSchema.parse({ phases: [{ name: "run", kind: "exec", command: "trusted", args: ["--help"] }] }).phases[0]!;
  assert.match(deps.phaseProblem(phase)!, /does not have the exec tool/);
});
