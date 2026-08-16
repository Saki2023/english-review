"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  applyReviewBatchToSession,
  classifyRepeatedReviewBatch,
  mergeReviewSession,
  retireReviewSession,
  reviewSentenceVariantKey,
  reviewSentenceVariantState,
  selectGuidedTaskIds
} = require("../review-session");

test("guided review consumes stable daily candidates without repeating completed groups", () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    taskId: `task-${index + 1}`,
    type: index % 2 === 0 ? "word" : "sentence"
  }));
  const first = selectGuidedTaskIds(candidates, [], 10);
  const afterFirst = mergeReviewSession(
    { updatedAt: "2026-08-15T08:00:00.000Z", doneTaskIds: first },
    { updatedAt: "2026-08-15T07:59:00.000Z", doneTaskIds: [] }
  );
  const second = selectGuidedTaskIds(candidates, afterFirst.doneTaskIds, 10);
  const afterSecond = mergeReviewSession(afterFirst, { updatedAt: "2026-08-15T09:00:00.000Z", doneTaskIds: second });
  const third = selectGuidedTaskIds(candidates, afterSecond.doneTaskIds, 10);

  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.deepEqual(first.filter(taskId => second.includes(taskId)), []);
  assert.equal(afterSecond.doneTaskIds.length, 20);
  assert.deepEqual(third, []);
});

test("word-first review groups still prepare and expose retry for later missing sentence snapshots", () => {
  const tasks = new Map([
    ["word-1", { taskId: "word-1", item: { type: "word" } }],
    ["sentence-1", { taskId: "sentence-1", item: { type: "sentence" } }],
    ["sentence-2", { taskId: "sentence-2", item: { type: "sentence" } }]
  ]);
  const session = {
    taskIds: ["word-1", "sentence-1", "sentence-2"],
    index: 0,
    variants: { "sentence-2": { id: "saved-variant" } }
  };
  const online = reviewSentenceVariantState(session, tasks, {
    apiEnabled: true,
    offlineSession: false,
    aiOptionsLoaded: false,
    aiConfigured: false
  });
  assert.deepEqual(online.missingTaskIds, ["sentence-1"]);
  assert.equal(online.shouldRequest, true, "persisted-pool lookup must not depend on AI option loading");
  assert.equal(online.retryVisible, true, "a later missing sentence must expose retry while the word is current");

  const offline = reviewSentenceVariantState(session, tasks, { apiEnabled: true, offlineSession: true });
  assert.equal(offline.shouldRequest, false);
  assert.equal(offline.retryVisible, false);
});

test("sentence variant responses follow a replaced session object only for the same batch snapshot", () => {
  const original = {
    date: "2026-08-16",
    mode: "all",
    batchId: "batch-current",
    taskIds: ["word-1", "sentence-1"]
  };
  assert.equal(reviewSentenceVariantKey({ ...original, variants: { "sentence-1": { id: "remote-copy" } } }), reviewSentenceVariantKey(original));
  assert.notEqual(reviewSentenceVariantKey({ ...original, batchId: "batch-replacement" }), reviewSentenceVariantKey(original));
  assert.notEqual(reviewSentenceVariantKey({ ...original, taskIds: ["word-1", "sentence-2"] }), reviewSentenceVariantKey(original));
});

test("review session merge cannot lose completed IDs to a newer stale client snapshot", () => {
  const merged = mergeReviewSession(
    { updatedAt: "2026-08-15T08:00:00.000Z", doneTaskIds: ["task-1", "task-2"], taskIds: ["task-1", "task-2"] },
    { updatedAt: "2026-08-15T09:00:00.000Z", doneTaskIds: [], taskIds: [] }
  );
  assert.deepEqual(merged.doneTaskIds, ["task-1", "task-2"]);
  assert.deepEqual(merged.taskIds, []);
});

