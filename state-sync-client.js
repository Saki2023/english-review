(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_STATE_SYNC = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_DEBOUNCE_MS = 900;

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clientStateProjection(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      schema: 1,
      taskStates: source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {},
      history: source.history && typeof source.history === "object" ? source.history : {},
      attempts: Array.isArray(source.attempts) ? source.attempts.slice(-120) : [],
      sessions: source.sessions && typeof source.sessions === "object" ? source.sessions : {},
      mistakes: Array.isArray(source.mistakes) ? source.mistakes.slice(-80) : [],
      studyTime: source.studyTime && typeof source.studyTime === "object" ? source.studyTime : {},
      previewPractice: source.previewPractice && typeof source.previewPractice === "object" ? source.previewPractice : {},
      previewPracticeHistory: Array.isArray(source.previewPracticeHistory) ? source.previewPracticeHistory : []
    };
  }

  function stableKey(value) {
    return JSON.stringify(value);
  }

  function createStateSaveQueue(options = {}) {
    const fetchImpl = options.fetchImpl;
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    const scheduleTimer = typeof options.setTimeoutImpl === "function" ? options.setTimeoutImpl : setTimeout;
    const cancelTimer = typeof options.clearTimeoutImpl === "function" ? options.clearTimeoutImpl : clearTimeout;
    const debounceMs = Math.max(0, Number(options.debounceMs) || DEFAULT_DEBOUNCE_MS);
    const onUnauthorized = typeof options.onUnauthorized === "function" ? options.onUnauthorized : () => {};
    let accountId = "";
    let epoch = 0;
    let timer = null;
    let pending = null;
    let retryRecord = null;
    let inFlight = null;
    let baselineState = null;
    let baselineStateKey = "";
    let baselineStudyTimeKey = "";

    function clearScheduledTimer() {
      if (timer !== null) cancelTimer(timer);
      timer = null;
    }

    function setAccountId(value) {
      const next = String(value || "");
      if (next === accountId) return;
      accountId = next;
      epoch += 1;
      clearScheduledTimer();
      pending = null;
      retryRecord = null;
      baselineState = null;
      baselineStateKey = "";
      baselineStudyTimeKey = "";
      if (inFlight && inFlight.controller) inFlight.controller.abort();
    }

    function markServerState(value) {
      if (!accountId) return;
      baselineState = cloneJson(clientStateProjection(value));
      baselineStateKey = stableKey(baselineState);
      baselineStudyTimeKey = stableKey(baselineState.studyTime || {});
    }

    function sameQueuedRecord(record) {
      return Boolean(record && (
        pending && pending.kind === record.kind && pending.key === record.key
        || inFlight && inFlight.record.kind === record.kind && inFlight.record.key === record.key
      ));
    }

    function armTimer() {
      clearScheduledTimer();
      timer = scheduleTimer(() => {
        timer = null;
        void flush();
      }, debounceMs);
    }

    function mergeQueuedRecords(older, newer) {
      if (!older) return newer;
      if (!newer) return older;
      if (newer.kind === "state") return newer;
      if (older.kind !== "state") return newer;
      const payload = cloneJson(older.payload);
      payload.studyTime = cloneJson(newer.payload.studyTime);
      return { ...older, payload, key: stableKey(payload) };
    }

    function enqueue(record, immediate) {
      if (!accountId || record.accountId !== accountId || record.epoch !== epoch) return Promise.resolve(false);
      pending = mergeQueuedRecords(pending || retryRecord, record);
      retryRecord = null;
      if (immediate) return flush();
      armTimer();
      return Promise.resolve(true);
    }

    function scheduleState(value, optionsValue = {}) {
      if (!accountId) return Promise.resolve(false);
      const payload = cloneJson(clientStateProjection(value));
      const key = stableKey(payload);
      const record = { kind: "state", accountId, epoch, payload, key };
      if (key === baselineStateKey || sameQueuedRecord(record)) return Promise.resolve(false);
      return enqueue(record, optionsValue.immediate === true);
    }

    function scheduleStudyTime(value, optionsValue = {}) {
      if (!accountId) return Promise.resolve(false);
      const payload = { studyTime: cloneJson(value && typeof value === "object" ? value : {}) };
      const key = stableKey(payload.studyTime);
      const record = { kind: "study-time", accountId, epoch, payload, key };
      if (key === baselineStudyTimeKey || sameQueuedRecord(record)) return Promise.resolve(false);
      return enqueue(record, optionsValue.immediate === true);
    }

    async function flush() {
      clearScheduledTimer();
      if (inFlight) {
        const result = await inFlight.promise;
        return pending ? (await flush()) || result : result;
      }
      const record = pending || retryRecord;
      pending = null;
      retryRecord = null;
      if (!record || !accountId || record.accountId !== accountId || record.epoch !== epoch) return false;
      const Controller = typeof AbortController === "function" ? AbortController : null;
      const controller = Controller ? new Controller() : null;
      const url = record.kind === "study-time" ? "/api/state/study-time" : "/api/state";
      let failed = false;
      const promise = Promise.resolve().then(() => fetchImpl(url, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record.payload),
        ...(controller ? { signal: controller.signal } : {})
      })).then(async response => {
        if (response && response.status === 401) onUnauthorized();
        if (!response || !response.ok) throw Object.assign(new Error("remote state save failed"), { statusCode: Number(response && response.status) || 0 });
        if (record.accountId !== accountId || record.epoch !== epoch) return false;
        if (record.kind === "state") {
          baselineState = cloneJson(record.payload);
          baselineStateKey = record.key;
          baselineStudyTimeKey = stableKey(record.payload.studyTime || {});
        } else {
          baselineStudyTimeKey = record.key;
          if (baselineState) {
            baselineState.studyTime = cloneJson(record.payload.studyTime);
            baselineStateKey = stableKey(baselineState);
          }
        }
        return true;
      }).catch(error => {
        failed = true;
        if (record.accountId === accountId && record.epoch === epoch && (!error || error.name !== "AbortError")) {
          if (pending) pending = mergeQueuedRecords(record, pending);
          else retryRecord = record;
        }
        return false;
      }).finally(() => {
        if (inFlight && inFlight.record === record) inFlight = null;
        if (pending && pending.accountId === accountId && pending.epoch === epoch) armTimer();
        else if (!failed) retryRecord = null;
      });
      inFlight = { record, controller, promise };
      const result = await promise;
      return pending ? (await flush()) || result : result;
    }

    function status() {
      return {
        accountId,
        pending: pending && pending.kind || "",
        retry: retryRecord && retryRecord.kind || "",
        inFlight: inFlight && inFlight.record.kind || ""
      };
    }

    return { flush, markServerState, scheduleState, scheduleStudyTime, setAccountId, status };
  }

  return { DEFAULT_DEBOUNCE_MS, clientStateProjection, createStateSaveQueue };
});
