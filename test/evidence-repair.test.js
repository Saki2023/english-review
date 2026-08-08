"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { repairLearningEvidence } = require("../server/evidence-repair");
const { analyzeAbilities } = require("../server/ability-analysis");
const { buildLearningSyncProfile } = require("../server/learning-sync");

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
  assert.deepEqual(secondPass.state, repaired.state);
  assert.equal(secondPass.changed, false);
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

test("evidence repair grades a saved AI review variant against its immutable snapshot", () => {
  const content = {
    words: [],
    sentences: [{ id: "size", day: 2, learned: "2026-08-01", english: "It is big.", chinese: "它很大。", acceptedChinese: ["它很大"], acceptedEnglish: ["it is big"], directions: ["zh-en"] }]
  };
  const variant = {
    id: "ai-be-variant",
    source: "ai",
    family: "be-adjective",
    english: "It is a hot cup.",
    chinese: "它是一个热杯子。",
    acceptedEnglish: ["it is a hot cup"],
    acceptedChinese: ["它是一个热杯子"]
  };
  const state = {
    evidenceRepairVersion: 2,
    taskStates: { "size:zh-en": { level: 0, lastResult: false, reviewCount: 1 } },
    history: { "2026-08-06": { reviewed: 1, correct: 0 } },
    attempts: [{ id: "attempt-variant", taskId: "size:zh-en", variantId: variant.id, reviewVariant: variant, date: "2026-08-06", answer: "It is a hot cup", correct: false, score: 0 }],
    mistakes: [{ id: "generated-by-old-repair", taskId: "size:zh-en", date: "2026-08-06", userAnswer: "It is a hot cup", prompt: "它很大。", correctAnswer: "It is big." }]
  };
  const repaired = require("../answer-utils").repairReviewEvidence(content, state);
  assert.equal(repaired.state.attempts[0].correct, true);
  assert.equal(repaired.state.attempts[0].gradingSource, "evidence-repair-v7");
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(repaired.state.history["2026-08-06"].correct, 1);
});

test("optional Chinese classifier omission repairs review, AI history, mistakes, and ability evidence", () => {
  const content = {
    words: ["it", "is", "a", "full", "cup"].map((english, index) => ({ id: `full-word-${index}`, english, chinese: english })),
    sentences: [{ id: "full-base", english: "It is full.", chinese: "它是满的。", directions: ["en-zh"] }]
  };
  const variant = {
    id: "ai-full-cup",
    source: "ai",
    family: "description",
    english: "It is a full cup.",
    chinese: "它是一个满的杯子。",
    acceptedEnglish: ["it is a full cup"],
    acceptedChinese: ["它是一个满的杯子"]
  };
  const state = {
    evidenceRepairVersion: 3,
    taskStates: { "full-base:en-zh": { level: 0, lastResult: false, reviewCount: 1, lastReviewed: "2026-08-07" } },
    history: { "2026-08-07": { reviewed: 1, correct: 0 } },
    attempts: [{
      id: "full-attempt",
      taskId: "full-base:en-zh",
      variantId: variant.id,
      reviewVariant: variant,
      date: "2026-08-07",
      answer: "它是满的杯子",
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      problemWords: ["a"],
      explanation: "漏掉了冠词 a。",
      detailedExplanation: "重点检查冠词 a。"
    }],
    mistakes: [{ id: "wrong-full", attemptId: "full-attempt", taskId: "full-base:en-zh", variantId: variant.id, reviewVariant: variant, userAnswer: "它是满的杯子" }],
    aiPractice: {
      currentSet: { id: "full-set", questions: [{ id: "q1", correct: false, score: 0, gradingStatus: "incorrect", problemWords: ["a"] }] },
      history: [{
        id: "full-set:q1",
        direction: "en-zh",
        prompt: "It is a full cup.",
        userAnswer: "它是满的杯子",
        correctAnswer: "它是一个满的杯子。",
        correct: false,
        score: 0,
        gradingStatus: "incorrect",
        problemWords: ["a"],
        explanation: "漏掉了冠词 a。",
        answeredAt: "2026-08-07T01:00:00.000Z"
      }]
    }
  };

  const repaired = repairLearningEvidence(content, state);
  const attempt = repaired.state.attempts[0];
  const aiItem = repaired.state.aiPractice.history[0];
  assert.equal(attempt.correct, true);
  assert.equal(attempt.score, 1);
  assert.equal(attempt.gradingStatus, "correct");
  assert.deepEqual(attempt.problemWords, []);
  assert.match(attempt.detailedExplanation, /省略了可选/);
  assert.equal(repaired.state.history["2026-08-07"].correct, 1);
  assert.equal(repaired.state.taskStates["full-base:en-zh"].lastResult, true);
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(aiItem.correct, true);
  assert.deepEqual(aiItem.problemWords, []);
  assert.equal(repaired.state.aiPractice.currentSet.questions[0].correct, true);
  assert.match(repaired.state.aiPractice.currentSet.questions[0].detailedExplanation, /省略了可选/);

  const abilities = analyzeAbilities(content, repaired.state).abilities;
  assert.equal(abilities.find(item => item.id === "reading").measuredAccuracy, 100);
  assert.equal(abilities.find(item => item.id === "vocabulary").measuredAccuracy, 100);

  const secondPass = repairLearningEvidence(content, repaired.state);
  assert.equal(secondPass.changed, false);
  assert.deepEqual(secondPass.state, repaired.state);
});

