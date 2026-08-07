"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizePreviewSchoolSentence, sanitizePreviewPractice, sanitizePreviewPracticeHistory } = require("../server/preview-practice");

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

test("ambiguous school preview prompts accept both meanings while new prompts are made explicit", () => {
  const oldState = sanitizePreviewPractice({
    tasks: [{
      id: "preview-school-zh-en",
      kind: "sentence",
      direction: "zh-en",
      wordId: "school",
      requiredPreviewWordIds: ["school"],
      english: "Sam is in school.",
      chinese: "萨姆在学校。"
    }],
    answers: { "preview-school-zh-en": "Sam is in a school." },
    results: { "preview-school-zh-en": { correct: false, score: 0, gradingStatus: "incorrect", explanation: "多写了 a。", problemWords: ["a"] } }
  });

  assert.deepEqual(oldState.tasks[0].acceptedEnglish, ["Sam is in school.", "Sam is in a school."]);
  assert.equal(oldState.results["preview-school-zh-en"].correct, true);
  assert.equal(oldState.results["preview-school-zh-en"].score, 1);
  assert.deepEqual(oldState.results["preview-school-zh-en"].problemWords, []);
  assert.match(oldState.results["preview-school-zh-en"].detailedExplanation, /在上学|一所学校/);

  const institutional = normalizePreviewSchoolSentence({ english: "Sam is in school.", chinese: "萨姆在学校。" }, { rewriteChinese: true });
  assert.equal(institutional.chinese, "萨姆在上学。");
  assert.deepEqual(institutional.acceptedEnglish, ["Sam is in school."]);

  const building = normalizePreviewSchoolSentence({ english: "Sam is in a school.", chinese: "萨姆在学校。" }, { rewriteChinese: true });
  assert.equal(building.chinese, "萨姆在一所学校里。");
  assert.deepEqual(building.acceptedEnglish, ["Sam is in a school."]);
});
