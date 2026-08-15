"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveRepeatedReviewBatchWithRecovery, startReviewBatchWithRecovery } = require("../review-batch-client");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function hangingRequest() {
  return new Promise(() => {});
}

test("a lost start response is bounded and recovers the server batch once", async () => {
  const batch = { id: "stable-batch", phase: "answering", questions: [{ id: "q1", taskId: "d1-man:en-zh" }] };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === "POST") return hangingRequest();
    return jsonResponse(200, { batch });
  };
  const result = await startReviewBatchWithRecovery({ fetchImpl, body: { batchId: batch.id }, startTimeoutMs: 10, recoveryTimeoutMs: 10 });
  assert.equal(result.source, "recovery");
  assert.equal(result.data.batch.id, batch.id);
  assert.deepEqual(calls, [
    { url: "/api/review/batches/start", method: "POST" },
    { url: "/api/review/batches", method: "GET" }
  ]);
});

test("a response body lost after headers also recovers instead of starting a request loop", async () => {
  const batch = { id: "stable-after-headers", phase: "answering", questions: [{ id: "q1", taskId: "d1-man:en-zh" }] };
  let calls = 0;
  const result = await startReviewBatchWithRecovery({
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (options.method === "POST") return { ok: true, status: 201, text: async () => { throw new TypeError("socket closed"); } };
      return jsonResponse(200, { batch });
    },
    body: { batchId: batch.id },
    startTimeoutMs: 20,
    recoveryTimeoutMs: 20
  });
  assert.equal(result.source, "recovery");
  assert.equal(result.data.batch.id, batch.id);
  assert.equal(calls, 2);
});

test("a successful status without a batch is recovered once and never treated as ready", async () => {
  const batch = { id: "stable-missing-envelope", phase: "answering", questions: [{ id: "q1", taskId: "d1-man:en-zh" }] };
  let calls = 0;
  const result = await startReviewBatchWithRecovery({
    fetchImpl: async (_url, options) => {
      calls += 1;
      return options.method === "POST" ? jsonResponse(201, { ok: true }) : jsonResponse(200, { batch });
    },
    body: { batchId: batch.id },
    startTimeoutMs: 20,
    recoveryTimeoutMs: 20
  });
  assert.equal(result.source, "recovery");
  assert.equal(result.data.batch.id, batch.id);
  assert.equal(calls, 2);
});

test("a start request that never arrives leaves a bounded manual-retry failure", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    if (options.method === "POST") return hangingRequest();
    return jsonResponse(200, { batch: null });
  };
  await assert.rejects(
    startReviewBatchWithRecovery({ fetchImpl, body: { batchId: "stable-batch" }, startTimeoutMs: 10, recoveryTimeoutMs: 10 }),
    error => error.code === "review-batch-not-found-after-start" && error.recoverable === true && /手动重试/.test(error.message)
  );
  assert.equal(calls, 2, "one POST and one recovery GET are allowed; no automatic request loop");
});

test("a hanging recovery query also exits within a bounded time", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    startReviewBatchWithRecovery({ fetchImpl: hangingRequest, body: { batchId: "stable-batch" }, startTimeoutMs: 10, recoveryTimeoutMs: 10 }),
    error => error.code === "review-batch-recovery-timeout" && error.recoverable === true
  );
  assert.ok(Date.now() - startedAt < 500);
});

test("recovery does not mistake a different completed batch for the requested start", async () => {
  const fetchImpl = async (_url, options) => options.method === "POST"
    ? hangingRequest()
    : jsonResponse(200, { batch: { id: "older-completed", phase: "completed", questions: [] } });
  await assert.rejects(
    startReviewBatchWithRecovery({ fetchImpl, body: { batchId: "new-stable-batch" }, startTimeoutMs: 10, recoveryTimeoutMs: 10 }),
    error => error.code === "review-batch-not-found-after-start"
  );
});

test("a 409 unfinished batch is adopted without an extra recovery request", async () => {
  const calls = [];
  const batch = { id: "other-tab-batch", phase: "answering", questions: [{ id: "q1", taskId: "d1-man:en-zh" }] };
  const result = await startReviewBatchWithRecovery({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return jsonResponse(409, { error: "已有未完成的今日复习题组", batch });
    },
    body: { batchId: "this-tab-batch" },
    startTimeoutMs: 20,
    recoveryTimeoutMs: 20
  });
  assert.equal(result.source, "conflict");
  assert.equal(result.data.batch.id, batch.id);
  assert.equal(calls.length, 1);
});

test("two tabs with different local IDs converge on one immutable server batch", async () => {
  let current = null;
  const fetchImpl = async (_url, options) => {
    const requested = JSON.parse(options.body);
    await Promise.resolve();
    if (!current) {
      current = { id: requested.batchId, phase: "answering", questions: [{ id: "fixed-question", taskId: requested.taskIds[0] }] };
      return jsonResponse(201, { batch: current, reused: false });
    }
    return jsonResponse(409, { error: "已有未完成的今日复习题组", batch: current });
  };
  const [left, right] = await Promise.all([
    startReviewBatchWithRecovery({ fetchImpl, body: { batchId: "tab-a", taskIds: ["d1-man:en-zh"] }, startTimeoutMs: 50 }),
    startReviewBatchWithRecovery({ fetchImpl, body: { batchId: "tab-b", taskIds: ["d1-mat:en-zh"] }, startTimeoutMs: 50 })
  ]);
  assert.equal(left.data.batch.id, right.data.batch.id);
  assert.deepEqual(left.data.batch.questions, right.data.batch.questions);
});

