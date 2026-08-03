"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { abilityChanges, analyzeAbilities } = require("../server/ability-analysis");

const content = {
  words: [{ id: "cat", english: "cat", chinese: "猫" }],
  sentences: [{ id: "cat-s", english: "It is a cat.", chinese: "它是一只猫。" }]
};

test("abilities keep unpracticed skills separate from wrong answers", () => {
  const report = analyzeAbilities(content, {});
  assert.equal(report.comprehensiveScore, 0);
  assert.equal(report.practicedAbilities, 0);
  assert.equal(report.unpracticedAbilities, 7);
  assert.equal(report.abilities.find(item => item.id === "listening").status, "unpracticed");
  assert.equal(report.abilities.find(item => item.id === "listening").measuredAccuracy, null);
});

test("review, AI, exam, dictation, and focused evidence share one score model", () => {
  const report = analyzeAbilities(content, {
    attempts: [
      { taskId: "cat:zh-en", correct: false, date: "2026-08-01" },
      { taskId: "cat-s:en-zh", correct: true, date: "2026-08-01" }
    ],
    aiPractice: { history: [{ direction: "zh-en", correct: true, answeredAt: "2026-08-02T01:00:00Z", prompt: "猫", correctAnswer: "cat" }] },
    aiExam: { history: [{
      id: "exam-1",
      status: "completed",
      totalPoints: 100,
      submittedAt: "2026-08-02T02:00:00Z",
      questions: [
        { id: "q1", type: "listening", points: 50, prompt: "听音", speechText: "cat", options: [{ id: "A", text: "猫" }], answerKey: { kind: "option", correctOption: "A" } },
        { id: "q2", type: "essay", points: 50, prompt: "写作", answerKey: { kind: "rubric", rubric: "写一句话" } }
      ],
      answers: { q1: "A", q2: "It is a cat." },
      result: { grades: [{ questionId: "q1", score: 50, correct: true }, { questionId: "q2", score: 25, correct: false }] }
    }] },
    dictation: { history: [{ completedAt: "2026-08-02T03:00:00Z", items: [{ correct: false }] }] },
    focusedPractice: { history: [{ type: "translation", completedAt: "2026-08-02T04:00:00Z", results: [{ score: 4, possible: 5 }] }] }
  });

  assert.equal(report.practicedAbilities, 7);
  assert.equal(report.abilities.find(item => item.id === "listening").evidenceCount, 2);
  assert.equal(report.abilities.find(item => item.id === "writing").measuredAccuracy, 50);
  assert.equal(report.abilities.find(item => item.id === "translation").sources.includes("focused-practice"), true);
  assert.equal(report.updatedAt, "2026-08-02T04:00:00Z");
});

test("a single correct answer does not overstate a skill as 100", () => {
  const report = analyzeAbilities(content, { attempts: [{ taskId: "cat:en-zh", correct: true, date: "2026-08-01" }] });
  const vocabulary = report.abilities.find(item => item.id === "vocabulary");
  assert.equal(vocabulary.measuredAccuracy, 100);
  assert.equal(vocabulary.score < 100, true);
  assert.equal(vocabulary.status, "developing");
});

test("ability changes report score and status transitions", () => {
  const before = analyzeAbilities(content, {});
  const after = analyzeAbilities(content, { attempts: [{ taskId: "cat:en-zh", correct: true, date: "2026-08-01" }] });
  const changes = abilityChanges(before, after);
  assert.deepEqual(changes.map(item => item.id), ["vocabulary"]);
  assert.equal(changes[0].before, 0);
  assert.equal(changes[0].after > 0, true);
});

test("partial translations and missing articles affect only the supported abilities", () => {
  const report = analyzeAbilities({
    words: ["a", "big", "pig", "sat", "on", "mat", "it", "is", "red", "pen"].map(english => ({ id: english, english, chinese: english })),
    sentences: [
      { id: "red-pen", english: "It is a red pen.", chinese: "它是一支红色的笔。" },
      { id: "pig-mat", english: "A big pig sat on a mat.", chinese: "一只大猪坐在垫子上。" }
    ]
  }, {
    aiPractice: { history: [
      {
        id: "partial-set:q1",
        setId: "partial-set",
        direction: "en-zh",
        prompt: "It is a red pen.",
        userAnswer: "它是一只红色的笔。",
        correctAnswer: "它是一支红色的笔。",
        correct: true,
        score: 0.8,
        gradingStatus: "partial",
        answeredAt: "2026-08-03T01:00:00Z",
        wordResults: ["it", "is", "a", "red", "pen"].map(english => ({ english, correct: true, issue: "" }))
      },
      {
        id: "partial-set:q2",
        setId: "partial-set",
        direction: "zh-en",
        prompt: "一只大猪坐在垫子上。",
        userAnswer: "a big pig sat on mat",
        correctAnswer: "A big pig sat on a mat.",
        correct: false,
        score: 0,
        gradingStatus: "incorrect",
        answeredAt: "2026-08-03T01:01:00Z",
        wordResults: [
          { english: "a", correct: false, issue: "missing" },
          { english: "big", correct: true, issue: "" },
          { english: "pig", correct: true, issue: "" },
          { english: "sat", correct: true, issue: "" },
          { english: "on", correct: true, issue: "" },
          { english: "mat", correct: true, issue: "" }
        ]
      }
    ] }
  });

  assert.equal(report.abilities.find(item => item.id === "reading").measuredAccuracy, 80);
  assert.equal(report.abilities.find(item => item.id === "vocabulary").measuredAccuracy, 100);
  assert.equal(report.abilities.find(item => item.id === "translation").measuredAccuracy, 83);
  assert.equal(report.abilities.find(item => item.id === "grammar").measuredAccuracy, 0);
  assert.equal(report.abilities.find(item => item.id === "spelling").measuredAccuracy, 100);
});
