"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ACTIVE_ACCOUNT_KEY,
  createOfflineStore,
  mergeOfflinePackRenewal,
  normalizeOfflinePack,
  normalizeOutboxOperation,
  packIsUsable
} = require("../offline-store");

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.failWrites = false;
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) {
    if (this.failWrites) throw new Error("quota exceeded");
    this.values.set(key, String(value));
  }
}

function asyncRequest(run) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
  });
  return request;
}

function fakeIndexedDb() {
  const stores = new Map();
  const control = {
    failNextPut: false,
    failPutNumbers: new Set(),
    holdNextPut: false,
    openFails: false,
    putCount: 0,
    releaseHeldPut: null
  };

  function heldRequest(run) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    let released = false;
    control.releaseHeldPut = () => {
      if (released) return;
      released = true;
      queueMicrotask(() => {
        try {
          request.result = run();
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          request.onerror?.();
        }
      });
    };
    return request;
  }

  function storeApi(name) {
    const descriptor = stores.get(name);
    if (!descriptor) throw new Error(`missing store ${name}`);
    return {
      keyPath: descriptor.keyPath,
      createIndex() { return this; },
      get(key) { return asyncRequest(() => structuredClone(descriptor.values.get(key))); },
      put(value) {
        const putNumber = ++control.putCount;
        const run = () => {
          if (control.failNextPut || control.failPutNumbers.has(putNumber)) {
            control.failNextPut = false;
            throw new Error("simulated IDB put failure");
          }
          const key = value[descriptor.keyPath];
          descriptor.values.set(key, structuredClone(value));
          return key;
        };
        if (control.holdNextPut) {
          control.holdNextPut = false;
          return heldRequest(run);
        }
        return asyncRequest(run);
      },
      delete(key) { return asyncRequest(() => descriptor.values.delete(key)); },
      index(indexName) {
        if (indexName !== "accountId") throw new Error("missing index");
        return { getAll: accountId => asyncRequest(() => Array.from(descriptor.values.values()).filter(value => value.accountId === accountId).map(value => structuredClone(value))) };
      }
    };
  }

  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name, options = {}) {
      stores.set(name, { keyPath: options.keyPath, values: new Map() });
      return storeApi(name);
    },
    deleteObjectStore(name) { stores.delete(name); },
    transaction(name) { return { objectStore: () => storeApi(name) }; }
  };

  return {
    control,
    indexedDB: {
      open(_name, _version) {
        const request = { result: db, error: null, transaction: { objectStore: name => storeApi(name) }, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (control.openFails) {
            request.error = new Error("simulated open failure");
            request.onerror?.();
            return;
          }
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      }
    },
    stores
  };
}

function pack(accountId, generatedOffset = 0) {
  const generatedAt = new Date(Date.now() + generatedOffset);
  return {
    schemaVersion: 1,
    packId: `pack-${accountId}-${generatedAt.getTime()}`,
    account: { id: accountId, username: accountId },
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 14 * 86400000).toISOString(),
    revision: String(generatedAt.getTime()),
    selfStudy: {},
    selfStudyPublic: {},
    preview: { words: [] },
    aiPractice: { preparedSets: [] }
  };
}

function operation(accountId, id, createdAt = Date.now()) {
  return { accountId, id, path: "/api/self-study/draft", method: "PUT", body: { draft: accountId }, createdAt, updatedAt: createdAt };
}

test("offline packs require the matching account, supported version, capacity, and future expiry", () => {
  const value = normalizeOfflinePack(pack("account-a"), "account-a");
  assert.equal(value.account.id, "account-a");
  assert.equal(packIsUsable(value, "account-a"), true);
  assert.equal(packIsUsable(value, "account-b"), false);
  assert.throws(() => normalizeOfflinePack({ ...value, schemaVersion: 99 }, "account-a"), /版本不兼容/);
  assert.throws(() => normalizeOfflinePack({ ...value, expiresAt: "2020-01-01T00:00:00.000Z" }, "account-a"), /已过期/);
});

test("expired packs remain inspectable and preserve local progress until explicit removal", async () => {
  const localStorage = new MemoryStorage();
  const store = createOfflineStore({ localStorage });
  const value = pack("account-a");
  value.expiresAt = "2026-08-20T00:00:00.000Z";
  value.localDraft = { setId: "set-one", answer: "草稿" };
  await store.savePack(value, "account-a");

  const status = await store.inspectPack("account-a", new Date("2026-08-22T00:00:00.000Z"));
  assert.equal(status.status, "expired");
  assert.equal(status.pack.localDraft.answer, "草稿");
  assert.equal(await store.loadPack("account-a", new Date("2026-08-22T00:00:00.000Z")), null);
  assert.equal((await store.loadPack("account-a", new Date("2026-08-22T00:00:00.000Z"), { allowExpired: true })).localDraft.answer, "草稿");
  assert.notEqual(localStorage.getItem("daily-english-review-offline-pack-v1-account-a"), null);
});

