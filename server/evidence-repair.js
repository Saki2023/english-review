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
  normalizeChinese,
  normalizeEnglish,
  repairReviewEvidence
} = require("../answer-utils");
const { expandRegisteredChineseAnswers, naturalizePlainDeepChinese } = require("../review-variants");
const { selfStudyAutomaticSummary } = require("./self-study");

const LEARNING_EVIDENCE_REPAIR_VERSION = 2;

const SELF_STUDY_ANSWER_REPAIRS = Object.freeze({
  "trip-day-011": Object.freeze({
    "reading-line-01-translate": Object.freeze(["萨姆和汤姆在一条船里。", "萨姆和汤姆在一艘船里。", "萨姆和汤姆在船里。", "萨姆和汤姆在船上。"])
  }),
  "trip-day-014": Object.freeze({
    "reading-line-04-translate": Object.freeze(["他们看见一只老鼠在房子里。", "他们看见一只老鼠在一所房子里。", "他们看到一只老鼠在一所房子里。"]),
    "reading-check-2": Object.freeze(["路上", "道路上", "在路上", "在道路上", "一条路上", "在一条路上"]),
    "reading-check-3": Object.freeze(["房间里", "在房间里", "一个房间里", "在一个房间里"]),
    "test-ez1": Object.freeze(["他们看见一头棕色的牛在路上。", "他们看见一头棕色的牛在道路上。", "他们看到一头棕色的牛在一条路上。"]),
    "test-ez2": Object.freeze(["他们在一个房间里玩游戏。", "他们在一个房间里玩一个游戏。", "他们在房间里玩一个游戏。"])
  })
});

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
    ? expandRegisteredChineseAnswers(content, item.prompt, [
      correctAnswer,
      sourceCorrectAnswer,
      ...(normalizeEnglish(item.prompt) === "sam and tom are in a zoo" ? ["萨姆与汤姆在一家动物园里。"] : [])
    ], 16)
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

function selfStudyAnswerMatches(step, answer, acceptedAnswers) {
  if (step && (step.direction === "en-zh" || step.type === "en-zh")) {
    return chineseAnswerQuality(answer, acceptedAnswers, step.english || step.prompt).gradingStatus === "correct";
  }
  const normalized = normalizeChinese(answer);
  return Boolean(normalized && acceptedAnswers.some(value => normalizeChinese(value) === normalized));
}

function repairedSelfStudyAttempt(attemptValue, step, acceptedAnswers, { invalidated = false, independent = false } = {}) {
  const attempt = attemptValue && typeof attemptValue === "object" ? attemptValue : {};
  if (invalidated) {
    return {
      ...attempt,
      status: "invalidated",
      correct: null,
      score: null,
      gradingStatus: "pending",
      explanation: "该记录由旧错误答案键诱发，已从学习证据中排除。",
      detailedExplanation: "该记录保留用于审计，但不再计入订正、错题、能力、单词使用或掌握证据。",
      problemWords: [],
      wordResults: [],
      correction: false,
      assistance: "",
      hintLevel: 0,
      formalEvidence: false,
      acceptedAnswerVersion: "self-study-answer-repair-v1"
    };
  }
  const correct = selfStudyAnswerMatches(step, attempt.answer, acceptedAnswers);
  if (!correct) return attempt;
  const english = step.english || step.prompt || "";
  return {
    ...attempt,
    status: "graded",
    correct: true,
    score: 1,
    gradingStatus: "correct",
    explanation: attempt.correct === true ? (attempt.explanation || "回答正确，可以继续。") : "答案与题干或短文内容一致，旧判定已定向修正。",
    detailedExplanation: attempt.correct === true ? (attempt.detailedExplanation || attempt.explanation || "回答正确，可以继续。") : "答案与本题修正后的参考范围一致；本次修复不放宽其他人物、地点、数量或动作差异。",
    problemWords: [],
    wordResults: english ? englishSourceWordResults(english, true, []) : [],
    ...(independent ? { correction: false, assistance: "", hintLevel: 0 } : {}),
    acceptedAnswerVersion: "self-study-answer-repair-v1"
  };
}

function replaceSelfStudyStepAnswers(lesson, repairs) {
  if (!lesson || !Array.isArray(lesson.stages) || !repairs) return lesson;
  let changed = false;
  const stages = lesson.stages.map(stage => ({
    ...stage,
    steps: stage.steps.map(step => {
      const acceptedAnswers = repairs[step.stepId];
      if (!acceptedAnswers) return step;
      const next = { ...step, acceptedAnswers: [...acceptedAnswers], referenceAnswer: acceptedAnswers[0] || "" };
      if (JSON.stringify(next) !== JSON.stringify(step)) changed = true;
      return next;
    })
  }));
  return changed ? { ...lesson, stages } : lesson;
}