test("a lost empty-repeat response is bounded and reconciles an already-retired batch once", async () => {
  const calls = [];
  const result = await resolveRepeatedReviewBatchWithRecovery({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "POST") return hangingRequest();
      return jsonResponse(200, {
        batch: null,
        state: { sessions: { "2026-08-16": { retiredBatchIds: ["legacy-empty"] } } }
      });
    },
    body: { batchId: "legacy-empty", action: "discard" },
    resolveTimeoutMs: 10,
    recoveryTimeoutMs: 10
  });
  assert.equal(result.source, "recovery");
  assert.deepEqual(calls, [
    { url: "/api/review/batches/resolve-repeat", method: "POST" },
    { url: "/api/review/batches", method: "GET" }
  ]);
});

test("an empty-repeat request that never arrives exits with the same batch and no retry loop", async () => {
  const batch = { id: "legacy-empty", phase: "answering", questions: [{ id: "q1", taskId: "d1-man:en-zh", answer: "" }] };
  let calls = 0;
  await assert.rejects(
    resolveRepeatedReviewBatchWithRecovery({
      fetchImpl: async (_url, options) => {
        calls += 1;
        return options.method === "POST" ? hangingRequest() : jsonResponse(200, { batch, state: { sessions: {} } });
      },
      body: { batchId: batch.id, action: "discard" },
      resolveTimeoutMs: 10,
      recoveryTimeoutMs: 10
    }),
    error => error.code === "review-repeat-still-current" && error.recoverable === true && error.data.batch.id === batch.id
  );
  assert.equal(calls, 2);
});

test("a 409 repeat classification mismatch is reconciled when another tab already retired it", async () => {
  let calls = 0;
  const result = await resolveRepeatedReviewBatchWithRecovery({
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (options.method === "POST") {
        return jsonResponse(409, { code: "review_repeat_not_confirmed", error: "完成索引暂不一致" });
      }
      return jsonResponse(200, {
        batch: { id: "new-current", phase: "answering", questions: [{ id: "q2", taskId: "d1-mat:en-zh", answer: "" }] },
        state: { sessions: { "2026-08-16": { retiredBatchIds: ["legacy-empty"] } } }
      });
    },
    body: { batchId: "legacy-empty", action: "discard" },
    resolveTimeoutMs: 20,
    recoveryTimeoutMs: 20
  });
  assert.equal(result.source, "recovery");
  assert.equal(result.data.batch.id, "new-current");
  assert.equal(calls, 2);
});

test("a different authoritative current batch is adopted and the stale local ID is retired", async () => {
  const result = await resolveRepeatedReviewBatchWithRecovery({
    fetchImpl: async (_url, options) => options.method === "POST"
      ? hangingRequest()
      : jsonResponse(200, {
        batch: { id: "other-tab-current", phase: "answering", questions: [{ id: "q2", taskId: "d1-mat:en-zh", answer: "" }] },
        state: { sessions: { "2026-08-16": { batchId: "other-tab-current", retiredBatchIds: [] } } }
      }),
    body: { batchId: "stale-local-batch", action: "discard" },
    resolveTimeoutMs: 10,
    recoveryTimeoutMs: 10
  });
  assert.equal(result.source, "recovery-current");
  assert.equal(result.data.batch.id, "other-tab-current");
  assert.equal(result.data.retiredBatchId, "stale-local-batch");
});

test("a lost continue response recovers the replacement batch without losing its draft", async () => {
  const replacement = {
    id: "replacement-draft",
    recoveredFromBatchId: "legacy-draft",
    phase: "answering",
    questions: [{ id: "q1", taskId: "d1-man:en-zh", answer: "男人" }]
  };
  const result = await resolveRepeatedReviewBatchWithRecovery({
    fetchImpl: async (_url, options) => options.method === "POST"
      ? hangingRequest()
      : jsonResponse(200, {
        batch: replacement,
        state: { sessions: { "2026-08-16": { retiredBatchIds: ["legacy-draft"] } } }
      }),
    body: { batchId: "legacy-draft", action: "continue" },
    resolveTimeoutMs: 10,
    recoveryTimeoutMs: 10
  });
  assert.equal(result.data.batch.id, replacement.id);
  assert.equal(result.data.batch.questions[0].answer, "男人");
});

test("a hanging repeat recovery query exits within a bounded time", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    resolveRepeatedReviewBatchWithRecovery({
      fetchImpl: hangingRequest,
      body: { batchId: "legacy-empty", action: "discard" },
      resolveTimeoutMs: 10,
      recoveryTimeoutMs: 10
    }),
    error => error.code === "review-repeat-recovery-timeout" && error.recoverable === true
  );
  assert.ok(Date.now() - startedAt < 500);
});