test("evidence repair keeps explicit pair quantities wrong", () => {
  const repaired = repairLearningEvidence({ words: [], sentences: [] }, {
    aiPractice: { history: [{
      id: "boot-set:q1",
      direction: "en-zh",
      prompt: "It is a boot.",
      userAnswer: "它是一双靴子",
      correctAnswer: "它是一只靴子。",
      correct: true,
      score: 1,
      gradingStatus: "correct",
      problemWords: []
    }] }
  });
  const item = repaired.state.aiPractice.history[0];
  assert.equal(item.correct, false);
  assert.equal(item.score, 0);
  assert.equal(item.gradingStatus, "incorrect");
  assert.match(item.detailedExplanation, /一双|数量/);
});

test("evidence repair clears a false pen error using the formal word-bank meanings", () => {
  const content = {
    currentDay: 4,
    words: [
      { id: "a", day: 1, english: "a", chinese: "一个", acceptedChinese: ["一个", "一"] },
      { id: "big", day: 2, english: "big", chinese: "大的", acceptedChinese: ["大的", "大"] },
      { id: "pen", day: 3, english: "pen", chinese: "笔", acceptedChinese: ["笔", "钢笔"] },
      { id: "is", day: 2, english: "is", chinese: "是", acceptedChinese: ["是"] },
      { id: "on", day: 1, english: "on", chinese: "在……上面", acceptedChinese: ["在上面", "在上"] },
      { id: "box", day: 4, english: "box", chinese: "箱子", acceptedChinese: ["箱子", "盒子"] }
    ],
    sentences: [{ id: "pen-base", day: 4, english: "A pen is on a box.", chinese: "一支笔在一个箱子上。", directions: ["en-zh"] }]
  };
  const variant = {
    id: "ai-big-pen-box",
    family: "on",
    english: "A big pen is on a box.",
    chinese: "一支大钢笔在一个箱子上。",
    acceptedEnglish: ["a big pen is on a box"],
    acceptedChinese: ["一支大钢笔在一个箱子上。"]
  };
  const state = {
    evidenceRepairVersion: 4,
    taskStates: { "pen-base:en-zh": { level: 0, lastResult: false, reviewCount: 1, lastReviewed: "2026-08-07" } },
    history: { "2026-08-07": { reviewed: 1, correct: 0 } },
    attempts: [{
      id: "pen-attempt",
      taskId: "pen-base:en-zh",
      variantId: variant.id,
      reviewVariant: variant,
      date: "2026-08-07",
      answer: "一支大笔在一个箱子上",
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      problemWords: ["pen"]
    }],
    mistakes: [{ id: "pen-mistake", attemptId: "pen-attempt", taskId: "pen-base:en-zh", variantId: variant.id, reviewVariant: variant, userAnswer: "一支大笔在一个箱子上" }]
  };

  const repaired = repairLearningEvidence(content, state);
  const attempt = repaired.state.attempts[0];
  assert.equal(attempt.correct, true);
  assert.equal(attempt.score, 1);
  assert.equal(attempt.gradingStatus, "correct");
  assert.deepEqual(attempt.problemWords, []);
  assert.equal(attempt.gradingSource, "evidence-repair-v7");
  assert.ok(attempt.reviewVariant.acceptedChinese.includes("一支大笔在一个箱子上。"));
  assert.match(attempt.detailedExplanation, /正式词库|笔|钢笔/);
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(repaired.state.history["2026-08-07"].correct, 1);
  assert.equal(repaired.state.taskStates["pen-base:en-zh"].lastResult, true);

  const abilities = analyzeAbilities(content, repaired.state).abilities;
  assert.equal(abilities.find(item => item.id === "reading").measuredAccuracy, 100);
  assert.notEqual(abilities.find(item => item.id === "vocabulary").measuredAccuracy, 0, "the repaired pen answer must not remain as a vocabulary penalty");
});

