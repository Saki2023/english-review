"use strict";

const { sanitizeAiPractice } = require("./ai-practice");
const { englishTokens } = require("./ai-question-utils");
const { sanitizeAiExamState } = require("./ai-exam");
const { analyzeAbilities } = require("./ability-analysis");
const { sanitizeDictationState } = require("./dictation");
const { sanitizeFocusedState, skillSummaries } = require("./focused-practice");
const { sanitizePreviewPracticeHistory } = require("./preview-practice");
const { publicTeachingProfile } = require("./teaching-profile");
const { DAILY_STUDY_PLAN, normalizeStudyTime, STUDY_TIME_TARGET_SECONDS } = require("../study-time");

function accuracy(correct, total) {
  return total ? Math.round((correct / total) * 100) : null;
}

function evidenceScore(value) {
  const score = Number(value && value.score);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : (value && value.correct ? 1 : 0);
}

function wordEvidence(item, token) {
  const result = (Array.isArray(item && item.wordResults) ? item.wordResults : []).find(entry => String(entry && entry.english || "").toLocaleLowerCase() === token);
  return result && typeof result.correct === "boolean" ? result.correct : null;
}

function historySetId(item, index) {
  if (item.setId) return item.setId;
  const id = String(item.id || "");
  return id.includes(":") ? id.slice(0, id.indexOf(":")) : `legacy-${item.date || "unknown"}-${index}`;
}

function summarizeAiSets(history) {
  const groups = new Map();
  history.forEach((item, index) => {
    const setId = historySetId(item, index);
    if (!groups.has(setId)) {
      groups.set(setId, {
        setId,
        createdAt: item.setCreatedAt || item.answeredAt || item.date || "",
        latestAt: item.answeredAt || item.setCreatedAt || item.date || "",
        model: item.model || "",
        reasoningEffort: item.reasoningEffort || "",
        expectedQuestions: Number(item.questionCount) || 0,
        answeredQuestions: 0,
        correctQuestions: 0
      });
    }
    const group = groups.get(setId);
    group.answeredQuestions += 1;
    group.correctQuestions += evidenceScore(item);
    group.expectedQuestions = Math.max(group.expectedQuestions, Number(item.questionCount) || 0);
    if (String(item.answeredAt || "") > String(group.latestAt || "")) group.latestAt = item.answeredAt;
    if (!group.model && item.model) group.model = item.model;
    if (!group.reasoningEffort && item.reasoningEffort) group.reasoningEffort = item.reasoningEffort;
  });
  return Array.from(groups.values()).map(group => ({
    ...group,
    expectedQuestions: group.expectedQuestions || group.answeredQuestions,
    completed: group.answeredQuestions >= (group.expectedQuestions || group.answeredQuestions),
    accuracy: accuracy(group.correctQuestions, group.answeredQuestions)
  })).sort((left, right) => String(right.latestAt || right.createdAt).localeCompare(String(left.latestAt || left.createdAt)));
}

function historyEnglish(item) {
  return item.direction === "zh-en" ? item.correctAnswer : item.prompt;
}

function taskItemId(taskId) {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  return separator > 0 ? value.slice(0, separator) : "";
}

