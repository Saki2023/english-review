"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildLearningProfile, createQuestionSet, sanitizeAiPractice, tutorThreadFromHistory } = require("../server/ai-practice");

test("learning profile prioritizes weak learned content and excludes future lessons", () => {
  const content = {
    currentDay: 3,
    words: [
      { id: "cat", day: 1, learned: "2026-08-01", english: "cat", chinese: "猫", directions: ["en-zh", "zh-en"] },
      { id: "big", day: 2, learned: "2026-08-01", english: "big", chinese: "大的", directions: ["en-zh"] },
      { id: "future", day: 3, learned: "2026-08-02", english: "dog", chinese: "狗", directions: ["en-zh"] }
    ],
    sentences: [
      { id: "sentence", day: 2, learned: "2026-08-01", english: "big cat", chinese: "大猫", directions: ["en-zh"] },
      { id: "future-sentence", day: 3, learned: "2026-08-02", english: "big dog", chinese: "大狗", directions: ["en-zh"] }
    ]
  };
  const state = {
    taskStates: { "cat:en-zh": { level: 0, lastResult: false }, "big:en-zh": { level: 3, lastResult: true } },
    attempts: [{ correct: false }],
    mistakes: [
      { taskId: "cat:en-zh", prompt: "cat", userAnswer: "狗", correctAnswer: "猫" },
      { taskId: "future:en-zh", prompt: "dog", userAnswer: "猫", correctAnswer: "狗" }
    ],
    aiExam: { weakPoints: [{ category: "vocabulary", severity: "high", detail: "cat 词义不稳定。", recommendation: "复习 cat。", relatedWords: ["cat"] }, { category: "vocabulary", detail: "未来词不应进入。", relatedWords: ["dog"] }] }
  };
  const profile = buildLearningProfile(content, state, "2026-08-01");

  assert.deepEqual(new Set(profile.allowedWords), new Set(["cat", "big"]));
  assert.equal(profile.allowedWords.includes("dog"), false);
  assert.equal(profile.learnedSentences.length, 1);
  assert.equal(profile.weakItems[0].english, "cat");
  assert.deepEqual(profile.recentMistakes.map(item => item.prompt), ["cat"]);
  assert.deepEqual(profile.recentExamWeakPoints.map(item => item.relatedWords), [["cat"]]);
  assert.equal(profile.recentAccuracy, 0);
});

