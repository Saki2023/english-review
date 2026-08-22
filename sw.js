const CACHE_NAME = "daily-english-review-v77";
const NAVIGATION_NETWORK_TIMEOUT_MS = 2500;
const APP_SHELL = [
  "/index.html",
  "/styles.css?v=77",
  "/data.js?v=77",
  "/pronunciation-data.js?v=77",
  "/review-variants.js?v=77",
  "/answer-utils.js?v=77",
  "/study-time.js?v=77",
  "/review-session.js?v=77",
  "/review-batch-client.js?v=77",
  "/state-sync-client.js?v=77",
  "/library-usage.js?v=77",
  "/offline-store.js?v=77",
  "/offline-learning.js?v=77",
  "/offline-ai.js?v=77",
  "/offline-replay.js?v=77",
  "/app.js?v=77",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=77"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

async function fetchAndCache(request, cacheKey = request) {
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetchAndCache(request);
}

async function navigationWithBoundedNetwork(networkPromise) {
  const cached = await caches.match("/index.html");
  if (!cached) {
    const response = await networkPromise;
    return response || new Response("当前网络不可用，且尚未准备离线页面。", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const response = await Promise.race([
    networkPromise,
    new Promise(resolve => setTimeout(() => resolve(null), NAVIGATION_NETWORK_TIMEOUT_MS))
  ]);
  return response || cached;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    const networkPromise = fetchAndCache(request, "/index.html").catch(() => null);
    event.waitUntil(networkPromise.then(() => undefined));
    event.respondWith(navigationWithBoundedNetwork(networkPromise));
    return;
  }
  event.respondWith(cacheFirst(request));
});
