import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the shipped worker, not a second implementation of its caching rules.
test("Access-protected service worker clears old shell caches and does not cache protected files or identity", async () => {
  const listeners: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  stores.set("console2-shell-v1-/console2/", new Map([["old", new Response("old shell")]]));
  let offline = false;
  const requested: string[] = [];
  const context = {
    URL, Request, setTimeout,
    self: { location: new URL("https://console.test/console2/sw.js"), addEventListener: (name: string, fn: (event: any) => void) => { listeners[name] = fn; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: {
      keys: async () => [...stores.keys()],
      delete: async (key: string) => stores.delete(key),
      open: async (key: string) => {
        if (!stores.has(key)) stores.set(key, new Map());
        const store = stores.get(key)!;
        return { match: async (r: string | Request) => store.get(typeof r === "string" ? r : r.url), put: async (r: string | Request, v: Response) => { store.set(typeof r === "string" ? r : r.url, v); } };
      },
    },
    fetch: async (r: string | Request) => {
      requested.push(typeof r === "string" ? r : r.url);
      if (offline) throw new Error("offline");
      // Browser network responses are type=basic; Node's constructed Responses are type=default.
      return { ok: true, type: "basic", redirected: false, headers: new Headers({ "x-harness-access-protected": "1" }) };
    },
    Headers,
  };
  runInNewContext(readFileSync(new URL("../../web/console2/public/sw.js", import.meta.url), "utf8"), context);
  let install: Promise<void> | undefined;
  listeners.install!({ waitUntil: (p: Promise<void>) => { install = p; } });
  await install;
  assert.equal(stores.size, 0, "old offline shells are removed when protected worker installs");
  const dispatch = (relative: string): Promise<unknown> | undefined => {
    let response: Promise<unknown> | undefined;
    listeners.fetch!({ request: { method: "GET", url: "https://console.test/console2/" + relative, mode: relative ? "cors" : "navigate" }, respondWith: (p: Promise<unknown>) => { response = p; } });
    return response;
  };
  await dispatch(""); await dispatch("assets/app.js");
  assert.ok([...stores.values()].every((store) => store.size === 0));
  const count = requested.length;
  assert.equal(dispatch("api/v1/identity"), undefined);
  assert.equal(dispatch("api/v1/events"), undefined);
  assert.equal(requested.length, count, "API requests are not intercepted");
  offline = true;
  await assert.rejects(dispatch("")!, /offline/, "no offline shell after protected install");
});
