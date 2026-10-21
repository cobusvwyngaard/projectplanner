// The app shell service worker (SPEC 6.1, Phase 5). It caches only the
// hashed files under /assets/, which never change under the same name, so a
// repeat visit starts fast. Pages and /api are never cached: every page is
// behind the session, and a cached page would show stale or signed-out
// content. Offline, a navigation answers with a plain page that says so.
// No offline sync in v1. Bump VERSION whenever the rules below change.

const VERSION = "planner-v1";
const ASSET_CACHE = VERSION + "-assets";

// Paths that always go straight to the network, in both directions.
const NEVER_CACHED = ["/api/", "/mcp", "/login", "/logout", "/authorize", "/token", "/register", "/.well-known/"];

// Shown when a page is asked for and the network is not there. It carries no
// planner data and no external resources: inline styles only.
const OFFLINE_PAGE = `<!doctype html>
<html lang="en-ZA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You are offline · Shared Planner</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: #f4f2ec; color: #1d2025; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 400px; padding: 32px 24px; border: 1px solid #dcd8cd; border-radius: 18px; background: #ffffff; }
h1 { margin: 0 0 8px; font-size: 1.35rem; }
p { margin: 0; }
</style>
</head>
<body>
<main>
<h1>You're offline.</h1>
<p>The planner needs a connection; it will load again when you're back online.</p>
</main>
</body>
</html>
`;

/** True for the paths that must never be cached or answered from a cache. */
function neverCached(pathname) {
  return NEVER_CACHED.some((path) => (path.endsWith("/") ? pathname.startsWith(path) : pathname === path));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Caches of older versions (and anything else on this origin) go.
      for (const name of await caches.keys()) {
        if (name !== ASSET_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (neverCached(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkOnly(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  }
  // Everything else goes straight to the network.
});

/** Pages are never cached; offline, one that says so instead of an error. */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

/** Hashed files answer from the cache when they are in it, and are stored after a plain 200. */
async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200 && !response.redirected) await cache.put(request, response.clone());
  return response;
}
