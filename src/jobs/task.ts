import { awaitWithContext } from "@earendil-works/chord/context";
import { defineTask, type Task } from "@earendil-works/pi-durable";
import { AppStateDoc, applyStateUpdate } from "../agent/durable/state-doc.ts";
import { readPath, parsePointer, type StateJson, type StateObject } from "../agent/durable/state.ts";
import {
  JobDefinitionSchema, JOB_LIMITS, renderTemplate, renderValue, TemplateError, type ExecPhase, type JobDefinition, type JobPhase, type RenderContext, type StatePhase,
} from "./definition.ts";
import { emptyDecision, emptyRun, JOB_TASK_KIND, JobDecisionFamily, JobRunFamily, type JobRunData, type PhaseRun } from "./docs.ts";

/**
 * The job task: one durable task per run, owned by the channel's main conversation as a background task, so a stop of the
 * conversation does not end it and `!stop` does not hide it from `inspect()`.
 *
 * The rules it follows come from what pi-durable does on a restart (tasks-characterization.test.ts): a task resumes in the
 * phase it was in, and replays that phase if it had not committed its checkpoint.
 *
 *  - A `state` step is one commit that applies the change, records the phase done and moves on, so replaying it is harmless.
 *  - An `exec` step commits "started" BEFORE it runs the command and the result AFTER. Finding "started" when it is
 *    entered means the command may have run and its result was lost, so it is never run again on its own: the run goes to
 *    `needs_decision` and waits for someone to say retry, skip or abort.
 */

export interface ExecResult {
  exitCode: number | null;
  /** Just the command's output, capped. */
  output: string;
  timedOut: boolean;
  truncated: boolean;
  aborted: boolean;
  startError?: string;
}

/** What a run needs from its channel. Resolved when a phase runs, so a store reopened on new config uses the new rules. */
export interface JobDeps {
  exec(input: { command: string; args: string[]; timeoutSeconds?: number; signal: AbortSignal }): Promise<ExecResult>;
  /** Why this phase may not run in this channel right now, or undefined when it may. Checked before an effect starts. */
  phaseProblem(phase: JobPhase): string | undefined;
  /** Told after a run's state changes. Best effort: a failure here never affects the run. */
  onChange?(run: JobRunData): void;
}

export type JobTaskInput = { runId: string };
export type JobTaskState =
  | { phase: "step"; index: number; started: boolean }
  | { phase: "decide"; index: number };
export type JobTaskResult = { status: "completed" | "failed" | "aborted" };
export type JobTask = Task<JobTaskInput, JobTaskState, JobTaskResult, object>;

type NextState = { status: "running"; checkpoint: JobTaskState } | { status: "terminal"; outcome: { status: "completed"; result: JobTaskResult } | { status: "failed"; error: { message: string } } | { status: "aborted"; reason: string } };

const RESULT_NOTE = "\n[output cut]";

/** A phase result is stored with a bound, and says when it was cut. */
export function boundResult(text: string): string {
  return text.length <= JOB_LIMITS.valueChars ? text : `${text.slice(0, JOB_LIMITS.valueChars - RESULT_NOTE.length)}${RESULT_NOTE}`;
}

const summaryOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
};

