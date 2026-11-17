import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry, defineDocFamily, defineExtension, defineTask, Harness, type AnyTask, type TaskId,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * A throwaway job used to characterize what pi-durable tasks do across restarts (see tasks-characterization.test.ts).
 * Phases a, b, approve, c. Effects are appended to a file, so they are visible across processes and survive a SIGKILL.
 * Phase b writes its effect and then hangs until a file called `release` exists, so a test can stop it mid-phase.
 */
export const ctx = BACKGROUND_CONTEXT;

type State =
  | { phase: "a" }
  | { phase: "b"; marker: number }
  | { phase: "approve" }
  | { phase: "c" };

export const effect = (dir: string, line: string) => appendFileSync(join(dir, "effects"), `${line}\n`);
export const effects = (dir: string): string[] => (existsSync(join(dir, "effects")) ? readFileSync(join(dir, "effects"), "utf8").split("\n").filter(Boolean) : []);

/** An approval a person gives from outside the task: written by whoever handles the Slack button. */
export const Approval = defineDocFamily<{ decision: string }, { decision: string }>({
  kind: "spike.approval", version: 1, scope: "session", checkpointWhen: () => false, family: true, initial: (seed) => ({ ...seed }),
});

export function makeJob(dir: string) {
  return defineTask<{ id: string }, State, { finished: true }>({
    name: "spike.job", version: 1,
    initial: () => ({ phase: "a" }),
    phases: {
      a: async (_task, runtime, context) => {
        effect(dir, "a");
        await runtime.commit(async () => ({ status: "running" as const, checkpoint: { phase: "b" as const, marker: 1 } }), context);
      },
      b: async (_task, runtime, context) => {
        effect(dir, "b");
        process.send?.({ ready: "in-b" });
        while (!existsSync(join(dir, "release"))) await awaitWithContext(new Promise((resolve) => setTimeout(resolve, 10)), context);
        await runtime.commit(async () => ({ status: "running" as const, checkpoint: { phase: "approve" as const } }), context);
      },
      approve: async (task, runtime, context) => {
        const key = task.input.id;
        await runtime.commit(async (tx) => { await tx.doc(Approval, key, { decision: "" }); return undefined; }, context);
        effect(dir, "approve-waiting");
        process.send?.({ ready: "approving" });
        const watch = await runtime.watchDoc(Approval, key, context);
        if (!watch) throw new Error("the approval document should exist");
        const decided = (value: { decision: string } | null) => value !== null && value.decision !== "";
        if (!decided(watch.value)) {
          await awaitWithContext(new Promise<void>((resolve) => { watch.start(async (call) => { if (call.kind === "failed") throw call.error; if (!call.retired && decided(call.value)) resolve(); }); }), context);
        }
        await watch.stop();
        const decision = (await runtime.snapshot(Approval, key, context))!.decision;
        effect(dir, `decided-${decision}`);
        await runtime.commit(async () => decision === "approved"
          ? { status: "running" as const, checkpoint: { phase: "c" as const } }
          : { status: "terminal" as const, outcome: { status: "aborted" as const, reason: "declined" } }, context);
      },
      c: async (_task, runtime, context) => {
        effect(dir, "c");
        await runtime.commit(async () => ({ status: "terminal" as const, outcome: { status: "completed" as const, result: { finished: true as const } } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      effect(dir, "abort-handler");
      await runtime.commit(async () => ({ status: "terminal" as const, outcome: { status: "aborted" as const, reason: "aborted" } }), context);
    },
  });
}

export async function openRaw(dir: string) {
  mkdirSync(dir, { recursive: true });
  const Job = makeJob(dir);
  const database = await openNodeSqliteDatabase(join(dir, "spike.sqlite"));
  const storage = await SqliteStorage.open(database);
  const extension = defineExtension({ name: "spike", tasks: [Job as unknown as AnyTask] });
  const registry = createRegistry();
  registry.install(extension);
  const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const harness = await Harness.open(storage, { models, registry, settings: { extensions: [], toolExecution: "sequential", followUpMode: "one-at-a-time" } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "fixture", modelId: "model" }, extensions: [extension], tools: [], cwd: dir } });
  const start = (id: string): Promise<TaskId<{ finished: true }>> =>
    harness.commit(async (tx) => tx.createTask(Job, { id }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true }), ctx) as Promise<TaskId<{ finished: true }>>;
  const decide = (id: string, decision: "approved" | "declined") =>
    harness.commit(async (tx) => { (await tx.doc(Approval, id, { decision: "" })).decision = decision; }, ctx);
  return { harness, root, start, decide, Job };
}
