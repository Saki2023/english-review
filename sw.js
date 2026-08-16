const CACHE_NAME = "daily-english-review-v67";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=67",
  "/data.js?v=67",
  "/pronunciation-data.js?v=67",
  "/review-variants.js?v=67",
  "/answer-utils.js?v=67",
  "/study-time.js?v=67",
  "/review-session.js?v=67",
  "/review-batch-client.js?v=67",
  "/offline-store.js?v=67",
  "/offline-learning.js?v=67",
  "/offline-ai.js?v=67",
  "/offline-replay.js?v=67",
  "/app.js?v=67",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=67"
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
