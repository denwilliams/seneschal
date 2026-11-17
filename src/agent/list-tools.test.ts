import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createListTools } from "./list-tools.ts";

test("tools are bound to channel context and share persisted data with the service", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "list-tools-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const [read, update] = createListTools(root);
  assert.equal(read!.name, "list_read"); assert.equal(update!.name, "list_update");
  const call = (tool: typeof read, p: unknown) => tool!.execute("id", p as never, undefined, undefined, {} as never);
  await call(update, { op: "create", list: "todo" });
  await call(update, { op: "add_item", list: "todo", values: { title: "From tool" } });
  const result = await call(read, { list: "todo" });
  assert.match(JSON.stringify(result), /From tool/);
  await assert.rejects(() => call(update, { op: "create", list: "bad", path: "/tmp", channel: "COTHER" }));
  await assert.rejects(() => call(update, { op: "delete_list", list: "todo" }));
  assert.match(JSON.stringify(await call(createListTools(root)[0], {})), /todo/);
});
