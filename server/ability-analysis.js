"use strict";

const { sanitizeAiPractice } = require("./ai-practice");
const { sanitizeAiExamState } = require("./ai-exam");
const { REQUIRED_ENGLISH_FUNCTION_WORDS } = require("../answer-utils");

const ABILITY_DEFINITIONS = [
  { id: "vocabulary", label: "词汇" },
  { id: "spelling", label: "拼写" },
  { id: "grammar", label: "语法" },
  { id: "reading", label: "阅读" },
  { id: "translation", label: "翻译" },
  { id: "listening", label: "听力" },
  { id: "writing", label: "写作" }
];

const EXAM_ABILITY_WEIGHTS = {
  "single-choice": { vocabulary: 0.8, grammar: 0.2 },
  "multiple-choice": { vocabulary: 0.3, grammar: 0.7 },
  "fill-blank": { spelling: 0.6, grammar: 0.4 },
  "true-false": { reading: 1 },
  cloze: { reading: 0.6, grammar: 0.4 },
  "reading-comprehension": { reading: 1 },
  listening: { listening: 1 },
  translation: { translation: 0.8, grammar: 0.2 },
  essay: { writing: 0.8, grammar: 0.2 }
};

function boundedRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function latestTimestamp(values) {
  return values.map(value => String(value || "")).filter(Boolean).sort().at(-1) || "";
}

function itemForTask(content, taskId) {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const direction = value.slice(separator + 1);
  const word = (content.words || []).find(item => item.id === id);
  if (word && !word.preview) return { item: word, kind: "word", direction };
  const sentence = (content.sentences || []).find(item => item.id === id);
  return sentence && !sentence.preview ? { item: sentence, kind: "sentence", direction } : null;
}

function ordinaryWeights(kind, direction) {
  if (kind === "word" && direction === "zh-en") return { vocabulary: 0.35, spelling: 1 };
  if (kind === "word") return { vocabulary: 1 };
  if (direction === "zh-en") return { translation: 1, grammar: 0.65, spelling: 0.35 };
  return { reading: 1 };
}

function aiPracticeWeights(direction) {
  return direction === "zh-en"
    ? { translation: 1, grammar: 0.65, spelling: 0.35 }
    : { reading: 0.8, vocabulary: 0.2 };
}

function focusedWeights(type) {
  const aliases = { choice: "single-choice", reading: "reading-comprehension" };
  return EXAM_ABILITY_WEIGHTS[aliases[type] || type] || {};
}

function createBuckets() {
  return Object.fromEntries(ABILITY_DEFINITIONS.map(definition => [definition.id, {
    earned: 0,
    possible: 0,
    evidenceCount: 0,
    sources: new Set(),
    timestamps: []
  }]));
}

function addEvidence(buckets, weights, ratio, source, occurredAt) {
  const result = boundedRatio(ratio);
  Object.entries(weights || {}).forEach(([ability, weightValue]) => {
    const bucket = buckets[ability];
    const weight = Number(weightValue);
    if (!bucket || !Number.isFinite(weight) || weight <= 0) return;
    bucket.earned += result * weight;
    bucket.possible += weight;
    bucket.evidenceCount += 1;
    bucket.sources.add(source);
    if (occurredAt) bucket.timestamps.push(occurredAt);
  });
}

function evidenceRatio(value) {
  const score = Number(value && value.score);
  if (Number.isFinite(score)) return boundedRatio(score);
  return value && value.correct ? 1 : 0;
}

function resultAccuracy(results, filter = () => true) {
  const relevant = (Array.isArray(results) ? results : []).filter(item => item && typeof item.correct === "boolean" && filter(item));
  return relevant.length ? relevant.filter(item => item.correct).length / relevant.length : null;
}

function translationRatios(value, direction) {
  const overall = evidenceRatio(value);
  const wordResults = Array.isArray(value && value.wordResults) ? value.wordResults : [];
  const allWords = resultAccuracy(wordResults);
  if (direction === "zh-en") {
    const lexical = resultAccuracy(wordResults, item => !REQUIRED_ENGLISH_FUNCTION_WORDS.includes(String(item.english || "").toLocaleLowerCase()));
    const functionWords = wordResults.filter(item => REQUIRED_ENGLISH_FUNCTION_WORDS.includes(String(item.english || "").toLocaleLowerCase()));
    const grammar = functionWords.some(item => item.correct === false) ? 0 : overall;
    return { translation: allWords == null ? overall : allWords, grammar, spelling: lexical == null ? overall : lexical };
  }
  return { reading: overall, vocabulary: allWords == null ? (value && value.correct ? 1 : null) : allWords };
}

function addEvidenceRatios(buckets, weights, ratios, source, occurredAt) {
  Object.entries(weights || {}).forEach(([ability, weight]) => {
    if (!Object.hasOwn(ratios, ability) || ratios[ability] == null) return;
    addEvidence(buckets, { [ability]: weight }, ratios[ability], source, occurredAt);
  });
}

function collectReviewEvidence(content, state, buckets) {
  (Array.isArray(state.attempts) ? state.attempts : []).forEach(attempt => {
    const task = itemForTask(content, attempt && attempt.taskId);
    if (!task || typeof attempt.correct !== "boolean") return;
    const weights = ordinaryWeights(task.kind, task.direction);
    if (task.kind === "sentence") addEvidenceRatios(buckets, weights, translationRatios(attempt, task.direction), "review", attempt.answeredAt || attempt.date);
    else addEvidence(buckets, weights, evidenceRatio(attempt), "review", attempt.answeredAt || attempt.date);
  });
}