test("missing, corrupt, and account-mismatched packs have distinct non-destructive states", async () => {
  const localStorage = new MemoryStorage();
  const store = createOfflineStore({ localStorage });
  assert.equal((await store.inspectPack("account-a")).status, "missing");

  localStorage.setItem("daily-english-review-offline-pack-v1-account-a", JSON.stringify({ accountId: "account-a", pack: { schemaVersion: 1, account: { id: "account-a" } }, savedAt: 1 }));
  assert.equal((await store.inspectPack("account-a")).status, "corrupt");
  assert.notEqual(localStorage.getItem("daily-english-review-offline-pack-v1-account-a"), null);

  localStorage.setItem("daily-english-review-offline-pack-v1-account-a", JSON.stringify({ accountId: "account-a", pack: pack("account-b"), savedAt: 2 }));
  assert.equal((await store.inspectPack("account-a")).status, "account_mismatch");
});

test("renewing an expired pack keeps pending AI, self-study, and preview drafts without reviving them when no outbox remains", () => {
  const local = pack("account-a");
  local.expiresAt = "2026-08-20T00:00:00.000Z";
  local.aiPractice = { currentSet: { id: "local-set", questions: [{ id: "q1", userAnswer: "草稿" }] } };
  local.selfStudy = { progress: { lesson: { stepIndex: 3 } } };
  local.preview = { practice: { draft: "预习草稿" } };
  const remote = pack("account-a", 1000);
  remote.aiPractice = { currentSet: { id: "server-set" } };
  remote.selfStudy = { progress: {} };

  const preserved = mergeOfflinePackRenewal(local, remote, { preserveLocalProgress: true });
  assert.equal(preserved.aiPractice.currentSet.id, "local-set");
  assert.equal(preserved.aiPractice.currentSet.questions[0].userAnswer, "草稿");
  assert.equal(preserved.selfStudy.progress.lesson.stepIndex, 3);
  assert.equal(preserved.preview.practice.draft, "预习草稿");
  assert.equal(preserved.expiresAt, remote.expiresAt);
  assert.equal(preserved.recovery.pendingOutbox, true);

  const authoritative = mergeOfflinePackRenewal(local, remote, { preserveLocalProgress: false });
  assert.equal(authoritative.aiPractice.currentSet.id, "server-set");
  assert.equal(authoritative.recovery, undefined);
});

test("offline outbox IDs are scoped by account and active access requires an explicit matching marker", async () => {
  const localStorage = new MemoryStorage();
  const store = createOfflineStore({ localStorage });
  await store.savePack(pack("account-a"), "account-a");
  await store.savePack(pack("account-b"), "account-b");
  await store.enqueue(operation("account-a", "same-attempt", 1), "account-a");
  await store.enqueue(operation("account-b", "same-attempt", 2), "account-b");

  assert.equal((await store.listOutbox("account-a"))[0].body.draft, "account-a");
  assert.equal((await store.listOutbox("account-b"))[0].body.draft, "account-b");
  assert.notEqual(normalizeOutboxOperation(operation("account-a", "same-attempt")).storageKey, normalizeOutboxOperation(operation("account-b", "same-attempt")).storageKey);
  assert.equal(store.activeAccountId(), "");
  store.activate("account-a");
  assert.equal(store.activeAccountId(), "account-a");
  assert.equal((await store.loadPack(store.activeAccountId())).account.id, "account-a");
  store.clearActive();
  assert.equal(localStorage.getItem(ACTIVE_ACCOUNT_KEY), null);
});

test("IndexedDB stores equal stable IDs independently for two accounts", async () => {
  const fake = fakeIndexedDb();
  const store = createOfflineStore({ indexedDB: fake.indexedDB, localStorage: new MemoryStorage() });
  await store.enqueue(operation("account-a", "same-attempt", 1), "account-a");
  await store.enqueue(operation("account-b", "same-attempt", 2), "account-b");

  assert.equal(fake.stores.get("outbox").values.size, 2);
  assert.equal((await store.listOutbox("account-a")).length, 1);
  assert.equal((await store.listOutbox("account-b")).length, 1);
  await store.removeOutbox("same-attempt", "account-a");
  assert.equal((await store.listOutbox("account-a")).length, 0);
  assert.equal((await store.listOutbox("account-b")).length, 1);
});

