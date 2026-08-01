"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildMistakePracticeQueue, chineseAnswerMatches, englishAnswerMatches, shouldSubmitOnEnter } = require("../answer-utils");

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

test("English matching remains case and punctuation tolerant", () => {
  assert.equal(englishAnswerMatches("I AM SAM!", ["i am sam"]), true);
  assert.equal(englishAnswerMatches("I am a man", ["i am sam"]), false);
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
