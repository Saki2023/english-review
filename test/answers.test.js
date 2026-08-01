"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chineseAnswerMatches, englishAnswerMatches } = require("../answer-utils");

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