function reviewItemProgress(content, state, aiHistory) {
  const taskStates = state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {};
  return [...content.words.filter(item => !item.preview).map(item => ({ ...item, kind: "word" })), ...content.sentences.filter(item => !item.preview).map(item => ({ ...item, kind: "sentence" }))].map(item => {
    const directions = Array.isArray(item.directions) && item.directions.length ? item.directions : ["en-zh"];
    const directionStates = directions.map(direction => {
      const taskId = `${item.id}:${direction}`;
      const source = taskStates[taskId] && typeof taskStates[taskId] === "object" ? taskStates[taskId] : {};
      return {
        taskId,
        direction,
        level: Number(source.level) || 0,
        lastResult: typeof source.lastResult === "boolean" ? source.lastResult : null,
        reviewCount: Number(source.reviewCount) || 0,
        lastReviewed: String(source.lastReviewed || ""),
        nextDue: String(source.nextDue || "")
      };
    });
    const itemTokens = englishTokens(item.english);
    const candidateAiHistory = aiHistory.filter(entry => {
      const entryTokens = englishTokens(historyEnglish(entry));
      if (item.kind === "word") return itemTokens.length === 1 && entryTokens.includes(itemTokens[0]);
      return itemTokens.join(" ") === entryTokens.join(" ");
    });
    const relatedAiHistory = item.kind === "word"
      ? candidateAiHistory.map(entry => ({ entry, result: wordEvidence(entry, itemTokens[0]) })).filter(value => typeof value.result === "boolean")
      : candidateAiHistory.map(entry => ({ entry, result: entry.correct === true }));
    const aiCorrect = relatedAiHistory.filter(value => value.result).length;
    const aiAccuracy = accuracy(aiCorrect, relatedAiHistory.length);
    const recentAi = relatedAiHistory.slice(-3);
    const standardReviews = directionStates.reduce((total, entry) => total + entry.reviewCount, 0);
    const standardWrong = directionStates.some(entry => entry.lastResult === false);
    const recentAiWrong = recentAi.some(value => !value.result);
    const standardStrong = directionStates.length > 0 && directionStates.every(entry => entry.level >= 2 && entry.lastResult !== false);
    const aiStrong = relatedAiHistory.length >= 3 && aiAccuracy >= 80 && !recentAiWrong;
    let status = "unpracticed";
    if (standardWrong || recentAiWrong) status = "weak";
    else if (standardStrong || aiStrong) status = "strong";
    else if (standardReviews > 0 || relatedAiHistory.length > 0) status = "developing";
    return {
      id: item.id,
      kind: item.kind,
      day: Number(item.day) || 0,
      english: item.english,
      chinese: item.chinese,
      phonetic: item.kind === "word" ? String(item.phonetic || "") : "",
      directions: directionStates,
      aiEvidence: {
        attempts: relatedAiHistory.length,
        correct: aiCorrect,
        accuracy: aiAccuracy,
        recentResults: recentAi.map(value => value.result)
      },
      status,
      needsReview: status !== "strong"
    };
  });
}

function aiWordSignals(content, history) {
  const words = new Map((content.words || []).filter(item => !item.preview).map(item => [String(item.english || "").toLocaleLowerCase(), item]));
  const signals = new Map();
  history.forEach(item => {
    (Array.isArray(item.wordResults) ? item.wordResults : []).forEach(result => {
      const token = String(result && result.english || "").toLocaleLowerCase();
      const word = words.get(token);
      if (!word || typeof result.correct !== "boolean") return;
      if (!signals.has(token)) signals.set(token, { english: word.english, chinese: word.chinese, attempts: 0, wrong: 0, lastWrongAt: "" });
      const signal = signals.get(token);
      signal.attempts += 1;
      if (!result.correct) {
        signal.wrong += 1;
        signal.lastWrongAt = item.answeredAt || item.date || signal.lastWrongAt;
      }
    });
  });
  return Array.from(signals.values()).filter(item => item.wrong > 0).map(item => ({
    ...item,
    accuracy: accuracy(item.attempts - item.wrong, item.attempts)
  })).sort((left, right) => right.wrong - left.wrong || left.accuracy - right.accuracy || right.attempts - left.attempts);
}

function examEvidence(exam) {
  const result = exam.result || {};
  const grades = new Map((result.grades || []).map(item => [item.questionId, item]));
  const possible = Number(result.possible) || Number(exam.totalPoints) || 100;
  const score = Number(result.score) || 0;
  return {
    id: exam.id,
    title: exam.title,
    createdAt: exam.createdAt,
    submittedAt: exam.submittedAt,
    model: exam.model,
    reasoningEffort: exam.reasoningEffort,
    includeEssay: exam.includeEssay,
    includeListening: exam.includeListening,
    clozePassage: exam.clozePassage,
    readingPassage: exam.readingPassage,
    score,
    possible,
    percentage: possible ? Math.round((score / possible) * 100) : null,
    typeScores: result.typeScores || [],
    summary: result.summary || "",
    weakPoints: result.weakPoints || [],
    questions: exam.questions.map(question => {
      const grade = grades.get(question.id) || {};
      return {
        id: question.id,
        type: question.type,
        typeLabel: question.typeLabel,
        prompt: question.prompt,
        sourceText: question.type === "listening"
          ? question.speechText
          : question.type === "cloze"
            ? exam.clozePassage
            : question.type === "reading-comprehension"
              ? exam.readingPassage
              : question.sourceText,
        options: question.options,
        points: question.points,
        learnerAnswer: exam.answers[question.id],
        score: Number(grade.score) || 0,
        correct: grade.correct === true,
        explanation: grade.explanation || "",
        correctAnswer: grade.correctAnswer || ""
      };
    })
  };
}

