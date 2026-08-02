(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_ANSWER_UTILS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EVIDENCE_REPAIR_VERSION = 1;
  const REQUIRED_ENGLISH_FUNCTION_WORDS = ["a", "an", "the", "on", "in", "am", "is", "are"];

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

  function englishWords(value) {
    return normalizeEnglish(value).match(/[a-z]+(?:'[a-z]+)?/g) || [];
  }

  function englishFunctionWordsMatch(answer, acceptedAnswers) {
    const answerWords = englishWords(answer);
    const references = (Array.isArray(acceptedAnswers) ? acceptedAnswers : []).filter(value => englishWords(value).length);
    if (!answerWords.length || !references.length) return false;
    const answerCounts = Object.fromEntries(REQUIRED_ENGLISH_FUNCTION_WORDS.map(word => [word, answerWords.filter(token => token === word).length]));
    return references.some(reference => {
      const referenceWords = englishWords(reference);
      return REQUIRED_ENGLISH_FUNCTION_WORDS.every(word => answerCounts[word] === referenceWords.filter(token => token === word).length);
    });
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

  function reviewTask(content, taskId) {
    const value = String(taskId || "");
    const separator = value.lastIndexOf(":");
    if (separator <= 0) return null;
    const itemId = value.slice(0, separator);
    const direction = value.slice(separator + 1);
    if (!["en-zh", "zh-en"].includes(direction)) return null;
    const items = [...(Array.isArray(content && content.words) ? content.words : []), ...(Array.isArray(content && content.sentences) ? content.sentences : [])];
    const item = items.find(candidate => candidate && candidate.id === itemId);
    return item ? { item, direction, taskId: value } : null;
  }

  function taskAcceptedAnswers(task) {
    return task.direction === "zh-en"
      ? (Array.isArray(task.item.acceptedEnglish) && task.item.acceptedEnglish.length ? task.item.acceptedEnglish : [task.item.english])
      : (Array.isArray(task.item.acceptedChinese) && task.item.acceptedChinese.length ? task.item.acceptedChinese : [task.item.chinese]);
  }

  function taskAnswerMatches(task, answer) {
    const accepted = taskAcceptedAnswers(task);
    return task.direction === "zh-en" ? englishAnswerMatches(answer, accepted) : chineseAnswerMatches(answer, accepted);
  }

  function answerIdentity(task, answer) {
    return task && task.direction === "zh-en" ? normalizeEnglish(answer) : normalizeChinese(answer);
  }

  function repairedMistake(task, attempt, index) {
    const date = String(attempt.date || "unknown");
    const safeTaskId = task.taskId.replace(/[^a-z0-9_-]+/gi, "-");
    return {
      id: `evidence-repair-v${EVIDENCE_REPAIR_VERSION}-${date}-${safeTaskId}-${index}`,
      taskId: task.taskId,
      day: Number(task.item.day) || 0,
      prompt: task.direction === "en-zh" ? task.item.english : task.item.chinese,
      userAnswer: String(attempt.answer || "（未填写）"),
      correctAnswer: task.direction === "zh-en" ? task.item.english : task.item.chinese,
      note: "冠词、介词或 be 动词有漏写或多写，已按当前判题规则修正。"
    };
  }

  function repairReviewEvidence(content, value) {
    const source = value && typeof value === "object" ? value : {};
    const taskStates = { ...(source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {}) };
    const history = Object.fromEntries(Object.entries(source.history && typeof source.history === "object" ? source.history : {}).map(([date, record]) => [date, { ...(record && typeof record === "object" ? record : {}) }]));
    const originalAttempts = Array.isArray(source.attempts) ? source.attempts : [];
    const dateDeltas = new Map();
    const affectedTaskIds = new Set();
    let changed = Number(source.evidenceRepairVersion) < EVIDENCE_REPAIR_VERSION;

    const attempts = originalAttempts.map(attemptValue => {
      const attempt = attemptValue && typeof attemptValue === "object" ? attemptValue : {};
      const task = reviewTask(content, attempt.taskId);
      if (!task || typeof attempt.correct !== "boolean") return attempt;
      const accepted = taskAcceptedAnswers(task);
      let correct = attempt.correct;
      if (!correct && taskAnswerMatches(task, attempt.answer)) correct = true;
      else if (correct && task.direction === "zh-en" && !englishFunctionWordsMatch(attempt.answer, accepted)) correct = false;
      if (correct === attempt.correct) return attempt;
      changed = true;
      affectedTaskIds.add(task.taskId);
      const date = String(attempt.date || "");
      if (date) dateDeltas.set(date, (dateDeltas.get(date) || 0) + (correct ? 1 : -1));
      return {
        ...attempt,
        correct,
        gradingSource: `evidence-repair-v${EVIDENCE_REPAIR_VERSION}`,
        explanation: correct
          ? "中文位置表达与参考答案等义，已按当前规则修正。"
          : "冠词、介词或 be 动词有漏写或多写，已按当前规则修正。"
      };
    });

    dateDeltas.forEach((delta, date) => {
      const record = history[date];
      if (!record) return;
      const reviewed = Math.max(0, Number(record.reviewed) || 0);
      record.correct = Math.max(0, Math.min(reviewed, (Number(record.correct) || 0) + delta));
    });

    const attemptByIdentity = new Map();
    attempts.forEach((attempt, index) => {
      const task = reviewTask(content, attempt && attempt.taskId);
      if (!task) return;
      attemptByIdentity.set(`${String(attempt.date || "")}|${task.taskId}|${answerIdentity(task, attempt.answer)}`, { attempt, index, task });
    });

    let mistakes = (Array.isArray(source.mistakes) ? source.mistakes : []).filter(mistake => {
      const task = reviewTask(content, mistake && mistake.taskId);
      if (!task) return true;
      const key = `${String(mistake.date || "")}|${task.taskId}|${answerIdentity(task, mistake.userAnswer)}`;
      const matchingAttempt = attemptByIdentity.get(key) || Array.from(attemptByIdentity.values()).find(entry => entry.task.taskId === task.taskId && answerIdentity(task, entry.attempt.answer) === answerIdentity(task, mistake.userAnswer));
      const shouldRemove = Boolean((matchingAttempt && matchingAttempt.attempt.correct === true) || taskAnswerMatches(task, mistake.userAnswer));
      if (shouldRemove) changed = true;
      return !shouldRemove;
    });

    attempts.forEach((attempt, index) => {
      if (attempt.correct !== false || originalAttempts[index] && originalAttempts[index].correct !== true) return;
      const task = reviewTask(content, attempt.taskId);
      if (!task) return;
      const exists = mistakes.some(mistake => mistake.taskId === task.taskId && answerIdentity(task, mistake.userAnswer) === answerIdentity(task, attempt.answer));
      if (!exists) mistakes.push(repairedMistake(task, attempt, index));
    });

    affectedTaskIds.forEach(taskId => {
      const latest = [...attempts].reverse().find(attempt => attempt && attempt.taskId === taskId && typeof attempt.correct === "boolean");
      if (!latest) return;
      const previous = taskStates[taskId] && typeof taskStates[taskId] === "object" ? taskStates[taskId] : {};
      taskStates[taskId] = {
        ...previous,
        lastResult: latest.correct,
        level: latest.correct ? Math.max(1, Number(previous.level) || 0) : 0,
        lastReviewed: previous.lastReviewed || latest.date || ""
      };
    });

    return {
      changed,
      state: {
        ...source,
        evidenceRepairVersion: EVIDENCE_REPAIR_VERSION,
        taskStates,
        history,
        attempts,
        mistakes: mistakes.slice(-80)
      }
    };
  }

  return {
    EVIDENCE_REPAIR_VERSION,
    REQUIRED_ENGLISH_FUNCTION_WORDS,
    buildMistakePracticeQueue,
    chineseAnswerMatches,
    englishAnswerMatches,
    englishFunctionWordsMatch,
    normalizeChinese,
    normalizeEnglish,
    repairReviewEvidence,
    shouldSubmitOnEnter
  };
});
