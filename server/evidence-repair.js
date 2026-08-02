"use strict";

const {
  chineseAnswerMatches,
  englishAnswerMatches,
  englishFunctionWordsMatch,
  normalizeEnglish,
  repairReviewEvidence
} = require("../answer-utils");

function correctedAiHistoryItem(value) {
  const item = value && typeof value === "object" ? value : {};
  const acceptedAnswers = item.correctAnswer ? [item.correctAnswer] : [];
  let correct = item.correct === true;
  if (!correct && item.direction === "en-zh" && chineseAnswerMatches(item.userAnswer, acceptedAnswers)) correct = true;
  if (!correct && item.direction === "zh-en" && englishAnswerMatches(item.userAnswer, acceptedAnswers)) correct = true;
  if (correct && item.direction === "zh-en" && !englishFunctionWordsMatch(item.userAnswer, acceptedAnswers)) correct = false;
  if (correct === (item.correct === true)) return item;
  return {
    ...item,
    correct,
    explanation: correct
      ? "中文位置表达与参考答案等义，已按当前规则修正。"
      : "冠词、介词或 be 动词有漏写或多写，已按当前规则修正。"
  };
}

function repairAiPractice(value) {
  const source = value && typeof value === "object" ? value : {};
  let changed = false;
  const history = (Array.isArray(source.history) ? source.history : []).map(item => {
    const repaired = correctedAiHistoryItem(item);
    if (repaired !== item) changed = true;
    return repaired;
  });
  const historyById = new Map(history.map(item => [item.id, item]));
  let currentSet = source.currentSet;
  if (currentSet && Array.isArray(currentSet.questions)) {
    const questions = currentSet.questions.map(question => {
      const historyItem = historyById.get(`${currentSet.id}:${question.id}`);
      if (!historyItem || (question.correct === historyItem.correct && question.explanation === historyItem.explanation)) return question;
      changed = true;
      return { ...question, correct: historyItem.correct, explanation: historyItem.explanation };
    });
    if (questions.some((question, index) => question !== currentSet.questions[index])) currentSet = { ...currentSet, questions };
  }
  if (!changed) return { changed: false, value: source };
  return { changed: true, value: { ...source, currentSet, history, updatedAt: new Date().toISOString() } };
}

function isKnownSemanticPromptIssue(question) {
  if (!question || question.type !== "single-choice" || !/(?:意思|语义).*(?:相近|相同)/.test(String(question.prompt || ""))) return false;
  if (normalizeEnglish(question.sourceText) !== "it is big") return false;
  const correctOption = (Array.isArray(question.options) ? question.options : []).find(option => option.id === question.answerKey?.correctOption);
  return normalizeEnglish(correctOption && correctOption.text) === "it is a big cat";
}

function repairExam(examValue) {
  const exam = examValue && typeof examValue === "object" ? examValue : null;
  if (!exam || !Array.isArray(exam.questions)) return { changed: false, value: exam };
  let changed = false;
  const questions = exam.questions.map(question => {
    if (!isKnownSemanticPromptIssue(question)) return question;
    changed = true;
    return { ...question, prompt: "选择含有 big 的句子。" };
  });
  return changed ? { changed: true, value: { ...exam, questions } } : { changed: false, value: exam };
}

function repairAiExam(value) {
  const source = value && typeof value === "object" ? value : {};
  const current = repairExam(source.currentExam);
  let changed = current.changed;
  const history = (Array.isArray(source.history) ? source.history : []).map(exam => {
    const repaired = repairExam(exam);
    if (repaired.changed) changed = true;
    return repaired.value;
  });
  if (!changed) return { changed: false, value: source };
  return { changed: true, value: { ...source, currentExam: current.value, history, updatedAt: new Date().toISOString() } };
}

function repairLearningEvidence(content, stateValue) {
  const review = repairReviewEvidence(content, stateValue);
  const practice = repairAiPractice(review.state.aiPractice);
  const exam = repairAiExam(review.state.aiExam);
  return {
    changed: review.changed || practice.changed || exam.changed,
    state: { ...review.state, aiPractice: practice.value, aiExam: exam.value }
  };
}

module.exports = {
  correctedAiHistoryItem,
  isKnownSemanticPromptIssue,
  repairAiExam,
  repairAiPractice,
  repairLearningEvidence
};
