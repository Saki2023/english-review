const CACHE_NAME = "daily-english-review-v63";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=63",
  "/data.js?v=63",
  "/pronunciation-data.js?v=63",
  "/review-variants.js?v=63",
  "/answer-utils.js?v=63",
  "/study-time.js?v=63",
  "/review-session.js?v=63",
  "/review-batch-client.js?v=63",
  "/offline-store.js?v=63",
  "/offline-learning.js?v=63",
  "/offline-ai.js?v=63",
  "/offline-replay.js?v=63",
  "/app.js?v=63",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=63"
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
