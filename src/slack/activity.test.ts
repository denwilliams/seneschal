import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessApp } from "./app.ts";
import { HarnessConfigSchema } from "../config/schema.ts";
import { ChannelRegistry } from "../workspace/registry.ts";
import { ChannelActivityLog } from "../agent/activity.ts";
import { deliverAnswer, storeLedger } from "./delivery.ts";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "slack-activity-")); dirs.push(dataDir);
  const posted: any[] = [];
  const client = { chat: {
    postMessage: async (input: any) => { posted.push(input); return { ts: `1793520000.${String(posted.length).padStart(6, "0")}` }; },
    getPermalink: async () => { throw new Error("Slack unavailable"); },
    update: async () => { throw new Error("Edit failed"); },
    postEphemeral: async () => ({}),
  } };
  const harness = Object.assign(Object.create(HarnessApp.prototype), {
    opts: { dataDir }, app: { client }, registry: new ChannelRegistry(dataDir),
    config: HarnessConfigSchema.parse({ defaults: { interactiveComponents: { enabled: true }, allowUsers: ["U1"] }, channels: { general: {} } }),
    claimedInteractiveResponses: new Set(), channelName: async () => "general", handle: async () => {},
  });
  const log = () => new ChannelActivityLog(join(dataDir, "channels", "CGENERAL"), "CGENERAL").read();
  return { harness, client, posted, log, dataDir };
}

test("real publisher records document/investigation updates even when permalink lookup fails", async () => {
  const f = fixture();
  const sent = await f.harness.post({ channelId: "CGENERAL", text: "Updated the investigation document: three findings." });
  assert.equal(f.log()[0]!.sourceTs, sent.ts);
  assert.equal(f.log()[0]!.snippet, "Updated the investigation document: three findings.");
  await f.harness.post({ channelId: "CGENERAL", text: "A second update" });
  assert.equal(f.log().length, 2);
});

test("real canned prompt rejects unauthorized clicks and resolves an accepted click even if Slack editing fails", async () => {
  const f = fixture();
  const sent = await f.harness.present({ channelId: "CGENERAL", threadTs: "1793520000.000000", question: "Continue the investigation?", responses: ["yes", "no"] });
  const body = { channel: { id: "CGENERAL" }, user: { id: "UOTHER" }, message: { ts: sent.ts, thread_ts: "1793520000.000000" }, actions: [f.posted[0].blocks[1].elements[0]] };
  await f.harness.handleInteractiveResponse(f.client, body);
  assert.equal(f.log()[0]!.interaction, "pending");
  body.user.id = "U1";
  await f.harness.handleInteractiveResponse(f.client, body);
  assert.equal(f.log()[0]!.interaction, "resolved");
  await f.harness.handleInteractiveResponse(f.client, body);
  assert.equal(f.log().length, 1);
});

test("delivery ledger records scheduled/chat completions only once, including recovery deliveries", async () => {
  const f = fixture();
  let state: any;
  const store = { deliveryState: async () => state, recordDelivery: async (_id: string, _key: string, patch: any) => { state = { partsSent: 0, ...state, ...patch }; return state; } };
  const ledger = storeLedger({ store, client: f.client as never, channel: "CGENERAL", threadTs: "1793520000.000100", threadKey: "1793520000.000100", requestId: "schedule-run-1",
    onDelivered: (text, id, ts) => f.harness.recordReplyActivity("CGENERAL", text, id, ts, true) });
  assert.equal(await deliverAnswer({ client: f.client as never, ledger, channel: "CGENERAL", threadTs: "1793520000.000100", text: "Morning scheduled investigation summary" }), "delivered");
  assert.equal(await deliverAnswer({ client: f.client as never, ledger, channel: "CGENERAL", threadTs: "1793520000.000100", text: "Morning scheduled investigation summary" }), "already-delivered");
  assert.equal(f.log().length, 1); assert.equal(f.log()[0]!.kind, "scheduled");
});

test("file publication records only its public description and a Slack source, never its bytes or local path", async () => {
  const f = fixture();
  const path = join(f.dataDir, "private-local-name.txt");
  writeFileSync(path, "PRIVATE FILE CONTENTS");
  f.harness.app.client.files = { uploadV2: async () => ({ files: [{ files: [{ id: "F123", permalink: "https://team.slack.com/files/U123/F123/report.txt" }] }] }) };
  await f.harness.upload({ channelId: "CGENERAL", path, filename: "report.txt", title: "Investigation report" });
  assert.equal(f.log()[0]!.fileUrl, "https://team.slack.com/files/U123/F123/report.txt");
  assert.equal(f.log()[0]!.snippet, "Investigation report");
  assert.ok(!JSON.stringify(f.log()).includes("PRIVATE FILE CONTENTS"));
  assert.ok(!JSON.stringify(f.log()).includes("private-local-name"));
});
