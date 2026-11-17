import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { ListsView } from "../lists/store.ts";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactServer } from "../artifacts/server.ts";
import { createListTools } from "../agent/list-tools.ts";
import { ChannelLists } from "../lists/store.ts";
import { fixture } from "./fixture.ts";
import { console2Route } from "./handler.ts";
import { MAX_LIST_BODY_BYTES } from "./lists.ts";

async function boot(t: import("node:test").TestContext, options: { actions?: boolean; dm?: boolean } = {}) {
  const f = fixture({ dm: options.dm }); f.source.baseUrl = "http://console.test/proxy";
  const server = new ArtifactServer({ enabled: true, host: "127.0.0.1", port: 0, baseUrl: f.source.baseUrl, console: true, artifacts: false, actions: options.actions ?? true }, f.dataDir, {}, undefined, undefined, undefined, () => f.source);
  await server.start(); t.after(async () => { await server.stop(); rmSync(f.dataDir, { recursive: true, force: true }); });
  const path = `/proxy/console2/api/v1/channels/${f.channelId}/lists`;
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (suffix = "") => fetch(origin + path + suffix, { headers: { host: "console.test" } });
  const post = (body: unknown, headers: Record<string, string | undefined> = {}) => {
    const sent: Record<string, string> = { host: "console.test", "content-type": "application/json", "x-console-action": "1" };
    for (const [k, v] of Object.entries(headers)) { if (v === undefined) delete sent[k]; else sent[k] = v; }
    return fetch(origin + path, { method: "POST", headers: sent, body: typeof body === "string" ? body : JSON.stringify(body) });
  };
  return { ...f, origin, get, post, path, store: new ChannelLists(join(f.dataDir, "channels", f.channelId)) };
}

test("lists route and interface-to-interface editing share the channel database, without a factory service", async (t) => {
  assert.deepEqual(console2Route("/console2/api/v1/channels/CCHAN001/lists"), { page: "lists", channelId: "CCHAN001" });
  const b = await boot(t);
  const root = join(b.dataDir, "channels", b.channelId);
  const [read, update] = createListTools(root);
  const tool = (p: unknown) => update!.execute("x", p as never, undefined, undefined, {} as never);
  await tool({ op: "create", list: "todo" });
  await tool({ op: "add_item", list: "todo", values: { title: "Agent item" } });
  const initial = await b.get("?list=todo"); assert.equal(initial.status, 200); assert.equal(initial.headers.get("cache-control"), "no-store");
  const view = await initial.json() as ListsView & { writable: boolean }; assert.equal(view.items![0]!.title, "Agent item"); assert.equal(view.writable, true);
  for (const body of [
    { op: "add_column", list: "todo", column: "owner", type: "text" },
    { op: "update_item", list: "todo", id: view.items![0]!.id, values: { title: "Human edit", notes: "Reviewed", completed: true, owner: "Ana" } },
    { op: "add_item", list: "todo", values: { title: "Human item", owner: "Bo" } },
  ]) assert.equal((await b.post(body)).status, 200);
  const fromTool = await read!.execute("x", { list: "todo" }, undefined, undefined, {} as never);
  assert.match(JSON.stringify(fromTool), /Human edit/); assert.match(JSON.stringify(fromTool), /Ana/);
  assert.equal(b.store.read("todo").items![0]!.completed, true);
  assert.equal((await b.post({ op: "drop_column", list: "todo", column: "owner", confirm: true })).status, 200);
  assert.equal(b.store.read("todo").items![0]!.notes, "Reviewed");
  assert.equal((await b.post({ op: "delete_item", list: "todo", id: view.items![0]!.id })).status, 200);
  assert.equal((await b.post({ op: "rename", list: "todo", name: "release" })).status, 200);
  assert.deepEqual(b.store.read().lists, ["release"]);
  assert.equal((await b.post({ op: "delete_list", list: "release", confirm: true })).status, 200);
  assert.deepEqual(b.store.read().lists, []);
});

test("near-limit items stay editable across tools and console, with room for the request envelope", async (t) => {
  const b = await boot(t);
  const [, update] = createListTools(join(b.dataDir, "channels", b.channelId));
  const tool = (p: unknown) => update!.execute("x", p as never, undefined, undefined, {} as never);
  // Maximum list name, and enough editable data that the console envelope exceeds 16 KiB.
  const list = "a".repeat(48);
  await tool({ op: "create", list });
  for (let i = 0; i < 3; i++) await tool({ op: "add_column", list, column: "c" + i, type: "text" });
  const values = { title: "x".repeat(4000), notes: "x".repeat(4000), c0: "x".repeat(4000), c1: "x".repeat(4000), c2: "x".repeat(300) };
  await tool({ op: "add_item", list, values });
  const id = b.store.read(list).items![0]!.id;
  await tool({ op: "update_item", list, id, values: { completed: true } });
  const edit = { op: "update_item", list, id, values: { ...values, completed: false } };
  assert.ok(Buffer.byteLength(JSON.stringify(edit)) > 16 * 1024);
  assert.equal((await b.post(edit)).status, 200);
  assert.equal((await b.post({ op: "add_item", list, values })).status, 200);
  const before = b.store.read(list);
  const overflow = { ...values, c2: "x".repeat(400) };
  for (const op of ["add_item", "update_item"]) {
    const response = await b.post({ op, list, ...(op === "update_item" ? { id } : {}), values: overflow });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /16 KiB/);
  }
  await assert.rejects(() => tool({ op: "update_item", list, id, values: overflow }), /16 KiB/);
  assert.deepEqual(b.store.read(list), before);
  for (const item of before.items!) {
    for (const [key, value] of Object.entries(values)) assert.equal(item[key], value);
    assert.equal(item.completed, false);
  }
});

