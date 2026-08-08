const CACHE_NAME = "daily-english-review-v56";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=56",
  "/data.js?v=56",
  "/pronunciation-data.js?v=56",
  "/review-variants.js?v=56",
  "/answer-utils.js?v=56",
  "/study-time.js?v=56",
  "/app.js?v=56",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/lucide.min.js?v=56"
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
