"use strict";

const { englishAnswerMatches } = require("../answer-utils");

const MAX_TASKS = 80;
const MAX_MAP_ENTRIES = 100;
const MAX_HISTORY = 30;

function clean(value, maximum) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function uniqueTexts(value, primary, maximum = 8) {
  const source = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  [primary, ...source].forEach(item => {
    const text = clean(item, 240);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key) || result.length >= maximum) return;
    seen.add(key);
    result.push(text);
  });
  return result;
}

function normalizePreviewSchoolSentence(value, { rewriteChinese = false } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const english = clean(source.english, 180);
  const originalChinese = clean(source.chinese, 180);
  const normalizedEnglish = english.toLocaleLowerCase().replace(/[.,!?;:]/g, "").replace(/\s+/g, " ").trim();
  const institutional = /\bin school\b/.test(normalizedEnglish);
  const building = /\bin a school\b/.test(normalizedEnglish);
  const ambiguousSchool = /在学校(?:里面|里)?/u.test(originalChinese) && !/在(?:一|某)所学校/u.test(originalChinese);
  let chinese = originalChinese;
  let acceptedEnglish = [english];

  if (ambiguousSchool && !rewriteChinese) {
    if (institutional) acceptedEnglish.push(english.replace(/\bin school\b/i, "in a school"));
    else if (building) acceptedEnglish.push(english.replace(/\bin a school\b/i, "in school"));
  }
  if (ambiguousSchool && rewriteChinese) {
    if (institutional) chinese = originalChinese.replace(/在学校(?:里面|里)?/u, "在上学");
    else if (building) chinese = originalChinese.replace(/在学校(?:里面|里)?/u, "在一所学校里");
  }

  acceptedEnglish = Array.from(new Set(acceptedEnglish.map(item => clean(item, 180)).filter(Boolean)));
  return { english, chinese, acceptedEnglish, ambiguousSchool, schoolMeaning: institutional ? "institutional" : building ? "building" : "" };
}

function repairAmbiguousSchoolResults(tasks, answers, results) {
  tasks.forEach(task => {
    if (task.direction !== "zh-en") return;
    const school = normalizePreviewSchoolSentence(task);
    const result = results[task.id];
    const answer = answers[task.id];
    if (!school.ambiguousSchool || !result || result.correct || !englishAnswerMatches(answer, task.acceptedEnglish)) return;
    results[task.id] = {
      ...result,
      correct: true,
      score: 1,
      gradingStatus: "correct",
      explanation: "中文“在学校”可能表示“在上学”，也可能表示“在一所学校里面”；两种合理英文均已接受。",
      detailedExplanation: "in school 表示“在上学/在校”；in a school 表示“在一所学校里面”。原中文题干没有区分这两个意思，因此本次预习答案已改判为正确，而且不会计入正式错题或能力分。",
      problemWords: [],
      wordResults: [],
      source: "local"
    };
  });
}

function normalizeTask(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 160);
  const kind = source.kind === "sentence" ? "sentence" : source.kind === "word" ? "word" : "";
  const direction = source.direction === "zh-en" ? "zh-en" : source.direction === "en-zh" ? "en-zh" : "";
  const english = clean(source.english, 180);
  const chinese = clean(source.chinese, 180);
  if (!id || !kind || !direction || !english || !chinese) return null;
  const school = normalizePreviewSchoolSentence({ english, chinese });
  return {
    id,
    kind,
    direction,
    wordId: clean(source.wordId, 120),
    requiredPreviewWordIds: Array.from(new Set((Array.isArray(source.requiredPreviewWordIds) ? source.requiredPreviewWordIds : []).map(item => clean(item, 120)).filter(Boolean))).slice(0, 8),
    english,
    chinese,
    acceptedEnglish: uniqueTexts([...school.acceptedEnglish, ...(Array.isArray(source.acceptedEnglish) ? source.acceptedEnglish : [])], english),
    acceptedChinese: uniqueTexts(source.acceptedChinese, chinese)
  };
}

function normalizeMap(value, maximumValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(-MAX_MAP_ENTRIES).map(([key, item]) => [clean(key, 160), clean(item, maximumValue)]).filter(([key]) => key));
}

function normalizeResultMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(-MAX_MAP_ENTRIES).map(([key, item]) => {
    const source = item && typeof item === "object" ? item : {};
    const problemWords = Array.from(new Set((Array.isArray(source.problemWords) ? source.problemWords : []).map(word => clean(word, 60).toLocaleLowerCase()).filter(Boolean))).slice(0, 12);
    const wordResults = (Array.isArray(source.wordResults) ? source.wordResults : []).map(word => {
      const result = word && typeof word === "object" ? word : {};
      return { english: clean(result.english, 60).toLocaleLowerCase(), correct: result.correct === true, issue: clean(result.issue, 40) };
    }).filter(word => word.english).slice(0, 30);
    return [clean(key, 160), {
      correct: source.correct === true,
      score: Math.max(0, Math.min(1, Number(source.score) || 0)),
      gradingStatus: ["correct", "partial", "incorrect"].includes(source.gradingStatus) ? source.gradingStatus : (source.correct === true ? "correct" : "incorrect"),
      explanation: clean(source.explanation, 240),
      detailedExplanation: clean(source.detailedExplanation, 320),
      problemWords,
      wordResults,
      source: ["ai", "local", "local-fallback"].includes(source.source) ? source.source : "",
      answeredAt: clean(source.answeredAt, 40)
    }];
  }).filter(([key]) => key));
}

function normalizePendingMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(-MAX_MAP_ENTRIES).map(([key, item]) => [clean(key, 160), clean(item, 240)]).filter(([key]) => key));
}

function normalizeHistoryEntry(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 160);
  const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS);
  if (!id || !tasks.length) return null;
  const taskIds = new Set(tasks.map(task => task.id));
  const answers = normalizeMap(source.answers, 500);
  const results = normalizeResultMap(source.results);
  Object.keys(answers).forEach(key => { if (!taskIds.has(key)) delete answers[key]; });
  Object.keys(results).forEach(key => { if (!taskIds.has(key)) delete results[key]; });
  repairAmbiguousSchoolResults(tasks, answers, results);
  const total = tasks.length;
  const completed = tasks.filter(task => results[task.id]).length;
  const correct = tasks.filter(task => results[task.id] && results[task.id].correct).length;
  const partial = tasks.filter(task => results[task.id] && results[task.id].gradingStatus === "partial").length;
  return {
    id,
    key: clean(source.key, 240),
    currentDay: Math.max(0, Number(source.currentDay) || 0),
    nextDay: Math.max(0, Number(source.nextDay) || 0),
    mode: ["mixed", "word", "sentence"].includes(source.mode) ? source.mode : "mixed",
    tasks,
    answers,
    results,
    total,
    completed,
    correct,
    partial,
    score: Math.max(0, Math.min(100, Number(source.score) || (total ? Math.round(tasks.reduce((sum, task) => sum + (Number(results[task.id]?.score) || 0), 0) / total * 100) : 0))),
    startedAt: clean(source.startedAt, 40),
    completedAt: clean(source.completedAt, 40)
  };
}

function sanitizePreviewPracticeHistory(value) {
  return (Array.isArray(value) ? value : []).map(normalizeHistoryEntry).filter(Boolean).slice(-MAX_HISTORY);
}

function sanitizePreviewPractice(value) {
  const source = value && typeof value === "object" ? value : {};
  const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS);
  const taskIds = new Set(tasks.map(task => task.id));
  const answers = normalizeMap(source.answers, 500);
  const results = normalizeResultMap(source.results);
  const pending = normalizePendingMap(source.pending);
  Object.keys(answers).forEach(key => { if (!taskIds.has(key)) delete answers[key]; });
  Object.keys(results).forEach(key => { if (!taskIds.has(key)) delete results[key]; });
  Object.keys(pending).forEach(key => { if (!taskIds.has(key)) delete pending[key]; });
  repairAmbiguousSchoolResults(tasks, answers, results);
  return {
    key: clean(source.key, 240),
    currentDay: Math.max(0, Number(source.currentDay) || 0),
    nextDay: Math.max(0, Number(source.nextDay) || 0),
    mode: ["mixed", "word", "sentence"].includes(source.mode) ? source.mode : "mixed",
    tasks,
    index: Math.max(0, Math.min(Number(source.index) || 0, tasks.length)),
    answers,
    results,
    pending,
    completed: Boolean(source.completed),
    roundId: clean(source.roundId, 180),
    historyRecorded: Boolean(source.historyRecorded),
    startedAt: clean(source.startedAt, 40),
    generatedAt: clean(source.generatedAt, 40),
    updatedAt: clean(source.updatedAt, 40)
  };
}

module.exports = { normalizePreviewSchoolSentence, normalizeTask, sanitizePreviewPractice, sanitizePreviewPracticeHistory };
