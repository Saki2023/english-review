"use strict";

const crypto = require("node:crypto");
const {
  EVIDENCE_REPAIR_VERSION,
  NATURAL_DEEP_EXPLANATION,
  NATURAL_PERSON_MEASURE_EXPLANATION,
  OPTIONAL_MEASURE_OMISSION_EXPLANATION,
  QUANTITY_CONFLICT_EXPLANATION,
  buildTranslationExplanation,
  chineseAnswerQuality,
  chineseAnswerMatches,
  chineseNaturalDeepMatches,
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
const { expandRegisteredChineseAnswers, naturalizePlainDeepChinese } = require("../review-variants");

const LEARNING_EVIDENCE_REPAIR_VERSION = 1;

function repairContentItemSignature(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: String(item.id || ""),
    day: Number(item.day) || 0,
    english: String(item.english || ""),
    chinese: String(item.chinese || ""),
    acceptedEnglish: Array.isArray(item.acceptedEnglish) ? item.acceptedEnglish.map(String) : [],
    acceptedChinese: Array.isArray(item.acceptedChinese) ? item.acceptedChinese.map(String) : [],
    directions: Array.isArray(item.directions) ? item.directions.map(String) : [],
    learned: String(item.learned || ""),
    preview: item.preview === true
  };
}

