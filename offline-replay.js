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

  async function replayOutbox(options) {
    const store = options && options.store;
    const fetchFunction = options && options.fetch;
    const accountId = String(options && options.accountId || "").trim();
    const onProgress = options && typeof options.onProgress === "function" ? options.onProgress : () => {};
    if (!store || typeof store.listOutbox !== "function" || typeof fetchFunction !== "function" || !accountId) throw new Error("离线同步参数不完整");
    const user = await authenticate(fetchFunction, accountId);
    const operations = await store.listOutbox(accountId);
    const responses = [];
    for (let index = 0; index < operations.length; index += 1) {
      const item = operations[index];
      const attempt = { ...item, attempts: Number(item.attempts || 0) + 1, updatedAt: Date.now(), lastError: "" };
      await store.enqueue(attempt, accountId);
      onProgress({ phase: "replay", index, total: operations.length, operation: attempt });
      let response;
      let data;
      try {
        response = await fetchFunction(attempt.path, {
          method: attempt.method,
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(attempt.body || {})
        });
        data = await readJson(response);
      } catch (error) {
        await store.enqueue({ ...attempt, updatedAt: Date.now(), lastError: String(error && error.message || "网络连接中断").slice(0, 300) }, accountId);
        throw replayError(String(error && error.message || "网络连接中断"), "network");
      }
      if (!response.ok) {
        const message = String(data.error || `待同步操作失败（HTTP ${response.status}）`).slice(0, 300);
        await store.enqueue({ ...attempt, updatedAt: Date.now(), lastError: message }, accountId);
        throw replayError(message, "operation_failed", response.status, data);
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
    return { user, replayed: responses.length, responses, pack, packError, remaining: (await store.listOutbox(accountId)).length };
  }

  return { authenticate, replayOutbox };
});
