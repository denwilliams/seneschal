// Real storage/validation, deterministic mock data; no production channel data.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelLists } from "../../../src/lists/store.ts";
const root = realpathSync(mkdtempSync(join(tmpdir(), "mock-lists-")));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const stores = new Map();
export function resetMockLists() {
  stores.clear(); rmSync(root, { recursive: true, force: true }); mkdirSync(root);
  const store = channelStore("C0GENERAL");
  store.mutate({ op: "create", list: "release_tasks" });
  store.mutate({ op: "add_column", list: "release_tasks", column: "owner", type: "text" });
  store.mutate({ op: "add_column", list: "release_tasks", column: "priority", type: "integer" });
  store.mutate({ op: "add_item", list: "release_tasks", values: { title: "Review release notes", notes: "Check the upgrade guide before publishing.", owner: "Ana", priority: 1 } });
  store.mutate({ op: "add_item", list: "release_tasks", values: { title: "Run smoke tests", completed: true, owner: "Bo", priority: 2 } });
}
function channelStore(id) {
  if (!stores.has(id)) { const dir = join(root, id); mkdirSync(dir, { recursive: true }); stores.set(id, new ChannelLists(dir)); }
  return stores.get(id);
}
export async function mockLists(req, res, url, api, channels, writable) {
  if (!url.pathname.startsWith(api + "/channels/")) return false;
  const parts = url.pathname.slice(api.length + 1).split("/").map(decodeURIComponent);
  if (parts.length !== 3 || parts[2] !== "lists") return false;
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); return true; };
  if (!Object.hasOwn(channels, parts[1])) return send(404, { error: "Unknown channel." });
  if (channels[parts[1]].isDm) return send(403, { error: "Lists are hidden for direct messages." });
  const store = channelStore(parts[1]);
  try {
    if (req.method === "POST") {
      if (!writable || req.headers["x-console-action"] !== "1") return send(403, { error: "Actions are off." });
      let body = ""; for await (const chunk of req) body += chunk;
      return send(200, store.mutate(JSON.parse(body)));
    }
    return send(200, { ...store.read(url.searchParams.get("list") || undefined, Number(url.searchParams.get("offset") || 0)), writable });
  } catch (error) { return send(400, { error: error.message }); }
}
resetMockLists();
