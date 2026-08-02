"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildPaperRecognitionMessages, parsePaperRecognition, validatePaperImages } = require("../server/paper-exam");

const exam = {
  id: "exam-1",
  title: "测试卷",
  questions: [
    { id: "q1", type: "single-choice", prompt: "选择", sourceText: "cat", options: [{ id: "A", text: "猫" }], answerKey: { kind: "option", correctOption: "A" } },
    { id: "q2", type: "translation", prompt: "翻译", sourceText: "cat", options: [], answerKey: { kind: "rubric", rubric: "猫" } }
  ]
};
const image = `data:image/jpeg;base64,${Buffer.from("small-test-image").toString("base64")}`;

test("paper recognition accepts bounded raster images and never sends answer keys", () => {
  assert.equal(validatePaperImages([image]).length, 1);
  const messages = buildPaperRecognitionMessages(exam, [image]);
  assert.equal(Array.isArray(messages[1].content), true);
  assert.equal(messages[1].content[1].type, "image_url");
  assert.equal(JSON.stringify(messages).includes("answerKey"), false);
  assert.equal(JSON.stringify(messages).includes("rubric"), false);
});

test("paper recognition filters unknown question ids", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ answers: { q1: "A", q2: "猫", unknown: "ignore" }, recognitionNote: "识别完成" }) } }] };
  const parsed = parsePaperRecognition(payload, exam);
  assert.deepEqual(parsed.answers, { q1: "A", q2: "猫" });
  assert.equal(parsed.recognitionNote, "识别完成");
});

test("paper recognition rejects non-raster data URLs", () => {
  assert.throws(() => validatePaperImages(["data:image/svg+xml;base64,PHN2Zz4="]), /格式不受支持/);
});
