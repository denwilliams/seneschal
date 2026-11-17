import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { HarnessConfigSchema, type FactoryMergeRules } from "../config/schema.ts";
import { hashWorkflow, SOFTWARE_FACTORY_WORKFLOW } from "../factory/workflow/definition.ts";
import { emptyFactoryRun, emptyRunSlack, type FactoryDecisionKind, type FactoryRunData, type RunSlack, type RunUpdate } from "../factory/workflow/docs.ts";
import { initialStages } from "../factory/workflow/transitions.ts";
import { exampleAgentSet, REPO } from "../factory/workflow/test-support.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { resolveChannel, type ResolvedChannel } from "../workspace/resolve.ts";
import type { FactoryRunStore } from "../factory/workflow/service.ts";
import { emptyIntakeNote, type IntakeNoteData } from "../factory/workflow/intake-docs.ts";
import type { PresenceSlack, PresenceStore } from "./factory-presence.ts";

/** What the Slack presence tests share: a real resolved factory channel, an in-memory run store and a Slack that records. */

export async function slackFactoryChannel(t: TestContext, options: { announce?: boolean; merge?: FactoryMergeRules; allowUsers?: string[]; dm?: boolean; intake?: boolean } = {}): Promise<ResolvedChannel> {
  const dir = mkdtempSync(join(tmpdir(), "factory-slack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const set = JSON.parse(JSON.stringify(exampleAgentSet())) as { software_factory: { agents: Record<string, { model?: string }> } };
  for (const agent of Object.values(set.software_factory.agents)) agent.model = "fixture/model";
  const config = HarnessConfigSchema.parse({
    agentSets: set,
    channels: {
      factory: {
        model: "fixture/model", agentSet: "software_factory", tools: ["read", "bash"],
        ...(options.allowUsers ? { allowUsers: options.allowUsers } : {}),
        factory: { name: "Acme", repositories: [REPO], ...(options.merge ? { merge: options.merge } : {}), ...(options.announce === undefined ? {} : { announce: options.announce }), ...(options.intake ? { intake: { enabled: true } } : {}) },
      },
    },
  });
  return resolveChannel(config, dir, { id: "C1", name: "factory", isDm: options.dm === true }, new ChannelRegistry(dir)).channel!;
}

/** A run partway through: triage and implement done, review in progress. */
export function aRun(overrides: Partial<FactoryRunData> = {}): FactoryRunData {
  const run: FactoryRunData = {
    ...emptyFactoryRun("fr_aaaa1111"), workflow: SOFTWARE_FACTORY_WORKFLOW.name, definition: JSON.stringify(SOFTWARE_FACTORY_WORKFLOW), hash: hashWorkflow(SOFTWARE_FACTORY_WORKFLOW), repo: REPO, issue: 7,
    issueTitle: "Login fails on an empty password", issueUrl: `https://github.com/${REPO}/issues/7`,
    by: { source: "agent", threadKey: "1700000000.000100", userId: "U1" },
    stages: initialStages(SOFTWARE_FACTORY_WORKFLOW), startedAt: 1_700_000_000_000, current: "review", costUsd: 0.5,
    ...overrides,
  };
  return run;
}

export function finished(run: FactoryRunData, stage: string, verdict: string, summary: string, extra: { report?: string; entry?: number; at?: number } = {}): FactoryRunData {
  const target = run.stages.find((s) => s.name === stage)!;
  target.status = "success";
  target.entries = Math.max(target.entries, extra.entry ?? 1);
  target.attempts.push({
    entry: extra.entry ?? 1, role: stage, runKey: `rk_${stage}_${target.attempts.length}`, status: "done", verdict, summary, report: extra.report ?? summary, reask: false,
    startedAt: (extra.at ?? 1_700_000_001_000) - 500, endedAt: extra.at ?? 1_700_000_001_000, durationMs: 500, costUsd: 0.1, steps: 3,
  });
  return run;
}

/** The store the presence and the service both use, with no engine under it. */
export class MemoryRuns implements PresenceStore, FactoryRunStore {
  runs = new Map<string, FactoryRunData>();
  decisions: { runId: string; decision: string; by: string; head: string; changes?: { feedback: string; since: number } }[] = [];
  slackWrites = 0;
  failSlackWrites = false;
  put(run: FactoryRunData): FactoryRunData { this.runs.set(run.runId, structuredClone(run)); return run; }
  async factoryRun(runId: string) { const run = this.runs.get(runId); return run && structuredClone(run); }
  async listFactoryRuns() { return [...this.runs.values()].map((run) => structuredClone(run)).reverse(); }
  async setFactoryRunSlack(runId: string, change: { channel?: string; ts?: string; posts?: number; event?: string; decision?: RunSlack["decision"] }) {
    if (this.failSlackWrites) throw new Error("store write failed");
    this.slackWrites++;
    const run = this.runs.get(runId)!;
    const slack = { ...emptyRunSlack(), ...run.slack };
    if (change.channel !== undefined) slack.channel = change.channel;
    if (change.ts !== undefined) slack.ts = change.ts;
    if (change.posts !== undefined) slack.posts = change.posts;
    if (change.decision !== undefined) slack.decision = { ...change.decision };
    if (change.event !== undefined && !slack.events.includes(change.event)) slack.events = [...slack.events, change.event];
    run.slack = slack;
  }
  note: IntakeNoteData = emptyIntakeNote();
  async intakeNote() { return structuredClone(this.note); }
  async setIntakeNote(change: { day?: string; channel?: string; ts?: string; counts?: Record<string, number>; event?: string }) {
    if (change.day !== undefined && change.day !== this.note.day) this.note = { ...emptyIntakeNote(), day: change.day };
    if (change.channel !== undefined) this.note.channel = change.channel;
    if (change.ts !== undefined) this.note.ts = change.ts;
    if (change.counts !== undefined) this.note.counts = { ...change.counts };
    if (change.event !== undefined && !this.note.events.includes(change.event)) this.note.events = [...this.note.events, change.event];
  }
  async startFactoryRun(): Promise<{ runId: string }> { throw new Error("not used"); }
  async decideFactoryRun(runId: string, decision: Exclude<FactoryDecisionKind, "">, by: string, head = "", _stage = "", changes?: { feedback: string; since: number }) { this.decisions.push({ runId, decision, by, head, ...(changes ? { changes } : {}) }); }
  async addFactoryRunUpdate(runId: string, update: RunUpdate) { const run = this.runs.get(runId); if (run) run.updates = [...run.updates, update]; }
  async abortFactoryRun(): Promise<"marked" | "terminal"> { return "marked"; }
}

export type SlackCall = { op: "post" | "update" | "permalink"; channel: string; ts?: string; threadTs?: string; text?: string; blocks?: unknown[] };

/** A Slack that records every call and fails on demand. */
export class FakeSlack implements PresenceSlack {
  calls: SlackCall[] = [];
  private n = 0;
  /** Called with each call before it succeeds; throw to fail it. */
  onCall: ((call: SlackCall) => void) | undefined;
  async post(args: { channel: string; threadTs?: string; text: string; blocks: unknown[] }) {
    const call: SlackCall = { op: "post", channel: args.channel, text: args.text, blocks: args.blocks, ...(args.threadTs ? { threadTs: args.threadTs } : {}) };
    this.onCall?.(call);
    this.calls.push(call);
    return { ts: `1800000000.${String(++this.n).padStart(6, "0")}` };
  }
  async update(args: { channel: string; ts: string; text: string; blocks: unknown[] }) {
    const call: SlackCall = { op: "update", channel: args.channel, ts: args.ts, text: args.text, blocks: args.blocks };
    this.onCall?.(call);
    this.calls.push(call);
  }
  async permalink(args: { channel: string; ts: string }) {
    this.calls.push({ op: "permalink", channel: args.channel, ts: args.ts });
    return `https://example.slack.com/archives/${args.channel}/p${args.ts.replace(".", "")}`;
  }
  posts() { return this.calls.filter((c) => c.op === "post"); }
  updates() { return this.calls.filter((c) => c.op === "update"); }
  replies() { return this.posts().filter((c) => c.threadTs); }
}

export const slackError = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code, ...extra } });

/** Time the test moves by hand: timers run when it says. */
export class ManualClock {
  time = 1_700_000_100_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now = () => this.time;
  schedule = (fn: () => void, ms: number): (() => void) => {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return () => { this.timers = this.timers.filter((timer) => timer.id !== id); };
  };
  get pending(): number { return this.timers.length; }
  /** Move time on and run what falls due, then let what that started settle. */
  async advance(ms: number): Promise<void> {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}
