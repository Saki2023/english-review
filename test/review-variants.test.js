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

test("AI variant validation rejects a learned word used with an unlearned sense", () => {
  const scopedContent = { currentDay: 5, words: [
    { english: "it", chinese: "它", day: 2 },
    { english: "is", chinese: "是", day: 2 },
    { english: "a", chinese: "一个", day: 1 },
    { english: "fun", chinese: "有趣的", day: 5 },
    { english: "top", chinese: "顶部；最上面的部分", acceptedChinese: ["顶部", "顶端", "最上面", "最上面的部分"], day: 4 }
  ], sentences: [] };
  const base = { id: "top-base", english: "It is fun.", chinese: "它很有趣。" };
  const result = variants.validateGeneratedSentenceVariant(scopedContent, base, { english: "It is a fun top.", chinese: "它是一个有趣的陀螺。" });
  assert.equal(result.valid, false);
  assert.equal(result.reasonCode, "unlearned-word-sense");
  assert.deepEqual(result.unlearnedWords, ["top"]);
});

test("AI variant validation keeps English and Chinese subjects aligned", () => {
  const scopedContent = { currentDay: 3, words: [
    { english: "it", chinese: "它", day: 2 },
    { english: "is", chinese: "是", day: 2 },
    { english: "a", chinese: "一个", day: 1 },
    { english: "big", chinese: "大的", day: 2 },
    { english: "cat", chinese: "猫", day: 2 }
  ], sentences: [] };
  const base = { id: "description-base", english: "It is big.", chinese: "它很大。" };
  const rejected = variants.validateGeneratedSentenceVariant(scopedContent, base, { english: "It is a big cat.", chinese: "这是一只大猫。" });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reasonCode, "subject-mismatch");

  const accepted = variants.validateGeneratedSentenceVariant(scopedContent, base, { english: "It is a big cat.", chinese: "它是一只大猫。", acceptedChinese: ["这是一只大猫", "它是一个大猫"] });
  assert.equal(accepted.valid, true);
  assert.deepEqual(accepted.variant.acceptedChinese, ["它是一只大猫。", "它是一个大猫"]);
});

test("AI variants expand formally registered Chinese word meanings inside full sentences", () => {
  const base = data.sentences.find(item => item.id === "d4-s4");
  const accepted = variants.sanitizeGeneratedSentenceVariant(content, base, {
    english: "A big pen is on a box.",
    chinese: "一支大钢笔在一个箱子上。"
  });

  assert.ok(accepted);
  assert.ok(accepted.acceptedChinese.includes("一支大钢笔在一个箱子上。"));
  assert.ok(accepted.acceptedChinese.includes("一支大笔在一个箱子上。"));
  assert.ok(accepted.acceptedChinese.includes("一支大钢笔在一个盒子上。"));
  assert.ok(accepted.acceptedChinese.includes("一支大笔在一个盒子上。"));
});
