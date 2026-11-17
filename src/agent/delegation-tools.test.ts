import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationTools, type ChannelDelegator } from "./delegation-tools.ts";

function fixture(threadTs: string | undefined = "123.456") {
  const transfers: any[] = [];
  const delegator: ChannelDelegator = {
    async transfer(input) {
      transfers.push(input);
      return { targetChannelLabel: "#engineering", threadTs: "123.456", permalink: "https://slack/x" };
    },
  };
  const [tool] = createDelegationTools({
    delegator,
    sourceChannelId: "C1",
    sourceChannelLabel: "#admin",
    allowedTargets: [
      { channel: "engineering", reason: "technical work with bash" },
      { channel: "COPS" },
    ],
    currentThreadTs: () => threadTs,
    currentUserId: () => "U1",
  });
  return { transfers, tool: tool as any };
}

test("does not expose a delegation tool without configured targets", () => {
  const tools = createDelegationTools({
    delegator: { async transfer() { throw new Error("unexpected"); } },
    sourceChannelId: "C1",
    sourceChannelLabel: "#admin",
    allowedTargets: [],
    currentThreadTs: () => undefined,
    currentUserId: () => "U1",
  });
  assert.deepEqual(tools, []);
});

test("does not expose delegation from a headless session without a source thread", () => {
  const { tool } = fixture("");
  assert.equal(tool, undefined);
});

test("transfers a task with source thread and user context", async () => {
  const { transfers, tool } = fixture("999.111");
  const result = await tool.execute("t1", {
    target: "engineering",
    task: "Run the deploy checks.",
    context: "The life-admin channel asked for this.",
  });

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].sourceChannelId, "C1");
  assert.equal(transfers[0].sourceChannelLabel, "#admin");
  assert.equal(transfers[0].sourceThreadTs, "999.111");
  assert.deepEqual(transfers[0].allowedTargets, [
    { channel: "engineering", reason: "technical work with bash" },
    { channel: "COPS" },
  ]);
  assert.equal(transfers[0].target, "engineering");
  assert.equal(transfers[0].task, "Run the deploy checks.");
  assert.equal(transfers[0].context, "The life-admin channel asked for this.");
  assert.equal(transfers[0].requestedBy, "U1");
  assert.match(result.content[0].text, /posted back here automatically/i);
});

test("refuses empty transfers", async () => {
  const { transfers, tool } = fixture();
  await assert.rejects(() => tool.execute("t1", { target: "engineering", task: "   " }), /empty/i);
  await assert.rejects(() => tool.execute("t1", { target: "   ", task: "Do it" }), /target/i);
  assert.equal(transfers.length, 0);
});

test("the model supplies a configured target, not an arbitrary Slack post shape", () => {
  const { tool } = fixture();
  const params = Object.keys(tool.parameters.properties).sort();
  assert.deepEqual(params, ["context", "target", "task"]);
  assert.ok(!params.includes("channelId"));
  assert.ok(!params.includes("threadTs"));
});