test("evidence repair restores natural person classifiers and recalculates AI scores without hiding real errors", () => {
  const content = {
    currentDay: 8,
    words: [
      { id: "mom", day: 4, learned: "2026-08-03", english: "mom", chinese: "妈妈" },
      { id: "cook", day: 8, learned: "2026-08-07", english: "cook", chinese: "厨师" },
      { id: "man", day: 1, learned: "2026-07-31", english: "man", chinese: "男人" },
      { id: "run", day: 8, learned: "2026-08-07", english: "run", chinese: "跑" }
    ],
    sentences: []
  };
  const personWordResults = english => english.split(" ").map(word => ({ english: word.toLocaleLowerCase().replace(/[^a-z]/g, ""), correct: true, issue: "" })).filter(item => item.english);
  const history = [
    {
      id: "identity-set:mom",
      setId: "identity-set",
      questionCount: 4,
      direction: "en-zh",
      prompt: "She is a mom.",
      userAnswer: "她是一个妈妈",
      correctAnswer: "她是一位妈妈。",
      correct: true,
      score: 0.8,
      gradingStatus: "partial",
      explanation: "英语意思理解正确；中文量词不够自然，本题按部分正确记录。",
      detailedExplanation: "量词“个”与参考答案“位”不同，建议使用“位”。",
      problemWords: [],
      wordResults: personWordResults("She is a mom"),
      answeredAt: "2026-08-08T07:14:41.505Z"
    },
    {
      id: "identity-set:cook",
      setId: "identity-set",
      questionCount: 4,
      direction: "en-zh",
      prompt: "She is a cook.",
      userAnswer: "她是一位厨师",
      correctAnswer: "她是一个厨师。",
      correct: true,
      score: 0.8,
      gradingStatus: "partial",
      explanation: "英语意思理解正确；中文量词不够自然，本题按部分正确记录。",
      detailedExplanation: "量词“位”与参考答案“个”不同，建议使用“个”。",
      problemWords: [],
      wordResults: personWordResults("She is a cook"),
      answeredAt: "2026-08-08T07:14:59.078Z"
    },
    {
      id: "identity-set:missing",
      setId: "identity-set",
      questionCount: 4,
      direction: "zh-en",
      prompt: "我是一个男人。",
      userAnswer: "I am",
      correctAnswer: "I am a man.",
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      explanation: "漏写 a man。",
      problemWords: ["a", "man"],
      answeredAt: "2026-08-08T07:15:10.000Z"
    },
    {
      id: "identity-set:meaning",
      setId: "identity-set",
      questionCount: 4,
      direction: "en-zh",
      prompt: "We run.",
      userAnswer: "我们看",
      correctAnswer: "我们跑。",
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      explanation: "把 run 误译为看。",
      problemWords: ["run"],
      answeredAt: "2026-08-08T07:15:20.000Z"
    }
  ];
  const state = {
    evidenceRepairVersion: 5,
    aiPractice: {
      currentSet: {
        id: "identity-set",
        questions: history.map((item, index) => ({
          id: item.id.split(":")[1],
          direction: item.direction,
          english: item.direction === "en-zh" ? item.prompt : item.correctAnswer,
          chinese: item.direction === "en-zh" ? item.correctAnswer : item.prompt,
          acceptedEnglish: item.direction === "zh-en" ? [item.correctAnswer] : [item.prompt],
          acceptedChinese: item.direction === "en-zh" ? [item.correctAnswer] : [item.prompt],
          correct: item.correct,
          score: item.score,
          gradingStatus: item.gradingStatus,
          explanation: item.explanation,
          problemWords: item.problemWords,
          index
        }))
      },
      history
    }
  };

  const before = analyzeAbilities(content, state);
  const repaired = repairLearningEvidence(content, state);
  const repairedHistory = repaired.state.aiPractice.history;
  const mom = repairedHistory.find(item => item.id.endsWith(":mom"));
  const cook = repairedHistory.find(item => item.id.endsWith(":cook"));
  assert.equal(repaired.changed, true);
  assert.equal(repaired.state.evidenceRepairVersion, 7);
  [mom, cook].forEach(item => {
    assert.equal(item.correct, true);
    assert.equal(item.score, 1);
    assert.equal(item.gradingStatus, "correct");
    assert.deepEqual(item.problemWords, []);
    assert.match(item.explanation, /一个.*一位|一位.*一个/);
    assert.doesNotMatch(`${item.explanation}${item.detailedExplanation}`, /不够自然|建议使用/);
  });
  assert.deepEqual(repaired.state.aiPractice.currentSet.questions.slice(0, 2).map(item => item.score), [1, 1]);
  assert.deepEqual(repairedHistory.filter(item => item.correct === false).map(item => item.id), ["identity-set:missing", "identity-set:meaning"]);

  const after = analyzeAbilities(content, repaired.state);
  assert.ok(after.abilities.find(item => item.id === "reading").measuredAccuracy > before.abilities.find(item => item.id === "reading").measuredAccuracy);
  const profile = buildLearningSyncProfile(content, repaired.state, { username: "test", role: "user" });
  assert.equal(profile.summary.aiCorrect, 2);
  assert.equal(profile.summary.aiAccuracy, 50);
  assert.equal(profile.activity.aiSets[0].accuracy, 50);
  assert.deepEqual(profile.weakPoints.recentAiMistakes.map(item => item.id), ["identity-set:meaning", "identity-set:missing"]);
  assert.equal(profile.weakPoints.aiWordSignals.some(item => ["mom", "cook"].includes(item.english)), false);

  const secondPass = repairLearningEvidence(content, repaired.state);
  assert.equal(secondPass.changed, false);
  assert.deepEqual(secondPass.state, repaired.state);
});

