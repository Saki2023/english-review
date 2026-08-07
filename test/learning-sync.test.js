"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildLearningSyncProfile, summarizeAiSets } = require("../server/learning-sync");

test("learning sync profile combines review and AI evidence without account secrets", () => {
  const content = {
    currentDay: 2,
    updatedAt: "2026-08-01",
    words: [
      { id: "cat", day: 2, learned: "2026-08-01", english: "cat", chinese: "猫", phonetic: "/kæt/", directions: ["en-zh", "zh-en"] },
      { id: "dog-preview", day: 3, learned: "", preview: true, english: "dog", chinese: "狗", phonetic: "/dɔɡ/", directions: ["en-zh", "zh-en"] }
    ],
    sentences: [{ id: "cat-sentence", day: 2, english: "A cat sat on a mat.", chinese: "一只猫坐在垫子上。", directions: ["en-zh"] }]
  };
  const state = {
    taskStates: { "cat:en-zh": { level: 1, lastResult: false, reviewCount: 2 } },
    history: { "2026-08-01": { reviewed: 2, correct: 1 } },
    studyTime: { daily: { "2026-08-01": 3600 } },
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
      wordResults: [
        { english: "a", correct: true, issue: "" },
        { english: "cat", correct: false, issue: "meaning" },
        { english: "sat", correct: true, issue: "" },
        { english: "on", correct: true, issue: "" },
        { english: "mat", correct: true, issue: "" }
      ],
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
  assert.equal(profile.summary.studyDays, 1);
  assert.equal(profile.summary.studyGoalDaysMet, 1);
  assert.equal(profile.activity.dailyStudyTime["2026-08-01"], 3600);
  assert.equal(profile.activity.studyPlan.length, 6);
  assert.equal(profile.activity.studyPlan.reduce((sum, stage) => sum + stage.targetSeconds, 0), 3600);
  assert.deepEqual(profile.activity.studyPlan.filter(stage => stage.canContinueInLearningWindow).map(stage => stage.id), ["phonics", "pattern", "reading"]);
  assert.equal(profile.course.notes, 0);
  assert.equal(profile.course.words, 1);
  assert.equal(profile.course.previewWords, 1);
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
  assert.equal(profile.learnedContent.some(item => item.id === "dog-preview"), false);
  assert.equal(Object.hasOwn(profile.user, "passwordHash"), false);
  assert.equal(JSON.stringify(profile).includes("never-return-this"), false);
});

test("AI word weakness signals include only the word that was actually missing", () => {
  const words = ["a", "big", "pig", "sat", "on", "mat"].map(english => ({ id: english, english, chinese: english }));
  const profile = buildLearningSyncProfile({
    currentDay: 2,
    words,
    sentences: [{ id: "pig-s", english: "A big pig sat on a mat.", chinese: "一只大猪坐在垫子上。" }]
  }, {
    aiPractice: { history: [{
      id: "set-a:q1",
      setId: "set-a",
      direction: "zh-en",
      prompt: "一只大猪坐在垫子上。",
      userAnswer: "a big pig sat on mat",
      correctAnswer: "A big pig sat on a mat.",
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      wordResults: [
        { english: "a", correct: false, issue: "missing" },
        { english: "big", correct: true, issue: "" },
        { english: "pig", correct: true, issue: "" },
        { english: "sat", correct: true, issue: "" },
        { english: "on", correct: true, issue: "" },
        { english: "mat", correct: true, issue: "" }
      ]
    }] }
  }, { username: "learner", role: "member" });

  assert.deepEqual(profile.weakPoints.aiWordSignals.map(item => item.english), ["a"]);
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

  assert.equal(profile.schemaVersion, 6);
  assert.equal(profile.summary.exams, 1);
  assert.equal(profile.summary.latestExamScore, 0);
  assert.equal(profile.summary.latestExamPossible, 150);
  assert.equal(profile.examHistory[0].questions[0].sourceText, "A cat sat on a mat.");
  assert.equal(profile.weakPoints.recentExamWeakPoints[0].category, "listening");
  assert.equal(profile.abilities.abilities.find(item => item.id === "listening").evidenceCount, 1);
  assert.equal(JSON.stringify(profile).includes("answerKey"), false);
});

test("learning sync exports only completed preview practice as non-formal evidence", () => {
  const completedRound = {
    id: "preview-round-1",
    currentDay: 7,
    nextDay: 8,
    mode: "mixed",
    tasks: [
      { id: "preview-word-sun-en-zh", kind: "word", direction: "en-zh", english: "sun", chinese: "太阳" },
      { id: "preview-sentence-sun-zh-en", kind: "sentence", direction: "zh-en", english: "It is in the sun.", chinese: "它在阳光下。" }
    ],
    answers: {
      "preview-word-sun-en-zh": "太阳",
      "preview-sentence-sun-zh-en": "It is on the sun."
    },
    results: {
      "preview-word-sun-en-zh": { correct: true, score: 1, gradingStatus: "correct", explanation: "词义正确。", answeredAt: "2026-08-07T09:01:00.000Z" },
      "preview-sentence-sun-zh-en": { correct: true, score: 0.8, gradingStatus: "partial", explanation: "介词需要调整。", detailedExplanation: "这里表示处于阳光下，参考答案使用 in。", problemWords: ["in"], answeredAt: "2026-08-07T09:02:00.000Z" }
    },
    startedAt: "2026-08-07T09:00:00.000Z",
    completedAt: "2026-08-07T09:02:00.000Z"
  };
  const profile = buildLearningSyncProfile({ currentDay: 7, words: [], sentences: [] }, {
    previewPractice: {
      tasks: [{ id: "unfinished", kind: "sentence", direction: "en-zh", english: "unfinished-secret", chinese: "未完成" }],
      answers: { unfinished: "草稿答案" }
    },
    previewPracticeHistory: [
      { ...completedRound, id: "incomplete-round", results: {}, completedAt: "2026-08-07T08:00:00.000Z" },
      completedRound
    ]
  }, { username: "learner", role: "member" });

  assert.equal(profile.summary.previewPracticeRounds, 1);
  assert.equal(profile.summary.previewPracticeQuestions, 2);
  assert.equal(profile.summary.previewPracticeFullyCorrect, 1);
  assert.equal(profile.summary.previewPracticePartiallyCorrect, 1);
  assert.equal(profile.summary.previewPracticeIncorrect, 0);
  assert.equal(profile.summary.previewPracticeAverageScore, 90);
  assert.equal(profile.summary.recordedMistakes, 0);
  assert.equal(profile.activity.previewPractice[0].formalEvidence, false);
  assert.equal(profile.previewPracticeHistory[0].previewDay, 8);
  assert.equal(profile.previewPracticeHistory[0].formalEvidence, false);
  assert.equal(profile.previewPracticeHistory[0].questions[1].prompt, "它在阳光下。");
  assert.equal(profile.previewPracticeHistory[0].questions[1].learnerAnswer, "It is on the sun.");
  assert.equal(profile.previewPracticeHistory[0].questions[1].referenceAnswer, "It is in the sun.");
  assert.equal(profile.previewPracticeHistory[0].questions[1].detailedExplanation, "这里表示处于阳光下，参考答案使用 in。");
  assert.equal(profile.previewPracticeHistory[0].questions[1].formalEvidence, false);
  assert.equal(JSON.stringify(profile).includes("unfinished-secret"), false);
  assert.equal(JSON.stringify(profile).includes("草稿答案"), false);
});
