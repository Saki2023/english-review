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

test("preview sentences inherit formal word meanings and repair legacy pool results idempotently", () => {
  const content = {
    words: [{
      id: "d8-pool",
      day: 8,
      learned: "2026-08-07",
      english: "pool",
      chinese: "水池；游泳池",
      acceptedChinese: ["水池", "游泳池", "泳池"]
    }]
  };
  const legacy = {
    key: "8|9|d9-deep",
    currentDay: 8,
    nextDay: 9,
    mode: "sentence",
    tasks: [{
      id: "preview-sentence-d9-deep",
      kind: "sentence",
      direction: "en-zh",
      wordId: "d9-deep",
      requiredPreviewWordIds: ["d9-deep"],
      english: "A pool is deep.",
      chinese: "一个水池是深的。",
      acceptedChinese: ["一个水池是深的。"]
    }],
    answers: { "preview-sentence-d9-deep": "一个游泳池很深" },
    pending: { "preview-sentence-d9-deep": "等待重试" },
    results: {
      "preview-sentence-d9-deep": {
        correct: false,
        score: 0,
        gradingStatus: "incorrect",
        explanation: "中文多写了“很”。",
        detailedExplanation: "参考答案要求写成一个水池是深的。",
        problemWords: ["pool"],
        wordResults: [{ english: "pool", correct: false, issue: "meaning" }],
        source: "ai",
        answeredAt: "2026-08-08T01:00:00.000Z"
      }
    }
  };

  const restored = sanitizePreviewPractice(JSON.parse(JSON.stringify(legacy)), content);
  const task = restored.tasks[0];
  const result = restored.results[task.id];
  assert.equal(task.chinese, "一个水池很深。");
  assert.ok(task.acceptedChinese.includes("一个水池是深的。"));
  assert.ok(task.acceptedChinese.includes("一个游泳池是深的。"));
  assert.ok(task.acceptedChinese.includes("一个泳池是深的。"));
  assert.ok(task.acceptedChinese.includes("一个水池很深。"));
  assert.ok(task.acceptedChinese.includes("一个游泳池很深。"));
  assert.ok(task.acceptedChinese.includes("一个泳池很深。"));
  assert.equal(result.correct, true);
  assert.equal(result.score, 1);
  assert.equal(result.gradingStatus, "correct");
  assert.deepEqual(result.problemWords, []);
  assert.deepEqual(result.wordResults, []);
  assert.equal(Object.hasOwn(restored.pending, task.id), false);
  assert.doesNotMatch(`${result.explanation} ${result.detailedExplanation}`, /只能翻译为水池|误译为游泳池|改变了原意|多写了“很”|要求写成/);
  assert.match(result.explanation, /自然表达|没有改变/);
  assert.match(result.detailedExplanation, /不会计入正式错题、待复习、薄弱点或能力分/);
  assert.deepEqual(sanitizePreviewPractice(JSON.parse(JSON.stringify(restored)), content), restored);

  const history = sanitizePreviewPracticeHistory([{
    ...legacy,
    id: "preview-round-pool",
    score: 0,
    completedAt: "2026-08-08T01:02:00.000Z"
  }], content);
  assert.equal(history[0].correct, 1);
  assert.equal(history[0].partial, 0);
  assert.equal(history[0].score, 100);
  assert.equal(history[0].results[task.id].correct, true);
});
