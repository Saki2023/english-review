"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildLearningSyncProfile, summarizeAiSets } = require("../server/learning-sync");

test("learning sync profile combines review and AI evidence without account secrets", () => {
  const content = {
    currentDay: 2,
    updatedAt: "2026-08-01",
    words: [{ id: "cat", day: 2, english: "cat", chinese: "猫", phonetic: "/kæt/", directions: ["en-zh", "zh-en"] }],
    sentences: [{ id: "cat-sentence", day: 2, english: "A cat sat on a mat.", chinese: "一只猫坐在垫子上。", directions: ["en-zh"] }]
  };
  const state = {
    taskStates: { "cat:en-zh": { level: 1, lastResult: false, reviewCount: 2 } },
    history: { "2026-08-01": { reviewed: 2, correct: 1 } },
    attempts: [{ taskId: "cat:en-zh", correct: false }, { taskId: "cat:zh-en", correct: true }],
    mistakes: [{ id: "m1", taskId: "cat:en-zh", prompt: "cat", userAnswer: "狗", correctAnswer: "猫" }],
    aiPractice: { history: [{
      id: "aiset-1:aiq-1",
      setId: "aiset-1",
      setCreatedAt: "2026-08-01T10:00:00.000Z",
      answeredAt: "2026-08-01T10:01:00.000Z",
      date: "2026-08-01",
      model: "test-model",
      reasoningEffort: "high",
      questionNumber: 1,
      questionCount: 1,
      direction: "en-zh",
      prompt: "A cat sat on a mat.",
      userAnswer: "一只狗坐在垫子上",
      correctAnswer: "一只猫坐在垫子上",
      correct: false,
      explanation: "cat 需要再复习。"
    }], tutorHistory: [{
      id: "tutor-1",
      setId: "aiset-1",
      questionId: "aiq-1",
      historyId: "aiset-1:aiq-1",
      source: "history",
      direction: "en-zh",
      prompt: "A cat sat on a mat.",
      learnerAnswer: "一只狗坐在垫子上",
      correctAnswer: "一只猫坐在垫子上",
      answered: true,
      question: "为什么这里是 cat？",
      answer: "因为 cat 表示猫。",
      askedAt: "2026-08-01T10:02:00.000Z",
      answeredAt: "2026-08-01T10:02:01.000Z"
    }] }
  };
  const profile = buildLearningSyncProfile(content, state, { username: "learner", role: "admin", passwordHash: "never-return-this" });

  assert.equal(profile.summary.reviewQuestions, 2);
  assert.equal(profile.summary.reviewAccuracy, 50);
  assert.equal(profile.summary.aiQuestions, 1);
  assert.equal(profile.summary.aiAccuracy, 0);
  assert.equal(profile.summary.tutorQuestions, 1);
  assert.equal(profile.summary.weakItems, 2);
  assert.equal(profile.summary.strongItems, 0);
  assert.equal(profile.weakPoints.aiWordSignals[0].english, "cat");
  assert.equal(profile.weakPoints.reviewItems[0].status, "weak");
  assert.equal(profile.weakPoints.reviewItems[0].aiEvidence.attempts, 1);
  assert.equal(profile.activity.aiSets[0].completed, true);
  assert.equal(profile.aiHistory[0].model, "test-model");
  assert.equal(profile.tutorHistory[0].learnerQuestion, "为什么这里是 cat？");
  assert.equal(profile.tutorHistory[0].aiAnswer, "因为 cat 表示猫。");
  assert.equal(profile.activity.tutorQuestions[0].id, "tutor-1");
  assert.equal(Object.hasOwn(profile.user, "passwordHash"), false);
  assert.equal(JSON.stringify(profile).includes("never-return-this"), false);
});

test("AI set summaries group question history and calculate scores", () => {
  const groups = summarizeAiSets([
    { id: "set-a:q1", setId: "set-a", questionCount: 2, correct: true, answeredAt: "2026-08-01T10:01:00Z" },
    { id: "set-a:q2", setId: "set-a", questionCount: 2, correct: false, answeredAt: "2026-08-01T10:02:00Z" }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].correctQuestions, 1);
  assert.equal(groups[0].accuracy, 50);
  assert.equal(groups[0].completed, true);
});

test("learning sync includes normalized exam scores and weakness evidence without private answer keys", () => {
  const question = {
    id: "examq-1",
    type: "listening",
    prompt: "听音后选择意思。",
    speechText: "A cat sat on a mat.",
    options: [{ id: "A", text: "一只猫坐在垫子上" }, { id: "B", text: "一只猪坐在垫子上" }],
    points: 150,
    answerKey: { kind: "option", correctOption: "A" }
  };
  const state = {
    aiExam: {
      history: [{
        id: "exam-1",
        title: "听力测试",
        status: "completed",
        totalPoints: 150,
        includeListening: true,
        createdAt: "2026-08-02T10:00:00Z",
        submittedAt: "2026-08-02T10:10:00Z",
        questions: [question],
        answers: { "examq-1": "B" },
        result: { grades: [{ questionId: "examq-1", score: 0, correct: false, explanation: "需要再听。", correctAnswer: "一只猫坐在垫子上" }], summary: "听力需要加强。", weakPoints: [{ category: "listening", severity: "high", detail: "听音辨句不稳定。", recommendation: "复习后重听。", questionIds: ["examq-1"], relatedWords: ["cat"] }] }
      }],
      weakPoints: [{ examId: "exam-1", recordedAt: "2026-08-02T10:10:00Z", category: "listening", severity: "high", detail: "听音辨句不稳定。", recommendation: "复习后重听。", questionIds: ["examq-1"], relatedWords: ["cat"] }]
    }
  };
  const profile = buildLearningSyncProfile({ currentDay: 2, words: [], sentences: [] }, state, { username: "learner", role: "member" });

  assert.equal(profile.schemaVersion, 4);
  assert.equal(profile.summary.exams, 1);
  assert.equal(profile.summary.latestExamScore, 0);
  assert.equal(profile.summary.latestExamPossible, 150);
  assert.equal(profile.examHistory[0].questions[0].sourceText, "A cat sat on a mat.");
  assert.equal(profile.weakPoints.recentExamWeakPoints[0].category, "listening");
  assert.equal(profile.abilities.abilities.find(item => item.id === "listening").evidenceCount, 1);
  assert.equal(JSON.stringify(profile).includes("answerKey"), false);
});
