"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mergeReviewSession, selectGuidedTaskIds } = require("../review-session");

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

test("review session merge cannot lose completed IDs to a newer stale client snapshot", () => {
  const merged = mergeReviewSession(
    { updatedAt: "2026-08-15T08:00:00.000Z", doneTaskIds: ["task-1", "task-2"], taskIds: ["task-1", "task-2"] },
    { updatedAt: "2026-08-15T09:00:00.000Z", doneTaskIds: [], taskIds: [] }
  );
  assert.deepEqual(merged.doneTaskIds, ["task-1", "task-2"]);
  assert.deepEqual(merged.taskIds, []);
});