function collectAiPracticeEvidence(state, buckets) {
  const practice = sanitizeAiPractice(state.aiPractice);
  practice.history.forEach(item => {
    addEvidenceRatios(buckets, aiPracticeWeights(item.direction), translationRatios(item, item.direction), "ai-practice", item.answeredAt || item.date);
  });
}

function collectExamEvidence(state, buckets) {
  const exams = sanitizeAiExamState(state.aiExam).history;
  exams.forEach(exam => {
    const grades = new Map((exam.result && exam.result.grades || []).map(grade => [grade.questionId, grade]));
    exam.questions.forEach(question => {
      const grade = grades.get(question.id);
      if (!grade || !Number(question.points)) return;
      addEvidence(buckets, EXAM_ABILITY_WEIGHTS[question.type], Number(grade.score) / Number(question.points), "exam", exam.submittedAt);
    });
  });
}

function collectDictationEvidence(state, buckets) {
  const history = state.dictation && Array.isArray(state.dictation.history) ? state.dictation.history : [];
  history.forEach(session => {
    (Array.isArray(session.items) ? session.items : []).forEach(item => {
      const ratio = typeof item.correct === "boolean" ? (item.correct ? 1 : 0) : boundedRatio(item.score);
      addEvidence(buckets, { vocabulary: 0.25, spelling: 0.5, listening: 0.25 }, ratio, "dictation", session.completedAt || item.answeredAt);
    });
  });
}

function collectFocusedEvidence(state, buckets) {
  const history = state.focusedPractice && Array.isArray(state.focusedPractice.history) ? state.focusedPractice.history : [];
  history.forEach(session => {
    const type = String(session.type || "");
    const results = Array.isArray(session.results) ? session.results : (Array.isArray(session.result && session.result.grades) ? session.result.grades : []);
    results.forEach(result => {
      const possible = Number(result.possible) || 1;
      const ratio = typeof result.correct === "boolean" ? (result.correct ? 1 : 0) : Number(result.score) / possible;
      addEvidence(buckets, focusedWeights(result.type || session.focusedType || type), ratio, "focused-practice", session.completedAt || result.answeredAt);
    });
  });
}

function publicAbility(definition, bucket) {
  if (!bucket.evidenceCount || !bucket.possible) {
    return {
      id: definition.id,
      label: definition.label,
      score: 0,
      measuredAccuracy: null,
      evidenceCount: 0,
      status: "unpracticed",
      confidence: "none",
      sources: [],
      updatedAt: ""
    };
  }
  const measuredAccuracy = Math.round((bucket.earned / bucket.possible) * 100);
  const confidenceRatio = Math.min(1, bucket.evidenceCount / 12);
  const score = Math.round(measuredAccuracy * (0.6 + 0.4 * confidenceRatio));
  return {
    id: definition.id,
    label: definition.label,
    score: Math.max(0, Math.min(100, score)),
    measuredAccuracy,
    evidenceCount: bucket.evidenceCount,
    status: bucket.evidenceCount >= 12 ? "stable" : "developing",
    confidence: bucket.evidenceCount >= 12 ? "high" : bucket.evidenceCount >= 5 ? "medium" : "low",
    sources: Array.from(bucket.sources).sort(),
    updatedAt: latestTimestamp(bucket.timestamps)
  };
}

function analyzeAbilities(contentValue, stateValue) {
  const content = contentValue && typeof contentValue === "object" ? contentValue : { words: [], sentences: [] };
  const state = stateValue && typeof stateValue === "object" ? stateValue : {};
  const buckets = createBuckets();
  collectReviewEvidence(content, state, buckets);
  collectAiPracticeEvidence(state, buckets);
  collectExamEvidence(state, buckets);
  collectDictationEvidence(state, buckets);
  collectFocusedEvidence(state, buckets);
  const abilities = ABILITY_DEFINITIONS.map(definition => publicAbility(definition, buckets[definition.id]));
  const practiced = abilities.filter(item => item.status !== "unpracticed");
  const totalEvidence = practiced.reduce((sum, item) => sum + item.evidenceCount, 0);
  const comprehensiveScore = practiced.length
    ? Math.round(practiced.reduce((sum, item) => sum + item.score * item.evidenceCount, 0) / totalEvidence)
    : 0;
  return {
    schemaVersion: 1,
    comprehensiveScore,
    practicedAbilities: practiced.length,
    unpracticedAbilities: abilities.length - practiced.length,
    totalEvidence,
    status: practiced.length ? (practiced.every(item => item.status === "stable") ? "stable" : "developing") : "unpracticed",
    updatedAt: latestTimestamp(abilities.map(item => item.updatedAt)),
    abilities
  };
}

function abilityChanges(beforeValue, afterValue) {
  const before = new Map(((beforeValue && beforeValue.abilities) || []).map(item => [item.id, item]));
  return ((afterValue && afterValue.abilities) || []).map(item => ({
    id: item.id,
    label: item.label,
    before: before.has(item.id) ? Number(before.get(item.id).score) || 0 : 0,
    after: Number(item.score) || 0,
    delta: (Number(item.score) || 0) - (before.has(item.id) ? Number(before.get(item.id).score) || 0 : 0),
    status: item.status
  })).filter(item => item.delta !== 0 || item.status !== (before.get(item.id) && before.get(item.id).status));
}

module.exports = {
  ABILITY_DEFINITIONS,
  EXAM_ABILITY_WEIGHTS,
  abilityChanges,
  analyzeAbilities
};
