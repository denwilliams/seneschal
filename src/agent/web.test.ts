import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  decodeEntities,
  downloadUrl,
  fetchPage,
  hostMatches,
  htmlToText,
  isPrivateAddress,
  writeAll,
  searchWeb,
  WebPolicyError,
  type SearchConfig,
  type WebPolicy,
} from "./web.ts";

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

/** A fetch double keyed by URL, recording what was asked for. */
function fakeFetch(pages: Record<string, Response | (() => Response)>) {
  const seen: string[] = [];
  const impl = (async (input: any) => {
    const url = String(input);
    seen.push(url);
    const page = pages[url];
    if (!page) throw new Error(`unexpected fetch: ${url}`);
    return typeof page === "function" ? page() : page;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const publicDns = async () => ["93.184.216.34"];

// --- Address policy --------------------------------------------------------

test("private, loopback and link-local addresses are recognised", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // cloud metadata, the classic SSRF target
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:192.168.0.1",
    "not-an-address",
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be refused`);
  }
});

test("ordinary public addresses are not", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`);
  }
});

test("host patterns match a domain and its subdomains, not a lookalike", () => {
  assert.equal(hostMatches("example.com", "example.com"), true);
  assert.equal(hostMatches("docs.example.com", "example.com"), true);
  assert.equal(hostMatches("docs.example.com", "*.example.com"), true);
  assert.equal(hostMatches("EXAMPLE.com", "example.com"), true);
  // The one that matters: a suffix match on the string alone would allow this.
  assert.equal(hostMatches("notexample.com", "example.com"), false);
  assert.equal(hostMatches("example.com.evil.test", "example.com"), false);
});

// --- Text extraction -------------------------------------------------------

test("html becomes readable text", () => {
  const { title, text } = htmlToText(`
    <html><head><title>Router firmware 7.14</title>
      <style>body { color: red }</style>
    </head>
    <body>
      <script>tracker('nope')</script>
      <h1>Release notes</h1>
      <p>VLAN tagging is fixed in 7.14.1.</p>
      <ul><li>One</li><li>Two</li></ul>
    </body></html>`);

  assert.equal(title, "Router firmware 7.14");
  assert.match(text, /Release notes/);
  assert.match(text, /VLAN tagging is fixed in 7\.14\.1\./);
  assert.match(text, /- One/);
  assert.doesNotMatch(text, /tracker/, "script contents must not reach the model");
  assert.doesNotMatch(text, /color: red/, "nor stylesheets");
  assert.doesNotMatch(text, /\n{3,}/, "and the whitespace is collapsed");
});

test("entities are decoded, including numeric ones", () => {
  assert.equal(decodeEntities("caf&eacute; &amp; bar"), "café & bar");
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeEntities("5 &lt; 6 &gt; 4"), "5 < 6 > 4");
  // Unknown entities are left alone rather than silently eaten.
  assert.equal(decodeEntities("&notareal;"), "&notareal;");
});

// --- Fetching --------------------------------------------------------------

test("a page is fetched, extracted and reported with its final url", async () => {
  const { impl } = fakeFetch({
    "https://example.com/notes": html("<title>Notes</title><body><p>Hello there</p></body>"),
  });
  const page = await fetchPage("https://example.com/notes", policy, {
    fetchImpl: impl,
    resolveHost: publicDns,
  });

  assert.equal(page.url, "https://example.com/notes");
  assert.equal(page.title, "Notes");
  assert.match(page.text, /Hello there/);
  assert.equal(page.truncated, false);
});

test("only http and https are fetchable", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "not a url"]) {
    await assert.rejects(
      () => fetchPage(url, policy, { fetchImpl: fakeFetch({}).impl, resolveHost: publicDns }),
      WebPolicyError,
      url,
    );
  }
});

test("a host that resolves to a private address is refused", async () => {
  await assert.rejects(
    () =>
      fetchPage("http://nas.local/admin", policy, {
        fetchImpl: fakeFetch({}).impl,
        resolveHost: async () => ["192.168.1.10"],
      }),
    (err: Error) => err instanceof WebPolicyError && /private or loopback/.test(err.message),
  );
});

test("a literal private address is refused without a lookup", async () => {
  await assert.rejects(
    () =>
      fetchPage("http://192.168.1.1/", policy, {
        fetchImpl: fakeFetch({}).impl,
        resolveHost: async () => assert.fail("should not resolve a literal address"),
      }),
    WebPolicyError,
  );
});

