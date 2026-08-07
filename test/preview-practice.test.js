"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { sanitizePreviewPractice, sanitizePreviewPracticeHistory } = require("../server/preview-practice");

test("preview practice keeps saved answers, pending retries, and detailed results per task", () => {
  const state = sanitizePreviewPractice({
    tasks: [{ id: "preview-word-a-en-zh", kind: "word", direction: "en-zh", english: "cat", chinese: "猫" }],
    answers: { "preview-word-a-en-zh": "狗", stale: "ignore" },
    pending: { "preview-word-a-en-zh": "AI 暂不可用", stale: "ignore" },
    results: { "preview-word-a-en-zh": { correct: false, explanation: "不同", detailedExplanation: "漏写目标词", problemWords: ["cat"], wordResults: [{ english: "cat", correct: false, issue: "meaning" }] } }
  });
  assert.equal(state.answers["preview-word-a-en-zh"], "狗");
  assert.equal(state.pending["preview-word-a-en-zh"], "AI 暂不可用");
  assert.equal(state.results["preview-word-a-en-zh"].detailedExplanation, "漏写目标词");
  assert.deepEqual(state.results["preview-word-a-en-zh"].problemWords, ["cat"]);
  assert.equal(Object.hasOwn(state.answers, "stale"), false);
  assert.equal(Object.hasOwn(state.pending, "stale"), false);
});

test("preview practice history keeps completed rounds and removes stale task maps", () => {
  const history = sanitizePreviewPracticeHistory([{
    id: "round-1",
    nextDay: 6,
    mode: "mixed",
    tasks: [{ id: "preview-word-a-en-zh", kind: "word", direction: "en-zh", english: "cat", chinese: "猫" }],
    answers: { "preview-word-a-en-zh": "猫", stale: "ignore" },
    results: { "preview-word-a-en-zh": { correct: true, score: 1, explanation: "ok" }, stale: { correct: false } },
    completedAt: "2026-08-06T00:00:00.000Z"
  }]);
  assert.equal(history.length, 1);
  assert.equal(history[0].completed, 1);
  assert.equal(history[0].correct, 1);
  assert.equal(history[0].score, 100);
  assert.equal(history[0].answers.stale, undefined);
  assert.equal(history[0].results.stale, undefined);
});
