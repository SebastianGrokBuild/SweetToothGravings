/* Sweet Tooth Cravings — Service Worker
 * Caches shell + key assets for offline browse; always prefers network for API.
 * Bump CACHE_VERSION when shipping client changes so devices refresh.
 */
const CACHE_VERSION = "stc-pwa-v3-20260728-polish";
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME = `runtime-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/admin.html",
  "/offline.html",
  "/manifest.json",
  "/config.js",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/assets/images/logo.png",
  "/assets/images/hero.jpg",
  "/assets/images/custom-cakes.jpg",
  "/assets/images/tres-leches-9x13.jpg",
  "/assets/images/chocoflan.jpg",
  "/assets/images/breakable-heart.jpg",
  "/assets/images/churro-cheesecake.jpg",
  "/assets/images/cupcakes.jpg",
  "/assets/images/2-tier-cakes.jpg",
  "/assets/images/flan.jpg",
  "/assets/images/bento-cake.jpg",
  "/assets/images/mini-cakes.jpg",
  "/assets/images/coquito.jpg",
  "/assets/images/sheet-cake.jpg",
  "/assets/images/chocolate-strawberries.jpg",
  "/assets/images/party-packages.jpg",
];

function isApiRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("onrender.com") ||
    url.hostname.includes("stripe.com") ||
    url.hostname.includes("api.stripe.com")
  );
}

function isCdnRequest(url) {
  return (
    url.hostname.includes("cdn.tailwindcss.com") ||
    url.hostname.includes("cdnjs.cloudflare.com") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" })),
        ),
      )
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn("[sw] precache partial failure", err);
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Allow page to ask SW to activate immediately after update
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Never cache order API / Stripe / auth traffic
  if (isApiRequest(url)) return;

  // Navigation: network first, fall back to cached shell
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(networkFirstHtml(req));
    return;
  }

  // Same-origin static assets: cache first, update in background
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // CDNs: stale-while-revalidate when available
  if (isCdnRequest(url)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirstHtml(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME);
      cache.put("/index.html", fresh.clone()).catch(() => {});
      cache.put("/", fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached =
      (await caches.match(request)) ||
      (await caches.match("/index.html")) ||
      (await caches.match("/")) ||
      (await caches.match("/offline.html"));
    if (cached) return cached;
    return new Response(offlineHtml(), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Refresh cache in background
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          caches.open(RUNTIME).then((c) => c.put(request, res)).catch(() => {});
        }
      })
      .catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    return caches.match("/index.html");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

function offlineHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#C9A9E8">
<title>Offline · Sweet Tooth Cravings</title>
<style>
  body{font-family:system-ui,sans-serif;background:#FDF8F5;color:#3F2A2B;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem;text-align:center}
  .card{max-width:22rem;background:#fff;border:1px solid #EDE4DC;border-radius:1.5rem;padding:2rem;box-shadow:0 10px 30px rgba(63,42,43,.06)}
  h1{font-size:1.35rem;margin:0 0 .5rem}
  p{color:#6B5B5F;font-size:.95rem;line-height:1.5;margin:0 0 1.25rem}
  button{background:#C9A9E8;color:#fff;border:0;border-radius:999px;padding:.75rem 1.25rem;font-weight:600;font-size:.95rem}
</style></head><body>
<div class="card">
  <h1>You're offline</h1>
  <p>Sweet Tooth Cravings needs a connection to load the latest menu. Check your signal and try again.</p>
  <button onclick="location.reload()">Retry</button>
</div>
</body></html>`;
}
