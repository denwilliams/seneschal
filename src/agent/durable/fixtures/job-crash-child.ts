import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../channel-store.ts";
import { hashDefinition, JobDefinitionSchema } from "../../../jobs/definition.ts";
import { makeJobTask } from "../../../jobs/task.ts";

/** Starts a job whose exec phase writes its effect and then hangs, so the parent can kill this process in the middle of it. */
const [root] = process.argv.slice(2);
if (!root) throw new Error("root required");
const definition = JobDefinitionSchema.parse({
  phases: [
    { name: "first", kind: "exec", command: "echo", args: ["one"] },
    { name: "second", kind: "exec", command: "deploy", args: ["prod"] },
  ],
});
const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
const models = createModels(); models.setProvider(faux.provider);
const jobTask = makeJobTask(() => ({
  phaseProblem: () => undefined,
  exec: async ({ command }) => {
    appendFileSync(join(root, "effects"), `${command}\n`);
    if (command === "deploy") {
      process.send?.({ ready: "deploying" });
      await new Promise(() => {});
    }
    return { exitCode: 0, output: "ok", timedOut: false, truncated: false, aborted: false };
  },
}));
const store = await DurableChannelStore.open({
  storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1",
  models, model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"], jobTask,
});
await store.startJob({ name: "release", definition, hash: hashDefinition(definition), input: {}, by: { source: "agent", threadKey: "t", userId: "U1" } });
setInterval(() => {}, 1000);