test("completed projection and archive retirement create a disjoint next group", () => {
  const firstTaskIds = Array.from({ length: 10 }, (_, index) => `task-${index + 1}`);
  const allCandidates = Array.from({ length: 23 }, (_, index) => ({
    taskId: `task-${index + 1}`,
    type: index % 2 === 0 ? "word" : "sentence"
  }));
  const completed = applyReviewBatchToSession({ date: "2026-08-15", doneTaskIds: firstTaskIds }, {
    id: "first-batch",
    date: "2026-08-15",
    mode: "all",
    phase: "completed",
    index: 9,
    questions: firstTaskIds.map(taskId => ({ taskId }))
  });
  assert.equal(completed.index, 10, "a completed batch cursor must sit after the final question");
  assert.equal(completed.currentTaskId, null);
  assert.equal(completed.batchComplete, true);

  const retired = retireReviewSession(completed, "first-batch", firstTaskIds, "2026-08-15T10:00:00.000Z");
  const secondTaskIds = selectGuidedTaskIds(allCandidates, retired.doneTaskIds, 10);
  const finalTaskIds = selectGuidedTaskIds(allCandidates, [...retired.doneTaskIds, ...secondTaskIds], 10);
  assert.equal(retired.batchId, "");
  assert.deepEqual(retired.retiredBatchIds, ["first-batch"]);
  assert.equal(secondTaskIds.length, 10);
  assert.deepEqual(secondTaskIds.filter(taskId => firstTaskIds.includes(taskId)), []);
  assert.equal(finalTaskIds.length, 3, "a short final group must not be padded with completed tasks");
  assert.deepEqual(selectGuidedTaskIds(allCandidates, allCandidates.map(item => item.taskId), 10), []);
});

test("a retired batch tombstone defeats delayed PUTs but preserves a newer active batch", () => {
  const retired = retireReviewSession({
    date: "2026-08-15",
    batchId: "old-batch",
    taskIds: ["task-1", "task-2"],
    doneTaskIds: ["task-1", "task-2"],
    updatedAt: "2026-08-15T10:00:00.000Z"
  }, "old-batch", [], "2026-08-15T10:01:00.000Z");
  const staleFuturePut = {
    date: "2026-08-15",
    batchId: "old-batch",
    taskIds: ["task-1", "task-2"],
    index: 0,
    doneTaskIds: [],
    updatedAt: "2099-01-01T00:00:00.000Z"
  };
  const stayedRetired = mergeReviewSession(retired, staleFuturePut);
  assert.equal(stayedRetired.batchId, "");
  assert.deepEqual(stayedRetired.taskIds, []);
  assert.deepEqual(stayedRetired.doneTaskIds, ["task-1", "task-2"]);

  const newerActive = {
    ...retired,
    batchId: "new-batch",
    taskIds: ["task-3"],
    index: 0,
    currentTaskId: "task-3",
    batchComplete: false,
    updatedAt: "2026-08-15T10:02:00.000Z"
  };
  const activeWins = mergeReviewSession(staleFuturePut, newerActive);
  assert.equal(activeWins.batchId, "new-batch");
  assert.deepEqual(activeWins.taskIds, ["task-3"]);
});

test("legacy repeated batches distinguish empty recovery, protected drafts, and explicit repeats", () => {
  const base = {
    id: "legacy-batch",
    phase: "answering",
    questions: [
      { taskId: "task-1", answer: "" },
      { taskId: "task-2", answer: "" }
    ]
  };
  assert.equal(classifyRepeatedReviewBatch(base, ["task-1", "task-2"]).kind, "empty");
  assert.deepEqual(classifyRepeatedReviewBatch({ ...base, questions: [{ taskId: "task-1", answer: "draft" }, { taskId: "task-2", answer: "" }] }, ["task-1", "task-2"]), {
    kind: "draft",
    taskIds: ["task-1", "task-2"],
    answeredCount: 1,
    questionCount: 2
  });
  assert.equal(classifyRepeatedReviewBatch({ ...base, allowRepeat: true }, ["task-1", "task-2"]), null);
  assert.equal(classifyRepeatedReviewBatch(base, ["task-1"]), null);
});
