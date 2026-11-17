import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { availableSkillNames, roleSkillGapMessage, roleSkillGaps, shippedAgentSetSkills } from "../../agent/skills.ts";
import { logger } from "../../util/log.ts";
import { fixture, HEAD, openProcess, reach, reply, startRun } from "./test-support.ts";

/**
 * A role in a workflow stage must have the skills its instructions name, and be able to open them through the same `read` the model
 * uses. Triage, coder and reviewer are told to follow a skill "if you have it", so losing one is silent; the deployer stops when it
 * is missing. These tests run the whole workflow and have each role read each of its skills.
 */

const systemText = (context: TranscriptContext): string =>
  (context.messages.filter((m) => m.role === "system") as unknown as { content: string; sections?: Record<string, string> }[])
    .flatMap((m) => [m.content, ...Object.values(m.sections ?? {})]).join("\n");
const textOf = (message: TranscriptContext["messages"][number]): string =>
  typeof message.content === "string" ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const FINALS: Record<string, string> = { github_triage: reply.triage(), coder: reply.implement(), reviewer: reply.review("APPROVED", 3), cloudflare_deployer: reply.deploy() };

/** The shipped skills a role's instructions name, from the example config itself. */
function namedSkills(instructions: string): string[] {
  const shipped = shippedAgentSetSkills();
  return [...new Set([...instructions.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)].map((m) => m[1]!).filter((name) => shipped.has(name)))];
}

async function workflowWithReads(t: TestContext, sandbox: Record<string, unknown> | undefined) {
  const f = fixture(t, { deployer: true, merge: { approvers: ["U1ADMIN"], deployEnvironment: "production" }, ...(sandbox ? { sandbox } : {}) });
  const p = await openProcess(f);
  const instructions = new Map(f.channel.agents.map((agent) => [agent.name, agent.instructions ?? ""]));
  const progress = new Map<string, { next: number; results: { skill: string; text: string }[]; listed: string }>();
  const router: FauxResponseFactory = (context) => {
    const system = systemText(context);
    const name = /You are `(github_triage|coder|reviewer|cloudflare_deployer)`/.exec(system)?.[1] ?? "unknown";
    const skills = namedSkills(instructions.get(name) ?? "");
    const state = progress.get(name) ?? { next: 0, results: [], listed: system };
    progress.set(name, state);
    const last = context.messages.at(-1)!;
    if (last.role === "toolResult") state.results.push({ skill: skills[state.next - 1]!, text: textOf(last) });
    if (state.next >= skills.length) return fauxAssistantMessage(FINALS[name]!);
    const skill = skills[state.next++]!;
    const location = new RegExp(`(/\\S*/${skill}/SKILL\\.md)`).exec(system)?.[1];
    if (!location) { state.results.push({ skill, text: "(not listed in the role's prompt)" }); return fauxAssistantMessage(`could not find ${skill}`); }
    return fauxAssistantMessage(fauxToolCall("read", { path: location }, { id: `r-${name}-${skill}` }), { stopReason: "toolUse" });
  };
  f.faux.setResponses(Array.from({ length: 80 }, () => router));
  const { runId } = await startRun(p);
  await reach(p, runId, ["waiting"], "merge");
  await p.store.decideFactoryRun(runId, "approve", "U1ADMIN", HEAD);
  await reach(p, runId, ["completed"]);
  return { progress, instructions };
}

for (const [label, sandbox] of [["no sandbox", undefined], ["a docker sandbox", { mode: "docker", network: "bridge" }]] as const) {
  test(`every role in a workflow run can open every skill its instructions name, with ${label}`, async (t) => {
    const { progress, instructions } = await workflowWithReads(t, sandbox);
    assert.deepEqual([...progress.keys()].sort(), ["cloudflare_deployer", "coder", "github_triage", "reviewer"], "all four roles ran");
    for (const [name, text] of instructions) {
      const wanted = namedSkills(text);
      const state = progress.get(name)!;
      assert.ok(wanted.length > 0, `${name} names at least one shipped skill`);
      for (const skill of wanted) {
        assert.match(state.listed, new RegExp(`/${skill}/SKILL\\.md`), `${name}'s prompt lists ${skill}`);
        const read = state.results.find((r) => r.skill === skill);
        assert.ok(read, `${name} read ${skill}`);
        assert.match(read!.text, new RegExp(`^---\\s*\\nname: ${skill}\\b`), `${name} could open ${skill} through read, and got: ${read!.text.slice(0, 120)}`);
      }
    }
  });
}

test("an agent set under another name loads none of the shipped skills, and the harness says so by name when the config loads", (t) => {
  const warnings: string[] = [];
  const warn = logger.warn;
  logger.warn = (message: string) => { warnings.push(message); };
  t.after(() => { logger.warn = warn; });
  const f = fixture(t, { agentSetName: "factory_team", deployer: true });
  const gaps = roleSkillGaps(f.channel, availableSkillNames(f.channel));
  assert.deepEqual(gaps.map((gap) => [gap.agent, gap.skills.sort(), gap.requireApproval]), [
    ["github_triage", ["factory-handoffs", "github-issue-triage"], false],
    ["coder", ["factory-handoffs"], false],
    ["reviewer", ["factory-handoffs"], false],
    ["cloudflare_deployer", ["cloudflare-deploy", "factory-handoffs"], true],
  ]);
  const message = roleSkillGapMessage(f.channel, gaps);
  assert.match(message, /agent-set-skills\/software_factory\//);
  assert.match(message, /named exactly `software_factory`/);
  assert.match(message, /"factory_team"/);
  const logged = warnings.filter((line) => /told to follow/.test(line));
  assert.equal(logged.length, 1, "once, however often the channel is resolved");
  assert.match(logged[0]!, /factory: .*`cloudflare_deployer`.*`cloudflare-deploy`/);

  // Correctly named: nothing is missing.
  const right = fixture(t, { deployer: true });
  assert.deepEqual(roleSkillGaps(right.channel, availableSkillNames(right.channel)), []);
});
