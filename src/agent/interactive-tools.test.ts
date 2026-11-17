import { test } from "node:test";
import assert from "node:assert/strict";
import { createInteractiveTools, type InteractiveResponseService } from "./interactive-tools.ts";

function fixture(threadTs = "123.456") {
  const requests: any[] = [];
  const service: InteractiveResponseService = {
    async present(input) {
      requests.push(input);
      return { ts: "234.567" };
    },
  };
  const [tool] = createInteractiveTools({
    service,
    channelId: "C1",
    channelLabel: "#general",
    currentThreadTs: () => threadTs || undefined,
  });
  return { requests, tool: tool as any };
}

test("posts fixed Yes/No buttons to the current thread", async () => {
  const { requests, tool } = fixture();
  await tool.execute("t1", { question: "Deploy now?", responses: ["yes", "no"] });

  assert.deepEqual(requests, [{
    channelId: "C1",
    threadTs: "123.456",
    question: "Deploy now?",
    responses: ["yes", "no"],
  }]);
});

test("deduplicates canned responses and tells the agent to wait", async () => {
  const { requests, tool } = fixture();
  const result = await tool.execute("t1", { question: "Continue?", responses: ["continue", "continue", "stop"] });

  assert.deepEqual(requests[0].responses, ["continue", "stop"]);
  assert.match(result.content[0].text, /wait/i);
});

test("does not permit custom choices, oversized or blank questions, or top-level routing", async () => {
  const { requests, tool } = fixture("");
  await assert.rejects(() => tool.execute("t1", { question: "x", responses: ["maybe"] }), /supported canned/i);
  await assert.rejects(() => tool.execute("t1", { question: " ", responses: ["yes"] }), /needs a question/i);
  await assert.rejects(() => tool.execute("t1", { question: "x".repeat(1_501), responses: ["yes"] }), /1,500/i);
  await assert.rejects(() => tool.execute("t1", { question: "x", responses: ["yes"] }), /conversation thread/i);
  assert.equal(requests.length, 0);
});
