"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildLearningProfile, createQuestionSet, sanitizeAiPractice } = require("../server/ai-practice");

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

test("AI practice state keeps a bounded question set and per-account settings", () => {
  const set = createQuestionSet([{ direction: "en-zh", english: "cat", chinese: "猫", acceptedEnglish: ["cat"], acceptedChinese: ["猫"], focus: "单词复习" }], { providerId: "provider-a", providerName: "NewAPI", model: "model-a", reasoningEffort: "max" });
  const tutorMessages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message-${index}` }));
  const practice = sanitizeAiPractice({ settings: { model: "model-a", reasoningEffort: "max", count: 10 }, tutorSettings: { reasoningEffort: "low" }, currentSet: set, tutor: { setId: set.id, questionId: set.questions[0].id, messages: tutorMessages } });
  assert.equal(practice.settings.model, "model-a");
  assert.equal(practice.settings.reasoningEffort, "max");
  assert.equal(practice.settings.count, 10);
  assert.equal(practice.tutorSettings.reasoningEffort, "low");
  assert.equal(practice.currentSet.questions.length, 1);
  assert.equal(practice.currentSet.reasoningEffort, "max");
  assert.equal(practice.currentSet.providerId, "provider-a");
  assert.equal(practice.currentSet.providerName, "NewAPI");
  assert.equal(practice.tutor.messages.length, 12);
  assert.equal(practice.tutor.messages[0].content, "message-2");
  assert.equal(sanitizeAiPractice({ settings: { reasoningEffort: "max" } }).tutorSettings.reasoningEffort, "medium");
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