test("AI practice state keeps a bounded current set, prepared groups, and per-account settings", () => {
  const question = { direction: "en-zh", english: "cat", chinese: "猫", acceptedEnglish: ["cat"], acceptedChinese: ["猫"], focus: "单词复习" };
  const selection = { providerId: "provider-a", providerName: "NewAPI", model: "model-a", reasoningEffort: "max" };
  const set = createQuestionSet([question], selection, { batchId: "batch-a", groupNumber: 1, groupCount: 5 });
  const queuedSets = Array.from({ length: 5 }, (_, index) => createQuestionSet([question], selection, { batchId: "batch-a", groupNumber: index + 2, groupCount: 5 }));
  queuedSets[0].index = 1;
  queuedSets[0].completed = true;
  queuedSets[0].questions[0].userAnswer = "猫";
  queuedSets[0].questions[0].correct = true;
  const tutorMessages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message-${index}` }));
  const practice = sanitizeAiPractice({ settings: { model: "model-a", reasoningEffort: "max", count: 10, groupCount: 5 }, tutorSettings: { providerId: "provider-b", reasoningEffort: "low" }, currentSet: set, queuedSets, tutor: { setId: set.id, questionId: set.questions[0].id, messages: tutorMessages } });
  assert.equal(practice.settings.model, "model-a");
  assert.equal(practice.settings.reasoningEffort, "max");
  assert.equal(practice.settings.count, 10);
  assert.equal(practice.settings.groupCount, 5);
  assert.equal(practice.tutorSettings.reasoningEffort, "low");
  assert.equal(practice.tutorSettings.providerId, "provider-b");
  assert.equal(practice.currentSet.questions.length, 1);
  assert.equal(practice.currentSet.reasoningEffort, "max");
  assert.equal(practice.currentSet.providerId, "provider-a");
  assert.equal(practice.currentSet.providerName, "NewAPI");
  assert.equal(practice.currentSet.batchId, "batch-a");
  assert.equal(practice.currentSet.groupNumber, 1);
  assert.equal(practice.queuedSets.length, 4);
  assert.equal(practice.queuedSets[0].groupNumber, 2);
  assert.equal(practice.queuedSets[0].index, 0);
  assert.equal(practice.queuedSets[0].completed, false);
  assert.equal(practice.queuedSets[0].questions[0].correct, null);
  assert.equal(practice.queuedSets[0].questions[0].userAnswer, "");
  assert.equal(practice.tutor.messages.length, 12);
  assert.equal(practice.tutor.messages[0].content, "message-2");
  assert.equal(practice.tutorHistory.length, 6);
  assert.equal(practice.tutorHistory[0].question, "message-2");
  assert.deepEqual(sanitizeAiPractice({ settings: { reasoningEffort: "max" }, tutorSettings: { providerId: "provider-c", model: "tutor-model", reasoningEffort: "high" } }).tutorSettings, { providerId: "provider-c", model: "tutor-model", reasoningEffort: "high" });
  assert.equal(sanitizeAiPractice({ settings: { reasoningEffort: "max" } }).tutorSettings.reasoningEffort, "medium");
  [1, 2, 3, 5].forEach(groupCount => assert.equal(sanitizeAiPractice({ settings: { groupCount } }).settings.groupCount, groupCount));
  assert.equal(sanitizeAiPractice({ settings: { groupCount: 4 } }).settings.groupCount, 1);
});

test("AI tutor keeps separate persistent histories for every exercise", () => {
  const practice = sanitizeAiPractice({ tutorHistory: [
    { id: "ask-1", setId: "set-a", questionId: "question-a", prompt: "cat", question: "为什么是猫？", answer: "cat 的意思是猫。", askedAt: "2026-08-02T10:00:00Z" },
    { id: "ask-2", setId: "set-b", questionId: "question-b", prompt: "mat", question: "mat 是什么？", answer: "mat 表示垫子。", askedAt: "2026-08-02T10:01:00Z" },
    { id: "ask-3", setId: "set-a", questionId: "question-a", prompt: "cat", question: "怎么发音？", answer: "可以先记住 /kæt/。", askedAt: "2026-08-02T10:02:00Z" }
  ] });

  assert.equal(practice.tutorHistory.length, 3);
  assert.deepEqual(tutorThreadFromHistory(practice, "set-a", "question-a").messages.map(item => item.content), ["为什么是猫？", "cat 的意思是猫。", "怎么发音？", "可以先记住 /kæt/。"]);
  assert.deepEqual(tutorThreadFromHistory(practice, "set-b", "question-b").messages.map(item => item.content), ["mat 是什么？", "mat 表示垫子。"]);
});

test("clearing a tutor session preserves learning history but cuts the active AI context", () => {
  const archived = [
    { id: "ask-old", setId: "set-a", questionId: "question-a", historyId: "set-a:question-a", question: "旧问题", answer: "旧回答", askedAt: "2026-08-03T10:00:00Z", answeredAt: "2026-08-03T10:00:05Z" },
    { id: "ask-new", setId: "set-a", questionId: "question-a", historyId: "set-a:question-a", question: "新问题", answer: "新回答", askedAt: "2026-08-03T10:02:00Z", answeredAt: "2026-08-03T10:02:05Z" }
  ];
  const reset = { setId: "set-a", questionId: "question-a", historyId: "set-a:question-a", source: "history", prompt: "cat", resetAt: "2026-08-03T10:01:00Z" };
  const reconstructed = sanitizeAiPractice({ tutorHistory: archived, tutorResets: [reset] });

  assert.equal(reconstructed.tutorHistory.length, 2, "clearing context must not delete the learning archive");
  assert.equal(reconstructed.tutorResets.length, 1);
  assert.deepEqual(tutorThreadFromHistory(reconstructed, "set-a", "question-a").messages.map(item => item.content), ["新问题", "新回答"]);

  const activelyCleared = sanitizeAiPractice({
    tutorHistory: archived,
    tutorResets: [reset],
    tutor: { setId: "set-a", questionId: "question-a", historyId: "set-a:question-a", source: "history", prompt: "cat", updatedAt: reset.resetAt, messages: [] }
  });
  assert.deepEqual(tutorThreadFromHistory(activelyCleared, "set-a", "question-a").messages, []);
  assert.equal(activelyCleared.tutor.historyId, "set-a:question-a");
  assert.equal(activelyCleared.tutor.source, "history");
});

test("legacy AI history gains set metadata without exposing old focus hints", () => {
  const practice = sanitizeAiPractice({ history: [{
    id: "aiset-old:aiq-old",
    date: "2026-08-01",
    direction: "en-zh",
    prompt: "A cat sat on a mat.",
    userAnswer: "一只猫坐在垫子上",
    correctAnswer: "一只猫坐在一张垫子上",
    correct: true,
    focus: "cat 表示猫"
  }] });
  assert.equal(practice.history[0].setId, "aiset-old");
  assert.equal(practice.history[0].focus, "介词辨析");
  assert.equal(practice.history[0].reasoningEffort, "");
});

test("AI question history retains the latest one thousand answers", () => {
  const history = Array.from({ length: 1002 }, (_, index) => ({
    id: `set-${index}:question-${index}`,
    date: "2026-08-01",
    direction: "en-zh",
    prompt: "cat",
    userAnswer: "猫",
    correctAnswer: "猫",
    correct: true
  }));
  const practice = sanitizeAiPractice({ history });
  assert.equal(practice.history.length, 1000);
  assert.equal(practice.history[0].id, "set-2:question-2");
});

test("AI tutor history retains the latest one thousand questions", () => {
  const tutorHistory = Array.from({ length: 1002 }, (_, index) => ({
    id: `ask-${index}`,
    setId: `set-${index}`,
    questionId: `question-${index}`,
    question: `question ${index}`,
    answer: `answer ${index}`
  }));
  const practice = sanitizeAiPractice({ tutorHistory });
  assert.equal(practice.tutorHistory.length, 1000);
  assert.equal(practice.tutorHistory[0].id, "ask-2");
});
