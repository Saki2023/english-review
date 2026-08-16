(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_SESSION = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_COMPLETED_TASKS_PER_DAY = 1000;
  const MAX_RETIRED_BATCHES_PER_DAY = 200;

  function uniqueTaskIds(value, limit = MAX_COMPLETED_TASKS_PER_DAY) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
      .map(item => String(item || "").trim().slice(0, 180))
      .filter(Boolean))).slice(0, limit);
  }

  function mergeCompletedTaskIds(...values) {
    return uniqueTaskIds(values.flatMap(value => Array.isArray(value) ? value : []));
  }

  function uniqueBatchIds(value, limit = MAX_RETIRED_BATCHES_PER_DAY) {
    return Array.from(new Set((Array.isArray(value) ? value : [])
      .map(item => String(item || "").trim().slice(0, 180))
      .filter(Boolean))).slice(-limit);
  }

  function reviewBatchTaskIds(value) {
    const source = value && typeof value === "object" ? value : {};
    return uniqueTaskIds((Array.isArray(source.questions) ? source.questions : []).map(question => question && question.taskId));
  }

  function applyReviewBatchToSession(sessionValue, batchValue) {
    const session = sessionValue && typeof sessionValue === "object" ? sessionValue : {};
    const batch = batchValue && typeof batchValue === "object" ? batchValue : {};
    const taskIds = reviewBatchTaskIds(batch);
    const completed = batch.phase === "completed";
    const index = completed
      ? taskIds.length
      : Math.min(Math.max(Number(batch.index) || 0, 0), Math.max(0, taskIds.length - 1));
    return {
      ...session,
      date: String(batch.date || session.date || "").slice(0, 20),
      mode: ["all", "word", "sentence"].includes(batch.mode) ? batch.mode : (["all", "word", "sentence"].includes(session.mode) ? session.mode : "all"),
      taskIds,
      index,
      currentTaskId: completed ? null : (taskIds[index] || null),
      batchId: String(batch.id || "").slice(0, 180),
      batchComplete: completed,
      allowRepeat: batch.allowRepeat === true,
      retiredBatchIds: uniqueBatchIds(session.retiredBatchIds),
      updatedAt: String(batch.updatedAt || session.updatedAt || "").slice(0, 40)
    };
  }

  function retireReviewSession(sessionValue, batchId, completedTaskIds = [], updatedAt = "") {
    const session = sessionValue && typeof sessionValue === "object" ? sessionValue : {};
    const retiredId = String(batchId || session.batchId || "").trim().slice(0, 180);
    return {
      ...session,
      taskIds: [],
      index: 0,
      doneTaskIds: mergeCompletedTaskIds(session.doneTaskIds, completedTaskIds),
      currentTaskId: null,
      batchId: "",
      batchComplete: true,
      allowRepeat: false,
      updatedAt: String(updatedAt || session.updatedAt || "").slice(0, 40),
      variants: {},
      retiredBatchIds: uniqueBatchIds([...(Array.isArray(session.retiredBatchIds) ? session.retiredBatchIds : []), retiredId])
    };
  }

  function classifyRepeatedReviewBatch(batchValue, completedTaskIds) {
    const batch = batchValue && typeof batchValue === "object" ? batchValue : null;
    if (!batch || batch.allowRepeat === true || !["answering", "review"].includes(batch.phase)) return null;
    const questions = Array.isArray(batch.questions) ? batch.questions : [];
    const taskIds = reviewBatchTaskIds(batch);
    const completed = new Set(uniqueTaskIds(completedTaskIds));
    if (!taskIds.length || !taskIds.every(taskId => completed.has(taskId))) return null;
    const answeredCount = questions.filter(question => String(question && question.answer || "").trim()).length;
    return {
      kind: answeredCount ? "draft" : "empty",
      taskIds,
      answeredCount,
      questionCount: questions.length
    };
  }

  function mergeReviewSession(localValue, remoteValue) {
    const local = localValue && typeof localValue === "object" ? localValue : {};
    const remote = remoteValue && typeof remoteValue === "object" ? remoteValue : {};
    const localUpdated = String(local.updatedAt || "");
    const remoteUpdated = String(remote.updatedAt || "");
    const localDone = uniqueTaskIds(local.doneTaskIds);
    const remoteDone = uniqueTaskIds(remote.doneTaskIds);
    const retiredBatchIds = uniqueBatchIds([...(Array.isArray(local.retiredBatchIds) ? local.retiredBatchIds : []), ...(Array.isArray(remote.retiredBatchIds) ? remote.retiredBatchIds : [])]);
    const retired = new Set(retiredBatchIds);
    let preferred = localUpdated || remoteUpdated
      ? (remoteUpdated > localUpdated ? remote : local)
      : remoteDone.length > localDone.length
        || (remoteDone.length === localDone.length && Number(remote.index || 0) >= Number(local.index || 0)) ? remote : local;
    const alternate = preferred === local ? remote : local;
    if (preferred.batchId && retired.has(String(preferred.batchId)) && alternate.batchId && !retired.has(String(alternate.batchId))) preferred = alternate;
    const merged = {
      ...preferred,
      doneTaskIds: mergeCompletedTaskIds(localDone, remoteDone),
      retiredBatchIds,
      variants: {
        ...(remote.variants && typeof remote.variants === "object" ? remote.variants : {}),
        ...(local.variants && typeof local.variants === "object" ? local.variants : {})
      }
    };
    if (merged.batchId && retired.has(String(merged.batchId))) {
      return retireReviewSession(merged, merged.batchId, [], remoteUpdated > localUpdated ? remoteUpdated : localUpdated);
    }
    return merged;
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

  function reviewSentenceVariantState(sessionValue, tasksById, options = {}) {
    const session = sessionValue && typeof sessionValue === "object" ? sessionValue : {};
    const variants = session.variants && typeof session.variants === "object" ? session.variants : {};
    const findTask = taskId => {
      if (tasksById && typeof tasksById.get === "function") return tasksById.get(taskId);
      if (typeof tasksById === "function") return tasksById(taskId);
      if (tasksById && typeof tasksById === "object") return tasksById[taskId];
      return null;
    };
    const missingTaskIds = uniqueTaskIds(session.taskIds).filter(taskId => {
      const task = findTask(taskId);
      return task && task.item && task.item.type === "sentence" && !variants[taskId];
    });
    const hasMissing = missingTaskIds.length > 0;
    const onlineApi = options.apiEnabled !== false && options.offlineSession !== true;
    return {
      missingTaskIds,
      hasMissing,
      shouldRequest: hasMissing && onlineApi,
      retryVisible: hasMissing && onlineApi
    };
  }

  function reviewSentenceVariantKey(sessionValue) {
    const session = sessionValue && typeof sessionValue === "object" ? sessionValue : {};
    return [
      String(session.date || "").slice(0, 20),
      ["all", "word", "sentence"].includes(session.mode) ? session.mode : "all",
      String(session.batchId || "").slice(0, 180),
      uniqueTaskIds(session.taskIds).join(",")
    ].join("|");
  }

  return {
    MAX_COMPLETED_TASKS_PER_DAY,
    MAX_RETIRED_BATCHES_PER_DAY,
    applyReviewBatchToSession,
    classifyRepeatedReviewBatch,
    mergeCompletedTaskIds,
    mergeReviewSession,
    retireReviewSession,
    reviewBatchTaskIds,
    reviewSentenceVariantKey,
    reviewSentenceVariantState,
    selectGuidedTaskIds,
    uniqueBatchIds,
    uniqueTaskIds
  };
});
