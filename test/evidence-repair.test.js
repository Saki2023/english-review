"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { repairLearningEvidence } = require("../server/evidence-repair");

test("learning evidence repair is idempotent across review, AI history, current question, and saved exam", () => {
  const content = {
    words: [],
    sentences: [{ id: "cat-s", day: 2, english: "A cat sat on a mat.", chinese: "一只猫坐在一张垫子上。", directions: ["en-zh"] }]
  };
  const state = {
    taskStates: { "cat-s:en-zh": { level: 0, lastResult: false, reviewCount: 1, lastReviewed: "2026-08-02" } },
    history: { "2026-08-02": { reviewed: 1, correct: 0 } },
    attempts: [{ taskId: "cat-s:en-zh", date: "2026-08-02", answer: "一只猫坐在一张垫子上面", correct: false }],
    mistakes: [{ id: "old-error", taskId: "cat-s:en-zh", prompt: "A cat sat on a mat.", userAnswer: "一只猫坐在一张垫子上面", correctAnswer: "一只猫坐在一张垫子上。" }],
    aiPractice: {
      currentSet: {
        id: "set-1",
        questions: [{ id: "q-1", correct: true, explanation: "语义一致。" }]
      },
      history: [
        { id: "set-1:q-1", direction: "zh-en", userAnswer: "a big pig sat on mat", correctAnswer: "A big pig sat on a mat.", correct: true, explanation: "语义一致。" },
        { id: "set-2:q-2", direction: "en-zh", userAnswer: "一只大猫坐在一张垫子上", correctAnswer: "一只猫坐在一张垫子上。", correct: false, explanation: "增加了大。" }
      ]
    },
    aiExam: {
      currentExam: {
        id: "exam-1",
        questions: [{ id: "exam-q", type: "single-choice", prompt: "选择意思相近的句子。", sourceText: "it is big", options: [{ id: "A", text: "it is a big cat" }], answerKey: { kind: "option", correctOption: "A" } }]
      },
      history: []
    }
  };

  const repaired = repairLearningEvidence(content, state);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.state.attempts[0].correct, true);
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(repaired.state.aiPractice.history[0].correct, false);
  assert.equal(repaired.state.aiPractice.history[1].correct, false);
  assert.equal(repaired.state.aiPractice.currentSet.questions[0].correct, false);
  assert.equal(repaired.state.aiExam.currentExam.questions[0].prompt, "选择含有 big 的句子。");

  const secondPass = repairLearningEvidence(content, repaired.state);
  assert.equal(secondPass.changed, false);
  assert.deepEqual(secondPass.state, repaired.state);
});
