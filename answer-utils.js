(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_ANSWER_UTILS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeEnglish(value) {
    return String(value || "").toLowerCase().replace(/[“”‘’.,!?;:，。！？；：]/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeChinese(value) {
    return String(value || "")
      .replace(/[\s“”‘’.,!?;:，。！？；：、]/g, "")
      .replace(/\.\.\./g, "")
      .replace(/一(?:个|块)垫子/g, "一张垫子")
      .replace(/([上下里外前后])面/g, "$1")
      .trim();
  }

  function englishAnswerMatches(answer, acceptedAnswers) {
    const normalized = normalizeEnglish(answer);
    return Boolean(normalized && acceptedAnswers.some(expected => normalizeEnglish(expected) === normalized));
  }

  function chineseAnswerMatches(answer, acceptedAnswers) {
    const normalized = normalizeChinese(answer);
    return Boolean(normalized && acceptedAnswers.some(expected => normalizeChinese(expected) === normalized));
  }

  function buildMistakePracticeQueue(rows, startTaskId, validTaskIds) {
    const filterKnownTasks = validTaskIds != null;
    const valid = new Set(validTaskIds || []);
    const seen = new Set();
    const taskIds = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const taskId = String(row && row.taskId || "");
      if (!taskId || seen.has(taskId) || (filterKnownTasks && !valid.has(taskId))) return;
      seen.add(taskId);
      taskIds.push(taskId);
    });
    const startIndex = taskIds.indexOf(String(startTaskId || ""));
    if (startIndex < 0) return [];
    return [...taskIds.slice(startIndex), ...taskIds.slice(0, startIndex)];
  }

  function shouldSubmitOnEnter(event) {
    return Boolean(event && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229);
  }

  return { buildMistakePracticeQueue, chineseAnswerMatches, englishAnswerMatches, normalizeChinese, normalizeEnglish, shouldSubmitOnEnter };
});
