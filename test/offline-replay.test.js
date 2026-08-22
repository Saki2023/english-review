"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createOfflineStore } = require("../offline-store");
const { replayOutbox } = require("../offline-replay");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) };
}

function pack(accountId = "account-a") {
  const generatedAt = new Date(Date.now() - 60 * 60 * 1000);
  return {
    schemaVersion: 1,
    account: { id: accountId, username: accountId },
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 14 * 86400000).toISOString(),
    revision: "one"
  };
}

function operation(id, path, createdAt) {
  return { id, accountId: "account-a", path, method: "POST", body: { requestId: id }, createdAt, updatedAt: createdAt };
}

async function preparedStore() {
  const store = createOfflineStore({ localStorage: new MemoryStorage() });
  await store.savePack(pack(), "account-a");
  await store.enqueue(operation("one", "/api/self-study/pause", 1), "account-a");
  await store.enqueue(operation("two", "/api/self-study/resume", 2), "account-a");
  return store;
}

test("offline outbox authenticates the same account, replays strict FIFO, and refreshes the authoritative pack", async () => {
  const store = await preparedStore();
  const calls = [];
  const refreshed = { ...pack(), revision: "server-after-replay" };
  const fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET" });
    if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a", username: "A" } });
    if (path === "/api/offline/pack") return jsonResponse(200, refreshed);
    return jsonResponse(200, { ok: true });
  };
  const result = await replayOutbox({ store, accountId: "account-a", fetch });
  assert.deepEqual(calls.map(item => item.path), ["/api/auth/status", "/api/self-study/pause", "/api/self-study/resume", "/api/offline/pack"]);
  assert.equal(result.replayed, 2);
  assert.equal(result.remaining, 0);
  assert.equal((await store.loadPack("account-a")).revision, "server-after-replay");
});

test("offline outbox stops at the first failed operation and never bypasses it", async () => {
  const store = await preparedStore();
  const calls = [];
  const fetch = async path => {
    calls.push(path);
    if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a" } });
    if (path === "/api/self-study/pause") return jsonResponse(503, { error: "暂时失败" });
    return jsonResponse(200, {});
  };
  await assert.rejects(() => replayOutbox({ store, accountId: "account-a", fetch }), error => error.code === "operation_failed" && error.statusCode === 503);
  assert.deepEqual(calls, ["/api/auth/status", "/api/self-study/pause"]);
  const pending = await store.listOutbox("account-a");
  assert.deepEqual(pending.map(item => item.id), ["one", "two"]);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastError, "暂时失败");
});

test("a lost response leaves the stable operation queued, and retry applies it once before later operations", async () => {
  const store = await preparedStore();
  const applied = new Set();
  const visibleOrder = [];
  let loseFirstResponse = true;
  const fetch = async (path, options = {}) => {
    if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a" } });
    if (path === "/api/offline/pack") return jsonResponse(200, pack());
    const body = JSON.parse(options.body);
    if (!applied.has(body.requestId)) {
      applied.add(body.requestId);
      visibleOrder.push(body.requestId);
    }
    if (body.requestId === "one" && loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error("response lost");
    }
    return jsonResponse(200, { reused: applied.has(body.requestId) });
  };
  await assert.rejects(() => replayOutbox({ store, accountId: "account-a", fetch }), error => error.code === "network");
  assert.deepEqual((await store.listOutbox("account-a")).map(item => item.id), ["one", "two"]);
  const second = await replayOutbox({ store, accountId: "account-a", fetch });
  assert.equal(second.replayed, 2);
  assert.deepEqual(visibleOrder, ["one", "two"]);
  assert.equal(applied.size, 2);
});

test("account mismatch blocks replay before reading or mutating queued operations", async () => {
  const store = await preparedStore();
  const before = await store.listOutbox("account-a");
  const fetch = async () => jsonResponse(200, { authenticated: true, user: { id: "account-b" } });
  await assert.rejects(() => replayOutbox({ store, accountId: "account-a", fetch }), error => error.code === "account_mismatch");
  assert.deepEqual(await store.listOutbox("account-a"), before);
});

test("a missing remote AI set is classified separately and remains first in FIFO", async () => {
  const store = await preparedStore();
  const first = await store.listOutbox("account-a");
  await store.removeOutbox("one", "account-a");
  await store.removeOutbox("two", "account-a");
  await store.enqueue({ ...first[0], id: "ai-draft:set-1:1:q1", path: "/api/ai/questions/batch/draft" }, "account-a");
  await store.enqueue(operation("later", "/api/self-study/resume", 2), "account-a");
  const calls = [];
  const fetch = async path => {
    calls.push(path);
    if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a" } });
    if (path === "/api/ai/questions/batch/draft") return jsonResponse(404, { error: "AI question set not found" });
    return jsonResponse(200, {});
  };
  await assert.rejects(() => replayOutbox({ store, accountId: "account-a", fetch }), error => error.code === "content_missing");
  assert.deepEqual(calls, ["/api/auth/status", "/api/ai/questions/batch/draft"]);
  assert.deepEqual((await store.listOutbox("account-a")).map(item => item.id), ["ai-draft:set-1:1:q1", "later"]);

  const retryCalls = [];
  const retried = await replayOutbox({
    store,
    accountId: "account-a",
    fetch: async path => {
      retryCalls.push(path);
      if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a" } });
      if (path === "/api/offline/pack") return jsonResponse(200, pack());
      return jsonResponse(200, { ok: true });
    }
  });
  assert.equal(retried.replayed, 2);
  assert.deepEqual(retryCalls, ["/api/auth/status", "/api/ai/questions/batch/draft", "/api/self-study/resume", "/api/offline/pack"]);
  assert.equal((await store.listOutbox("account-a")).length, 0);
});

test("two tabs replaying the same stable IDs keep server evidence idempotent and empty the queue", async () => {
  const store = await preparedStore();
  const applied = new Set();
  let evidenceWrites = 0;
  const fetch = async (path, options = {}) => {
    if (path === "/api/auth/status") return jsonResponse(200, { authenticated: true, user: { id: "account-a" } });
    if (path === "/api/offline/pack") return jsonResponse(200, pack());
    const requestId = JSON.parse(options.body).requestId;
    if (!applied.has(requestId)) { applied.add(requestId); evidenceWrites += 1; }
    await new Promise(resolve => setImmediate(resolve));
    return jsonResponse(200, { reused: applied.has(requestId) });
  };
  await Promise.all([
    replayOutbox({ store, accountId: "account-a", fetch }),
    replayOutbox({ store, accountId: "account-a", fetch })
  ]);
  assert.equal(evidenceWrites, 2);
  assert.deepEqual(Array.from(applied), ["one", "two"]);
  assert.equal((await store.listOutbox("account-a")).length, 0);
});
