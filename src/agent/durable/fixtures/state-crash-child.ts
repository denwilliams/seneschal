import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../channel-store.ts";

/** Appends 0, 1, 2, … to /log as fast as it can, so the parent can kill it in the middle of an update. */
const [root] = process.argv.slice(2);
if (!root) throw new Error("root required");
const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
const models = createModels();
models.setProvider(faux.provider);
const store = await DurableChannelStore.open({
  storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1",
  models, model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
});
for (let i = 0; ; i++) {
  await store.updateState({ op: "append", path: "/log", value: i, by: { source: "agent", threadKey: "t" } });
  if (i === 20) process.send?.({ ready: true });
}