function definitionOf(run: JobRunData): JobDefinition | undefined {
  try {
    const parsed = JobDefinitionSchema.safeParse(JSON.parse(run.definition));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function contextFor(run: JobRunData, state: StateObject): RenderContext {
  return {
    input: run.input,
    results: Object.fromEntries(Object.entries(run.results).map(([name, value]) => [name, { result: value.result, exit: value.exit < 0 ? null : value.exit }])),
    state: (path) => {
      let segments: string[];
      try { segments = parsePointer(path); } catch { return undefined; }
      const found = readPath(state, segments);
      if (!found.found) return undefined;
      return typeof found.value === "string" ? found.value : JSON.stringify(found.value);
    },
  };
}

const terminal = (status: JobTaskResult["status"], reason: string): NextState =>
  status === "completed" ? { status: "terminal", outcome: { status: "completed", result: { status } } }
    : status === "failed" ? { status: "terminal", outcome: { status: "failed", error: { message: reason } } }
      : { status: "terminal", outcome: { status: "aborted", reason } };

export function makeJobTask(getDeps: () => JobDeps | undefined): JobTask {
  type Runtime = Parameters<Parameters<typeof defineTask<JobTaskInput, JobTaskState, JobTaskResult>>[0]["phases"]["step"]>[1];
  type Context = Parameters<Parameters<typeof defineTask<JobTaskInput, JobTaskState, JobTaskResult>>[0]["phases"]["step"]>[2];

  const notify = (run: JobRunData | undefined) => {
    if (!run) return;
    try { getDeps()?.onChange?.(run); } catch { /* observers never affect a run */ }
  };
  const snapshotOf = async (runtime: Runtime, runId: string, context: Context): Promise<JobRunData | undefined> => {
    const run = await runtime.snapshot(JobRunFamily, runId, context);
    return run && run.job ? (JSON.parse(JSON.stringify(run)) as JobRunData) : undefined;
  };

  /** End the run: record why, and make the task terminal, in one commit. */
  const end = async (runtime: Runtime, context: Context, runId: string, status: JobTaskResult["status"], reason: string, mark?: { index: number; phase: Partial<PhaseRun> }) => {
    await runtime.commit(async (tx) => {
      const run = await tx.doc(JobRunFamily, runId, emptyRun(runId));
      const now = runtime.now();
      if (mark && run.phases[mark.index]) Object.assign(run.phases[mark.index]!, mark.phase);
      run.status = status;
      run.reason = reason;
      run.endedAt = now;
      run.updatedAt = now;
      return terminal(status, reason);
    }, context);
    notify(await snapshotOf(runtime, runId, context));
  };

  /** Advance to the next phase after the phase at `index` finished, with `phase` fields recorded on it. */
  const advance = async (runtime: Runtime, context: Context, runId: string, index: number, phase: Partial<PhaseRun>, extra?: (run: JobRunData) => void) => {
    await runtime.commit(async (tx) => {
      const run = await tx.doc(JobRunFamily, runId, emptyRun(runId));
      const now = runtime.now();
      Object.assign(run.phases[index]!, phase, { endedAt: now });
      extra?.(run as unknown as JobRunData);
      run.index = index + 1;
      run.status = "running";
      run.updatedAt = now;
      return { status: "running", checkpoint: { phase: "step", index: index + 1, started: false } } satisfies NextState;
    }, context);
    notify(await snapshotOf(runtime, runId, context));
  };

  return defineTask<JobTaskInput, JobTaskState, JobTaskResult>({
    name: JOB_TASK_KIND,
    version: 1,
    initial: () => ({ phase: "step", index: 0, started: false }),
    phases: {
      step: async (task, runtime, context) => {
        const { runId } = task.input;
        const { index, started } = task.state.checkpoint;
        const run = await snapshotOf(runtime, runId, context);
        if (!run) return end(runtime, context, runId, "failed", "the run's record is missing");
        const definition = definitionOf(run);
        if (!definition) return end(runtime, context, runId, "failed", "the run's pinned definition is unreadable");
        if (index >= definition.phases.length) return end(runtime, context, runId, "completed", "");
        const phase = definition.phases[index]!;
        const deps = getDeps();
        if (!deps) return end(runtime, context, runId, "failed", "jobs are not available in this channel's store");

        if (phase.kind === "state") return stateStep(runtime, context, runId, index, phase, run);

        // exec
        if (started) {
          // Entered with "started" already committed: the command may have run and its result was lost. Never run it again
          // on its own; wait for a person to choose.
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(JobRunFamily, runId, emptyRun(runId));
            doc.status = "needs_decision";
            doc.reason = `Phase "${phase.name}" was interrupted (the harness stopped while it ran), so it may or may not have taken effect. Retry it, skip it, or abort the run.`;
            doc.phases[index]!.summary = "interrupted: waiting for a decision";
            doc.updatedAt = runtime.now();
            return { status: "running", checkpoint: { phase: "decide", index } } satisfies NextState;
          }, context);
          notify(await snapshotOf(runtime, runId, context));
          return;
        }
        const problem = deps.phaseProblem(phase);
        if (problem) return end(runtime, context, runId, "failed", `phase "${phase.name}" is not permitted now: ${problem}`, { index, phase: { status: "failed", summary: summaryOf(problem) } });
        const stateNow = ((await runtime.snapshot(AppStateDoc, context))?.value ?? {}) as StateObject;
        let args: string[];
        try {
          args = (phase as ExecPhase).args.map((text) => renderTemplate(text, contextFor(run, stateNow)));
        } catch (error) {
          const message = error instanceof TemplateError ? error.message : String(error);
          return end(runtime, context, runId, "failed", `phase "${phase.name}": ${message}`, { index, phase: { status: "failed", summary: summaryOf(message) } });
        }
        // Intent first. Everything after this line may be lost to a crash; this line may not.
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(JobRunFamily, runId, emptyRun(runId));
          const now = runtime.now();
          Object.assign(doc.phases[index]!, { status: "running", startedAt: now, summary: "" });
          doc.status = "running";
          doc.updatedAt = now;
          return { status: "running", checkpoint: { phase: "step", index, started: true } } satisfies NextState;
        }, context);
        notify(await snapshotOf(runtime, runId, context));

        const exec = phase as ExecPhase;
        let outcome: ExecResult;
        try {
          outcome = await deps.exec({ command: exec.command, args, ...(exec.timeoutSeconds ? { timeoutSeconds: exec.timeoutSeconds } : {}), signal: runtime.signal });
        } catch (error) {
          outcome = { exitCode: null, output: "", timedOut: false, truncated: false, aborted: false, startError: error instanceof Error ? error.message : String(error) };
        }
        // The harness is going down (or the run was aborted) while the command ran: leave "started" in place, so the next
        // invocation reports the interruption instead of recording a result that never was.
        if (outcome.aborted) await awaitWithContext(new Promise<never>(() => {}), context);

        const ok = outcome.exitCode === 0 && !outcome.startError && !outcome.timedOut;
        const result = boundResult(outcome.output.trimEnd());
        const note = outcome.startError ? `could not start: ${outcome.startError}` : outcome.timedOut ? "timed out" : outcome.exitCode === null ? "killed" : `exit ${outcome.exitCode}`;
        const summary = summaryOf(`${note}${result ? ` — ${result}` : ""}`);
        const exit = outcome.exitCode ?? -1;
        if (!ok && exec.onFailure === "fail") {
          await runtime.commit(async (tx) => {
            const doc = await tx.doc(JobRunFamily, runId, emptyRun(runId));
            doc.results[phase.name] = { result, exit };
            return undefined;
          }, context);
          return end(runtime, context, runId, "failed", `phase "${phase.name}" failed: ${note}`, { index, phase: { status: "failed", exit, summary, endedAt: runtime.now() } });
        }
        await advance(runtime, context, runId, index, { status: ok ? "done" : "failed", exit, summary }, (doc) => { doc.results[phase.name] = { result, exit }; });
      },

      decide: async (task, runtime, context) => {
        const { runId } = task.input;
        const { index } = task.state.checkpoint;
        await runtime.commit(async (tx) => { await tx.doc(JobDecisionFamily, runId, emptyDecision()); return undefined; }, context);
        const watch = await runtime.watchDoc(JobDecisionFamily, runId, context);
        if (!watch) throw new Error("the decision document should exist");
        const decided = (value: { decision: string } | null) => value !== null && value.decision !== "";
        if (!decided(watch.value)) {
          await awaitWithContext(new Promise<void>((resolve) => { watch.start(async (call) => { if (call.kind === "failed") throw call.error; if (!call.retired && decided(call.value)) resolve(); }); }), context);
        }
        await watch.stop();
        const choice = (await runtime.snapshot(JobDecisionFamily, runId, context))!;
        const decision = choice.decision;
        // Consume the decision in the same commit that acts on it, so one decision is acted on once.
        const consume = async (tx: Parameters<Parameters<typeof runtime.commit>[0]>[0]) => {
          const doc = await tx.doc(JobDecisionFamily, runId, emptyDecision());
          doc.decision = "";
        };
        if (decision === "retry") {
          await runtime.commit(async (tx) => {
            await consume(tx);
            const run = await tx.doc(JobRunFamily, runId, emptyRun(runId));
            run.status = "running";
            run.reason = "";
            run.phases[index]!.status = "pending";
            run.phases[index]!.summary = "retrying";
            run.updatedAt = runtime.now();
            return { status: "running", checkpoint: { phase: "step", index, started: false } } satisfies NextState;
          }, context);
          notify(await snapshotOf(runtime, runId, context));
          return;
        }
        if (decision === "skip") {
          await runtime.commit(async (tx) => {
            await consume(tx);
            const run = await tx.doc(JobRunFamily, runId, emptyRun(runId));
            const now = runtime.now();
            Object.assign(run.phases[index]!, { status: "skipped", summary: `skipped by ${choice.by || "someone"} after an interruption`, endedAt: now });
            run.index = index + 1;
            run.status = "running";
            run.reason = "";
            run.updatedAt = now;
            return { status: "running", checkpoint: { phase: "step", index: index + 1, started: false } } satisfies NextState;
          }, context);
          notify(await snapshotOf(runtime, runId, context));
          return;
        }
        await runtime.commit(async (tx) => { await consume(tx); return undefined; }, context);
        return end(runtime, context, runId, "aborted", `aborted by ${choice.by || "someone"} after an interruption`, { index, phase: { status: "failed", summary: "interrupted; the run was aborted" } });
      },
    },
    abort: async (task, runtime, context) => {
      const run = await snapshotOf(runtime, task.input.runId, context);
      // `DurableChannelStore.abortJob` records the reason before it aborts; anything else that aborts leaves a plain one.
      const reason = run?.reason || "aborted";
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(JobRunFamily, task.input.runId, emptyRun(task.input.runId));
        const now = runtime.now();
        if (doc.job) {
          doc.status = "aborted";
          doc.reason = reason;
          doc.endedAt = now;
          doc.updatedAt = now;
          for (const phase of doc.phases) if (phase.status === "running" || phase.status === "pending") phase.status = phase.status === "running" ? "failed" : "pending";
        }
        return terminal("aborted", reason);
      }, context);
      notify(await snapshotOf(runtime, task.input.runId, context));
    },
  });

  /** A `state` step: the change, the phase marked done and the move to the next phase are one commit. */
  async function stateStep(runtime: Runtime, context: Context, runId: string, index: number, phase: JobPhase, run: JobRunData): Promise<void> {
    const statePhase = phase as StatePhase;
    let failure: string | undefined;
    await runtime.commit(async (tx) => {
      const doc = await tx.doc(JobRunFamily, runId, emptyRun(runId));
      const stateDoc = await tx.doc(AppStateDoc);
      const now = runtime.now();
      const mark = (status: "done" | "failed", summary: string) => Object.assign(doc.phases[index]!, { status, summary, startedAt: doc.phases[index]!.startedAt || now, endedAt: now });
      let value: unknown;
      try {
        value = statePhase.value === undefined ? undefined : renderValue(statePhase.value, contextFor(run, JSON.parse(JSON.stringify(stateDoc.value)) as StateObject));
      } catch (error) {
        failure = `phase "${statePhase.name}": ${error instanceof TemplateError ? error.message : String(error)}`;
        mark("failed", summaryOf(failure));
        doc.status = "failed"; doc.reason = failure; doc.endedAt = now; doc.updatedAt = now;
        return terminal("failed", failure);
      }
      const applied = applyStateUpdate(stateDoc as never, { op: statePhase.op, path: statePhase.path, ...(value !== undefined ? { value: value as StateJson } : {}), by: { source: "job", threadKey: doc.by.threadKey, userId: doc.by.userId } });
      if ("error" in applied) {
        failure = `phase "${statePhase.name}": ${applied.error.message}`;
        mark("failed", summaryOf(applied.error.message));
        doc.status = "failed"; doc.reason = failure; doc.endedAt = now; doc.updatedAt = now;
        return terminal("failed", failure);
      }
      mark("done", applied.changed ? `${statePhase.op} ${statePhase.path || "(whole state)"}; state is at revision ${applied.rev}` : `${statePhase.op} ${statePhase.path || "(whole state)"}: already like that`);
      doc.index = index + 1;
      doc.status = "running";
      doc.updatedAt = now;
      return { status: "running", checkpoint: { phase: "step", index: index + 1, started: false } } satisfies NextState;
    }, context);
    notify(await snapshotOf(runtime, runId, context));
  }
}