test("console list writes retain switch, Host, same-origin, JSON, header, strict body and size protections", async (t) => {
  const b = await boot(t);
  const body = { op: "create", list: "todo" };
  assert.equal((await b.post(body, { "x-console-action": undefined })).status, 403);
  assert.equal((await b.post(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await b.post(body, { origin: "https://evil.test" })).status, 403);
  assert.equal((await b.post(body, { "sec-fetch-site": "cross-site" })).status, 403);
  const rejectedHost = await new Promise<number>((resolve, reject) => {
    const req = request(b.origin + b.path, { method: "POST", headers: { host: "evil.test" } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.end("{}");
  });
  assert.equal(rejectedHost, 421);
  assert.equal((await b.post("{not json")).status, 400);
  assert.equal((await b.post("x".repeat(MAX_LIST_BODY_BYTES + 1))).status, 413);
  assert.equal((await b.post({ ...body, path: "../other/lists.sqlite" })).status, 400);
  assert.equal((await b.post(body, { origin: "http://console.test" })).status, 200);
  assert.equal((await b.get("?list=todo&offset=-1")).status, 400);
  assert.equal((await b.get("?list=unknown")).status, 400);
  const reads = await fetch(b.origin + b.path, { headers: { host: "console.test", origin: "https://evil.test" } }); assert.equal(reads.status, 403);
  const off = await boot(t, { actions: false });
  assert.equal((await off.get()).status, 200); assert.equal((await (await off.get()).json() as { writable: boolean }).writable, false);
  assert.equal((await off.post(body)).status, 403); assert.deepEqual(off.store.read().lists, []);
});

test("list body bound also rejects oversized chunked requests without mutating data", async (t) => {
  const b = await boot(t);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(b.origin + b.path, { method: "POST", headers: { host: "console.test", "content-type": "application/json", "x-console-action": "1" } }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject);
    req.write(" ".repeat(MAX_LIST_BODY_BYTES));
    req.end(" ");
  });
  assert.equal(status, 413);
  assert.deepEqual(b.store.read().lists, []);
});

test("console cannot read/write another channel, unknown/rejected channels or DMs", async (t) => {
  const b = await boot(t);
  b.store.mutate({ op: "create", list: "private" });
  const otherRoot = join(b.dataDir, "channels", "COTHER1"); mkdirSync(otherRoot);
  const other = new ChannelLists(otherRoot); other.mutate({ op: "create", list: "other_only" });
  b.source.channels = () => [{ id: b.channelId, isDm: false }, { id: "COTHER1", isDm: false }] as never;
  const originalResolve = b.source.resolve;
  b.source.resolve = (channel) => ({ ...originalResolve(channel)!, paths: { ...originalResolve(channel)!.paths, root: channel.id === b.channelId ? join(b.dataDir, "channels", b.channelId) : otherRoot } });
  const getOther = await fetch(b.origin + b.path.replace(b.channelId, "COTHER1"), { headers: { host: "console.test" } });
  assert.deepEqual((await getOther.json() as ListsView).lists, ["other_only"]);
  assert.equal((await b.post({ op: "delete_list", list: "other_only", confirm: true })).status, 400);
  assert.deepEqual(other.read().lists, ["other_only"]);
  const unknown = await fetch(b.origin + b.path.replace(b.channelId, "CUNKNOWN1"), { headers: { host: "console.test" } }); assert.equal(unknown.status, 404);
  b.source.resolve = () => undefined; assert.equal((await b.get()).status, 403);
  const dm = await boot(t, { dm: true }); dm.store.mutate({ op: "create", list: "secret" });
  const hidden = await dm.get("?list=secret"); assert.equal(hidden.status, 403); assert.ok(!(await hidden.text()).includes("secret"));
  assert.equal((await dm.post({ op: "delete_list", list: "secret", confirm: true })).status, 403);
  assert.deepEqual(dm.store.read().lists, ["secret"]);
});

test("console list mutations share the existing per-caller action rate limiter", async (t) => {
  const b = await boot(t);
  for (let i = 0; i < 20; i++) assert.equal((await b.post({ op: "create", list: "list_" + i })).status, 200);
  assert.equal((await b.post({ op: "create", list: "over_limit" })).status, 429);
});
