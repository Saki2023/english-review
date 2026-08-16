const CACHE_NAME = "daily-english-review-v69";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=69",
  "/data.js?v=69",
  "/pronunciation-data.js?v=69",
  "/review-variants.js?v=69",
  "/answer-utils.js?v=69",
  "/study-time.js?v=69",
  "/review-session.js?v=69",
  "/review-batch-client.js?v=69",
  "/state-sync-client.js?v=69",
  "/offline-store.js?v=69",
  "/offline-learning.js?v=69",
  "/offline-ai.js?v=69",
  "/offline-replay.js?v=69",
  "/app.js?v=69",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=69"
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