function learningEvidenceRepairSignature(content = {}) {
  const byId = (left, right) => String(left && left.id || "").localeCompare(String(right && right.id || ""));
  const payload = {
    version: LEARNING_EVIDENCE_REPAIR_VERSION,
    reviewVersion: EVIDENCE_REPAIR_VERSION,
    words: (Array.isArray(content.words) ? content.words : []).map(repairContentItemSignature).sort(byId),
    sentences: (Array.isArray(content.sentences) ? content.sentences : []).map(repairContentItemSignature).sort(byId)
  };
  return `learning-evidence-v${LEARNING_EVIDENCE_REPAIR_VERSION}-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function correctedAiHistoryItem(value, content = {}) {
  const item = value && typeof value === "object" ? value : {};
  const sourceCorrectAnswer = String(item.correctAnswer || "");
  const correctAnswer = item.direction === "en-zh" ? naturalizePlainDeepChinese(item.prompt, sourceCorrectAnswer) : sourceCorrectAnswer;
  const acceptedAnswers = item.direction === "en-zh"
    ? expandRegisteredChineseAnswers(content, item.prompt, [correctAnswer, sourceCorrectAnswer], 16)
    : (sourceCorrectAnswer ? [sourceCorrectAnswer] : []);
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
      const naturalDeep = chineseNaturalDeepMatches(item.userAnswer, acceptedAnswers, item.prompt);
      explanation = quality.gradingStatus === "partial"
        ? "英语意思理解正确；中文量词不够自然，本题按部分正确记录。"
        : naturalDeep
          ? NATURAL_DEEP_EXPLANATION
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
    correctAnswer,
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

function normalizeAiQuestion(content, value) {
  const question = value && typeof value === "object" ? value : {};
  if (question.direction !== "en-zh") return question;
  const sourceChinese = String(question.chinese || "");
  const chinese = naturalizePlainDeepChinese(question.english, sourceChinese);
  const acceptedChinese = expandRegisteredChineseAnswers(content, question.english, [chinese, sourceChinese, ...(Array.isArray(question.acceptedChinese) ? question.acceptedChinese : [])], 16);
  const naturalDeep = chineseNaturalDeepMatches(question.userAnswer, acceptedChinese, question.english);
  const repaired = {
    ...question,
    chinese,
    acceptedChinese,
    ...(naturalDeep ? {
      correct: true,
      score: 1,
      gradingStatus: "correct",
      explanation: NATURAL_DEEP_EXPLANATION,
      detailedExplanation: buildTranslationExplanation({ direction: "en-zh", referenceAnswer: chinese, answer: question.userAnswer, correct: true, gradingStatus: "correct", explanation: NATURAL_DEEP_EXPLANATION, problemWords: [] }),
      problemWords: [],
      wordResults: englishSourceWordResults(question.english, true, [])
    } : {})
  };
  return JSON.stringify(repaired) === JSON.stringify(question) ? question : repaired;
}

function normalizeAiQuestionSet(content, value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.questions)) return value;
  const questions = value.questions.map(question => normalizeAiQuestion(content, question));
  return questions.some((question, index) => question !== value.questions[index]) ? { ...value, questions } : value;
}

function repairAiPractice(value, content = {}) {
  const source = value && typeof value === "object" ? value : {};
  let changed = false;
  const history = (Array.isArray(source.history) ? source.history : []).map(item => {
    const repaired = correctedAiHistoryItem(item, content);
    if (repaired !== item) changed = true;
    return repaired;
  });
  const historyById = new Map(history.map(item => [item.id, item]));
  let currentSet = normalizeAiQuestionSet(content, source.currentSet);
  if (currentSet !== source.currentSet) changed = true;
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
  const queuedSets = (Array.isArray(source.queuedSets) ? source.queuedSets : []).map(set => normalizeAiQuestionSet(content, set));
  if (queuedSets.some((set, index) => set !== source.queuedSets[index])) changed = true;
  if (!changed) return { changed: false, value: source };
  return { changed: true, value: { ...source, currentSet, queuedSets, history, updatedAt: new Date().toISOString() } };
}

function isKnownSemanticPromptIssue(question) {
  if (!question || question.type !== "single-choice" || !/(?:意思|语义).*(?:相近|相同)/.test(String(question.prompt || ""))) return false;
  if (normalizeEnglish(question.sourceText) !== "it is big") return false;
  const correctOption = (Array.isArray(question.options) ? question.options : []).find(option => option.id === question.answerKey?.correctOption);
  return normalizeEnglish(correctOption && correctOption.text) === "it is a big cat";
}

function removeCorrectedWeakPoints(value, correctedIds) {
  return (Array.isArray(value) ? value : []).map(item => {
    const questionIds = Array.isArray(item && item.questionIds) ? item.questionIds : [];
    const retained = questionIds.filter(questionId => !correctedIds.has(questionId));
    return { item: { ...item, questionIds: retained }, drop: questionIds.length > 0 && retained.length === 0 };
  }).filter(entry => !entry.drop).map(entry => entry.item);
}

function normalizeExamQuestion(content, value) {
  const question = value && typeof value === "object" ? value : {};
  if (question.type !== "translation" || question.direction !== "en-zh") return question;
  const key = question.answerKey && typeof question.answerKey === "object" ? question.answerKey : {};
  const sourceAnswers = Array.isArray(key.acceptedAnswers) ? key.acceptedAnswers : [];
  const acceptedAnswers = expandRegisteredChineseAnswers(content, question.sourceText, [
    ...sourceAnswers.map(answer => naturalizePlainDeepChinese(question.sourceText, answer)),
    ...sourceAnswers
  ], 16);
  const repaired = { ...question, answerKey: { ...key, acceptedAnswers } };
  return JSON.stringify(repaired) === JSON.stringify(question) ? question : repaired;
}

function repairExam(examValue, content = {}) {
  const exam = examValue && typeof examValue === "object" ? examValue : null;
  if (!exam || !Array.isArray(exam.questions)) return { changed: false, value: exam, correctedQuestionIds: new Set() };
  const questions = exam.questions.map(question => {
    const promptRepaired = isKnownSemanticPromptIssue(question) ? { ...question, prompt: "选择含有 big 的句子。" } : question;
    return normalizeExamQuestion(content, promptRepaired);
  });
  const correctedQuestionIds = new Set();
  let result = exam.result;
  if (result && Array.isArray(result.grades)) {
    const grades = result.grades.map(grade => {
      const question = questions.find(item => item.id === grade.questionId);
      const answer = exam.answers && question ? exam.answers[question.id] : "";
      if (!question || question.type !== "translation" || question.direction !== "en-zh"
        || !chineseNaturalDeepMatches(answer, question.answerKey.acceptedAnswers, question.sourceText)) return grade;
      correctedQuestionIds.add(question.id);
      return {
        ...grade,
        score: question.points,
        correct: true,
        explanation: NATURAL_DEEP_EXPLANATION,
        detailedExplanation: NATURAL_DEEP_EXPLANATION,
        correctAnswer: question.answerKey.acceptedAnswers.join(" / ")
      };
    });
    const typeScores = Array.from(new Set(questions.map(question => question.type))).map(type => {
      const typeQuestions = questions.filter(question => question.type === type);
      const previous = (Array.isArray(result.typeScores) ? result.typeScores : []).find(item => item.type === type);
      return {
        type,
        label: previous && previous.label || typeQuestions[0].typeLabel || type,
        score: grades.filter(grade => typeQuestions.some(question => question.id === grade.questionId)).reduce((sum, grade) => sum + (Number(grade.score) || 0), 0),
        possible: typeQuestions.reduce((sum, question) => sum + (Number(question.points) || 0), 0)
      };
    });
    result = {
      ...result,
      score: grades.reduce((sum, grade) => sum + (Number(grade.score) || 0), 0),
      possible: questions.reduce((sum, question) => sum + (Number(question.points) || 0), 0),
      grades,
      typeScores,
      weakPoints: removeCorrectedWeakPoints(result.weakPoints, correctedQuestionIds)
    };
  }
  const repairedExam = { ...exam, questions, result };
  const changed = JSON.stringify(repairedExam) !== JSON.stringify(exam);
  return { changed, value: changed ? repairedExam : exam, correctedQuestionIds };
}

function repairAiExam(value, content = {}) {
  const source = value && typeof value === "object" ? value : {};
  const current = repairExam(source.currentExam, content);
  let changed = current.changed;
  const correctedQuestionIds = new Set(current.correctedQuestionIds);
  const history = (Array.isArray(source.history) ? source.history : []).map(exam => {
    const repaired = repairExam(exam, content);
    if (repaired.changed) changed = true;
    repaired.correctedQuestionIds.forEach(id => correctedQuestionIds.add(id));
    return repaired.value;
  });
  const weakPoints = removeCorrectedWeakPoints(source.weakPoints, correctedQuestionIds);
  if (JSON.stringify(weakPoints) !== JSON.stringify(source.weakPoints || [])) changed = true;
  if (!changed) return { changed: false, value: source };
  return { changed: true, value: { ...source, currentExam: current.value, history, weakPoints, updatedAt: new Date().toISOString() } };
}

function repairLearningEvidence(content, stateValue) {
  const review = repairReviewEvidence(content, stateValue);
  const practice = repairAiPractice(review.state.aiPractice, content);
  const exam = repairAiExam(review.state.aiExam, content);
  return {
    changed: review.changed || practice.changed || exam.changed,
    state: { ...review.state, aiPractice: practice.value, aiExam: exam.value }
  };
}

module.exports = {
  LEARNING_EVIDENCE_REPAIR_VERSION,
  correctedAiHistoryItem,
  isKnownSemanticPromptIssue,
  learningEvidenceRepairSignature,
  repairAiExam,
  repairAiPractice,
  repairLearningEvidence
};
