(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_BATCH_CLIENT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_START_TIMEOUT_MS = 12000;
  const DEFAULT_RECOVERY_TIMEOUT_MS = 6000;

  function requestError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  function timeoutError(label, timeoutMs) {
    return requestError(`${label}超过 ${Math.max(1, Math.ceil(timeoutMs / 1000))} 秒`, "review-batch-timeout", {
      timedOut: true,
      recoverable: true
    });
  }

  async function fetchJsonWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
    if (typeof fetchImpl !== "function") throw requestError("浏览器不支持题组请求", "review-batch-fetch-unavailable");
    const Controller = typeof AbortController === "function" ? AbortController : null;
    const controller = Controller ? new Controller() : null;
    let timer = null;
    const label = String(options.timeoutLabel || "题组请求");
    const requestOptions = { ...options };
    delete requestOptions.timeoutLabel;
    if (controller) requestOptions.signal = controller.signal;

    const request = Promise.resolve().then(async () => {
      const response = await fetchImpl(url, requestOptions);
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        throw requestError("服务器返回的题组状态无法读取", "review-batch-invalid-response", { recoverable: true });
      }
      return { ok: response.ok, status: response.status, data };
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(timeoutError(label, timeoutMs));
      }, Math.max(1, Number(timeoutMs) || 1));
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  function httpError(result, fallback = "题组请求失败，请稍后重试") {
    const statusCode = Number(result && result.status) || 0;
    const data = result && result.data && typeof result.data === "object" ? result.data : {};
    return requestError(String(data.error || fallback), "review-batch-http-error", { statusCode, data });
  }

  function ambiguousStartFailure(error) {
    if (!error) return true;
    if (error.recoverable || error.timedOut || error.name === "AbortError" || error instanceof TypeError) return true;
    const status = Number(error.statusCode) || 0;
    return status === 408 || status === 425 || status >= 500;
  }

  function recoveryFailure(startError, recoveryError = null) {
    if (recoveryError && recoveryError.timedOut) {
      return requestError("保存题目快照后无法确认服务器状态，恢复查询也已超时。请检查网络后手动重试；重试仍使用同一组题目。", "review-batch-recovery-timeout", {
        recoverable: true,
        cause: recoveryError,
        startError
      });
    }
    if (recoveryError) {
      return requestError("保存题目快照后无法读取服务器状态。请检查网络或重新登录后手动重试；不会重复建组或计分。", "review-batch-recovery-failed", {
        recoverable: true,
        cause: recoveryError,
        startError,
        statusCode: recoveryError.statusCode
      });
    }
    return requestError("保存题目快照超时，服务器暂未发现已创建的题组。请检查网络后手动重试；重试仍使用同一组题目。", "review-batch-not-found-after-start", {
      recoverable: true,
      startError
    });
  }

  async function startReviewBatchWithRecovery({
    fetchImpl,
    basePath = "/api/review/batches",
    body,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    recoveryTimeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS
  } = {}) {
    let startError = null;
    try {
      const started = await fetchJsonWithTimeout(fetchImpl, `${basePath}/start`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        timeoutLabel: "保存题目快照"
      }, startTimeoutMs);
      if (started.ok && started.data && started.data.batch) return { data: started.data, source: "start" };
      if (started.status === 409 && started.data && started.data.batch) {
        return { data: started.data, source: "conflict" };
      }
      startError = started.ok
        ? requestError("服务器未返回已保存的题组", "review-batch-invalid-response", { recoverable: true })
        : httpError(started);
      if (!ambiguousStartFailure(startError)) throw startError;
    } catch (error) {
      if (!ambiguousStartFailure(error)) throw error;
      startError = error;
    }

    let recovered;
    try {
      recovered = await fetchJsonWithTimeout(fetchImpl, basePath, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        timeoutLabel: "恢复题组状态"
      }, recoveryTimeoutMs);
    } catch (error) {
      throw recoveryFailure(startError, error);
    }
    if (!recovered.ok) throw recoveryFailure(startError, httpError(recovered, "读取当前题组失败"));
    const recoveredBatch = recovered.data && recovered.data.batch;
    const requestedBatchId = String(body && body.batchId || "");
    if (recoveredBatch && (String(recoveredBatch.id || "") === requestedBatchId || recoveredBatch.phase !== "completed")) {
      return { data: recovered.data, source: "recovery", startErrorCode: String(startError && startError.code || "") };
    }
    throw recoveryFailure(startError);
  }

  return {
    DEFAULT_START_TIMEOUT_MS,
    DEFAULT_RECOVERY_TIMEOUT_MS,
    fetchJsonWithTimeout,
    startReviewBatchWithRecovery
  };
});
