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
