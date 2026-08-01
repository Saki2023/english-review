"use strict";

const { sanitizeAiPractice } = require("./ai-practice");
const { englishTokens } = require("./ai-question-utils");

function accuracy(correct, total) {
  return total ? Math.round((correct / total) * 100) : null;
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
    if (item.correct) group.correctQuestions += 1;
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

function reviewItemProgress(content, state, aiHistory) {
  const taskStates = state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {};
  return [...content.words.map(item => ({ ...item, kind: "word" })), ...content.sentences.map(item => ({ ...item, kind: "sentence" }))].map(item => {
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
    const relatedAiHistory = aiHistory.filter(entry => {
      const entryTokens = englishTokens(historyEnglish(entry));
      if (item.kind === "word") return itemTokens.length === 1 && entryTokens.includes(itemTokens[0]);
      return itemTokens.join(" ") === entryTokens.join(" ");
    });
    const aiCorrect = relatedAiHistory.filter(entry => entry.correct).length;
    const aiAccuracy = accuracy(aiCorrect, relatedAiHistory.length);
    const recentAi = relatedAiHistory.slice(-3);
    const standardReviews = directionStates.reduce((total, entry) => total + entry.reviewCount, 0);
    const standardWrong = directionStates.some(entry => entry.lastResult === false);
    const recentAiWrong = recentAi.some(entry => !entry.correct);
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
        recentResults: recentAi.map(entry => entry.correct)
      },
      status,
      needsReview: status !== "strong"
    };
  });
}

function aiWordSignals(content, history) {
  const words = new Map((content.words || []).map(item => [String(item.english || "").toLocaleLowerCase(), item]));
  const signals = new Map();
  history.forEach(item => {
    const english = historyEnglish(item);
    new Set(englishTokens(english)).forEach(token => {
      const word = words.get(token);
      if (!word) return;
      if (!signals.has(token)) signals.set(token, { english: word.english, chinese: word.chinese, attempts: 0, wrong: 0, lastWrongAt: "" });
      const signal = signals.get(token);
      signal.attempts += 1;
      if (!item.correct) {
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

function buildLearningSyncProfile(content, state, user) {
  const aiPractice = sanitizeAiPractice(state.aiPractice);
  const aiHistory = aiPractice.history;
  const aiCorrect = aiHistory.filter(item => item.correct).length;
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const reviewCorrect = attempts.filter(item => item.correct === true).length;
  const itemProgress = reviewItemProgress(content, state, aiHistory);
  const mistakes = Array.isArray(state.mistakes) ? state.mistakes.slice(-80) : [];
  const recentAiMistakes = aiHistory.filter(item => !item.correct).slice(-100).reverse();
  const aiSets = summarizeAiSets(aiHistory);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    user: { username: user.username, role: user.role },
    course: {
      currentDay: Number(content.currentDay) || 1,
      contentUpdatedAt: String(content.updatedAt || ""),
      words: (content.words || []).length,
      sentences: (content.sentences || []).length
    },
    summary: {
      reviewQuestions: attempts.length,
      reviewCorrect,
      reviewAccuracy: accuracy(reviewCorrect, attempts.length),
      aiSets: aiSets.length,
      aiQuestions: aiHistory.length,
      aiCorrect,
      aiAccuracy: accuracy(aiCorrect, aiHistory.length),
      itemsNeedingReview: itemProgress.filter(item => item.needsReview).length,
      weakItems: itemProgress.filter(item => item.status === "weak").length,
      developingItems: itemProgress.filter(item => item.status === "developing").length,
      strongItems: itemProgress.filter(item => item.status === "strong").length,
      unpracticedItems: itemProgress.filter(item => item.status === "unpracticed").length,
      recordedMistakes: mistakes.length + recentAiMistakes.length
    },
    weakPoints: {
      reviewItems: itemProgress.filter(item => item.status === "weak"),
      developingItems: itemProgress.filter(item => item.status === "developing"),
      unpracticedItems: itemProgress.filter(item => item.status === "unpracticed"),
      aiWordSignals: aiWordSignals(content, aiHistory),
      recentMistakes: mistakes,
      recentAiMistakes
    },
    activity: {
      dailyReview: state.history && typeof state.history === "object" ? state.history : {},
      aiSets
    },
    learnedContent: itemProgress,
    aiHistory
  };
}

module.exports = { accuracy, aiWordSignals, buildLearningSyncProfile, summarizeAiSets };
