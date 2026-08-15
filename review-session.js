(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_SESSION = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_COMPLETED_TASKS_PER_DAY = 1000;

  function uniqueTaskIds(value, limit = MAX_COMPLETED_TASKS_PER_DAY) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
      .map(item => String(item || "").trim().slice(0, 180))
      .filter(Boolean))).slice(0, limit);
  }

  function mergeCompletedTaskIds(...values) {
    return uniqueTaskIds(values.flatMap(value => Array.isArray(value) ? value : []));
  }

  function mergeReviewSession(localValue, remoteValue) {
    const local = localValue && typeof localValue === "object" ? localValue : {};
    const remote = remoteValue && typeof remoteValue === "object" ? remoteValue : {};
    const localUpdated = String(local.updatedAt || "");
    const remoteUpdated = String(remote.updatedAt || "");
    const localDone = uniqueTaskIds(local.doneTaskIds);
    const remoteDone = uniqueTaskIds(remote.doneTaskIds);
    const preferred = localUpdated || remoteUpdated
      ? (remoteUpdated > localUpdated ? remote : local)
      : remoteDone.length > localDone.length
        || (remoteDone.length === localDone.length && Number(remote.index || 0) >= Number(local.index || 0)) ? remote : local;
    return {
      ...preferred,
      doneTaskIds: mergeCompletedTaskIds(localDone, remoteDone),
      variants: {
        ...(remote.variants && typeof remote.variants === "object" ? remote.variants : {}),
        ...(local.variants && typeof local.variants === "object" ? local.variants : {})
      }
    };
  }

  function selectGuidedTaskIds(candidates, completedTaskIds, limit) {
    const completed = new Set(uniqueTaskIds(completedTaskIds));
    const available = (Array.isArray(candidates) ? candidates : []).filter(item => item && item.taskId && !completed.has(String(item.taskId)));
    const pools = {
      word: available.filter(item => item.type === "word"),
      sentence: available.filter(item => item.type === "sentence")
    };
    const selected = [];
    let nextType = "word";
    const requested = Math.max(0, Math.floor(Number(limit) || 0));
    while (selected.length < requested && (pools.word.length || pools.sentence.length)) {
      const alternateType = nextType === "word" ? "sentence" : "word";
      const bucket = pools[nextType].length ? pools[nextType] : pools[alternateType];
      if (!bucket.length) break;
      selected.push(String(bucket.shift().taskId));
      nextType = alternateType;
    }
    return uniqueTaskIds(selected, requested);
  }

  return {
    MAX_COMPLETED_TASKS_PER_DAY,
    mergeCompletedTaskIds,
    mergeReviewSession,
    selectGuidedTaskIds,
    uniqueTaskIds
  };
});