function dictationEvidence(state) {
  const dictation = sanitizeDictationState(state.dictation);
  return {
    sessions: dictation.history.map(session => ({
      id: session.id,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      score: session.score,
      possible: session.items.length,
      percentage: accuracy(session.score, session.items.length),
      summary: session.analysis?.summary || "",
      weakWords: session.analysis?.weakWords || [],
      recommendations: session.analysis?.recommendations || [],
      items: session.items.map(item => ({ wordId: item.wordId, day: item.day, english: item.english, chinese: item.chinese, phonetic: item.phonetic, learnerAnswer: item.answer, correct: item.correct }))
    })),
    weights: dictation.weights
  };
}

function focusedEvidence(state) {
  const focused = sanitizeFocusedState(state.focusedPractice);
  return {
    skills: skillSummaries(focused.history),
    sessions: focused.history.map(session => ({
      id: session.id,
      focusedType: session.focusedType,
      label: session.label,
      title: session.title,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      score: session.result?.score || 0,
      possible: session.result?.possible || 5,
      levelScore: session.result?.levelScore || 0,
      summary: session.result?.summary || "",
      weakPoints: session.result?.weakPoints || []
    }))
  };
}

function tutorEvidence(state) {
  const practice = sanitizeAiPractice(state.aiPractice);
  return practice.tutorHistory.map(item => ({
    id: item.id,
    setId: item.setId,
    questionId: item.questionId,
    historyId: item.historyId,
    source: item.source,
    taskId: item.taskId,
    variantId: item.variantId,
    direction: item.direction,
    prompt: item.prompt,
    learnerAnswer: item.learnerAnswer,
    correctAnswer: item.answered ? item.correctAnswer : "",
    answered: item.answered,
    explanation: item.explanation,
    learnerQuestion: item.question,
    aiAnswer: item.answer,
    askedAt: item.askedAt,
    answeredAt: item.answeredAt,
    providerName: item.providerName,
    model: item.model,
    reasoningEffort: item.reasoningEffort
  }));
}

function previewPracticeEvidence(state) {
  return sanitizePreviewPracticeHistory(state.previewPracticeHistory).filter(round => (
    round.total > 0
    && round.completed >= round.total
    && Boolean(round.completedAt)
  )).map(round => {
    const questions = round.tasks.map((task, index) => {
      const result = round.results[task.id] || {};
      const gradingStatus = ["correct", "partial", "incorrect"].includes(result.gradingStatus)
        ? result.gradingStatus
        : (result.correct === true ? "correct" : "incorrect");
      return {
        id: task.id,
        number: index + 1,
        kind: task.kind,
        direction: task.direction,
        english: task.english,
        chinese: task.chinese,
        prompt: task.direction === "en-zh" ? task.english : task.chinese,
        learnerAnswer: round.answers[task.id] || "",
        referenceAnswer: task.direction === "en-zh" ? task.chinese : task.english,
        correct: result.correct === true,
        gradingStatus,
        score: evidenceScore(result),
        explanation: result.explanation || "",
        detailedExplanation: result.detailedExplanation || result.explanation || "",
        problemWords: result.problemWords || [],
        wordResults: result.wordResults || [],
        gradingSource: result.source || "",
        answeredAt: result.answeredAt || "",
        formalEvidence: false
      };
    });
    return {
      id: round.id,
      sourceCurrentDay: round.currentDay,
      previewDay: round.nextDay,
      mode: round.mode,
      total: questions.length,
      fullyCorrect: questions.filter(question => question.gradingStatus === "correct").length,
      partiallyCorrect: questions.filter(question => question.gradingStatus === "partial").length,
      incorrect: questions.filter(question => question.gradingStatus === "incorrect").length,
      accepted: questions.filter(question => question.correct).length,
      score: round.score,
      startedAt: round.startedAt,
      completedAt: round.completedAt,
      formalEvidence: false,
      questions
    };
  });
}

