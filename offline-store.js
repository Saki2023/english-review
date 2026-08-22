(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_OFFLINE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFFLINE_SCHEMA_VERSION = 1;
  const MAX_PACK_BYTES = 6 * 1024 * 1024;
  const MAX_OUTBOX_ITEMS = 500;
  const MAX_OUTBOX_BYTES = 1024 * 1024;
  const DB_NAME = "daily-english-review-offline-v1";
  const DB_VERSION = 2;
  const ACTIVE_ACCOUNT_KEY = "daily-english-review-offline-active-v1";
  const LOCAL_PACK_PREFIX = "daily-english-review-offline-pack-v1-";
  const LOCAL_OUTBOX_PREFIX = "daily-english-review-offline-outbox-v1-";

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function cleanId(value, maximum = 180) {
    return String(value || "").trim().slice(0, maximum);
  }

  function byteLength(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function normalizeOfflinePack(value, expectedAccountId = "", now = new Date(), options = {}) {
    const source = value && typeof value === "object" ? clone(value) : null;
    if (!source || Number(source.schemaVersion) !== OFFLINE_SCHEMA_VERSION) throw new Error("离线包版本不兼容，请联网重新准备");
    const accountId = cleanId(source.account && source.account.id, 120);
    if (!accountId || (expectedAccountId && accountId !== cleanId(expectedAccountId, 120))) throw new Error("离线包不属于当前账号");
    const generatedAt = String(source.generatedAt || "");
    const expiresAt = String(source.expiresAt || "");
    if (!Number.isFinite(Date.parse(generatedAt)) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("离线包时间信息无效，请联网重新准备");
    if (!options.allowExpired && Date.parse(expiresAt) <= now.getTime()) throw new Error("离线包已过期，请联网重新准备");
    const bytes = byteLength(source);
    if (bytes > MAX_PACK_BYTES) throw new Error("离线包超过本机容量上限");
    source.account.id = accountId;
    source.account.username = String(source.account.username || "离线账号").slice(0, 80);
    source.byteSize = bytes;
    return source;
  }

  function packIsUsable(value, accountId, now = new Date()) {
    try { normalizeOfflinePack(value, accountId, now); return true; } catch (_) { return false; }
  }

  function mergeOfflinePackRenewal(localValue, remoteValue, options = {}) {
    const remote = normalizeOfflinePack(remoteValue, remoteValue && remoteValue.account && remoteValue.account.id);
    if (!options.preserveLocalProgress || !localValue) return remote;
    const local = normalizeOfflinePack(localValue, remote.account.id, new Date(), { allowExpired: true });
    const merged = clone(remote);
    ["selfStudy", "selfStudyPublic", "aiPractice", "localOutboxSequence", "localUpdatedAt"].forEach(field => {
      if (Object.hasOwn(local, field)) merged[field] = clone(local[field]);
    });
    if (merged.aiPractice && typeof merged.aiPractice === "object") {
      const localReceipts = Array.isArray(local.aiPractice && local.aiPractice.recoveryReceipts) ? local.aiPractice.recoveryReceipts : [];
      const remoteReceipts = Array.isArray(remote.aiPractice && remote.aiPractice.recoveryReceipts) ? remote.aiPractice.recoveryReceipts : [];
      const retainedSetIds = new Set([
        merged.aiPractice.currentSet && cleanId(merged.aiPractice.currentSet.id, 80),
        ...(Array.isArray(merged.aiPractice.preparedSets) ? merged.aiPractice.preparedSets.map(set => cleanId(set && set.id, 80)) : [])
      ].filter(Boolean));
      const receipts = new Map();
      [...localReceipts, ...remoteReceipts].forEach(item => {
        const setId = cleanId(item && item.setId, 80);
        const receipt = String(item && item.receipt || "").slice(0, 200000);
        if (setId && receipt && retainedSetIds.has(setId) && !receipts.has(setId)) receipts.set(setId, { setId, receipt });
      });
      merged.aiPractice.recoveryReceipts = Array.from(receipts.values()).slice(0, 21);
    }
    if (local.preview && typeof local.preview === "object") {
      merged.preview ||= {};
      ["practice", "practiceSentences"].forEach(field => {
        if (Object.hasOwn(local.preview, field)) merged.preview[field] = clone(local.preview[field]);
      });
    }
    merged.recovery = {
      pendingOutbox: true,
      renewedAt: remote.generatedAt,
      sourcePackId: cleanId(local.packId, 220)
    };
    merged.byteSize = byteLength(merged);
    if (merged.byteSize > MAX_PACK_BYTES) throw new Error("续期后的离线包超过本机容量上限，请先联网同步待处理记录");
    return merged;
  }

  function normalizeOutboxOperation(value, expectedAccountId = "") {
    const source = value && typeof value === "object" ? value : {};
    const accountId = cleanId(source.accountId || expectedAccountId, 120);
    const id = cleanId(source.id, 220);
    const path = String(source.path || "").trim().slice(0, 240);
    const method = ["POST", "PUT", "PATCH", "DELETE"].includes(String(source.method || "POST").toUpperCase()) ? String(source.method || "POST").toUpperCase() : "POST";
    if (!accountId || (expectedAccountId && accountId !== cleanId(expectedAccountId, 120))) throw new Error("待同步操作不属于当前账号");
    if (!id) throw new Error("待同步操作缺少稳定 ID");
    if (!/^\/api\/(?:self-study(?:\/|$)|ai\/questions\/(?:batch(?:\/|$)|next$))/.test(path)) throw new Error("待同步操作路径不在离线白名单中");
    const record = {
      id,
      accountId,
      storageKey: `${accountId}:${id}`,
      path,
      method,
      body: source.body && typeof source.body === "object" ? clone(source.body) : {},
      createdAt: Number(source.createdAt) || Date.now(),
      updatedAt: Number(source.updatedAt) || Date.now(),
      attempts: Math.max(0, Number(source.attempts) || 0),
      lastError: String(source.lastError || "").slice(0, 300)
    };
    if (byteLength(record) > 64 * 1024) throw new Error("单条待同步操作过大");
    return record;
  }

  function mergeOutboxRecords(values, nextValue, accountId) {
    const map = new Map((Array.isArray(values) ? values : []).map(value => normalizeOutboxOperation(value, accountId)).map(value => [value.id, value]));
    const next = normalizeOutboxOperation(nextValue, accountId);
    const existing = map.get(next.id);
    if (existing && (existing.path !== next.path || existing.method !== next.method)) throw new Error("待同步操作 ID 已用于不同请求");
    if (existing && next.path === "/api/self-study/submit") {
      const fields = ["lessonId", "stepId", "answer", "attemptId"];
      if (fields.some(field => String(existing.body && existing.body[field] || "").trim() !== String(next.body && next.body[field] || "").trim())) {
        throw new Error("离线作答提交 ID 已用于不同课程、步骤或答案");
      }
    }
    map.set(next.id, existing ? { ...existing, ...next, createdAt: existing.createdAt } : next);
    const records = Array.from(map.values()).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    if (records.length > MAX_OUTBOX_ITEMS || byteLength(records) > MAX_OUTBOX_BYTES) throw new Error("离线待同步队列已满，请先联网同步");
    return records;
  }

  function createOfflineStore(environment = typeof globalThis !== "undefined" ? globalThis : {}) {
    const localStorage = environment.localStorage || null;
    const indexedDB = environment.indexedDB || null;
    let databasePromise = null;
    let lastSavedAt = 0;
    const packSaveChains = new Map();

    function localGet(key, fallback = null) {
      if (!localStorage) return fallback;
      try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch (_) { return fallback; }
    }

    function localSet(key, value) {
      if (!localStorage) return false;
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    }

    function localRemove(key) {
      if (!localStorage) return;
      try { localStorage.removeItem(key); } catch (_) {}
    }

    function openDatabase() {
      if (!indexedDB) return Promise.resolve(null);
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("packs")) db.createObjectStore("packs", { keyPath: "accountId" });
          if (db.objectStoreNames.contains("outbox")) {
            const transaction = request.transaction;
            const store = transaction && transaction.objectStore("outbox");
            if (!store || store.keyPath !== "storageKey") db.deleteObjectStore("outbox");
          }
          if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "storageKey" }).createIndex("accountId", "accountId", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("无法打开离线数据库"));
      }).catch(() => null);
      return databasePromise;
    }

    async function idbRequest(storeName, mode, operation) {
      const db = await openDatabase();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let request;
        try { request = operation(store); } catch (error) { reject(error); return; }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("离线数据库操作失败"));
      });
    }

    function packKey(accountId) { return `${LOCAL_PACK_PREFIX}${cleanId(accountId, 120)}`; }
    function outboxKey(accountId) { return `${LOCAL_OUTBOX_PREFIX}${cleanId(accountId, 120)}`; }

    function packTimestamp(record) {
      const savedAt = Number(record && record.savedAt);
      if (Number.isFinite(savedAt) && savedAt > 0) return savedAt;
      const pack = record && record.pack;
      const generated = Date.parse(pack && pack.generatedAt || "");
      const revision = Number(pack && pack.revision);
      return Number.isFinite(generated) ? generated : (Number.isFinite(revision) ? revision : 0);
    }

    function storedPackRecord(record) {
      if (!record || typeof record !== "object") return null;
      return record.pack && typeof record.pack === "object"
        ? { pack: record.pack, savedAt: Number(record.savedAt) || 0 }
        : { pack: record, savedAt: 0 };
    }

    function inspectStoredPack(record, accountId, now, source) {
      const stored = storedPackRecord(record);
      if (!stored) return null;
      try {
        const pack = normalizeOfflinePack(stored.pack, accountId, now, { allowExpired: true });
        const expired = Date.parse(pack.expiresAt) <= now.getTime();
        return { status: expired ? "expired" : "usable", accountId, pack, savedAt: stored.savedAt, source };
      } catch (error) {
        const rawAccountId = cleanId(stored.pack && stored.pack.account && stored.pack.account.id, 120);
        return {
          status: rawAccountId && rawAccountId !== accountId ? "account_mismatch" : "corrupt",
          accountId,
          savedAt: stored.savedAt,
          source,
          error: String(error && error.message || "离线包损坏")
        };
      }
    }

    async function writePack(pack) {
      lastSavedAt = Math.max(Date.now(), lastSavedAt + 1);
      const record = { accountId: pack.account.id, pack, savedAt: lastSavedAt };
      const db = await openDatabase();
      if (db) {
        try {
          await idbRequest("packs", "readwrite", store => store.put(record));
          localRemove(packKey(record.accountId));
          return clone(pack);
        } catch (_) {}
      }
      if (!localSet(packKey(record.accountId), record)) throw new Error("离线包无法写入本机存储，请释放浏览器空间后重试");
      return clone(pack);
    }

    function savePack(value, expectedAccountId = "") {
      const pack = normalizeOfflinePack(value, expectedAccountId, new Date(), { allowExpired: true });
      const accountId = pack.account.id;
      const previous = packSaveChains.get(accountId) || Promise.resolve();
      const task = previous.catch(() => {}).then(() => writePack(pack));
      const settled = task.catch(() => {});
      packSaveChains.set(accountId, settled);
      settled.then(() => {
        if (packSaveChains.get(accountId) === settled) packSaveChains.delete(accountId);
      });
      return task;
    }

    async function inspectPack(accountId, now = new Date()) {
      const normalizedId = cleanId(accountId, 120);
      if (!normalizedId) return { status: "missing", accountId: "", pack: null };
      const pendingSave = packSaveChains.get(normalizedId);
      if (pendingSave) await pendingSave;
      const db = await openDatabase();
      const indexed = db ? await idbRequest("packs", "readonly", store => store.get(normalizedId)).catch(() => null) : null;
      const local = localGet(packKey(normalizedId));
      const candidates = [inspectStoredPack(indexed, normalizedId, now, "indexedDB"), inspectStoredPack(local, normalizedId, now, "localStorage")]
        .filter(record => record && record.status !== "missing")
        .sort((left, right) => packTimestamp(right) - packTimestamp(left));
      if (!candidates.length) return { status: "missing", accountId: normalizedId, pack: null };
      const record = candidates[0];
      if (record.status !== "usable" && record.status !== "expired") return { ...record, pack: null };
      if (db && record.source === "localStorage") {
        try {
          await idbRequest("packs", "readwrite", store => store.put({ accountId: normalizedId, pack: record.pack, savedAt: record.savedAt }));
          localRemove(packKey(normalizedId));
        } catch (_) {}
      }
      return { ...record, pack: clone(record.pack) };
    }

    async function loadPack(accountId, now = new Date(), options = {}) {
      const status = await inspectPack(accountId, now);
      if (status.status === "usable" || (status.status === "expired" && options.allowExpired)) return status.pack;
      return null;
    }

    async function removePack(accountId) {
      const normalizedId = cleanId(accountId, 120);
      const pendingSave = packSaveChains.get(normalizedId);
      if (pendingSave) await pendingSave;
      localRemove(packKey(normalizedId));
      await idbRequest("packs", "readwrite", store => store.delete(normalizedId)).catch(() => null);
    }

    async function persistOutboxRecords(records, db) {
      if (!db) return false;
      try {
        for (const record of records) await idbRequest("outbox", "readwrite", store => store.put(record));
        return true;
      } catch (_) {
        return false;
      }
    }

    function saveLocalOutbox(accountId, records) {
      if (!records.length) {
        localRemove(outboxKey(accountId));
        return true;
      }
      return localSet(outboxKey(accountId), records);
    }

    async function listOutbox(accountId) {
      const normalizedId = cleanId(accountId, 120);
      let values = [];
      const db = await openDatabase();
      if (db) {
        values = await new Promise(resolve => {
          const transaction = db.transaction("outbox", "readonly");
          const request = transaction.objectStore("outbox").index("accountId").getAll(normalizedId);
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => resolve([]);
        });
      }
      const localValues = localGet(outboxKey(normalizedId), []);
      const map = new Map();
      [...(Array.isArray(values) ? values : []), ...(Array.isArray(localValues) ? localValues : [])].forEach(value => {
        try {
          const record = normalizeOutboxOperation(value, normalizedId);
          const existing = map.get(record.id);
          if (!existing || record.updatedAt >= existing.updatedAt) map.set(record.id, record);
        } catch (_) {}
      });
      const records = Array.from(map.values()).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      if (db && Array.isArray(localValues) && localValues.length) {
        if (await persistOutboxRecords(records, db)) localRemove(outboxKey(normalizedId));
      }
      return records;
    }

    async function enqueue(value, accountId) {
      const normalizedId = cleanId(accountId || value && value.accountId, 120);
      const records = mergeOutboxRecords(await listOutbox(normalizedId), value, normalizedId);
      const record = records.find(item => item.id === cleanId(value && value.id, 220));
      const db = await openDatabase();
      if (db) {
        if (await persistOutboxRecords(records, db)) {
          localRemove(outboxKey(normalizedId));
          return clone(record);
        }
      }
      if (!saveLocalOutbox(normalizedId, records)) throw new Error("离线待同步队列无法写入本机存储");
      return clone(record);
    }

    async function removeOutbox(id, accountId) {
      const normalizedId = cleanId(accountId, 120);
      const records = (await listOutbox(normalizedId)).filter(item => item.id !== id);
      const db = await openDatabase();
      if (db) {
        await idbRequest("outbox", "readwrite", store => store.delete(`${normalizedId}:${cleanId(id, 220)}`));
        if (await persistOutboxRecords(records, db)) localRemove(outboxKey(normalizedId));
        else if (!saveLocalOutbox(normalizedId, records)) throw new Error("离线待同步队列无法更新");
      } else if (!saveLocalOutbox(normalizedId, records)) {
        throw new Error("离线待同步队列无法更新");
      }
      return records.length;
    }

    async function updatePack(accountId, updater) {
      const pack = await loadPack(accountId, new Date(), { allowExpired: true });
      if (!pack) throw new Error("当前账号没有可用离线包");
      const next = typeof updater === "function" ? updater(clone(pack)) : pack;
      return savePack(next, accountId);
    }

    function activate(accountId) {
      if (!localStorage) return;
      try { localStorage.setItem(ACTIVE_ACCOUNT_KEY, cleanId(accountId, 120)); } catch (_) {}
    }

    function activeAccountId() {
      if (!localStorage) return "";
      return cleanId(localStorage.getItem(ACTIVE_ACCOUNT_KEY), 120);
    }

    function clearActive() {
      localRemove(ACTIVE_ACCOUNT_KEY);
    }

    return { activeAccountId, activate, clearActive, enqueue, inspectPack, listOutbox, loadPack, removeOutbox, removePack, savePack, updatePack };
  }

  return {
    ACTIVE_ACCOUNT_KEY,
    MAX_OUTBOX_ITEMS,
    MAX_PACK_BYTES,
    OFFLINE_SCHEMA_VERSION,
    byteLength,
    createOfflineStore,
    mergeOutboxRecords,
    mergeOfflinePackRenewal,
    normalizeOfflinePack,
    normalizeOutboxOperation,
    packIsUsable
  };
});
