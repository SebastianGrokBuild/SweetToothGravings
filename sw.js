/* Sweet Tooth Cravings — Service Worker
 * Shell can offline-cache lightly; product photos always prefer the network
 * so replacing a file in assets/images/ shows up on every device.
 * Bump CACHE_VERSION when shipping SW logic changes.
 */
const CACHE_VERSION = "stc-pwa-v4-20260801-img-network";
const PRECACHE = `precache-${CACHE_VERSION}`;
const RUNTIME = `runtime-${CACHE_VERSION}`;

/** App shell only — do NOT precache product photos (they change often). */
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

function isImageAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/assets/images/")) return true;
  return /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(url.pathname);
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

  if (isApiRequest(url)) return;

  // HTML navigations: network first
  if (
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html")
  ) {
    event.respondWith(networkFirstHtml(req));
    return;
  }

  // Product / site images: always try network first so file replacements win
  if (isImageAsset(url)) {
    event.respondWith(networkFirstImage(req));
    return;
  }

  // Same-origin non-image static (JS/CSS/icons shell): stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

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

/** Images: network first, ignore HTTP cache when possible, cache as offline fallback only. */
async function networkFirstImage(request) {
  try {
    const fresh = await fetch(request, { cache: "no-cache" });
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME);
      cache.put(request, fresh.clone()).catch(() => {});
      return fresh;
    }
  } catch {
    /* fall through to cache */
  }
  const cached = await caches.match(request);
  if (cached) return cached;
  // Last resort: try normal fetch without no-cache
  try {
    return await fetch(request);
  } catch {
    return new Response("", { status: 504, statusText: "Image offline" });
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
  <p>Reconnect to browse the full menu and place an order.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</div>
</body></html>`;
}
