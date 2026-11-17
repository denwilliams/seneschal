import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskRunTracker, TaskStatusStore } from "./store.ts";
import { createTaskStatusTools } from "./tools.ts";

test("set_task_status records an explicit wait on the current substantive turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-task-tool-"));
  try {
    const store = new TaskStatusStore(dir);
    const tracker = new TaskRunTracker(store, { channelId: "C1", threadKey: "1.1", summary: "Review PR", kind: "review" });
    const [tool, linksTool] = createTaskStatusTools(() => tracker) as any[];
    const result = await tool.execute("call-1", { status: "waiting", detail: "Waiting for CI" });
    assert.match(result.content[0].text, /waiting/);
    assert.equal(store.all()[0]!.status, "waiting");
    assert.equal(store.all()[0]!.detail, "Waiting for CI");
    await linksTool.execute("call-2", { links: [{ url: "https://github.com/example/repo/pull/12", label: "PR #12" }] });
    assert.equal(store.all()[0]!.links?.[0]?.label, "PR #12");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set_task_status cannot run without an active task turn", async () => {
  const tool = createTaskStatusTools(() => undefined)[0] as any;
  await assert.rejects(() => tool.execute("call-1", { status: "blocked" }), /No active task turn/);
});
