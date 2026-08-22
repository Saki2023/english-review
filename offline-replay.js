(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_OFFLINE_REPLAY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function replayError(message, code, statusCode = 0, data = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    error.data = data;
    return error;
  }

  async function readJson(response) {
    const text = await response.text().catch(() => "");
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return {}; }
  }

  async function authenticate(fetchFunction, accountId) {
    let response;
    try {
      response = await fetchFunction("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      throw replayError(String(error && error.message || "网络仍不可用"), "network");
    }
    const data = await readJson(response);
    if (!response.ok) throw replayError(String(data.error || "账号状态暂时不可用"), "auth_unavailable", response.status, data);
    if (!data.authenticated || !data.user) throw replayError("登录状态已失效，请联网重新登录", "auth_required", response.status, data);
    if (String(data.user.id || "") !== String(accountId || "")) throw replayError("当前登录账号与离线包账号不一致，已停止同步", "account_mismatch", 409, data);
    return data.user;
  }

  function aiSetIdForOperation(item) {
    if (!item || !/^\/api\/ai\/questions\/(?:batch(?:\/|$)|next$)/.test(String(item.path || ""))) return "";
    const bodySetId = String(item.body && item.body.setId || "").trim();
    if (bodySetId) return bodySetId.slice(0, 80);
    const legacyId = String(item.id || "").match(/^ai-[^:]+:([^:]+):/);
    return String(legacyId && legacyId[1] || "").trim().slice(0, 80);
  }

  function findOfflineAiSet(pack, setId) {
    const practice = pack && pack.aiPractice && typeof pack.aiPractice === "object" ? pack.aiPractice : {};
    return [practice.currentSet, ...(Array.isArray(practice.preparedSets) ? practice.preparedSets : [])]
      .find(set => set && String(set.id || "") === setId) || null;
  }

  function findOfflineAiRecoveryReceipt(pack, setId) {
    const values = pack && pack.aiPractice && Array.isArray(pack.aiPractice.recoveryReceipts) ? pack.aiPractice.recoveryReceipts : [];
    const match = values.find(item => item && String(item.setId || "") === setId);
    return String(match && match.receipt || "").slice(0, 200000);
  }

  async function recoverMissingAiSet({ store, fetchFunction, accountId, operation, onProgress }) {
    const setId = aiSetIdForOperation(operation);
    if (!setId || typeof store.inspectPack !== "function") throw replayError("服务器暂时找不到原题组，本机队列已保留", "content_missing", 404);
    const inspected = await store.inspectPack(accountId).catch(() => ({ status: "missing", pack: null }));
    const pack = inspected && inspected.pack;
    const set = findOfflineAiSet(pack, setId);
    if (!set) throw replayError("本机离线包中也找不到该题组快照，队列已保留", "content_corrupt", 422);
    onProgress({ phase: "recover", operation, setId });
    let response;
    let data;
    try {
      response = await fetchFunction("/api/ai/questions/batch/recover", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setId,
          set,
          receipt: findOfflineAiRecoveryReceipt(pack, setId),
          recoveryRequestId: `offline-recover:${setId}`,
          operationPath: String(operation.path || "").slice(0, 240),
          operationMethod: String(operation.method || "POST").slice(0, 12)
        })
      });
      data = await readJson(response);
    } catch (error) {
      throw replayError(String(error && error.message || "原题组恢复请求连接中断"), "network");
    }
    if (!response.ok) {
      const message = String(data.error || `原题组恢复失败（HTTP ${response.status}）`).slice(0, 300);
      const code = response.status === 409 ? "content_conflict" : response.status === 422 ? "content_corrupt" : "content_missing";
      throw replayError(message, code, response.status, data);
    }
    return { setId, status: String(data.status || "recovered"), data };
  }

  async function sendOperation(fetchFunction, attempt) {
    const response = await fetchFunction(attempt.path, {
      method: attempt.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt.body || {})
    });
    return { response, data: await readJson(response) };
  }

  async function replayOutbox(options) {
    const store = options && options.store;
    const fetchFunction = options && options.fetch;
    const accountId = String(options && options.accountId || "").trim();
    const onProgress = options && typeof options.onProgress === "function" ? options.onProgress : () => {};
    if (!store || typeof store.listOutbox !== "function" || typeof fetchFunction !== "function" || !accountId) throw new Error("离线同步参数不完整");
    const user = await authenticate(fetchFunction, accountId);
    const operations = await store.listOutbox(accountId);
    const responses = [];
    const recoveredSetIds = new Set();
    const completedSetIds = new Set();
    for (let index = 0; index < operations.length; index += 1) {
      const item = operations[index];
      const attempt = { ...item, attempts: Number(item.attempts || 0) + 1, updatedAt: Date.now(), lastError: "" };
      await store.enqueue(attempt, accountId);
      onProgress({ phase: "replay", index, total: operations.length, operation: attempt });
      let response;
      let data;
      try {
        ({ response, data } = await sendOperation(fetchFunction, attempt));
        const missingAiSet = response.status === 404 && Boolean(aiSetIdForOperation(attempt));
        if (missingAiSet) {
          const recovery = await recoverMissingAiSet({ store, fetchFunction, accountId, operation: attempt, onProgress });
          if (recovery.status === "completed") {
            completedSetIds.add(recovery.setId);
            await store.removeOutbox(attempt.id, accountId);
            responses.push({ id: attempt.id, path: attempt.path, statusCode: 200, data: recovery.data, recovered: false, alreadyCompleted: true });
            continue;
          }
          recoveredSetIds.add(recovery.setId);
          ({ response, data } = await sendOperation(fetchFunction, attempt));
        }
      } catch (error) {
        await store.enqueue({ ...attempt, updatedAt: Date.now(), lastError: String(error && error.message || "网络连接中断").slice(0, 300) }, accountId);
        if (error && error.code) throw error;
        throw replayError(String(error && error.message || "网络连接中断"), "network");
      }
      if (!response.ok) {
        const message = String(data.error || `待同步操作失败（HTTP ${response.status}）`).slice(0, 300);
        await store.enqueue({ ...attempt, updatedAt: Date.now(), lastError: message }, accountId);
        const missingContent = response.status === 404 && /^\/api\/(?:ai\/questions|self-study)(?:\/|$)/.test(attempt.path);
        throw replayError(message, missingContent ? "content_missing" : "operation_failed", response.status, data);
      }
      await store.removeOutbox(attempt.id, accountId);
      responses.push({ id: attempt.id, path: attempt.path, statusCode: response.status, data });
    }

    let pack = null;
    let packError = "";
    try {
      const response = await fetchFunction("/api/offline/pack", { credentials: "same-origin", cache: "no-store" });
      const data = await readJson(response);
      if (!response.ok) packError = String(data.error || `离线包刷新失败（HTTP ${response.status}）`);
      else if (String(data.account && data.account.id || "") !== accountId) packError = "服务器刷新包的账号不一致";
      else {
        pack = data;
        await store.savePack(pack, accountId);
      }
    } catch (error) {
      packError = String(error && error.message || "离线包刷新失败");
    }
    onProgress({ phase: "complete", index: operations.length, total: operations.length });
    return { user, replayed: responses.length, responses, pack, packError, recoveredSetIds: Array.from(recoveredSetIds), completedSetIds: Array.from(completedSetIds), remaining: (await store.listOutbox(accountId)).length };
  }

  return { authenticate, replayOutbox };
});
