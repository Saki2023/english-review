"use strict";

const crypto = require("node:crypto");
const { safeQuestionFocus } = require("./ai-question-utils");
const { sanitizeAiExamState } = require("./ai-exam");
const { teachingProfileForAi } = require("./teaching-profile");
const { sanitizeDictationState } = require("./dictation");
const { sanitizeFocusedState } = require("./focused-practice");

const MAX_AI_HISTORY = 1000;
const MAX_QUESTION_COUNT = 10;
const MAX_TUTOR_MESSAGES = 12;
const MAX_TUTOR_HISTORY = 1000;
const MAX_TUTOR_RESETS = 1000;
const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function cleanText(value, maximum = 300) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function sanitizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return source.map(item => cleanText(item)).filter(Boolean).slice(0, 8);
}

function boundedScore(value, correct) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : (correct ? 1 : 0);
}

function sanitizeWordResult(value) {
  const source = value && typeof value === "object" ? value : {};
  const english = cleanText(source.english, 60).toLocaleLowerCase();
  if (!english) return null;
  return { english, correct: source.correct === true, issue: cleanText(source.issue, 40) };
}

function sanitizeWordResults(value) {
  const unique = new Map();
  (Array.isArray(value) ? value : []).map(sanitizeWordResult).filter(Boolean).forEach(item => unique.set(item.english, item));
  return Array.from(unique.values()).slice(0, 30);
}

function sanitizeTutorMessage(value) {
  if (!value || typeof value !== "object" || !["user", "assistant"].includes(value.role)) return null;
  const content = cleanText(value.content, value.role === "assistant" ? 1200 : 500);
  if (!content) return null;
  return { role: value.role, content, createdAt: cleanText(value.createdAt, 40) };
}

function sanitizeTutorThread(value) {
  if (!value || typeof value !== "object") return null;
  const setId = cleanText(value.setId, 80);
  const questionId = cleanText(value.questionId, 80);
  if (!setId || !questionId) return null;
  return {
    setId,
    questionId,
    historyId: cleanText(value.historyId, 180),
    source: ["current", "history", "review"].includes(value.source) ? value.source : "",
    taskId: cleanText(value.taskId, 180),
    variantId: cleanText(value.variantId, 120),
    direction: ["en-zh", "zh-en"].includes(value.direction) ? value.direction : "",
    prompt: cleanText(value.prompt, 300),
    updatedAt: cleanText(value.updatedAt, 40),
    messages: (Array.isArray(value.messages) ? value.messages : []).map(sanitizeTutorMessage).filter(Boolean).slice(-MAX_TUTOR_MESSAGES)
  };
}

function sanitizeTutorReset(value) {
  if (!value || typeof value !== "object") return null;
  const setId = cleanText(value.setId, 80);
  const questionId = cleanText(value.questionId, 80);
  const resetAt = cleanText(value.resetAt, 40);
  if (!setId || !questionId || !resetAt) return null;
  return {
    setId,
    questionId,
    historyId: cleanText(value.historyId, 180),
    source: ["current", "history", "review"].includes(value.source) ? value.source : "",
    taskId: cleanText(value.taskId, 180),
    variantId: cleanText(value.variantId, 120),
    direction: ["en-zh", "zh-en"].includes(value.direction) ? value.direction : "",
    prompt: cleanText(value.prompt, 300),
    resetAt
  };
}

function sanitizeTutorExchange(value) {
  if (!value || typeof value !== "object") return null;
  const setId = cleanText(value.setId, 80);
  const questionId = cleanText(value.questionId, 80);
  const question = cleanText(value.question, 500);
  const answer = cleanText(value.answer, 1200);
  if (!setId || !questionId || !question || !answer) return null;
  const askedAt = cleanText(value.askedAt, 40);
  return {
    id: cleanText(value.id, 180) || `tutor-${crypto.randomUUID()}`,
    setId,
    questionId,
    historyId: cleanText(value.historyId, 180),
    source: ["current", "history", "review"].includes(value.source) ? value.source : "current",
    taskId: cleanText(value.taskId, 180),
    variantId: cleanText(value.variantId, 120),
    direction: ["en-zh", "zh-en"].includes(value.direction) ? value.direction : "",
    prompt: cleanText(value.prompt, 300),
    learnerAnswer: cleanText(value.learnerAnswer, 500),
    correctAnswer: cleanText(value.correctAnswer, 300),
    answered: Boolean(value.answered),
    explanation: cleanText(value.explanation, 180),
    question,
    answer,
    askedAt,
    answeredAt: cleanText(value.answeredAt, 40) || askedAt,
    providerId: cleanText(value.providerId, 64),
    providerName: cleanText(value.providerName, 60),
    model: cleanText(value.model, 120),
    reasoningEffort: AI_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : ""
  };
}

