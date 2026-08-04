"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const variants = require("../review-variants");
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "data.js"), "utf8"), context);
const data = context.window.ENGLISH_REVIEW_DATA;

const content = {
  currentDay: 4,
  words: data.words,
  sentences: data.sentences
};

test("sentence variant picker stays within learned words and avoids the fixed library when possible", () => {
  const base = data.sentences.find(item => item.id === "d4-s4");
  const chosen = variants.chooseSentenceVariant(content, base, "stable-seed", []);
  assert.ok(chosen);
  assert.notEqual(variants.normalizeEnglish(chosen.english), variants.normalizeEnglish(base.english));
  assert.equal(variants.sentenceFamily(chosen), "on");
  assert.ok(chosen.requiredWords.every(word => data.words.some(item => variants.normalizeEnglish(item.english) === word)));
  assert.equal(variants.chooseSentenceVariant(content, base, "stable-seed", []).id, chosen.id, "the same seed must be stable after refresh");
});

test("AI variant validation rejects an unlearned word or a changed sentence family", () => {
  const base = data.sentences.find(item => item.id === "d2-s3");
  assert.equal(variants.sanitizeGeneratedSentenceVariant(content, base, { english: "A dog sat on a mat.", chinese: "一只狗坐在垫子上。" }), null);
  assert.equal(variants.sanitizeGeneratedSentenceVariant(content, base, { english: "It is a cat.", chinese: "它是一只猫。" }), null);
  const unlearned = variants.validateGeneratedSentenceVariant(content, base, { english: "A dog sat on a mat.", chinese: "一只狗坐在垫子上。" });
  assert.equal(unlearned.valid, false);
  assert.equal(unlearned.reasonCode, "unlearned-word");
  assert.deepEqual(unlearned.unlearnedWords, ["dog"]);
  const wrongFamily = variants.validateGeneratedSentenceVariant(content, base, { english: "It is a cat.", chinese: "它是一只猫。" });
  assert.equal(wrongFamily.valid, false);
  assert.equal(wrongFamily.reasonCode, "wrong-family");
  const accepted = variants.sanitizeGeneratedSentenceVariant(content, base, { english: "A pig sat on a box.", chinese: "一头猪坐在一个箱子上。", acceptedChinese: ["一只猪坐在箱子上"] });
  assert.ok(accepted);
  assert.equal(accepted.acceptedEnglish[0], "a pig sat on a box");
  assert.equal(accepted.acceptedChinese[1], "一只猪坐在箱子上");
});
