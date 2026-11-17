// Service worker for webConsole2. It exists so the console can be installed and so its app shell opens when the network is
// down. It deliberately caches almost nothing:
//
//   - `api/`        never touched: the live API and the event stream are sensitive and must always come from the harness.
//                   The worker does not even look at the response, so nothing from the API can end up in a cache.
//   - the shell     (index.html): network first, the cached copy only as the offline fallback.
//   - hashed files  (`assets/`), icons, manifest: cache first.
//   - everything else, and every non-GET request: left to the browser.
//
// A response is cached only if it is `ok`, `basic` and NOT redirected. Behind an access proxy an expired session answers with
// a redirect to a login page; caching that would make the console open a login page for ever.
//
// Everything is relative to where this file is served (`<prefix>/console2/`), which is not known at build time.

const VERSION = "v2";
const SCOPE = new URL("./", self.location).pathname;
const CACHE = `console2-shell-${VERSION}-${SCOPE}`;
const OWN_CACHES = (name) => name.startsWith("console2-shell-") && name.endsWith(`-${SCOPE}`);
const SHELL_KEY = new Request(new URL("./", self.location).href);
const STATIC = /^(assets\/|icon[^/]*\.(png|svg)$|favicon[^/]*\.(png|svg)$|apple-touch-icon\.png$|manifest\.webmanifest$|theme-init\.js$)/;
const NETWORK_TIMEOUT_MS = 6000;

// Access-protected shells/assets must be fetched through the session gate, not opened offline from this cache.
const protectedResponse = (response) => response.headers.get("x-harness-access-protected") === "1";
const cacheable = (response) => response.ok && response.type === "basic" && !response.redirected && !protectedResponse(response);
async function clearOwnCaches() {
  for (const name of await caches.keys()) if (OWN_CACHES(name)) await caches.delete(name);
}

/** Fetch the shell and everything it names, so the first visit is enough to work offline. */
async function precache() {
  const cache = await caches.open(CACHE);
  const index = await fetch(new Request(SHELL_KEY.url, { cache: "reload" }));
  if (protectedResponse(index)) { await clearOwnCaches(); return; }
  if (!cacheable(index)) throw new Error("the shell did not load cleanly, so it is not cached");
  const html = await index.clone().text();
  const wanted = new Set(["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "favicon-32.png", "apple-touch-icon.png"]);
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)) wanted.add(match[1]);
  await cache.put(SHELL_KEY, index);
  await Promise.all([...wanted].map(async (relative) => {
    if (!STATIC.test(relative)) return;
    const response = await fetch(new URL(relative, SHELL_KEY.url));
    if (cacheable(response)) await cache.put(new URL(relative, SHELL_KEY.url).href, response);
  }));
}

self.addEventListener("install", (event) => {
  // A failed precache fails the install: the page keeps working without a worker, which is the safe outcome.
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (OWN_CACHES(name) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const fromCache = () => cache.match(SHELL_KEY, { ignoreSearch: true });
  const network = fetch(request).then(async (response) => {
    if (protectedResponse(response)) await clearOwnCaches();
    else if (cacheable(response)) await cache.put(SHELL_KEY, response.clone());
    return response;
  });
  network.catch(() => {}); // when the cache answers first this is never awaited; awaiting it below still rejects as usual
  try {
    // A connection that hangs is as good as none: after a few seconds prefer the cached shell if there is one.
    const cached = await fromCache();
    if (!cached) return await network;
    return await Promise.race([network, new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS))]);
  } catch (error) {
    const cached = await fromCache();
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  const relative = url.pathname.slice(SCOPE.length);
  if (relative.startsWith("api/")) return; // never intercepted, never cached
  if (request.mode === "navigate" || relative === "" || relative === "index.html") return void event.respondWith(networkFirst(request));
  if (STATIC.test(relative)) return void event.respondWith(cacheFirst(request));
});