function legacyTutorHistory(tutor) {
  if (!tutor) return [];
  const exchanges = [];
  for (let index = 0; index < tutor.messages.length - 1; index += 1) {
    const question = tutor.messages[index];
    const answer = tutor.messages[index + 1];
    if (question.role !== "user" || answer.role !== "assistant") continue;
    const exchange = sanitizeTutorExchange({
      id: `legacy-${tutor.setId}-${tutor.questionId}-${index}`,
      setId: tutor.setId,
      questionId: tutor.questionId,
      question: question.content,
      answer: answer.content,
      askedAt: question.createdAt,
      answeredAt: answer.createdAt
    });
    if (exchange) exchanges.push(exchange);
    index += 1;
  }
  return exchanges;
}

function sanitizeQuestion(value) {
  const source = value && typeof value === "object" ? value : {};
  const direction = source.direction === "zh-en" ? "zh-en" : "en-zh";
  const english = cleanText(source.english);
  const chinese = cleanText(source.chinese);
  if (!english || !chinese) return null;
  const correct = typeof source.correct === "boolean" ? source.correct : null;
  return {
    id: cleanText(source.id, 80) || `aiq-${crypto.randomUUID()}`,
    direction,
    english,
    chinese,
    acceptedEnglish: sanitizeStringArray(source.acceptedEnglish, [english]),
    acceptedChinese: sanitizeStringArray(source.acceptedChinese, [chinese]),
    focus: safeQuestionFocus(english),
    userAnswer: cleanText(source.userAnswer, 500),
    correct,
    score: correct === null ? null : boundedScore(source.score, correct),
    gradingStatus: ["correct", "partial", "incorrect"].includes(source.gradingStatus) ? source.gradingStatus : (correct === null ? "" : correct ? "correct" : "incorrect"),
    problemWords: sanitizeStringArray(source.problemWords),
    wordResults: sanitizeWordResults(source.wordResults),
    explanation: cleanText(source.explanation, 180),
    answeredAt: cleanText(source.answeredAt, 40)
  };
}

function sanitizeQuestionSet(value) {
  if (!value || typeof value !== "object") return null;
  const questions = (Array.isArray(value.questions) ? value.questions : []).map(sanitizeQuestion).filter(Boolean).slice(0, MAX_QUESTION_COUNT);
  if (!questions.length) return null;
  const index = Math.min(Math.max(Number(value.index) || 0, 0), questions.length);
  return {
    id: cleanText(value.id, 80) || `aiset-${crypto.randomUUID()}`,
    createdAt: cleanText(value.createdAt, 40) || new Date().toISOString(),
    providerId: cleanText(value.providerId, 64),
    providerName: cleanText(value.providerName, 60),
    model: cleanText(value.model, 120),
    reasoningEffort: AI_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : "medium",
    questions,
    index,
    completed: Boolean(value.completed || index >= questions.length)
  };
}

function sanitizeHistoryItem(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = cleanText(source.id, 180) || `aihistory-${crypto.randomUUID()}`;
  const legacySetId = id.includes(":") ? id.slice(0, id.indexOf(":")) : "";
  const direction = source.direction === "zh-en" ? "zh-en" : "en-zh";
  const english = direction === "zh-en" ? source.correctAnswer : source.prompt;
  const questionNumber = Math.min(Math.max(Number(source.questionNumber) || 0, 0), MAX_QUESTION_COUNT);
  const questionCount = Math.min(Math.max(Number(source.questionCount) || 0, 0), MAX_QUESTION_COUNT);
  const correct = source.correct === true;
  return {
    id,
    setId: cleanText(source.setId, 80) || cleanText(legacySetId, 80),
    setCreatedAt: cleanText(source.setCreatedAt, 40),
    answeredAt: cleanText(source.answeredAt, 40),
    date: cleanText(source.date, 20),
    providerId: cleanText(source.providerId, 64),
    providerName: cleanText(source.providerName, 60),
    model: cleanText(source.model, 120),
    reasoningEffort: AI_EFFORTS.includes(source.reasoningEffort) ? source.reasoningEffort : "",
    questionNumber,
    questionCount,
    direction,
    prompt: cleanText(source.prompt),
    userAnswer: cleanText(source.userAnswer, 500),
    correctAnswer: cleanText(source.correctAnswer),
    correct,
    score: boundedScore(source.score, correct),
    gradingStatus: ["correct", "partial", "incorrect"].includes(source.gradingStatus) ? source.gradingStatus : (correct ? "correct" : "incorrect"),
    problemWords: sanitizeStringArray(source.problemWords),
    wordResults: sanitizeWordResults(source.wordResults),
    focus: safeQuestionFocus(english),
    explanation: cleanText(source.explanation, 180)
  };
}

