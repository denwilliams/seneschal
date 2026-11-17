import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DurableChannelStore } from "../channel-store.ts";

const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error("root/mode required");
const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }], tokensPerSecond: mode === "model" ? 10 : 1_000_000 });
const models = createModels();
models.setProvider(faux.provider);
const runtime = await DurableChannelStore.open({
  storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1",
  models, model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
  tools: [{
    name: "mutation", description: "Test mutation", parameters: Type.Object({}),
    // Even an unreviewed caller's safe declaration must not survive the host adapter.
    replay: "safe",
    execute: async (_args, api, context) => {
      appendFileSync(join(root, "effects"), "executed\n");
      api.output("effect started\n");
      // Send only after intent was persisted and the external effect occurred.
      process.send?.({ ready: true });
      return awaitWithContext(new Promise<never>(() => {}), context);
    },
  }],
});
if (mode === "tool") {
  faux.setResponses([fauxAssistantMessage(fauxToolCall("mutation", {}, { id: "call-1" }), { stopReason: "toolUse" })]);
} else {
  faux.setResponses([fauxAssistantMessage("Partial answer that should be marked aborted after an abrupt process crash. ".repeat(8))]);
  // 1.5 shows partials before storing them (up to one second). This fixture characterizes recovery of a STORED
  // partial, so kill only after its storage publication, not a presentation event that may still be deferred.
  const harness = (runtime as unknown as { harness: Harness }).harness;
  harness.observeCommits({ advance: (publication) => {
    if (publication.changes.some((change) => change.type === "document" && change.kind === "change"
      && change.record.kind === "pi.live" && "generation" in change.value
      && (change.value.generation as { message?: unknown } | undefined)?.message)) process.send?.({ ready: true });
  }, end: () => {} });
}
await runtime.submit("thread", { requestId: "event-1", content: "hello", userId: "U1" });
setInterval(() => {}, 1000);
