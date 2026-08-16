"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { clientStateProjection, createStateSaveQueue } = require("../state-sync-client");

function model(value = 0) {
  return {
    taskStates: { task: { level: value } },
    history: { "2026-08-16": { reviewed: value, correct: value } },
    attempts: [],
    sessions: {},
    mistakes: [],
    studyTime: { daily: { "2026-08-16": value }, updatedAt: String(value) },
    previewPractice: {},
    previewPracticeHistory: [],
    aiPractice: { history: [{ secret: "large protected history" }] },
    formalPractice: { review: { current: { answer: "protected" } } },
    aiExam: { answerKey: "protected" }
  };
}

function okResponse() {
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}

function wait(milliseconds = 20) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

test("client state projection excludes server-owned and answer-bearing practice data", () => {
  const projected = clientStateProjection(model(3));
  assert.deepEqual(Object.keys(projected), [
    "schema",
    "taskStates",
    "history",
    "attempts",
    "sessions",
    "mistakes",
    "studyTime",
    "previewPractice",
    "previewPracticeHistory"
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /large protected history|answerKey|formalPractice|aiPractice/);
});

test("rapid state saves coalesce to the latest snapshot", async () => {
  const calls = [];
  const queue = createStateSaveQueue({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return okResponse();
    },
    debounceMs: 5
  });
  queue.setAccountId("account-a");
  queue.scheduleState(model(1));
  queue.scheduleState(model(2));
  queue.scheduleState(model(3));
  await wait(30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/state");
  assert.equal(calls[0].body.taskStates.task.level, 3);
});

test("an in-flight save never overlaps and is followed only by the newest queued snapshot", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const queue = createStateSaveQueue({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.taskStates.task.level);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
      active -= 1;
      return okResponse();
    },
    debounceMs: 5
  });
  queue.setAccountId("account-a");
  const first = queue.scheduleState(model(1), { immediate: true });
  while (!releaseFirst) await wait(1);
  queue.scheduleState(model(2));
  queue.scheduleState(model(3));
  releaseFirst();
  await first;
  await wait(30);
  assert.deepEqual(calls, [1, 3]);
  assert.equal(maximumActive, 1);
});

test("switching accounts drops a pending old-account snapshot", async () => {
  const calls = [];
  const queue = createStateSaveQueue({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).taskStates.task.level);
      return okResponse();
    },
    debounceMs: 20
  });
  queue.setAccountId("account-a");
  queue.scheduleState(model(1));
  queue.setAccountId("account-b");
  await queue.scheduleState(model(2), { immediate: true });
  await wait(35);
  assert.deepEqual(calls, [2]);
});

test("study time uses the lightweight endpoint and updates the full-state baseline", async () => {
  const calls = [];
  const queue = createStateSaveQueue({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return okResponse();
    },
    debounceMs: 5
  });
  queue.setAccountId("account-a");
  queue.markServerState(model(0));
  await queue.scheduleState(model(0));
  assert.equal(calls.length, 0, "the server baseline must not be uploaded again");
  queue.scheduleStudyTime(model(1).studyTime);
  queue.scheduleStudyTime(model(2).studyTime);
  await wait(30);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/state/study-time");
  assert.deepEqual(calls[0].body, { studyTime: model(2).studyTime });
  const stateWithSavedTime = model(0);
  stateWithSavedTime.studyTime = model(2).studyTime;
  await queue.scheduleState(stateWithSavedTime);
  assert.equal(calls.length, 1, "a successful lightweight save must advance the full-state baseline");
});

test("a failed save remains manually retriable without an automatic request loop", async () => {
  let calls = 0;
  const queue = createStateSaveQueue({
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}", { status: 503 });
    },
    debounceMs: 5
  });
  queue.setAccountId("account-a");
  await queue.scheduleState(model(1), { immediate: true });
  await wait(30);
  assert.equal(calls, 1);
  assert.equal(queue.status().retry, "state");
  await queue.scheduleState(model(1), { immediate: true });
  assert.equal(calls, 2);
});

test("an explicit flush drains the newest snapshot queued behind an in-flight save", async () => {
  const calls = [];
  let releaseFirst;
  const queue = createStateSaveQueue({
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).taskStates.task.level);
      if (calls.length === 1) await new Promise(resolve => { releaseFirst = resolve; });
      return okResponse();
    },
    debounceMs: 50
  });
  queue.setAccountId("account-a");
  const first = queue.scheduleState(model(1), { immediate: true });
  while (!releaseFirst) await wait(1);
  queue.scheduleState(model(2));
  const flushed = queue.flush();
  releaseFirst();
  await first;
  await flushed;
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(queue.status(), { accountId: "account-a", pending: "", retry: "", inFlight: "" });
});

test("a study-time update preserves a failed full-state snapshot", async () => {
  const calls = [];
  const queue = createStateSaveQueue({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return calls.length === 1 ? new Response("{}", { status: 503 }) : okResponse();
    },
    debounceMs: 5
  });
  queue.setAccountId("account-a");
  await queue.scheduleState(model(4), { immediate: true });
  await queue.scheduleStudyTime(model(5).studyTime, { immediate: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "/api/state");
  assert.equal(calls[1].body.taskStates.task.level, 4);
  assert.deepEqual(calls[1].body.studyTime, model(5).studyTime);
});
