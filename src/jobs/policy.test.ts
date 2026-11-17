import assert from "node:assert/strict";
import { test } from "node:test";
import { HarnessConfigSchema } from "../config/schema.ts";
import { JobDefinitionSchema } from "./definition.ts";
import { jobProblem, phaseProblem, type JobChannel } from "./policy.ts";

const channel = (over: { tools?: string[]; allow?: string[][] } = {}): JobChannel => {
  const config = HarnessConfigSchema.parse({
    channels: { C1: { tools: over.tools ?? ["read", "exec"], exec: { commands: { git: { command: "/usr/bin/git", allowArgs: over.allow ?? [["log", "--oneline", "*"], ["status"]] } } } } },
  });
  const entry = config.channels.C1!;
  return { tools: entry.tools as never, exec: { commands: entry.exec!.commands as never, shared: [] } } as JobChannel;
};
const job = (phases: unknown[]) => JobDefinitionSchema.parse({ input: { x: { default: "1" } }, phases });
const exec = (name: string, command: string, args: string[] = []) => ({ name, kind: "exec", command, args });

test("a state phase needs nothing from the channel", () => {
  assert.equal(phaseProblem(job([{ name: "s", kind: "state", op: "set", path: "/a", value: 1 }]).phases[0]!, channel({ tools: ["read"] })), undefined);
});

test("an exec phase needs the exec tool: a job can never do more than the channel could", () => {
  const phase = job([exec("a", "git", ["status"])]).phases[0]!;
  assert.match(phaseProblem(phase, channel({ tools: ["read"] }))!, /does not have the exec tool/);
  assert.equal(phaseProblem(phase, channel()), undefined);
});

test("an exec phase must name a command in this channel's own policy", () => {
  const problem = phaseProblem(job([exec("a", "rm")]).phases[0]!, channel())!;
  assert.match(problem, /no command "rm" in this channel's exec policy/);
  assert.match(problem, /it has "git"/);
});

test("literal arguments are checked against the allowlist now; templated ones wait until run time", () => {
  assert.equal(phaseProblem(job([exec("a", "git", ["log", "--oneline", "main"])]).phases[0]!, channel()), undefined);
  assert.match(phaseProblem(job([exec("a", "git", ["push", "--force"])]).phases[0]!, channel())!, /not allowed for "git"/);
  assert.equal(phaseProblem(job([{ name: "a", kind: "exec", command: "git", args: ["push", "${input.x}"] }, ]).phases[0]!, channel()), undefined, "cannot be known yet, so the run-time check is the one that counts");
  assert.match(phaseProblem(job([exec("a", "git", ["$" + "${literal}"])]).phases[0]!, channel())!, /not allowed/, "an escaped $${ is literal text and is checked as such");
});

test("a job's problem names the first phase that cannot run", () => {
  const definition = job([{ name: "ok", kind: "state", op: "set", path: "/a", value: 1 }, exec("deploy", "kubectl")]);
  assert.match(jobProblem(definition, channel())!, /^phase "deploy": there is no command "kubectl"/);
  assert.equal(jobProblem(job([exec("a", "git", ["status"])]), channel()), undefined);
});
