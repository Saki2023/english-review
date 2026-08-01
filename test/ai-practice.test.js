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
    ]
  };
  const profile = buildLearningProfile(content, state, "2026-08-01");

  assert.deepEqual(new Set(profile.allowedWords), new Set(["cat", "big"]));
  assert.equal(profile.allowedWords.includes("dog"), false);
  assert.equal(profile.learnedSentences.length, 1);
  assert.equal(profile.weakItems[0].english, "cat");
  assert.deepEqual(profile.recentMistakes.map(item => item.prompt), ["cat"]);
  assert.equal(profile.recentAccuracy, 0);
});

test("AI practice state keeps a bounded question set and per-account settings", () => {
  const set = createQuestionSet([{ direction: "en-zh", english: "cat", chinese: "猫", acceptedEnglish: ["cat"], acceptedChinese: ["猫"], focus: "猫" }], { model: "model-a", reasoningEffort: "high" });
  const practice = sanitizeAiPractice({ settings: { model: "model-a", reasoningEffort: "high", count: 10 }, currentSet: set });
  assert.equal(practice.settings.model, "model-a");
  assert.equal(practice.settings.reasoningEffort, "high");
  assert.equal(practice.settings.count, 10);
  assert.equal(practice.currentSet.questions.length, 1);
});
