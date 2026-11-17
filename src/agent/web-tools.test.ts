import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebTools } from "./web-tools.ts";
import type { SearchConfig, WebPolicy } from "./web.ts";

const policy: WebPolicy = {
  maxBytes: 100_000,
  maxChars: 5_000,
  downloadMaxBytes: 100_000,
  timeoutSeconds: 5,
  maxRedirects: 3,
  allowHosts: [],
  blockHosts: [],
  allowPrivateHosts: false,
  userAgent: "test",
};

const noSearch: SearchConfig = { provider: "none", apiKey: "", url: "", maxResults: 3 };

function tools(over: {
  search?: SearchConfig;
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  workspace?: string;
} = {}) {
  const list = createWebTools({
    policy,
    search: over.search ?? noSearch,
    workspace: over.workspace ?? "/tmp",
    deps: {
      ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
      resolveHost: over.resolveHost ?? (async () => ["93.184.216.34"]),
    },
  });
  return Object.fromEntries(list.map((t) => [t.name, t as any]));
}

const page = (body: string) =>
  (async () =>
    new Response(body, {
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;

test("search is only offered when a provider is configured", () => {
  assert.deepEqual(Object.keys(tools()), ["download_url", "fetch_url"]);
  assert.deepEqual(
    Object.keys(tools({ search: { ...noSearch, provider: "brave", apiKey: "k" } })).sort(),
    ["download_url", "fetch_url", "search_web"],
  );
});

test("download_url reports workspace path, type and bytes without reading binary data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-download-tool-"));
  try {
    const binary = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/pdf" },
      })) as unknown as typeof fetch;
    const { download_url } = tools({ fetchImpl: binary, workspace: dir });
    const result = await download_url.execute("t1", { url: "https://example.com/manual.pdf" });

    assert.match(result.content[0].text, /application\/pdf, 3 bytes/);
    assert.equal(result.details.filename, "manual.pdf");
    assert.match(result.details.path, /manual\.pdf$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetched text arrives labelled as untrusted input", async () => {
  const { fetch_url } = tools({
    fetchImpl: page("<title>Changelog</title><body><p>7.14.1 fixes VLAN tagging.</p></body>"),
  });
  const result = await fetch_url.execute("t1", { url: "https://example.com/changelog" });
  const text = result.content[0].text;

  assert.match(text, /Fetched https:\/\/example\.com\/changelog/);
  assert.match(text, /Title: Changelog/);
  assert.match(text, /not instructions/i, "the model is told what this text is");
  assert.match(text, /7\.14\.1 fixes VLAN tagging\./);
  assert.equal(result.details.url, "https://example.com/changelog");
});

test("a page with no readable text is reported, not guessed at", async () => {
  const { fetch_url } = tools({ fetchImpl: page("<body><div id='root'></div></body>") });
  const result = await fetch_url.execute("t1", { url: "https://example.com/app" });

  assert.equal(result.details.empty, true);
  assert.match(result.content[0].text, /JavaScript/);
  assert.match(result.content[0].text, /rather than guessing/);
});

test("a policy refusal tells the agent it is a limit, not a blip", async () => {
  const { fetch_url } = tools({ resolveHost: async () => ["10.0.0.5"] });
  await assert.rejects(
    () => fetch_url.execute("t1", { url: "https://intranet.example/" }),
    /do not retry the same URL/,
  );
});

test("a network failure is passed through as itself", async () => {
  const failing = (async () => {
    throw new Error("getaddrinfo ENOTFOUND example.com");
  }) as unknown as typeof fetch;
  const { fetch_url } = tools({ fetchImpl: failing });

  await assert.rejects(
    () => fetch_url.execute("t1", { url: "https://example.com/" }),
    (err: Error) =>
      /Could not reach example\.com/.test(err.message) && !/do not retry/.test(err.message),
  );
});

test("fetch_url takes a url and nothing else", () => {
  const { fetch_url } = tools();
  assert.deepEqual(Object.keys(fetch_url.parameters.properties), ["url"]);
});

test("search results point at pages to open rather than standing as an answer", async () => {
  const impl = (async () =>
    Response.json({
      web: {
        results: [
          { title: "Release notes", url: "https://example.com/notes", description: "7.14.1" },
        ],
      },
    })) as unknown as typeof fetch;

  const { search_web } = tools({
    search: { provider: "brave", apiKey: "k", url: "", maxResults: 3 },
    fetchImpl: impl,
  });
  const result = await search_web.execute("t1", { query: "router firmware 7.14.1" });
  const text = result.content[0].text;

  assert.match(text, /1\. Release notes/);
  assert.match(text, /https:\/\/example\.com\/notes/);
  assert.match(text, /not instructions/i);
  assert.match(text, /fetch_url/, "and it is told to open the page");
  assert.equal(result.details.results, 1);
});

test("an empty search says so instead of inventing results", async () => {
  const impl = (async () => Response.json({ web: { results: [] } })) as unknown as typeof fetch;
  const { search_web } = tools({
    search: { provider: "brave", apiKey: "k", url: "", maxResults: 3 },
    fetchImpl: impl,
  });

  const result = await search_web.execute("t1", { query: "nothing at all" });
  assert.equal(result.details.results, 0);
  assert.match(result.content[0].text, /No results/);
});
