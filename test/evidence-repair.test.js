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

test("measure-word repair records partial credit without clearing mastery and attributes only real word errors", () => {
  const content = {
    words: ["a", "big", "pig", "sat", "on", "mat", "it", "is", "red", "pen"].map((english, index) => ({ id: `w-${index}`, day: 3, english, chinese: english })),
    sentences: [{ id: "red-pen", day: 3, english: "It is a red pen.", chinese: "它是一支红色的笔。", acceptedChinese: ["它是一支红色的笔", "它是一支红笔", "它是红色的笔"], directions: ["en-zh"] }]
  };
  const state = {
    taskStates: { "red-pen:en-zh": { level: 2, lastResult: false, reviewCount: 3, lastReviewed: "2026-08-03" } },
    history: { "2026-08-03": { reviewed: 1, correct: 0 } },
    attempts: [{ taskId: "red-pen:en-zh", date: "2026-08-03", answer: "它是一只红色的笔", correct: false }],
    mistakes: [{ id: "measure", taskId: "red-pen:en-zh", userAnswer: "它是一只红色的笔" }],
    aiPractice: { history: [
      { id: "partial", direction: "en-zh", prompt: "It is a red pen.", userAnswer: "它是一只红色的笔", correctAnswer: "它是一支红色的笔。", correct: false },
      { id: "article", direction: "zh-en", prompt: "一头大猪坐在一张垫子上。", userAnswer: "a big pig sat on mat", correctAnswer: "A big pig sat on a mat.", correct: false }
    ] }
  };

  const repaired = repairLearningEvidence(content, state);
  assert.equal(repaired.state.attempts[0].correct, true);
  assert.equal(repaired.state.attempts[0].gradingStatus, "partial");
  assert.equal(repaired.state.attempts[0].score, 0.8);
  assert.equal(repaired.state.history["2026-08-03"].correct, 0.8);
  assert.equal(repaired.state.taskStates["red-pen:en-zh"].level, 2);
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(repaired.state.aiPractice.history[0].gradingStatus, "partial");
  assert.equal(repaired.state.aiPractice.history[0].wordResults.every(item => item.correct), true);
  const articleResults = new Map(repaired.state.aiPractice.history[1].wordResults.map(item => [item.english, item.correct]));
  assert.equal(articleResults.get("a"), false);
  ["big", "pig", "sat", "on", "mat"].forEach(word => assert.equal(articleResults.get(word), true));
});