test("pinned connections use validated addresses and retain HTTP Host on redirects", async () => {
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    hosts.push(request.headers.host ?? "");
    if (request.url === "/start") {
      response.writeHead(302, { location: `http://redirect.test:${(server.address() as AddressInfo).port}/finish` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pinned response");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const resolutions: string[] = [];
    const page = await fetchPage(`http://origin.test:${port}/start`, { ...policy, allowPrivateHosts: true }, {
      resolveHost: async (host) => {
        resolutions.push(host);
        return ["127.0.0.1"];
      },
    });
    assert.equal(page.url, `http://redirect.test:${port}/finish`);
    assert.match(page.text, /pinned response/);
    assert.deepEqual(resolutions, ["origin.test", "redirect.test"]);
    assert.deepEqual(hosts, [`origin.test:${port}`, `redirect.test:${port}`]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("pinned HTTPS connections retain the URL hostname as TLS SNI", async () => {
  let host = "";
  let servername = "";
  const server = createSecureServer({
    key: await readFile(new URL("./fixtures/test-server.key", import.meta.url)),
    cert: await readFile(new URL("./fixtures/test-server.crt", import.meta.url)),
  }, (request, response) => {
    host = request.headers.host ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("secure pinned response");
  });
  server.on("secureConnection", (socket) => { servername = typeof socket.servername === "string" ? socket.servername : ""; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed local test fixture only
  try {
    const { port } = server.address() as AddressInfo;
    const page = await fetchPage(`https://tls.test:${port}/`, { ...policy, allowPrivateHosts: true }, {
      resolveHost: async () => ["127.0.0.1"],
    });
    assert.match(page.text, /secure pinned response/);
    assert.equal(host, `tls.test:${port}`);
    assert.equal(servername, "tls.test");
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("a transport DNS rebind cannot reach a loopback server or stage a download", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("this must not be fetched");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const fetchWithRedirect = (async (input: any, init: any) => {
      if (new URL(String(input)).hostname === "public.test") {
        return new Response(null, { status: 302, headers: { location: `http://localhost:${port}/` } });
      }
      return fetch(input, init);
    }) as unknown as typeof fetch;
    const rebindPolicy = { ...policy, allowPrivateHosts: true, timeoutSeconds: 1 };
    const resolutions: string[] = [];
    const deps = {
      fetchImpl: fetchWithRedirect,
      // A deliberate local-network channel approved 127.0.0.2. A fresh lookup
      // of localhost would instead hit the server on 127.0.0.1.
      resolveHost: async (host: string) => {
        resolutions.push(host);
        return host === "public.test" ? ["127.0.0.2"] : ["127.0.0.2"];
      },
    };

    await assert.rejects(
      () => fetchPage("http://public.test/start", rebindPolicy, deps),
      /Could not reach|did not answer within/,
    );
    const dir = await mkdtemp(join(tmpdir(), "harness-download-rebind-"));
    try {
      await assert.rejects(
        () => downloadUrl("http://public.test/start", dir, rebindPolicy, { deps }),
        /Could not reach|did not answer within/,
      );
      assert.deepEqual(await readdir(dir), [], "a rebinding download must not leave a staged file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.deepEqual(resolutions, ["public.test", "localhost", "public.test", "localhost"]);
    assert.equal(requests, 0, "the loopback server must never receive the request");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("allowPrivateHosts opens the local network deliberately", async () => {
  const { impl } = fakeFetch({ "http://192.168.1.50/status": html("<body>All good</body>") });
  const page = await fetchPage(
    "http://192.168.1.50/status",
    { ...policy, allowPrivateHosts: true },
    { fetchImpl: impl, resolveHost: publicDns },
  );
  assert.match(page.text, /All good/);
});

test("a redirect into the local network is refused, not followed", async () => {
  // The whole reason redirects are followed by hand: the URL the agent was
  // given is public, and the destination is the router.
  const { impl, seen } = fakeFetch({
    "https://example.com/go": new Response(null, {
      status: 302,
      headers: { location: "http://192.168.1.1/admin" },
    }),
  });

  await assert.rejects(
    () => fetchPage("https://example.com/go", policy, { fetchImpl: impl, resolveHost: publicDns }),
    WebPolicyError,
  );
  assert.deepEqual(seen, ["https://example.com/go"], "the second hop is never requested");
});

test("an ordinary redirect is followed and the final url reported", async () => {
  const { impl } = fakeFetch({
    "https://example.com/old": new Response(null, {
      status: 301,
      headers: { location: "/new" },
    }),
    "https://example.com/new": html("<body>Moved here</body>"),
  });

  const page = await fetchPage("https://example.com/old", policy, {
    fetchImpl: impl,
    resolveHost: publicDns,
  });
  assert.equal(page.url, "https://example.com/new");
  assert.match(page.text, /Moved here/);
});

test("a redirect loop stops at the configured limit", async () => {
  const { impl } = fakeFetch({
    "https://example.com/loop": () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/loop" } }),
  });

  await assert.rejects(
    () =>
      fetchPage("https://example.com/loop", { ...policy, maxRedirects: 2 }, {
        fetchImpl: impl,
        resolveHost: publicDns,
      }),
    /redirected more than 2 times/,
  );
});

test("allowHosts and blockHosts bound where a channel can go", async () => {
  const { impl } = fakeFetch({ "https://example.com/": html("<body>ok</body>") });
  const deps = { fetchImpl: impl, resolveHost: publicDns };

  await assert.rejects(
    () => fetchPage("https://example.com/", { ...policy, allowHosts: ["docs.internal"] }, deps),
    /not on this channel's allowed list/,
  );
  await assert.rejects(
    () => fetchPage("https://example.com/", { ...policy, blockHosts: ["example.com"] }, deps),
    /blocked list/,
  );
  // Allowed when it is on the list.
  const page = await fetchPage("https://example.com/", { ...policy, allowHosts: ["example.com"] }, deps);
  assert.match(page.text, /ok/);
});

test("short file writes are retried until every byte is staged", async () => {
  const calls: number[] = [];
  const writer = {
    write: async (data: Uint8Array) => {
      calls.push(data.byteLength);
      return { bytesWritten: Math.min(2, data.byteLength) };
    },
  };

  assert.equal(await writeAll(writer, new Uint8Array([1, 2, 3, 4, 5])), 5);
  assert.deepEqual(calls, [5, 3, 1]);
});

test("a binary is staged in the workspace with a safe unique filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-download-"));
  try {
    await writeFile(join(dir, "guide.pdf"), "keep me");
    const { impl } = fakeFetch({
      "https://example.com/files/manual": new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="../../guide.pdf"',
        },
      }),
    });

    const file = await downloadUrl("https://example.com/files/manual", dir, policy, {
      deps: { fetchImpl: impl, resolveHost: publicDns },
    });

    assert.equal(file.filename, "guide-2.pdf");
    assert.equal(file.contentType, "application/pdf");
    assert.equal(file.bytes, 4);
    assert.equal(await readFile(join(dir, "guide.pdf"), "utf8"), "keep me", "existing files are never overwritten");
    assert.deepEqual(await readFile(file.path), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloads enforce the byte cap and clean up partial files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-download-"));
  try {
    const { impl } = fakeFetch({
      "https://example.com/large.pdf": new Response("12345", { headers: { "content-type": "application/pdf" } }),
    });
    await assert.rejects(
      () => downloadUrl("https://example.com/large.pdf", dir, { ...policy, downloadMaxBytes: 4 }, {
        deps: { fetchImpl: impl, resolveHost: publicDns },
      }),
      (err: Error) => err instanceof WebPolicyError && /download limit/.test(err.message),
    );
    assert.deepEqual(await readdir(dir), [], "an over-limit body leaves no partial download behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a download redirect into the local network is refused before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-download-"));
  try {
    const { impl, seen } = fakeFetch({
      "https://example.com/manual": new Response(null, {
        status: 302,
        headers: { location: "http://192.168.1.1/manual.pdf" },
      }),
    });
    await assert.rejects(
      () => downloadUrl("https://example.com/manual", dir, policy, {
        deps: { fetchImpl: impl, resolveHost: publicDns },
      }),
      WebPolicyError,
    );
    assert.deepEqual(seen, ["https://example.com/manual"]);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("binary content is refused by name rather than relayed", async () => {
  const { impl } = fakeFetch({
    "https://example.com/manual.pdf": new Response("%PDF-1.7 binary junk", {
      headers: { "content-type": "application/pdf" },
    }),
  });

  await assert.rejects(
    () =>
      fetchPage("https://example.com/manual.pdf", policy, {
        fetchImpl: impl,
        resolveHost: publicDns,
      }),
    (err: Error) => err instanceof WebPolicyError && /application\/pdf/.test(err.message),
  );
});

test("an error status is reported rather than parsed", async () => {
  const { impl } = fakeFetch({
    "https://example.com/gone": html("<body>Not found</body>", 404),
  });
  await assert.rejects(
    () => fetchPage("https://example.com/gone", policy, { fetchImpl: impl, resolveHost: publicDns }),
    /returned 404/,
  );
});

test("a long page is cut to the character cap and says so", async () => {
  const { impl } = fakeFetch({
    "https://example.com/long": html(`<body><p>${"word ".repeat(2000)}</p></body>`),
  });
  const page = await fetchPage("https://example.com/long", { ...policy, maxChars: 200 }, {
    fetchImpl: impl,
    resolveHost: publicDns,
  });

  assert.equal(page.text.length, 200);
  assert.equal(page.truncated, true);
});

test("plain text is passed through without html handling", async () => {
  const { impl } = fakeFetch({
    "https://example.com/robots.txt": new Response("User-agent: *\nDisallow: /private", {
      headers: { "content-type": "text/plain" },
    }),
  });
  const page = await fetchPage("https://example.com/robots.txt", policy, {
    fetchImpl: impl,
    resolveHost: publicDns,
  });
  assert.match(page.text, /Disallow: \/private/);
});

// --- Search ----------------------------------------------------------------

const search = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  provider: "none",
  apiKey: "",
  url: "",
  maxResults: 3,
  ...over,
});

test("search says plainly when no provider is configured", async () => {
  await assert.rejects(
    () => searchWeb("anything", search()),
    (err: Error) => err instanceof WebPolicyError && /No search provider/.test(err.message),
  );
});

test("a provider with no key fails with the config key to fix", async () => {
  await assert.rejects(
    () => searchWeb("anything", search({ provider: "brave" })),
    /web\.search\.apiKey/,
  );
  await assert.rejects(
    () => searchWeb("anything", search({ provider: "searxng" })),
    /web\.search\.url/,
  );
});

test("brave results are normalised", async () => {
  const impl = (async (url: any, init: any) => {
    assert.match(String(url), /q=router%20firmware/);
    assert.equal((init.headers as any)["x-subscription-token"], "key-123");
    return Response.json({
      web: {
        results: [
          { title: "Firmware", url: "https://example.com/fw", description: "Fixes <b>VLAN</b>" },
          { title: "Other", url: "https://example.com/other" },
        ],
      },
    });
  }) as unknown as typeof fetch;

  const results = await searchWeb(
    "router firmware",
    search({ provider: "brave", apiKey: "key-123" }),
    { fetchImpl: impl },
  );

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    title: "Firmware",
    url: "https://example.com/fw",
    snippet: "Fixes VLAN",
  });
  assert.equal(results[1]?.snippet, undefined);
});

test("tavily and searxng results are normalised the same way", async () => {
  const tavily = (async () =>
    Response.json({
      results: [{ title: "T", url: "https://t.example", content: "snippet" }],
    })) as unknown as typeof fetch;
  const searx = (async (url: any) => {
    assert.match(String(url), /^https:\/\/searx\.example\/search\?/);
    return Response.json({ results: [{ title: "S", url: "https://s.example", content: "snip" }] });
  }) as unknown as typeof fetch;

  assert.deepEqual(
    await searchWeb("q", search({ provider: "tavily", apiKey: "k" }), { fetchImpl: tavily }),
    [{ title: "T", url: "https://t.example", snippet: "snippet" }],
  );
  assert.deepEqual(
    await searchWeb("q", search({ provider: "searxng", url: "https://searx.example/" }), {
      fetchImpl: searx,
    }),
    [{ title: "S", url: "https://s.example", snippet: "snip" }],
  );
});

test("a failing search reports the provider and status", async () => {
  const impl = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () => searchWeb("q", search({ provider: "brave", apiKey: "k" }), { fetchImpl: impl }),
    /brave search failed: 429/,
  );
});
