"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { operateAiPractice } = require("../offline-ai");
const { createOfflineStore } = require("../offline-store");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function question(id) {
  return { id, contentType: id.endsWith("q1") ? "word" : "sentence", direction: id.endsWith("q1") ? "en-zh" : "zh-en", prompt: `Question ${id}`, userAnswer: "", answeredAt: "" };
}

function set(id, count = 2) {
  return {
    id,
    phase: "answering",
    completed: false,
    index: 0,
    questions: Array.from({ length: count }, (_, index) => question(`${id}-q${index + 1}`)),
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z"
  };
}

function pack() {
  const generatedAt = new Date(Date.now() - 60 * 60 * 1000);
  return {
    schemaVersion: 1,
    account: { id: "account-a", username: "account-a" },
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + 14 * 86400000).toISOString(),
    aiPractice: {
      currentSet: set("set-1"),
      preparedSets: [set("set-2"), set("set-3")],
      generationQueue: [{ requestId: "generate-1", status: "ready", readyGroups: 2, groups: [{ id: "set-2" }, { id: "set-3" }] }]
    }
  };
}

function operate(value, path, body, minute) {
  return operateAiPractice(value, path, body, { now: new Date(`2026-08-15T00:${String(minute).padStart(2, "0")}:00.000Z`), randomUUID: () => "stable-grade" });
}

test("offline AI saves drafts, blocks blank review, and queues grading without creating results or formal evidence", async () => {
  let value = pack();
  let result = operate(value, "/draft", { setId: "set-1", questionId: "set-1-q1", index: 0, nextIndex: 1, answer: "答案一" }, 1);
  value = result.pack;
  assert.equal(result.operation.id, "ai-draft:set-1:1:set-1-q1");
  assert.equal(result.practice.currentSet.index, 1);
  assert.throws(() => operate(value, "/review", { setId: "set-1" }, 2), /第 2 题还没有作答/);

  result = operate(value, "/draft", { setId: "set-1", questionId: "set-1-q2", index: 1, nextIndex: 1, answer: "答案二" }, 3);
  value = result.pack;
  result = operate(value, "/review", { setId: "set-1" }, 4);
  value = result.pack;
  assert.equal(result.practice.currentSet.phase, "review");
  assert.equal(result.operation.id, "ai-review:set-1:1");
  assert.equal(result.practice.currentSet.gradeRequestId, "aigrade-offline-set-1-stable-grade");
  assert.equal(result.operation.body.gradeRequestId, "aigrade-offline-set-1-stable-grade");

  result = operate(value, "/grade", { setId: "set-1", gradeRequestId: result.practice.currentSet.gradeRequestId }, 5);
  assert.equal(result.practice.currentSet.phase, "grading");
  assert.equal(result.practice.currentSet.offlineGradePending, true);
  assert.equal(result.operation.id, "ai-grade:aigrade-offline-set-1-stable-grade");
  assert.equal(result.formalEvidence, false);
  assert.doesNotMatch(JSON.stringify(result.pack), /"correct"|"score"|"formalEvidence":true/);
});

test("offline AI edit creates a later review cycle so replay order remains valid", async () => {
  let value = pack();
  value.aiPractice.currentSet.questions.forEach(item => { item.userAnswer = "原答案"; });
  let result = operate(value, "/review", { setId: "set-1" }, 1);
  value = result.pack;
  const firstReview = result.operation;
  result = operate(value, "/edit", { setId: "set-1", index: 0 }, 2);
  value = result.pack;
  const edit = result.operation;
  result = operate(value, "/draft", { setId: "set-1", questionId: "set-1-q1", index: 0, nextIndex: 1, answer: "修改后" }, 3);
  const changedDraft = result.operation;
  value = result.pack;
  result = operate(value, "/review", { setId: "set-1" }, 4);
  const secondReview = result.operation;
  assert.deepEqual([firstReview.id, edit.id, changedDraft.id, secondReview.id], [
    "ai-review:set-1:1",
    "ai-edit:set-1:2",
    "ai-draft:set-1:2:set-1-q1",
    "ai-review:set-1:2"
  ]);
  assert.ok(firstReview.createdAt < edit.createdAt && edit.createdAt < changedDraft.createdAt && changedDraft.createdAt < secondReview.createdAt);
});

test("offline AI consumes downloaded groups in FIFO order only after confirmation and preserves queue order across storage", async () => {
  let value = pack();
  value.aiPractice.currentSet.phase = "grading";
  value.aiPractice.currentSet.offlineGradePending = true;
  let result = operate(value, "/next", { setId: "set-2", nextRequestId: "next-set-2" }, 1);
  assert.equal(result.practice.currentSet.id, "set-2");
  assert.deepEqual(result.practice.preparedSets.map(item => item.id), ["set-3"]);
  assert.deepEqual(result.practice.generationQueue[0].groups.map(item => item.id), ["set-3"]);
  assert.equal(result.operation.id, "ai-next:set-2");

  const store = createOfflineStore({ localStorage: new MemoryStorage() });
  await store.savePack(result.pack, "account-a");
  await store.enqueue(result.operation, "account-a");
  const restored = await store.loadPack("account-a", new Date("2026-08-16T00:00:00.000Z"));
  assert.equal(restored.aiPractice.currentSet.id, "set-2");
  assert.deepEqual(restored.aiPractice.currentSet.questions.map(item => item.contentType), ["word", "sentence"]);
  assert.deepEqual(restored.aiPractice.preparedSets.map(item => item.id), ["set-3"]);
  assert.deepEqual((await store.listOutbox("account-a")).map(item => item.id), ["ai-next:set-2"]);
});

test("offline AI cannot edit after final confirmation or invent a group when no downloaded snapshot remains", () => {
  const value = pack();
  value.aiPractice.currentSet.phase = "grading";
  value.aiPractice.currentSet.offlineGradePending = true;
  assert.throws(() => operate(value, "/edit", { setId: "set-1", index: 0 }, 1), /不能继续修改/);
  value.aiPractice.preparedSets = [];
  assert.throws(() => operate(value, "/next", {}, 2), /实时生成需要联网/);
});