function sanitizeAiPractice(value) {
  const source = value && typeof value === "object" ? value : {};
  const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
  const tutorSettings = source.tutorSettings && typeof source.tutorSettings === "object" ? source.tutorSettings : {};
  const tutor = sanitizeTutorThread(source.tutor);
  const savedTutorHistory = (Array.isArray(source.tutorHistory) ? source.tutorHistory : []).map(sanitizeTutorExchange).filter(Boolean);
  const tutorResetMap = new Map();
  (Array.isArray(source.tutorResets) ? source.tutorResets : []).map(sanitizeTutorReset).filter(Boolean).forEach(item => {
    const key = `${item.setId}\u0000${item.questionId}`;
    const previous = tutorResetMap.get(key);
    if (!previous || item.resetAt > previous.resetAt) tutorResetMap.set(key, item);
  });
  return {
    settings: {
      model: cleanText(settings.model, 120),
      reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
      count: [5, 10].includes(Number(settings.count)) ? Number(settings.count) : 5
    },
    tutorSettings: {
      providerId: cleanText(tutorSettings.providerId, 64),
      model: cleanText(tutorSettings.model, 120),
      reasoningEffort: AI_EFFORTS.includes(tutorSettings.reasoningEffort) ? tutorSettings.reasoningEffort : "medium"
    },
    currentSet: sanitizeQuestionSet(source.currentSet),
    tutor,
    tutorHistory: (savedTutorHistory.length ? savedTutorHistory : legacyTutorHistory(tutor)).slice(-MAX_TUTOR_HISTORY),
    tutorResets: Array.from(tutorResetMap.values()).slice(-MAX_TUTOR_RESETS),
    history: (Array.isArray(source.history) ? source.history : []).map(sanitizeHistoryItem).slice(-MAX_AI_HISTORY),
    updatedAt: cleanText(source.updatedAt, 40)
  };
}

function tutorThreadFromHistory(value, setId, questionId) {
  const practice = sanitizeAiPractice(value);
  if (practice.tutor && practice.tutor.setId === setId && practice.tutor.questionId === questionId) return practice.tutor;
  const resetAt = practice.tutorResets.filter(item => item.setId === setId && item.questionId === questionId).sort((left, right) => right.resetAt.localeCompare(left.resetAt))[0]?.resetAt || "";
  const messages = practice.tutorHistory.filter(item => item.setId === setId && item.questionId === questionId && (!resetAt || item.askedAt > resetAt)).flatMap(item => [
    { role: "user", content: item.question, createdAt: item.askedAt },
    { role: "assistant", content: item.answer, createdAt: item.answeredAt }
  ]).slice(-MAX_TUTOR_MESSAGES);
  if (messages.length) return { setId, questionId, messages };
  return { setId, questionId, messages: [] };
}

function taskItem(content, taskId) {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  const itemId = separator > 0 ? value.slice(0, separator) : value;
  return [...content.words, ...content.sentences].find(item => item.id === itemId) || null;
}

function itemWeakness(item, taskStates) {
  const directions = Array.isArray(item.directions) && item.directions.length ? item.directions : ["en-zh"];
  const states = directions.map(direction => taskStates[`${item.id}:${direction}`] || {});
  const incorrect = states.some(state => state.lastResult === false) ? 0 : 1;
  const level = Math.min(...states.map(state => Number(state.level) || 0));
  return { incorrect, level };
}

function englishTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

