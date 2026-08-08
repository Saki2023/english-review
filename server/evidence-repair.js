"use strict";

const {
  NATURAL_PERSON_MEASURE_EXPLANATION,
  OPTIONAL_MEASURE_OMISSION_EXPLANATION,
  QUANTITY_CONFLICT_EXPLANATION,
  buildTranslationExplanation,
  chineseAnswerQuality,
  chineseAnswerMatches,
  chineseNaturalPersonMeasureMatches,
  chineseOptionalMeasureOmissionMatches,
  chineseQuantityConflict,
  englishAnswerMatches,
  englishFunctionWordDifferences,
  englishFunctionWordsMatch,
  englishSourceWordResults,
  englishWordResults,
  normalizeEnglish,
  repairReviewEvidence
} = require("../answer-utils");

function correctedAiHistoryItem(value) {
  const item = value && typeof value === "object" ? value : {};
  const acceptedAnswers = item.correctAnswer ? [item.correctAnswer] : [];
  let correct = item.correct === true;
  let score = Number.isFinite(Number(item.score)) ? Math.max(0, Math.min(1, Number(item.score))) : (correct ? 1 : 0);
  let gradingStatus = ["correct", "partial", "incorrect"].includes(item.gradingStatus) ? item.gradingStatus : (correct ? "correct" : "incorrect");
  let explanation = String(item.explanation || "");
  let detailedExplanation = String(item.detailedExplanation || "");
  let problemWords = Array.isArray(item.problemWords) ? item.problemWords : [];
  if (item.direction === "en-zh") {
    const quality = chineseAnswerQuality(item.userAnswer, acceptedAnswers, item.prompt);
    if (quality.gradingStatus === "correct" || quality.gradingStatus === "partial") {
      correct = true;
      score = quality.score;
      gradingStatus = quality.gradingStatus;
      problemWords = [];
      const optionalMeasureOmission = chineseOptionalMeasureOmissionMatches(item.userAnswer, acceptedAnswers);
      const naturalPersonMeasure = chineseNaturalPersonMeasureMatches(item.userAnswer, acceptedAnswers, item.prompt);
      explanation = quality.gradingStatus === "partial"
        ? "英语意思理解正确；中文量词不够自然，本题按部分正确记录。"
        : naturalPersonMeasure
          ? NATURAL_PERSON_MEASURE_EXPLANATION
          : optionalMeasureOmission
          ? OPTIONAL_MEASURE_OMISSION_EXPLANATION
          : (item.correct ? (explanation || "中文表达与参考答案等义。") : "中文表达与参考答案等义，已按当前规则修正。");
      detailedExplanation = buildTranslationExplanation({ direction: item.direction, referenceAnswer: item.correctAnswer, answer: item.userAnswer, correct: true, gradingStatus, explanation, problemWords });
    } else if (correct && chineseQuantityConflict(item.userAnswer, acceptedAnswers)) {
      correct = false;
      score = 0;
      gradingStatus = "incorrect";
      problemWords = [];
      explanation = QUANTITY_CONFLICT_EXPLANATION;
      detailedExplanation = buildTranslationExplanation({ direction: item.direction, referenceAnswer: item.correctAnswer, answer: item.userAnswer, correct: false, gradingStatus, explanation, problemWords });
    }
  }
  if (!correct && item.direction === "zh-en" && englishAnswerMatches(item.userAnswer, acceptedAnswers)) {
    correct = true;
    score = 1;
    gradingStatus = "correct";
  }
  if (correct && item.direction === "zh-en" && !englishFunctionWordsMatch(item.userAnswer, acceptedAnswers)) {
    correct = false;
    score = 0;
    gradingStatus = "incorrect";
    problemWords = englishFunctionWordDifferences(item.userAnswer, acceptedAnswers);
    explanation = "冠词、介词或 be 动词有漏写或多写，已按当前规则修正。";
  }
  const english = item.direction === "zh-en" ? item.correctAnswer : item.prompt;
  const wordResults = item.direction === "zh-en"
    ? englishWordResults(english, item.userAnswer)
    : englishSourceWordResults(english, correct, problemWords);
  const repaired = {
    ...item,
    correct,
    score,
    gradingStatus,
    explanation,
    detailedExplanation,
    problemWords,
    wordResults
  };
  return JSON.stringify(repaired) === JSON.stringify(item) ? item : repaired;
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
      if (!historyItem) return question;
      const repaired = {
        ...question,
        correct: historyItem.correct,
        score: historyItem.score,
        gradingStatus: historyItem.gradingStatus,
        explanation: historyItem.explanation,
        detailedExplanation: historyItem.detailedExplanation,
        problemWords: historyItem.problemWords,
        wordResults: historyItem.wordResults
      };
      if (JSON.stringify(repaired) === JSON.stringify(question)) return question;
      changed = true;
      return repaired;
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
