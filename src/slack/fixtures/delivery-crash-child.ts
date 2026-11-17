import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebClient } from "@slack/web-api";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { DurableChannelStore } from "../../agent/durable/channel-store.ts";
import { storeLedger } from "../delivery.ts";
import { SlackResponseStream } from "../stream.ts";

/**
 * Runs ONE reply in a real process against a Slack that lives in a file, so what "reached Slack" survives the
 * process being killed. `mode` picks the moment the parent will SIGKILL it:
 *   after-send   the message is in Slack, but the timestamp was never recorded
 *   before-send  intent is recorded, nothing reached Slack
 *   final        a complete run (used for the retry)
 */
const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error("root/mode required");
const slackFile = join(root, "slack.jsonl");
if (!existsSync(slackFile)) writeFileSync(slackFile, "");
const sent = () => readFileSync(slackFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { ts: string; text: string; metadata?: unknown });
const hang = () => new Promise<never>(() => {});

const client = {
  reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  conversations: { replies: async () => ({ ok: true, messages: sent() }) },
  chat: {
    postMessage: async (args: { text: string; metadata?: unknown }) => {
      if (mode === "before-send") { process.send?.({ ready: true }); await hang(); }
      const message = { ts: `300.${sent().length + 1}`, text: args.text, ...(args.metadata ? { metadata: args.metadata } : {}) };
      appendFileSync(slackFile, `${JSON.stringify(message)}\n`);   // it is now in Slack
      return { ok: true, ts: message.ts };
    },
    update: async (args: { ts: string; text: string }) => {
      const all = sent().map((m) => (m.ts === args.ts ? { ...m, text: args.text } : m));
      writeFileSync(slackFile, all.map((m) => JSON.stringify(m)).join("\n") + "\n");
      return { ok: true };
    },
  },
} as unknown as WebClient;

const faux = fauxProvider({ provider: "fixture", models: [{ id: "model" }] });
const models = createModels(); models.setProvider(faux.provider);
const store = await DurableChannelStore.open({
  storageDir: join(root, "store"), workspace: join(root, "workspace"), channelId: "C1", models,
  model: { provider: "fixture", modelId: "model" }, allowedModels: ["fixture/model"],
});
const real = storeLedger({ store, client, channel: "C1", threadTs: "1.1", threadKey: "1.1", requestId: "slack:C1:1.2" });
const ledger = mode === "after-send"
  ? { ...real, posted: async () => { process.send?.({ ready: true }); await hang(); } }   // sent, timestamp never recorded
  : real;
const stream = new SlackResponseStream({ client, channel: "C1", threadTs: "1.1", anchorTs: "1.2", ackEmoji: "hourglass" });
await stream.open();
await stream.attachLedger(ledger);
await stream.close("The answer.");
await store.close();
process.send?.({ done: true });
process.exit(0);
