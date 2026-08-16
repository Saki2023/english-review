"use strict";

const crypto = require("node:crypto");

const MAX_REVIEW_QUESTIONS = 100;
const MAX_REVIEW_HISTORY = 40;
const MAX_QUESTION_ATTEMPTS = 20;
const PHASES = new Set(["answering", "review", "grading", "completed"]);
const GRADING_MODES = new Set(["group", "immediate"]);

function cleanText(value, maximum = 500) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function cleanStringArray(value, fallback = [], maximum = 16) {
  const source = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(source.map(item => cleanText(item, 300)).filter(Boolean))).slice(0, maximum);
}

function sanitizeReviewResult(value) {
  if (!value || typeof value !== "object" || typeof value.correct !== "boolean") return null;
  const correct = value.correct === true;
  const scoreValue = Number(value.score);
  const score = Number.isFinite(scoreValue) ? Math.max(0, Math.min(1, scoreValue)) : (correct ? 1 : 0);
  return {
    correct,
    score,
    gradingStatus: ["correct", "partial", "incorrect"].includes(value.gradingStatus) ? value.gradingStatus : (correct ? "correct" : "incorrect"),
    source: cleanText(value.source, 40) || "local",
    explanation: cleanText(value.explanation, 300),
    detailedExplanation: cleanText(value.detailedExplanation, 600),
    problemWords: cleanStringArray(value.problemWords, [], 30),
    wordResults: (Array.isArray(value.wordResults) ? value.wordResults : []).map(item => ({
      english: cleanText(item && item.english, 60).toLocaleLowerCase(),
      correct: item && item.correct === true,
      issue: cleanText(item && item.issue, 80)
    })).filter(item => item.english).slice(0, 30)
  };
}

function sanitizeQuestionAttempt(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanText(value.id, 180);
  const answer = cleanText(value.answer, 500);
  const result = sanitizeReviewResult(value.result);
  if (!id || !answer || !result) return null;
  return {
    id,
    answer,
    result,
    submittedAt: cleanText(value.submittedAt, 40)
  };
}

function sanitizeReviewQuestion(value) {
  if (!value || typeof value !== "object") return null;
  const taskId = cleanText(value.taskId, 180);
  const direction = value.direction === "zh-en" ? "zh-en" : "en-zh";
  const english = cleanText(value.english, 300);
  const chinese = cleanText(value.chinese, 300);
  if (!taskId || !english || !chinese) return null;
  const itemType = value.itemType === "sentence" ? "sentence" : "word";
  const attempts = (Array.isArray(value.attempts) ? value.attempts : [])
    .map(sanitizeQuestionAttempt)
    .filter(Boolean)
    .slice(-MAX_QUESTION_ATTEMPTS);
  return {
    id: cleanText(value.id, 180) || `reviewq-${crypto.randomUUID()}`,
    taskId,
    variantId: cleanText(value.variantId, 180),
    direction,
    itemType,
    day: Math.max(0, Number(value.day) || 0),
    phonetic: cleanText(value.phonetic, 100),
    english,
    chinese,
    acceptedEnglish: cleanStringArray(value.acceptedEnglish, [english], 16),
    acceptedChinese: cleanStringArray(value.acceptedChinese, [chinese], 16),
    reviewVariant: value.reviewVariant && typeof value.reviewVariant === "object" ? JSON.parse(JSON.stringify(value.reviewVariant)) : null,
    answer: cleanText(value.answer, 500),
    draftUpdatedAt: cleanText(value.draftUpdatedAt, 40),
    result: sanitizeReviewResult(value.result),
    attemptRequestId: cleanText(value.attemptRequestId, 180),
    attempts,
    completedAt: cleanText(value.completedAt, 40)
  };
}

function sanitizeReviewBatch(value) {
  if (!value || typeof value !== "object") return null;
  const questions = (Array.isArray(value.questions) ? value.questions : []).map(sanitizeReviewQuestion).filter(Boolean).slice(0, MAX_REVIEW_QUESTIONS);
  if (!questions.length) return null;
  const phase = PHASES.has(value.phase) ? value.phase : (questions.every(question => question.result) ? "completed" : "answering");
  return {
    id: cleanText(value.id, 180) || `reviewbatch-${crypto.randomUUID()}`,
    date: cleanText(value.date, 20),
    mode: ["all", "word", "sentence"].includes(value.mode) ? value.mode : "all",
    gradingMode: GRADING_MODES.has(value.gradingMode) ? value.gradingMode : "group",
    allowRepeat: value.allowRepeat === true,
    recoveredFromBatchId: cleanText(value.recoveredFromBatchId, 180),
    phase,
    index: Math.min(Math.max(Number(value.index) || 0, 0), Math.max(0, questions.length - 1)),
    questions,
    model: cleanText(value.model, 120),
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"].includes(value.reasoningEffort) ? value.reasoningEffort : "medium",
    gradeRequestId: cleanText(value.gradeRequestId, 180),
    createdAt: cleanText(value.createdAt, 40) || new Date().toISOString(),
    updatedAt: cleanText(value.updatedAt, 40) || new Date().toISOString(),
    reviewOpenedAt: cleanText(value.reviewOpenedAt, 40),
    gradingStartedAt: cleanText(value.gradingStartedAt, 40),
    completedAt: cleanText(value.completedAt, 40),
    lastError: cleanText(value.lastError, 300)
  };
}