test("deep evidence repair clears only false 很深 penalties across review, AI, exam, and abilities", () => {
  const content = {
    currentDay: 9,
    words: [
      { id: "we", day: 4, learned: "2026-08-03", english: "we", chinese: "我们" },
      { id: "see", day: 9, learned: "2026-08-08", english: "see", chinese: "看见" },
      { id: "a", day: 1, learned: "2026-07-31", english: "a", chinese: "一个" },
      { id: "deep", day: 9, learned: "2026-08-08", english: "deep", chinese: "深的" },
      { id: "pool", day: 8, learned: "2026-08-07", english: "pool", chinese: "水池；游泳池", acceptedChinese: ["水池", "游泳池", "泳池"] }
    ],
    sentences: [{
      id: "deep-base",
      day: 9,
      learned: "2026-08-08",
      english: "We see a deep pool.",
      chinese: "我们看见一个深的水池。",
      acceptedChinese: ["我们看见一个深的水池。"],
      directions: ["en-zh"]
    }]
  };
  const deepHistory = {
    id: "deep-set:q-deep",
    setId: "deep-set",
    questionCount: 2,
    direction: "en-zh",
    prompt: "We see a deep pool.",
    userAnswer: "我们看见一个很深的游泳池",
    correctAnswer: "我们看见一个深的水池。",
    correct: false,
    score: 0,
    gradingStatus: "incorrect",
    explanation: "多写了很。",
    detailedExplanation: "删除很。",
    problemWords: ["deep"],
    answeredAt: "2026-08-08T02:00:00.000Z"
  };
  const degreeHistory = {
    id: "deep-set:q-degree",
    setId: "deep-set",
    questionCount: 2,
    direction: "en-zh",
    prompt: "We see a very deep pool.",
    userAnswer: "我们看见一个很深的游泳池",
    correctAnswer: "我们看见一个非常深的游泳池。",
    correct: false,
    score: 0,
    gradingStatus: "incorrect",
    explanation: "漏掉了程度信息。",
    problemWords: ["very"],
    answeredAt: "2026-08-08T02:01:00.000Z"
  };
  const exam = {
    id: "deep-exam",
    status: "completed",
    questions: [{
      id: "deep-exam-q",
      type: "translation",
      typeLabel: "翻译题",
      sourceText: "A pool is deep.",
      direction: "en-zh",
      points: 10,
      answerKey: { kind: "text", language: "zh", acceptedAnswers: ["一个水池是深的。"] }
    }],
    answers: { "deep-exam-q": "游泳池很深" },
    result: {
      score: 8,
      possible: 10,
      grades: [{ questionId: "deep-exam-q", score: 8, correct: true, explanation: "多写了很。", detailedExplanation: "建议删除很。", correctAnswer: "一个水池是深的。" }],
      typeScores: [{ type: "translation", label: "翻译题", score: 8, possible: 10 }],
      weakPoints: [{ category: "translation", severity: "low", detail: "不要写很。", recommendation: "删除很。", questionIds: ["deep-exam-q"], relatedWords: ["deep"] }]
    }
  };
  const state = {
    evidenceRepairVersion: 6,
    taskStates: { "deep-base:en-zh": { level: 0, lastResult: false, reviewCount: 1, lastReviewed: "2026-08-08" } },
    history: { "2026-08-08": { reviewed: 1, correct: 0 } },
    attempts: [{ id: "deep-review", taskId: "deep-base:en-zh", date: "2026-08-08", answer: "我们看见一个很深的游泳池", correct: false, score: 0, gradingStatus: "incorrect", explanation: "多写了很。", problemWords: ["deep"] }],
    mistakes: [{ id: "deep-mistake", attemptId: "deep-review", taskId: "deep-base:en-zh", userAnswer: "我们看见一个很深的游泳池" }],
    aiPractice: {
      currentSet: {
        id: "deep-set",
        questions: [
          { id: "q-deep", direction: "en-zh", english: deepHistory.prompt, chinese: deepHistory.correctAnswer, acceptedChinese: [deepHistory.correctAnswer], userAnswer: deepHistory.userAnswer, correct: false, score: 0, gradingStatus: "incorrect", explanation: deepHistory.explanation, problemWords: ["deep"] },
          { id: "q-degree", direction: "en-zh", english: degreeHistory.prompt, chinese: degreeHistory.correctAnswer, acceptedChinese: [degreeHistory.correctAnswer], userAnswer: degreeHistory.userAnswer, correct: false, score: 0, gradingStatus: "incorrect", explanation: degreeHistory.explanation, problemWords: ["very"] }
        ]
      },
      queuedSets: [{ id: "queued-deep", questions: [{ id: "queued-q", direction: "en-zh", english: "A pool is deep.", chinese: "一个水池是深的。", acceptedChinese: ["一个水池是深的。"] }] }],
      history: [deepHistory, degreeHistory]
    },
    aiExam: {
      currentExam: exam,
      history: [JSON.parse(JSON.stringify(exam))],
      weakPoints: [{ id: "deep-weak", examId: "deep-exam", category: "translation", detail: "不要写很。", questionIds: ["deep-exam-q"], relatedWords: ["deep"] }]
    }
  };

  const before = analyzeAbilities(content, state);
  const repaired = repairLearningEvidence(content, state);
  assert.equal(repaired.changed, true);
  assert.equal(repaired.state.evidenceRepairVersion, 7);
  assert.equal(repaired.state.attempts[0].correct, true);
  assert.equal(repaired.state.attempts[0].score, 1);
  assert.equal(repaired.state.mistakes.length, 0);
  assert.equal(repaired.state.history["2026-08-08"].correct, 1);
  const repairedDeep = repaired.state.aiPractice.history.find(item => item.id.endsWith("q-deep"));
  const retainedDegree = repaired.state.aiPractice.history.find(item => item.id.endsWith("q-degree"));
  assert.equal(repairedDeep.correct, true);
  assert.equal(repairedDeep.score, 1);
  assert.deepEqual(repairedDeep.problemWords, []);
  assert.match(repairedDeep.explanation, /自然表达|没有改变/);
  assert.equal(retainedDegree.correct, false);
  assert.equal(retainedDegree.score, 0);
  assert.ok(repaired.state.aiPractice.currentSet.questions[0].acceptedChinese.includes("我们看见一个很深的游泳池。"));
  assert.equal(repaired.state.aiPractice.currentSet.questions[0].correct, true);
  assert.equal(repaired.state.aiPractice.currentSet.questions[1].correct, false);
  assert.equal(repaired.state.aiPractice.queuedSets[0].questions[0].chinese, "一个水池很深。");
  const repairedExam = repaired.state.aiExam.currentExam;
  assert.equal(repairedExam.result.score, 10);
  assert.equal(repairedExam.result.grades[0].score, 10);
  assert.equal(repairedExam.result.grades[0].correct, true);
  assert.equal(repairedExam.result.typeScores[0].score, 10);
  assert.deepEqual(repairedExam.result.weakPoints, []);
  assert.deepEqual(repaired.state.aiExam.weakPoints, []);
  assert.ok(repairedExam.questions[0].answerKey.acceptedAnswers.includes("一个游泳池很深。"));

  const after = analyzeAbilities(content, repaired.state);
  assert.ok(after.abilities.find(item => item.id === "translation").measuredAccuracy > before.abilities.find(item => item.id === "translation").measuredAccuracy);
  const profile = buildLearningSyncProfile(content, repaired.state, { username: "test", role: "user" });
  assert.equal(profile.weakPoints.recentAiMistakes.some(item => item.id.endsWith("q-deep")), false);
  assert.equal(profile.weakPoints.recentAiMistakes.some(item => item.id.endsWith("q-degree")), true);

  const secondPass = repairLearningEvidence(content, repaired.state);
  assert.deepEqual(secondPass.state, repaired.state);
  assert.equal(secondPass.changed, false);
});