test("IndexedDB is primary, local quota errors do not block it, and a newer fallback repairs stale IDB", async () => {
  const localStorage = new MemoryStorage();
  localStorage.failWrites = true;
  const fake = fakeIndexedDb();
  const store = createOfflineStore({ indexedDB: fake.indexedDB, localStorage });
  const first = pack("account-a", 0);
  await store.savePack(first, "account-a");
  assert.equal(fake.stores.get("packs").values.get("account-a").pack.packId, first.packId);
  assert.equal(Array.from(localStorage.values.keys()).some(key => key.includes("offline-pack")), false);

  localStorage.failWrites = false;
  fake.control.failNextPut = true;
  const second = { ...structuredClone(first), packId: `${first.packId}-updated`, revision: `${first.revision}:draft-updated` };
  await store.savePack(second, "account-a");
  assert.equal(Array.from(localStorage.values.keys()).some(key => key.includes("offline-pack")), true);
  const restored = await store.loadPack("account-a");
  assert.equal(restored.packId, second.packId);
  assert.equal(fake.stores.get("packs").values.get("account-a").pack.packId, second.packId);
  assert.equal(Array.from(localStorage.values.keys()).some(key => key.includes("offline-pack")), false);
});

test("offline pack writes are serialized per account so a delayed old snapshot cannot overwrite newer progress", async () => {
  const fake = fakeIndexedDb();
  const store = createOfflineStore({ indexedDB: fake.indexedDB, localStorage: new MemoryStorage() });
  const oldSnapshot = { ...pack("account-a"), localMarker: "old-preview-draft" };
  const newProgress = { ...structuredClone(oldSnapshot), localMarker: "new-self-study-and-ai-progress" };

  fake.control.holdNextPut = true;
  const oldSave = store.savePack(oldSnapshot, "account-a");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof fake.control.releaseHeldPut, "function");
  const newSave = store.savePack(newProgress, "account-a");
  fake.control.releaseHeldPut();
  await Promise.all([oldSave, newSave]);

  assert.equal((await store.loadPack("account-a")).localMarker, "new-self-study-and-ai-progress");
  assert.equal(fake.stores.get("packs").values.get("account-a").pack.localMarker, "new-self-study-and-ai-progress");
});

test("partial fallback migration followed by enqueue and remove preserves every remaining FIFO operation", async () => {
  const localStorage = new MemoryStorage();
  const key = "daily-english-review-offline-outbox-v1-account-a";
  const initial = [operation("account-a", "one", 1), operation("account-a", "two", 2), operation("account-a", "three", 3)];
  localStorage.setItem(key, JSON.stringify(initial));
  const fake = fakeIndexedDb();
  fake.control.failPutNumbers = new Set([2, 4, 6, 8, 10]);
  const store = createOfflineStore({ indexedDB: fake.indexedDB, localStorage });

  assert.deepEqual((await store.listOutbox("account-a")).map(item => item.id), ["one", "two", "three"]);
  assert.notEqual(localStorage.getItem(key), null);

  await store.enqueue(operation("account-a", "four", 4), "account-a");
  assert.deepEqual(JSON.parse(localStorage.getItem(key)).map(item => item.id), ["one", "two", "three", "four"]);

  await store.removeOutbox("one", "account-a");
  assert.deepEqual(JSON.parse(localStorage.getItem(key)).map(item => item.id), ["two", "three", "four"]);

  fake.control.failPutNumbers.clear();
  assert.deepEqual((await store.listOutbox("account-a")).map(item => item.id), ["two", "three", "four"]);
  assert.equal(localStorage.getItem(key), null);
  assert.deepEqual(Array.from(fake.stores.get("outbox").values.values()).sort((a, b) => a.createdAt - b.createdAt).map(item => item.id), ["two", "three", "four"]);
});

test("an existing self-study submit operation cannot be overwritten with a conflicting answer", async () => {
  const store = createOfflineStore({ localStorage: new MemoryStorage() });
  const first = {
    id: "self-submit:attempt-one",
    accountId: "account-a",
    path: "/api/self-study/submit",
    method: "POST",
    body: { lessonId: "lesson-one", stepId: "step-one", answer: "B", attemptId: "attempt-one" },
    createdAt: 1,
    updatedAt: 1
  };
  await store.enqueue(first, "account-a");
  await assert.rejects(
    () => store.enqueue({ ...first, body: { ...first.body, answer: "A" }, updatedAt: 2 }, "account-a"),
    /提交 ID 已用于不同课程、步骤或答案/
  );
  assert.equal((await store.listOutbox("account-a"))[0].body.answer, "B");
});

test("local fallback reports capacity failure when IndexedDB is unavailable", async () => {
  const localStorage = new MemoryStorage();
  localStorage.failWrites = true;
  const store = createOfflineStore({ localStorage });
  await assert.rejects(() => store.savePack(pack("account-a"), "account-a"), /无法写入本机存储/);
});
