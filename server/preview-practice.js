"use strict";

const MAX_TASKS = 80;
const MAX_MAP_ENTRIES = 100;

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

function normalizeTask(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = clean(source.id, 160);
  const kind = source.kind === "sentence" ? "sentence" : source.kind === "word" ? "word" : "";
  const direction = source.direction === "zh-en" ? "zh-en" : source.direction === "en-zh" ? "en-zh" : "";
  const english = clean(source.english, 180);
  const chinese = clean(source.chinese, 180);
  if (!id || !kind || !direction || !english || !chinese) return null;
  return {
    id,
    kind,
    direction,
    wordId: clean(source.wordId, 120),
    requiredPreviewWordIds: Array.from(new Set((Array.isArray(source.requiredPreviewWordIds) ? source.requiredPreviewWordIds : []).map(item => clean(item, 120)).filter(Boolean))).slice(0, 8),
    english,
    chinese,
    acceptedEnglish: uniqueTexts(source.acceptedEnglish, english),
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
    return [clean(key, 160), {
      correct: source.correct === true,
      score: Math.max(0, Math.min(1, Number(source.score) || 0)),
      gradingStatus: ["correct", "partial", "incorrect"].includes(source.gradingStatus) ? source.gradingStatus : (source.correct === true ? "correct" : "incorrect"),
      explanation: clean(source.explanation, 240),
      answeredAt: clean(source.answeredAt, 40)
    }];
  }).filter(([key]) => key));
}

function sanitizePreviewPractice(value) {
  const source = value && typeof value === "object" ? value : {};
  const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS);
  const taskIds = new Set(tasks.map(task => task.id));
  const answers = normalizeMap(source.answers, 500);
  const results = normalizeResultMap(source.results);
  Object.keys(answers).forEach(key => { if (!taskIds.has(key)) delete answers[key]; });
  Object.keys(results).forEach(key => { if (!taskIds.has(key)) delete results[key]; });
  return {
    key: clean(source.key, 240),
    currentDay: Math.max(0, Number(source.currentDay) || 0),
    nextDay: Math.max(0, Number(source.nextDay) || 0),
    mode: ["mixed", "word", "sentence"].includes(source.mode) ? source.mode : "mixed",
    tasks,
    index: Math.max(0, Math.min(Number(source.index) || 0, tasks.length)),
    answers,
    results,
    completed: Boolean(source.completed),
    generatedAt: clean(source.generatedAt, 40),
    updatedAt: clean(source.updatedAt, 40)
  };
}

module.exports = { normalizeTask, sanitizePreviewPractice };
