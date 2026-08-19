"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  activityEvents,
  appendEvents,
  applyRecall,
  migrateWordUsage,
  publicWordUsage,
  rankedWordIds,
  sanitizeWordUsage,
  studyDate,
  usageRows
} = require("../server/word-memory");

const content = {
  words: [
    { id: "cat", day: 1, learned: "2026-08-01", english: "cat", chinese: "猫", phonetic: "/k\u00e6t/", directions: ["en-zh", "zh-en"] },
    { id: "dog", day: 2, learned: "2026-08-02", english: "dog", chinese: "狗", phonetic: "/d\u0252g/", directions: ["en-zh", "zh-en"] },
    { id: "pool", day: 8, learned: "2026-08-08", english: "pool", chinese: "水池", phonetic: "/pu\u02d0l/", directions: ["en-zh", "zh-en"] },
    { id: "hen", day: 10, learned: "", status: "planned", english: "hen", chinese: "母鸡", phonetic: "/hen/", directions: ["en-zh", "zh-en"] }
  ],
  sentences: []
};

test("usage events deduplicate the same word inside one activity and stay idempotent", () => {
  const events = activityEvents({
    eventId: "review-batch:question-1",
    source: "review",
    taskId: "sentence-1:en-zh",
    english: "A cat sees a cat in a pool.",
    kind: "exposure",
    result: "completed",
    formalEvidence: true,
    date: "2026-08-19",
    occurredAt: "2026-08-19T01:00:00.000Z"
  }, content);
  assert.deepEqual(events.map(event => event.wordId), ["cat", "pool"]);
  const first = appendEvents(null, events, content);
  const second = appendEvents(first.state, events, content);
  assert.equal(first.added.length, 2);
  assert.equal(second.added.length, 0);
  assert.equal(second.state.events.length, 2);
  assert.deepEqual(second.state.memories, {}, "sentence exposure must not advance word recall memory");
});

test("SM-2 mapping keeps wrong, assisted, and independent recall distinct", () => {
  const base = { wordId: "cat", repetitions: 2, intervalDays: 3, easiness: 2.5, nextDue: "2026-08-19" };
  const wrong = applyRecall(base, {
    eventId: "wrong:cat", wordId: "cat", source: "review", taskId: "cat:en-zh", kind: "recall", result: "wrong",
    formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T01:00:00.000Z"
  });
  assert.equal(wrong.repetitions, 0);
  assert.equal(wrong.intervalDays, 1);
  assert.equal(wrong.nextDue, "2026-08-20");
  assert.equal(wrong.lapses, 1);

  const assisted = applyRecall(base, {
    eventId: "assisted:cat", wordId: "cat", source: "review", taskId: "cat:en-zh", kind: "recall", result: "assisted",
    formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T01:01:00.000Z"
  });
  assert.equal(assisted.repetitions, 2);
  assert.equal(assisted.intervalDays, 1);
  assert.equal(assisted.nextDue, "2026-08-20");
  assert.equal(assisted.assistedCount, 1);

  const correct = applyRecall(base, {
    eventId: "correct:cat", wordId: "cat", source: "review", taskId: "cat:en-zh", kind: "recall", result: "independent-correct",
    formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T01:02:00.000Z"
  });
  assert.equal(correct.repetitions, 3);
  assert.equal(correct.intervalDays, 8);
  assert.equal(correct.nextDue, "2026-08-27");
});

test("planned words can record non-formal exposure but never gain recall memory", () => {
  const exposure = activityEvents({
    eventId: "preview-hen-1",
    source: "preview",
    taskId: "preview-hen",
    wordIds: ["hen"],
    kind: "exposure",
    result: "completed",
    formalEvidence: false,
    date: "2026-08-19"
  }, content);
  const forbiddenRecall = activityEvents({
    eventId: "preview-hen-recall",
    source: "preview",
    wordIds: ["hen"],
    kind: "recall",
    result: "independent-correct",
    formalEvidence: true,
    date: "2026-08-19"
  }, content);
  assert.equal(exposure.length, 1);
  assert.equal(forbiddenRecall.length, 0);
  assert.deepEqual(appendEvents(null, exposure, content).state.memories, {});
});

test("legacy migration is idempotent and preserves old word SRS without touching other state", () => {
  const account = {
    attempts: [
      { id: "attempt-word", taskId: "cat:en-zh", date: "2026-08-18", submittedAt: "2026-08-18T03:00:00.000Z", correct: true, score: 1, gradingStatus: "correct", formalEvidence: true },
      { id: "attempt-sentence", taskId: "sentence:en-zh", date: "2026-08-18", submittedAt: "2026-08-18T03:01:00.000Z", english: "A dog sees a cat.", correct: false, score: 0, gradingStatus: "incorrect", formalEvidence: true }
    ],
    taskStates: {
      "cat:en-zh": { level: 4, reviewCount: 7, lastResult: true, lastReviewed: "2026-08-18", nextDue: "2026-09-01" },
      "cat:zh-en": { level: 3, reviewCount: 5, lastResult: true, lastReviewed: "2026-08-17", nextDue: "2026-08-25" }
    },
    mistakes: [{ id: "keep-me" }],
    aiPractice: { generationQueue: [{ requestId: "keep-queue" }] }
  };
  const before = JSON.stringify(account);
  const first = migrateWordUsage(null, account, content, { date: "2026-08-19" });
  const second = migrateWordUsage(first.state, account, content, { date: "2026-08-19" });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
  assert.equal(first.state.memories.cat.repetitions, 4);
  assert.equal(first.state.memories.cat.nextDue, "2026-09-01");
  assert.equal(first.state.events.length, 3, "one direct recall plus two sentence word exposures are migrated");
  assert.equal(JSON.stringify(account), before, "migration must not mutate existing account evidence");
});