function buildLearningProfile(content, state, studyDate = "") {
  const taskStates = state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {};
  const learnedWords = content.words.filter(item => !item.preview && (!studyDate || !item.learned || String(item.learned) <= studyDate));
  const learnedSentences = content.sentences.filter(item => !item.preview && (!studyDate || !item.learned || String(item.learned) <= studyDate));
  const rankedWords = [...learnedWords].sort((a, b) => {
    const weakA = itemWeakness(a, taskStates);
    const weakB = itemWeakness(b, taskStates);
    return weakA.incorrect - weakB.incorrect || weakA.level - weakB.level || Number(b.day || 0) - Number(a.day || 0);
  }).slice(0, 120);
  const allowedWords = Array.from(new Set(rankedWords.flatMap(item => englishTokens(item.english))));
  const allowedSet = new Set(allowedWords);
  const rankedSentences = [...learnedSentences].sort((a, b) => {
    const weakA = itemWeakness(a, taskStates);
    const weakB = itemWeakness(b, taskStates);
    return weakA.incorrect - weakB.incorrect || weakA.level - weakB.level || Number(b.day || 0) - Number(a.day || 0);
  }).filter(item => englishTokens(item.english).every(token => allowedSet.has(token))).slice(0, 40);

  const weakItems = [...rankedWords, ...rankedSentences].map(item => {
    const weak = itemWeakness(item, taskStates);
    return { english: item.english, chinese: item.chinese, day: item.day, level: weak.level, lastResult: weak.incorrect ? "not-wrong" : "wrong" };
  }).filter(item => item.lastResult === "wrong" || item.level < 2).slice(0, 24);
  const recentAttempts = (Array.isArray(state.attempts) ? state.attempts : []).slice(-30);
  const correctAttempts = recentAttempts.filter(item => item.correct).length;
  const aiPractice = sanitizeAiPractice(state.aiPractice);
  const learnedItemIds = new Set([...learnedWords, ...learnedSentences].map(item => item.id));
  const recentMistakes = (Array.isArray(state.mistakes) ? state.mistakes : []).filter(item => {
    const learnedItem = taskItem(content, item && item.taskId);
    return learnedItem && learnedItemIds.has(learnedItem.id);
  }).slice(-12);
  const recentAiPractice = aiPractice.history.filter(item => {
    const english = item.direction === "zh-en" ? item.correctAnswer : item.prompt;
    return englishTokens(english).every(token => allowedSet.has(token));
  }).slice(-12);
  const aiExam = sanitizeAiExamState(state.aiExam);
  const recentExamWeakPoints = aiExam.weakPoints.filter(item => {
    const relatedTokens = item.relatedWords.flatMap(englishTokens);
    return relatedTokens.every(token => allowedSet.has(token));
  }).slice(-20).map(item => ({
    category: item.category,
    severity: item.severity,
    detail: item.detail,
    recommendation: item.recommendation,
    relatedWords: item.relatedWords
  }));
  const localTeachingProfile = teachingProfileForAi(state.teachingProfile);
  const recentDictationMistakes = sanitizeDictationState(state.dictation).history.slice(-10).flatMap(session => session.items.filter(item => item.correct === false).map(item => ({
    english: item.english,
    learnerAnswer: item.answer,
    completedAt: session.completedAt
  }))).slice(-20);
  const recentFocusedWeakPoints = sanitizeFocusedState(state.focusedPractice).history.slice(-10).flatMap(session => (session.result?.weakPoints || []).map(item => ({
    focusedType: session.focusedType,
    detail: item.detail,
    recommendation: item.recommendation,
    relatedWords: item.relatedWords
  }))).slice(-20);

  return {
    currentDay: Number(content.currentDay) || 1,
    allowedWords,
    learnedWords: rankedWords.map(item => ({ english: item.english, chinese: item.chinese, day: item.day })),
    learnedSentences: rankedSentences.map(item => ({ english: item.english, chinese: item.chinese, day: item.day })),
    weakItems,
    recentMistakes: recentMistakes.map(item => ({ prompt: cleanText(item.prompt), userAnswer: cleanText(item.userAnswer), correctAnswer: cleanText(item.correctAnswer), note: cleanText(item.note, 100) })),
    recentAiPractice: recentAiPractice.map(item => ({ prompt: item.prompt, userAnswer: item.userAnswer, correctAnswer: item.correctAnswer, correct: item.correct, focus: item.focus })),
    recentExamWeakPoints,
    recentDictationMistakes,
    recentFocusedWeakPoints,
    localTeachingProfile,
    recentAccuracy: recentAttempts.length ? Math.round((correctAttempts / recentAttempts.length) * 100) : null
  };
}

function createQuestionSet(questions, selection) {
  return sanitizeQuestionSet({
    id: `aiset-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    providerId: selection.providerId,
    providerName: selection.providerName,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    questions: questions.map(question => ({ ...question, id: `aiq-${crypto.randomUUID()}` })),
    index: 0,
    completed: false
  });
}

module.exports = {
  MAX_AI_HISTORY,
  MAX_TUTOR_HISTORY,
  MAX_TUTOR_MESSAGES,
  MAX_TUTOR_RESETS,
  buildLearningProfile,
  createQuestionSet,
  sanitizeAiPractice,
  sanitizeQuestion,
  sanitizeQuestionSet,
  sanitizeTutorExchange,
  sanitizeTutorReset,
  sanitizeTutorThread,
  taskItem,
  tutorThreadFromHistory
};
