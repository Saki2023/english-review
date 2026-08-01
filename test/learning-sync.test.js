"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildLearningSyncProfile, summarizeAiSets } = require("../server/learning-sync");

test("learning sync profile combines review and AI evidence without account secrets", () => {
  const content = {
    currentDay: 2,
    updatedAt: "2026-08-01",
    words: [{ id: "cat", day: 2, english: "cat", chinese: "猫", phonetic: "/kæt/", directions: ["en-zh", "zh-en"] }],
    sentences: [{ id: "cat-sentence", day: 2, english: "A cat sat on a mat.", chinese: "一只猫坐在垫子上。", directions: ["en-zh"] }]
  };
  const state = {
    taskStates: { "cat:en-zh": { level: 1, lastResult: false, reviewCount: 2 } },
    history: { "2026-08-01": { reviewed: 2, correct: 1 } },
    attempts: [{ taskId: "cat:en-zh", correct: false }, { taskId: "cat:zh-en", correct: true }],
    mistakes: [{ id: "m1", taskId: "cat:en-zh", prompt: "cat", userAnswer: "狗", correctAnswer: "猫" }],
    aiPractice: { history: [{
      id: "aiset-1:aiq-1",
      setId: "aiset-1",
      setCreatedAt: "2026-08-01T10:00:00.000Z",
      answeredAt: "2026-08-01T10:01:00.000Z",
      date: "2026-08-01",
      model: "test-model",
      reasoningEffort: "high",
      questionNumber: 1,
      questionCount: 1,
      direction: "en-zh",
      prompt: "A cat sat on a mat.",
      userAnswer: "一只狗坐在垫子上",
      correctAnswer: "一只猫坐在垫子上",
      correct: false,
      explanation: "cat 需要再复习。"
    }] }
  };
  const profile = buildLearningSyncProfile(content, state, { username: "learner", role: "admin", passwordHash: "never-return-this" });

  assert.equal(profile.summary.reviewQuestions, 2);
  assert.equal(profile.summary.reviewAccuracy, 50);
  assert.equal(profile.summary.aiQuestions, 1);
  assert.equal(profile.summary.aiAccuracy, 0);
  assert.equal(profile.summary.weakItems, 2);
  assert.equal(profile.summary.strongItems, 0);
  assert.equal(profile.weakPoints.aiWordSignals[0].english, "cat");
  assert.equal(profile.weakPoints.reviewItems[0].status, "weak");
  assert.equal(profile.weakPoints.reviewItems[0].aiEvidence.attempts, 1);
  assert.equal(profile.activity.aiSets[0].completed, true);
  assert.equal(profile.aiHistory[0].model, "test-model");
  assert.equal(Object.hasOwn(profile.user, "passwordHash"), false);
  assert.equal(JSON.stringify(profile).includes("never-return-this"), false);
});

test("AI set summaries group question history and calculate scores", () => {
  const groups = summarizeAiSets([
    { id: "set-a:q1", setId: "set-a", questionCount: 2, correct: true, answeredAt: "2026-08-01T10:01:00Z" },
    { id: "set-a:q2", setId: "set-a", questionCount: 2, correct: false, answeredAt: "2026-08-01T10:02:00Z" }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].correctQuestions, 1);
  assert.equal(groups[0].accuracy, 50);
  assert.equal(groups[0].completed, true);
});