function repairSelfStudyEvidence(value, wordUsageValue) {
  const source = value && typeof value === "object" ? value : {};
  let changed = false;
  const invalidatedAttemptIds = new Set();
  const completedAttemptIds = new Set();
  const lessons = (Array.isArray(source.lessons) ? source.lessons : []).map(lesson => {
    const repairs = SELF_STUDY_ANSWER_REPAIRS[lesson && lesson.lessonId];
    const repaired = replaceSelfStudyStepAnswers(lesson, repairs);
    if (repaired !== lesson) changed = true;
    return repaired;
  });
  const progress = Object.fromEntries(Object.entries(source.progress && typeof source.progress === "object" ? source.progress : {}).map(([lessonId, progressValue]) => {
    const repairs = SELF_STUDY_ANSWER_REPAIRS[lessonId];
    if (!repairs || !progressValue || !progressValue.snapshot) return [lessonId, progressValue];
    const original = progressValue;
    const snapshot = replaceSelfStudyStepAnswers(original.snapshot, repairs);
    const stepDefinitions = new Map(snapshot.stages.flatMap(stage => stage.steps).map(step => [step.stepId, step]));
    const steps = { ...(original.steps && typeof original.steps === "object" ? original.steps : {}) };
    Object.entries(repairs).forEach(([stepId, acceptedAnswers]) => {
      const step = stepDefinitions.get(stepId);
      const stepState = steps[stepId];
      if (!step || !stepState || !Array.isArray(stepState.attempts)) return;
      const firstValidIndex = stepState.attempts.findIndex(attempt => selfStudyAnswerMatches(step, attempt && attempt.answer, acceptedAnswers));
      if (firstValidIndex < 0) return;
      const attempts = stepState.attempts.map((attempt, index) => {
        if (index > firstValidIndex) {
          if (attempt && attempt.attemptId) invalidatedAttemptIds.add(attempt.attemptId);
          return repairedSelfStudyAttempt(attempt, step, acceptedAnswers, { invalidated: true });
        }
        const repaired = repairedSelfStudyAttempt(attempt, step, acceptedAnswers, { independent: index === 0 && index === firstValidIndex });
        if (index === firstValidIndex && repaired && repaired.attemptId) completedAttemptIds.add(repaired.attemptId);
        return repaired;
      });
      const firstWasValid = firstValidIndex === 0;
      steps[stepId] = {
        ...stepState,
        attempts,
        ...(firstWasValid ? { firstAttemptId: attempts[0] && attempts[0].attemptId || stepState.firstAttemptId, assistance: "", hintLevel: 0 } : {})
      };
    });
    const next = { ...original, snapshot, steps };
    const summaryStep = snapshot.stages.flatMap(stage => stage.steps).find(step => step.type === "summary");
    const summaryState = summaryStep && next.steps[summaryStep.stepId];
    if (summaryState && summaryState.automaticSummary) {
      const summaryTime = new Date(summaryState.automaticSummary.generatedAt || original.completedAt || original.updatedAt || 0);
      const stableTime = Number.isFinite(summaryTime.getTime()) ? summaryTime : new Date(0);
      next.steps = { ...next.steps, [summaryStep.stepId]: { ...summaryState, automaticSummary: selfStudyAutomaticSummary(next, stableTime) } };
    }
    if (JSON.stringify(next) !== JSON.stringify(original)) changed = true;
    return [lessonId, next];
  }));

  const usageSource = wordUsageValue && typeof wordUsageValue === "object" ? wordUsageValue : {};
  const usageEvents = (Array.isArray(usageSource.events) ? usageSource.events : []).filter(event => {
    const eventId = String(event && event.eventId || "");
    const invalidated = Array.from(invalidatedAttemptIds).some(attemptId => eventId.startsWith(`self-study:${attemptId}:`));
    if (invalidated) changed = true;
    return !invalidated;
  }).map(event => {
    const eventId = String(event && event.eventId || "");
    const repaired = Array.from(completedAttemptIds).some(attemptId => eventId.startsWith(`self-study:${attemptId}:`));
    if (!repaired || event.result === "completed") return event;
    changed = true;
    return { ...event, result: "completed", formalEvidence: false };
  });
  const wordUsage = usageEvents.length === (Array.isArray(usageSource.events) ? usageSource.events.length : 0)
    && usageEvents.every((event, index) => event === usageSource.events[index])
    ? usageSource
    : { ...usageSource, events: usageEvents };
  return { changed, value: changed ? { ...source, lessons, progress } : source, wordUsage };
}

function repairLearningEvidence(content, stateValue) {
  const review = repairReviewEvidence(content, stateValue);
  const practice = repairAiPractice(review.state.aiPractice, content);
  const exam = repairAiExam(review.state.aiExam, content);
  const selfStudy = repairSelfStudyEvidence(review.state.selfStudy, review.state.wordUsage);
  const correctedAiById = new Map((Array.isArray(practice.value && practice.value.history) ? practice.value.history : []).map(item => [String(item && item.id || ""), item]));
  const sentencePracticeEvents = (Array.isArray(review.state.sentencePracticeEvents) ? review.state.sentencePracticeEvents : []).map(event => {
    const corrected = correctedAiById.get(String(event && event.id || ""));
    if (!corrected || event.correct === (corrected.correct === true && corrected.gradingStatus === "correct" && Number(corrected.score) >= 1)) return event;
    return { ...event, correct: corrected.correct === true && corrected.gradingStatus === "correct" && Number(corrected.score) >= 1 };
  });
  const sentenceEventsChanged = sentencePracticeEvents.some((event, index) => event !== review.state.sentencePracticeEvents[index]);
  return {
    changed: review.changed || practice.changed || exam.changed || selfStudy.changed || sentenceEventsChanged,
    state: { ...review.state, aiPractice: practice.value, aiExam: exam.value, selfStudy: selfStudy.value, wordUsage: selfStudy.wordUsage, sentencePracticeEvents }
  };
}

module.exports = {
  LEARNING_EVIDENCE_REPAIR_VERSION,
  correctedAiHistoryItem,
  isKnownSemanticPromptIssue,
  learningEvidenceRepairSignature,
  repairAiExam,
  repairAiPractice,
  repairSelfStudyEvidence,
  repairLearningEvidence
};