function buildLearningSyncProfile(content, state, user) {
  const aiPractice = sanitizeAiPractice(state.aiPractice);
  const aiHistory = aiPractice.history;
  const aiCorrect = Math.round(aiHistory.reduce((sum, item) => sum + evidenceScore(item), 0) * 100) / 100;
  const formalItemIds = new Set([...(content.words || []), ...(content.sentences || [])].filter(item => !item.preview).map(item => item.id));
  const attempts = (Array.isArray(state.attempts) ? state.attempts : []).filter(item => formalItemIds.has(taskItemId(item && item.taskId)));
  const reviewCorrect = Math.round(attempts.reduce((sum, item) => sum + evidenceScore(item), 0) * 100) / 100;
  const itemProgress = reviewItemProgress(content, state, aiHistory);
  const mistakes = (Array.isArray(state.mistakes) ? state.mistakes : []).filter(item => formalItemIds.has(taskItemId(item && item.taskId))).slice(-80);
  const recentAiMistakes = aiHistory.filter(item => !item.correct).slice(-100).reverse();
  const aiSets = summarizeAiSets(aiHistory);
  const aiExam = sanitizeAiExamState(state.aiExam);
  const examHistory = aiExam.history.map(examEvidence);
  const examPercentages = examHistory.map(exam => exam.percentage).filter(value => Number.isFinite(value));
  const latestExam = examHistory[examHistory.length - 1] || null;
  const recentExamWeakPoints = aiExam.weakPoints.slice(-100).reverse();
  const abilities = analyzeAbilities(content, state);
  const dictation = dictationEvidence(state);
  const focused = focusedEvidence(state);
  const tutorHistory = tutorEvidence(state);
  const previewPracticeHistory = previewPracticeEvidence(state);
  const previewPracticeQuestions = previewPracticeHistory.flatMap(round => round.questions);
  const dictationScores = dictation.sessions.map(session => session.percentage).filter(value => Number.isFinite(value));
  const dictationWrong = dictation.sessions.flatMap(session => session.items).filter(item => item.correct === false).length;
  const focusedWeakPoints = focused.sessions.flatMap(session => session.weakPoints);
  const studyTime = normalizeStudyTime(state.studyTime);

  return {
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    user: { username: user.username, role: user.role },
    course: {
      currentDay: Number(content.currentDay) || 1,
      contentUpdatedAt: String(content.updatedAt || ""),
      words: (content.words || []).filter(item => !item.preview).length,
      previewWords: (content.words || []).filter(item => item.preview).length,
      sentences: (content.sentences || []).filter(item => !item.preview).length,
      notes: (content.notes || []).length
    },
    summary: {
      reviewQuestions: attempts.length,
      reviewCorrect,
      reviewAccuracy: accuracy(reviewCorrect, attempts.length),
      aiSets: aiSets.length,
      aiQuestions: aiHistory.length,
      aiCorrect,
      aiAccuracy: accuracy(aiCorrect, aiHistory.length),
      tutorQuestions: tutorHistory.length,
      previewPracticeRounds: previewPracticeHistory.length,
      previewPracticeQuestions: previewPracticeQuestions.length,
      previewPracticeFullyCorrect: previewPracticeQuestions.filter(question => question.gradingStatus === "correct").length,
      previewPracticePartiallyCorrect: previewPracticeQuestions.filter(question => question.gradingStatus === "partial").length,
      previewPracticeIncorrect: previewPracticeQuestions.filter(question => question.gradingStatus === "incorrect").length,
      previewPracticeAverageScore: previewPracticeHistory.length ? Math.round(previewPracticeHistory.reduce((sum, round) => sum + round.score, 0) / previewPracticeHistory.length) : null,
      latestPreviewPracticeAt: previewPracticeHistory.length ? previewPracticeHistory[previewPracticeHistory.length - 1].completedAt : "",
      exams: examHistory.length,
      examAveragePercentage: examPercentages.length ? Math.round(examPercentages.reduce((sum, value) => sum + value, 0) / examPercentages.length) : null,
      latestExamScore: latestExam ? latestExam.score : null,
      latestExamPossible: latestExam ? latestExam.possible : null,
      latestExamPercentage: latestExam ? latestExam.percentage : null,
      dictations: dictation.sessions.length,
      dictationAveragePercentage: dictationScores.length ? Math.round(dictationScores.reduce((sum, value) => sum + value, 0) / dictationScores.length) : null,
      focusedSessions: focused.sessions.length,
      studyDays: Object.keys(studyTime.daily).length,
      studyGoalSeconds: STUDY_TIME_TARGET_SECONDS,
      studyGoalDaysMet: Object.values(studyTime.daily).filter(seconds => Number(seconds) >= STUDY_TIME_TARGET_SECONDS).length,
      itemsNeedingReview: itemProgress.filter(item => item.needsReview).length,
      weakItems: itemProgress.filter(item => item.status === "weak").length,
      developingItems: itemProgress.filter(item => item.status === "developing").length,
      strongItems: itemProgress.filter(item => item.status === "strong").length,
      unpracticedItems: itemProgress.filter(item => item.status === "unpracticed").length,
      recordedMistakes: mistakes.length + recentAiMistakes.length + recentExamWeakPoints.length + dictationWrong + focusedWeakPoints.length
    },
    weakPoints: {
      reviewItems: itemProgress.filter(item => item.status === "weak"),
      developingItems: itemProgress.filter(item => item.status === "developing"),
      unpracticedItems: itemProgress.filter(item => item.status === "unpracticed"),
      aiWordSignals: aiWordSignals(content, aiHistory),
      recentMistakes: mistakes,
      recentAiMistakes,
      recentExamWeakPoints,
      dictationWrongItems: dictation.sessions.flatMap(session => session.items.filter(item => !item.correct).map(item => ({ ...item, sessionId: session.id, completedAt: session.completedAt }))).slice(-100).reverse(),
      recentFocusedWeakPoints: focusedWeakPoints.slice(-100).reverse()
    },
    activity: {
      dailyReview: state.history && typeof state.history === "object" ? state.history : {},
      dailyStudyTime: studyTime.daily,
      dailyStudyStages: studyTime.stages,
      studyGoalSeconds: STUDY_TIME_TARGET_SECONDS,
      studyPlan: DAILY_STUDY_PLAN.map(stage => ({ id: stage.id, label: stage.label, minutes: stage.minutes, targetSeconds: stage.minutes * 60, canContinueInLearningWindow: stage.allowBackground === true })),
      aiSets,
      tutorQuestions: tutorHistory.map(item => ({ id: item.id, setId: item.setId, questionId: item.questionId, askedAt: item.askedAt })),
      previewPractice: previewPracticeHistory.map(round => ({ id: round.id, previewDay: round.previewDay, mode: round.mode, completedAt: round.completedAt, total: round.total, fullyCorrect: round.fullyCorrect, partiallyCorrect: round.partiallyCorrect, incorrect: round.incorrect, score: round.score, formalEvidence: false })),
      exams: examHistory.map(exam => ({ id: exam.id, title: exam.title, submittedAt: exam.submittedAt, score: exam.score, possible: exam.possible, percentage: exam.percentage })),
      dictations: dictation.sessions.map(session => ({ id: session.id, completedAt: session.completedAt, score: session.score, possible: session.possible, percentage: session.percentage })),
      focusedSessions: focused.sessions.map(session => ({ id: session.id, focusedType: session.focusedType, completedAt: session.completedAt, levelScore: session.levelScore }))
    },
    learnedContent: itemProgress,
    abilities,
    localTeachingProfile: publicTeachingProfile(state.teachingProfile),
    aiHistory,
    tutorHistory,
    previewPracticeHistory,
    examHistory,
    dictationHistory: dictation.sessions,
    dictationWeights: dictation.weights,
    focusedSkills: focused.skills,
    focusedHistory: focused.sessions
  };
}

module.exports = { accuracy, aiWordSignals, buildLearningSyncProfile, dictationEvidence, examEvidence, focusedEvidence, previewPracticeEvidence, summarizeAiSets, tutorEvidence };
