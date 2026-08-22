const CACHE_NAME = "daily-english-review-v76";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=76",
  "/data.js?v=76",
  "/pronunciation-data.js?v=76",
  "/review-variants.js?v=76",
  "/answer-utils.js?v=76",
  "/study-time.js?v=76",
  "/review-session.js?v=76",
  "/review-batch-client.js?v=76",
  "/state-sync-client.js?v=76",
  "/library-usage.js?v=76",
  "/offline-store.js?v=76",
  "/offline-learning.js?v=76",
  "/offline-ai.js?v=76",
  "/offline-replay.js?v=76",
  "/app.js?v=76",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=76"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put("/index.html", copy)); return response; }).catch(() => caches.match("/index.html")));
    return;
  }
  event.respondWith(fetch(request).then(response => { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)); return response; }).catch(() => caches.match(request)));
});
