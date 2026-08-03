"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildMistakePracticeQueue, chineseAnswerMatches, chineseAnswerQuality, englishAnswerMatches, englishFunctionWordDifferences, englishFunctionWordsMatch, isReviewEligibleItem, repairReviewEvidence, shouldSubmitOnEnter } = require("../answer-utils");

test("today review accepts only formally learned content", () => {
  const today = "2026-08-03";
  assert.equal(isReviewEligibleItem({ day: 4, learned: "2026-08-03", preview: false }, 4, today), true);
  assert.equal(isReviewEligibleItem({ day: 5, learned: "", preview: true }, 4, today), false);
  assert.equal(isReviewEligibleItem({ day: 4, learned: "", preview: false }, 4, today), false);
  assert.equal(isReviewEligibleItem({ day: 5, learned: "2026-08-03", preview: false }, 4, today), false);
  assert.equal(isReviewEligibleItem({ day: 4, learned: "2026-08-04", preview: false }, 4, today), false);
});

test("Chinese answers accept explicit equivalent location wording", () => {
  const accepted = ["一只猫坐在一张垫子上", "一只猫坐在垫子上"];

  assert.equal(chineseAnswerMatches("一只猫坐在一张垫子上面。", accepted), true);
  assert.equal(chineseAnswerMatches("一只猫坐在一个垫子上", accepted), true);
  assert.equal(chineseAnswerMatches("一只猫坐在一块垫子上面", accepted), true);
});

test("Chinese normalization does not accept changed meaning", () => {
  const accepted = ["一只猫坐在一张垫子上"];

  assert.equal(chineseAnswerMatches("一只狗坐在一张垫子上", accepted), false);
  assert.equal(chineseAnswerMatches("一只猫坐在一张垫子里面", accepted), false);
});

test("Chinese measure-word mistakes preserve semantic understanding as partial credit", () => {
  const accepted = ["它是一支红色的笔", "它是一支红笔", "它是红色的笔"];
  assert.deepEqual(chineseAnswerQuality("它是一只红色的笔", accepted), { correct: true, gradingStatus: "partial", score: 0.8 });
  assert.equal(chineseAnswerMatches("它是一只红色的笔", accepted), false);
  assert.deepEqual(chineseAnswerQuality("它是一只红色的猫", accepted), { correct: false, gradingStatus: "incorrect", score: 0 });
});

test("English matching remains case and punctuation tolerant", () => {
  assert.equal(englishAnswerMatches("I AM SAM!", ["i am sam"]), true);
  assert.equal(englishAnswerMatches("I am a man", ["i am sam"]), false);
});

test("English structure comparison requires every learned function word", () => {
  const accepted = ["A big pig sat on a mat."];
  assert.equal(englishFunctionWordsMatch("a big pig sat on a mat", accepted), true);
  assert.equal(englishFunctionWordsMatch("a big pig sat on mat", accepted), false);
  assert.equal(englishFunctionWordsMatch("a big pig sat in a mat", accepted), false);
  assert.equal(englishFunctionWordsMatch("the big pig sat on a mat", accepted), false);
  assert.deepEqual(englishFunctionWordDifferences("a big pig sat on mat", accepted), ["a"]);
});

test("review evidence repair corrects equivalent Chinese, restores daily counts, and rejects missing articles", () => {
  const content = {
    words: [],
    sentences: [
      { id: "cat-s", day: 2, english: "A cat sat on a mat.", chinese: "一只猫坐在一张垫子上。", directions: ["en-zh"] },
      { id: "pig-s", day: 2, english: "A big pig sat on a mat.", chinese: "一头大猪坐在一张垫子上。", directions: ["zh-en"] }
    ]
  };
  const input = {
    taskStates: {
      "cat-s:en-zh": { level: 0, lastResult: false, reviewCount: 1, lastReviewed: "2026-08-02" },
      "pig-s:zh-en": { level: 2, lastResult: true, reviewCount: 1, lastReviewed: "2026-08-02" }
    },
    history: { "2026-08-02": { reviewed: 2, correct: 1 } },
    attempts: [
      { taskId: "cat-s:en-zh", date: "2026-08-02", answer: "一只猫坐在一张垫子上面", correct: false },
      { taskId: "pig-s:zh-en", date: "2026-08-02", answer: "a big pig sat on mat", correct: true }
    ],
    mistakes: [{ id: "old-error", taskId: "cat-s:en-zh", prompt: "A cat sat on a mat.", userAnswer: "一只猫坐在一张垫子上面", correctAnswer: "一只猫坐在一张垫子上。" }]
  };

  const repaired = repairReviewEvidence(content, input);
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.state.attempts.map(item => item.correct), [true, false]);
  assert.equal(repaired.state.history["2026-08-02"].correct, 1);
  assert.equal(repaired.state.taskStates["cat-s:en-zh"].lastResult, true);
  assert.equal(repaired.state.taskStates["pig-s:zh-en"].lastResult, false);
  assert.equal(repaired.state.mistakes.some(item => item.id === "old-error"), false);
  assert.equal(repaired.state.mistakes.some(item => item.taskId === "pig-s:zh-en"), true);
  assert.deepEqual(repaired.state.attempts[1].wordResults, [
    { english: "a", correct: false, issue: "missing" },
    { english: "big", correct: true, issue: "" },
    { english: "pig", correct: true, issue: "" },
    { english: "sat", correct: true, issue: "" },
    { english: "on", correct: true, issue: "" },
    { english: "mat", correct: true, issue: "" }
  ]);

  const secondPass = repairReviewEvidence(content, repaired.state);
  assert.equal(secondPass.changed, false);
  assert.deepEqual(secondPass.state, repaired.state);
});

test("mistake practice starts at the selected row and continues through unique mistakes", () => {
  const rows = [
    { taskId: "sentence-a:en-zh" },
    { taskId: "word-b:zh-en" },
    { taskId: "sentence-a:en-zh" },
    { taskId: "missing:en-zh" },
    { taskId: "sentence-c:zh-en" }
  ];
  const valid = ["sentence-a:en-zh", "word-b:zh-en", "sentence-c:zh-en"];

  assert.deepEqual(buildMistakePracticeQueue(rows, "word-b:zh-en", valid), [
    "word-b:zh-en",
    "sentence-c:zh-en",
    "sentence-a:en-zh"
  ]);
  assert.deepEqual(buildMistakePracticeQueue(rows, "unknown", valid), []);
  assert.deepEqual(buildMistakePracticeQueue(rows, "sentence-a:en-zh", []), []);
});

test("AI tutor sends with Enter while preserving multiline and IME input", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", ctrlKey: true }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", metaKey: true }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldSubmitOnEnter({ key: "a" }), false);
});
