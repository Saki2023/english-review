"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const ORIGIN = "https://english.6584285.xyz";

function requestKey(value) {
  const raw = value && typeof value === "object" && value.url ? value.url : String(value);
  return new URL(raw, ORIGIN).href;
}

function createWorker({ fetchImpl, setTimeoutImpl = setTimeout } = {}) {
  const listeners = {};
  const stores = new Map();
  let clientsClaimed = 0;
  let skippedWaiting = 0;

  function storeFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function cacheFor(name) {
    const store = storeFor(name);
    return {
      async addAll(entries) {
        for (const entry of entries) {
          const response = await fetchImpl(new Request(new URL(entry, ORIGIN)));
          if (!response.ok) throw new Error(`failed to cache ${entry}`);
          store.set(requestKey(entry), response.clone());
        }
      },
      async match(request) {
        const response = store.get(requestKey(request));
        return response ? response.clone() : undefined;
      },
      async put(request, response) {
        store.set(requestKey(request), response.clone());
      }
    };
  }

  const caches = {
    async open(name) { return cacheFor(name); },
    async keys() { return Array.from(stores.keys()); },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const store of stores.values()) {
        const response = store.get(requestKey(request));
        if (response) return response.clone();
      }
      return undefined;
    }
  };

  const self = {
    location: { origin: ORIGIN },
    clients: { async claim() { clientsClaimed += 1; } },
    async skipWaiting() { skippedWaiting += 1; },
    addEventListener(type, handler) { listeners[type] = handler; }
  };

  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), {
    self,
    caches,
    fetch: fetchImpl || (async () => new Response("network")),
    Request,
    Response,
    URL,
    Promise,
    setTimeout: setTimeoutImpl,
    clearTimeout
  }, { filename: "sw.js" });

  function dispatchFetch(request) {
    let responsePromise;
    const waits = [];
    listeners.fetch({
      request,
      respondWith(value) { responsePromise = Promise.resolve(value); },
      waitUntil(value) { waits.push(Promise.resolve(value)); }
    });
    return { responsePromise, waits };
  }

  async function dispatchLifecycle(type) {
    const waits = [];
    listeners[type]({ waitUntil(value) { waits.push(Promise.resolve(value)); } });
    await Promise.all(waits);
  }

  return { cacheFor, caches, dispatchFetch, dispatchLifecycle, stores, counts: () => ({ clientsClaimed, skippedWaiting }) };
}

test("service worker serves cached static assets without touching the network and bypasses APIs", async () => {
  let fetchCalls = 0;
  const worker = createWorker({ fetchImpl: async () => { fetchCalls += 1; throw new Error("network should not be used"); } });
  const cache = worker.cacheFor("daily-english-review-v79");
  const asset = new Request(`${ORIGIN}/app.js?v=79`);
  await cache.put(asset, new Response("cached-app"));

  const cachedEvent = worker.dispatchFetch(asset);
  assert.ok(cachedEvent.responsePromise);
  assert.equal(await (await cachedEvent.responsePromise).text(), "cached-app");
  assert.equal(fetchCalls, 0);

  const apiEvent = worker.dispatchFetch(new Request(`${ORIGIN}/api/state`));
  assert.equal(apiEvent.responsePromise, undefined);
  assert.equal(fetchCalls, 0);

  const postEvent = worker.dispatchFetch({ url: `${ORIGIN}/form`, method: "POST", mode: "same-origin" });
  assert.equal(postEvent.responsePromise, undefined);
});

test("install precaches the complete v79 app shell and immediately activates the worker", async () => {
  const fetched = [];
  const worker = createWorker({
    fetchImpl: async request => {
      fetched.push(new URL(request.url).pathname + new URL(request.url).search);
      return new Response(`cached:${request.url}`);
    }
  });

  await worker.dispatchLifecycle("install");

  assert.equal(worker.counts().skippedWaiting, 1);
  assert.deepEqual(await worker.caches.keys(), ["daily-english-review-v79"]);
  assert.equal(fetched.length, 19);
  assert.equal(new Set(fetched).size, 19);
  assert.ok(fetched.includes("/index.html"));
  assert.ok(fetched.includes("/app.js?v=79"));
  assert.ok(fetched.includes("/offline-store.js?v=79"));
  assert.ok(fetched.includes("/vendor/lucide.min.js?v=79"));
  assert.equal(fetched.some(entry => entry.includes("v=76")), false);
});

test("slow navigation returns cached HTML while the delayed network refresh stays alive", async () => {
  let resolveNetwork;
  const network = new Promise(resolve => { resolveNetwork = resolve; });
  const worker = createWorker({
    fetchImpl: async () => network,
    setTimeoutImpl: callback => { queueMicrotask(callback); return 1; }
  });
  const cache = worker.cacheFor("daily-english-review-v79");
  await cache.put("/index.html", new Response("cached-index"));

  const event = worker.dispatchFetch({ url: `${ORIGIN}/`, method: "GET", mode: "navigate" });
  assert.equal(await (await event.responsePromise).text(), "cached-index");

  resolveNetwork(new Response("fresh-index"));
  await Promise.all(event.waits);
  assert.equal(await (await cache.match("/index.html")).text(), "fresh-index");
});

test("first navigation waits for a real response and activation retires the old cache", async () => {
  const worker = createWorker({ fetchImpl: async () => new Response("first-online-index") });
  worker.cacheFor("daily-english-review-v76");
  const event = worker.dispatchFetch({ url: `${ORIGIN}/`, method: "GET", mode: "navigate" });
  assert.equal(await (await event.responsePromise).text(), "first-online-index");
  await Promise.all(event.waits);

  await worker.dispatchLifecycle("activate");
  assert.deepEqual(await worker.caches.keys(), ["daily-english-review-v79"]);
  assert.equal(worker.counts().clientsClaimed, 1);
});