function sanitizeFormalPractice(value) {
  const source = value && typeof value === "object" ? value : {};
  const review = source.review && typeof source.review === "object" ? source.review : {};
  return {
    review: {
      gradingMode: GRADING_MODES.has(review.gradingMode) ? review.gradingMode : "group",
      current: sanitizeReviewBatch(review.current),
      history: (Array.isArray(review.history) ? review.history : []).map(sanitizeReviewBatch).filter(Boolean).slice(-MAX_REVIEW_HISTORY)
    },
    updatedAt: cleanText(source.updatedAt, 40)
  };
}

function publicQuestionAttempt(value) {
  const attempt = sanitizeQuestionAttempt(value);
  return attempt ? {
    id: attempt.id,
    answer: attempt.answer,
    result: attempt.result,
    submittedAt: attempt.submittedAt
  } : null;
}

function publicReviewQuestion(question, batch) {
  const completed = batch.phase === "completed";
  const immediate = batch.gradingMode === "immediate";
  const attempted = immediate && question.attempts.length > 0;
  const reveal = completed || attempted;
  const prompt = question.direction === "en-zh" ? question.english : question.chinese;
  const result = reveal ? sanitizeReviewResult(question.result) : null;
  return {
    id: question.id,
    taskId: question.taskId,
    variantId: question.variantId,
    direction: question.direction,
    itemType: question.itemType,
    day: question.day,
    phonetic: question.direction === "en-zh" ? question.phonetic : "",
    prompt,
    answer: immediate && !attempted ? "" : question.answer,
    draftUpdatedAt: question.draftUpdatedAt,
    ...(immediate ? {
      attemptRequestId: question.attemptRequestId,
      attemptCount: question.attempts.length,
      completedAt: question.completedAt
    } : {}),
    ...(reveal ? {
      english: question.english,
      chinese: question.chinese,
      referenceAnswer: question.direction === "zh-en" ? question.english : question.chinese,
      result,
      ...(immediate ? { attempts: question.attempts.map(publicQuestionAttempt).filter(Boolean) } : {})
    } : {})
  };
}

function publicReviewBatch(value) {
  const batch = sanitizeReviewBatch(value);
  if (!batch) return null;
  return {
    id: batch.id,
    date: batch.date,
    mode: batch.mode,
    gradingMode: batch.gradingMode,
    allowRepeat: batch.allowRepeat,
    recoveredFromBatchId: batch.recoveredFromBatchId,
    phase: batch.phase,
    index: batch.index,
    questions: batch.questions.map(question => publicReviewQuestion(question, batch)),
    model: batch.model,
    reasoningEffort: batch.reasoningEffort,
    gradeRequestId: batch.gradeRequestId,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    reviewOpenedAt: batch.reviewOpenedAt,
    gradingStartedAt: batch.gradingStartedAt,
    completedAt: batch.completedAt,
    lastError: batch.lastError
  };
}

function publicFormalPractice(value) {
  const practice = sanitizeFormalPractice(value);
  return {
    review: {
      gradingMode: practice.review.gradingMode,
      current: publicReviewBatch(practice.review.current),
      history: practice.review.history.map(publicReviewBatch).filter(Boolean)
    },
    updatedAt: practice.updatedAt
  };
}

function createReviewBatch(questions, options = {}) {
  const now = new Date().toISOString();
  const gradingMode = GRADING_MODES.has(options.gradingMode) ? options.gradingMode : "group";
  return sanitizeReviewBatch({
    id: options.id || `reviewbatch-${crypto.randomUUID()}`,
    date: options.date,
    mode: options.mode,
    gradingMode,
    allowRepeat: options.allowRepeat === true,
    phase: "answering",
    index: 0,
    questions: (Array.isArray(questions) ? questions : []).map(question => ({
      ...question,
      attemptRequestId: cleanText(question && question.attemptRequestId, 180) || `reviewattempt-${crypto.randomUUID()}`
    })),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    createdAt: now,
    updatedAt: now
  });
}

function formalPracticeSummary(value) {
  const practice = sanitizeFormalPractice(value);
  const batches = [...practice.review.history, ...(practice.review.current ? [practice.review.current] : [])];
  return batches.map(batch => ({
    id: batch.id,
    date: batch.date,
    mode: batch.mode,
    gradingMode: batch.gradingMode,
    phase: batch.phase,
    questionCount: batch.questions.length,
    answeredCount: batch.questions.filter(question => question.answer).length,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    completedAt: batch.completedAt
  })).slice(-MAX_REVIEW_HISTORY);
}

module.exports = {
  MAX_REVIEW_HISTORY,
  createReviewBatch,
  formalPracticeSummary,
  publicFormalPractice,
  publicReviewBatch,
  sanitizeFormalPractice,
  sanitizeReviewBatch,
  sanitizeReviewResult
};
