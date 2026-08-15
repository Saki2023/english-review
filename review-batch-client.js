(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_BATCH_CLIENT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_START_TIMEOUT_MS = 12000;
  const DEFAULT_RECOVERY_TIMEOUT_MS = 6000;
  const DEFAULT_REPEAT_RESOLVE_TIMEOUT_MS = 8000;
  const DEFAULT_REPEAT_RECOVERY_TIMEOUT_MS = 6000;

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

  function retiredBatchIdsFromState(value) {
    const state = value && typeof value === "object" ? value : {};
    const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
    return new Set(Object.values(sessions).flatMap(session => (
      Array.isArray(session && session.retiredBatchIds) ? session.retiredBatchIds : []
    )).map(item => String(item || "").trim()).filter(Boolean));
  }

  function repeatResolutionWasApplied(dataValue, requestedBatchId, action) {
    const data = dataValue && typeof dataValue === "object" ? dataValue : {};
    const requestedId = String(requestedBatchId || "").trim();
    if (!requestedId) return false;
    const retiredId = String(data.retiredBatchId || data.archivedBatchId || data.previousBatchId || "").trim();
    const retired = retiredId === requestedId || retiredBatchIdsFromState(data.state).has(requestedId);
    const batch = data.batch && typeof data.batch === "object" ? data.batch : null;
    if (action === "continue") {
      return Boolean(batch && String(batch.id || "") !== requestedId && (
        retired || String(batch.recoveredFromBatchId || "") === requestedId
      ));
    }
    return retired && (!batch || String(batch.id || "") !== requestedId);
  }

  function repeatResolutionFailure(resolveError, recoveryError = null, data = null) {
    if (recoveryError && recoveryError.timedOut) {
      return requestError("处理旧重复题组后无法确认服务器状态，恢复查询也已超时。请检查网络后手动重试；不会重复建组或计分。", "review-repeat-recovery-timeout", {
        recoverable: true,
        cause: recoveryError,
        resolveError,
        data
      });
    }
    if (recoveryError) {
      return requestError("处理旧重复题组后无法读取服务器状态。请检查网络或重新登录后手动重试；不会丢弃草稿或写入证据。", "review-repeat-recovery-failed", {
        recoverable: true,
        cause: recoveryError,
        resolveError,
        statusCode: recoveryError.statusCode,
        data
      });
    }
    return requestError("服务器尚未确认这组旧题已经退役。请手动重试；系统不会连续请求、换题或计分。", "review-repeat-not-confirmed", {
      recoverable: true,
      resolveError,
      data
    });
  }

  function ambiguousRepeatResolutionFailure(error) {
    if (!error) return true;
    if (error.recoverable || error.timedOut || error.name === "AbortError" || error instanceof TypeError) return true;
    const status = Number(error.statusCode) || 0;
    return status === 404 || status === 408 || status === 409 || status === 425 || status >= 500;
  }

  async function resolveRepeatedReviewBatchWithRecovery({
    fetchImpl,
    basePath = "/api/review/batches",
    body,
    resolveTimeoutMs = DEFAULT_REPEAT_RESOLVE_TIMEOUT_MS,
    recoveryTimeoutMs = DEFAULT_REPEAT_RECOVERY_TIMEOUT_MS
  } = {}) {
    const requestBody = body && typeof body === "object" ? body : {};
    const requestedBatchId = String(requestBody.batchId || "").trim();
    const action = requestBody.action === "continue" ? "continue" : "discard";
    let resolveError = null;
    let responseData = null;
    try {
      const resolved = await fetchJsonWithTimeout(fetchImpl, `${basePath}/resolve-repeat`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        timeoutLabel: "处理旧重复题组"
      }, resolveTimeoutMs);
      responseData = resolved.data;
      if (resolved.ok && repeatResolutionWasApplied(responseData, requestedBatchId, action)) {
        return { data: responseData, source: "resolve" };
      }
      resolveError = resolved.ok
        ? requestError("服务器返回的旧题组处理结果不完整", "review-repeat-invalid-response", { recoverable: true, data: responseData })
        : httpError(resolved, "旧重复题组处理失败，请稍后重试");
      if (!ambiguousRepeatResolutionFailure(resolveError)) throw resolveError;
    } catch (error) {
      if (!ambiguousRepeatResolutionFailure(error)) throw error;
      resolveError = error;
      if (!responseData && error && error.data) responseData = error.data;
    }

    let recovered;
    try {
      recovered = await fetchJsonWithTimeout(fetchImpl, basePath, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        timeoutLabel: "核对旧题组状态"
      }, recoveryTimeoutMs);
    } catch (error) {
      throw repeatResolutionFailure(resolveError, error, responseData);
    }
    if (!recovered.ok) {
      throw repeatResolutionFailure(resolveError, httpError(recovered, "读取当前题组失败"), recovered.data || responseData);
    }
    const recoveredData = recovered.data && typeof recovered.data === "object" ? recovered.data : {};
    if (repeatResolutionWasApplied(recoveredData, requestedBatchId, action)) {
      return { data: recoveredData, source: "recovery", resolveErrorCode: String(resolveError && resolveError.code || "") };
    }
    const current = recoveredData.batch && typeof recoveredData.batch === "object" ? recoveredData.batch : null;
    if (current && String(current.id || "") !== requestedBatchId) {
      return {
        data: { ...recoveredData, retiredBatchId: requestedBatchId },
        source: "recovery-current",
        resolveErrorCode: String(resolveError && resolveError.code || "")
      };
    }
    if (current && String(current.id || "") === requestedBatchId) {
      const originalMessage = String(resolveError && resolveError.message || "").trim();
      throw requestError(originalMessage || "服务器仍保留这组旧题，尚未确认可以无证据退役。请手动重试。", "review-repeat-still-current", {
        recoverable: true,
        resolveError,
        data: recoveredData
      });
    }
    throw repeatResolutionFailure(resolveError, null, recoveredData);
  }

  return {
    DEFAULT_START_TIMEOUT_MS,
    DEFAULT_RECOVERY_TIMEOUT_MS,
    DEFAULT_REPEAT_RESOLVE_TIMEOUT_MS,
    DEFAULT_REPEAT_RECOVERY_TIMEOUT_MS,
    fetchJsonWithTimeout,
    repeatResolutionWasApplied,
    resolveRepeatedReviewBatchWithRecovery,
    startReviewBatchWithRecovery
  };
});