test("aggregates support inclusive dates and stable sorting without leaking answers", () => {
  const events = [
    ...activityEvents({ eventId: "cat-1", source: "review", taskId: "cat:en-zh", wordIds: ["cat"], kind: "recall", result: "wrong", formalEvidence: true, date: "2026-08-18", occurredAt: "2026-08-18T01:00:00Z" }, content),
    ...activityEvents({ eventId: "cat-2", source: "review", taskId: "cat:zh-en", wordIds: ["cat"], kind: "recall", result: "independent-correct", formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T01:00:00Z" }, content),
    ...activityEvents({ eventId: "dog-1", source: "exam", taskId: "exam-1", english: "dog", kind: "exposure", result: "completed", formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T02:00:00Z" }, content)
  ];
  const state = appendEvents(null, events, content).state;
  const aggregate = usageRows(state, content, { date: "2026-08-19", from: "2026-08-19", to: "2026-08-19", sort: "usage", order: "desc" });
  const cat = aggregate.rows.find(row => row.id === "cat");
  assert.equal(cat.totalUsage, 2);
  assert.equal(cat.periodUsage, 1);
  assert.equal(cat.todayUsage, 1);
  assert.equal(cat.independentCorrect, 1);
  assert.equal(cat.wrong, 0);
  assert.equal(JSON.stringify(aggregate).includes("answer"), false);
  assert.deepEqual(aggregate.rows.slice(0, 2).map(row => row.id), ["cat", "dog"]);
});

test("coverage ranking applies due, weak, unused-today, three-day and seven-day priorities", () => {
  let state = sanitizeWordUsage({ memories: {
    cat: { wordId: "cat", repetitions: 5, intervalDays: 30, nextDue: "2026-09-01", lastResult: "independent-correct" },
    dog: { wordId: "dog", repetitions: 1, intervalDays: 1, nextDue: "2026-08-19", lastResult: "wrong", lapses: 2 },
    pool: { wordId: "pool", repetitions: 4, intervalDays: 14, nextDue: "2026-08-30", lastResult: "independent-correct" }
  } });
  state = appendEvents(state, [
    ...activityEvents({ eventId: "cat-old", source: "review", wordIds: ["cat"], kind: "recall", result: "independent-correct", formalEvidence: true, date: "2026-08-11", occurredAt: "2026-08-11T01:00:00Z" }, content),
    ...activityEvents({ eventId: "dog-yesterday", source: "review", wordIds: ["dog"], kind: "recall", result: "wrong", formalEvidence: true, date: "2026-08-18", occurredAt: "2026-08-18T01:00:00Z" }, content),
    ...activityEvents({ eventId: "pool-today", source: "reading", english: "pool", kind: "exposure", result: "completed", formalEvidence: true, date: "2026-08-19", occurredAt: "2026-08-19T01:00:00Z" }, content)
  ], content, { applyMemory: false }).state;
  const rows = usageRows(state, content, { date: "2026-08-19", capacity: 1 }).rows;
  assert.equal(rows.find(row => row.id === "cat").coverageStatus, "overdue-coverage");
  assert.equal(rows.find(row => row.id === "pool").coverageStatus, "covered-today");
  assert.deepEqual(rankedWordIds(state, content, { date: "2026-08-19", limit: 3 }), ["dog", "cat", "pool"]);
});

test("Beijing date conversion uses Asia/Shanghai midnight", () => {
  assert.equal(studyDate("2026-08-18T15:59:59.000Z"), "2026-08-18");
  assert.equal(studyDate("2026-08-18T16:00:00.000Z"), "2026-08-19");
});

test("public usage projection exposes safe rows for library statistics", () => {
  const state = appendEvents(null, activityEvents({
    eventId: "public-cat-1",
    source: "review",
    taskId: "cat:en-zh",
    wordIds: ["cat"],
    kind: "recall",
    result: "independent-correct",
    formalEvidence: true,
    date: "2026-08-19",
    occurredAt: "2026-08-19T02:00:00.000Z"
  }, content), content).state;
  const projected = publicWordUsage(state, content, { date: "2026-08-19", from: "2026-08-19", to: "2026-08-19" });
  const cat = projected.rows.find(row => row.id === "cat");
  assert.equal(cat.periodUsage, 1);
  assert.equal(cat.independentCorrect, 1);
  assert.equal(cat.accuracy, 100);
  assert.equal(Object.hasOwn(cat, "answer"), false);
  assert.equal(Object.hasOwn(projected, "events"), false);
  assert.equal(JSON.stringify(projected).includes("acceptedChinese"), false);
});
