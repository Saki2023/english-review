"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const { test } = require("node:test");
const { offlineSelfStudyPackage, sanitizeSelfStudyLesson } = require("../server/self-study");
const { operateSelfStudy, publicSelfStudyState } = require("../offline-learning");
const { replayOutbox } = require("../offline-replay");
const { createOfflineStore } = require("../offline-store");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function choice(stepId, category, overrides = {}) {
  return {
    stepId,
    type: "choice",
    category,
    prompt: "It is a cat.",
    choices: [{ id: "A", text: "正确选项" }, { id: "B", text: "错误选项" }],
    acceptedAnswers: ["A"],
    correctionHint: "当前选择不正确，请重新检查题干。",
    ...overrides
  };
}

function lesson() {
  return sanitizeSelfStudyLesson({
    lessonId: "offline-day-9",
    studyDay: 9,
    title: "第 9 天离线课程",
    version: "1",
    enabledFrom: "2026-08-01T00:00:00.000Z",
    plannedContent: {
      words: [{ id: "offline-d9-dog", english: "dog", chinese: "狗", directions: ["en-zh", "zh-en"] }],
      sentences: [{ id: "offline-d9-sentence", english: "It is a dog.", chinese: "它是一只狗。", directions: ["en-zh", "zh-en"] }],
      note: { summary: "学习 dog。" }
    },
    stages: [
      { stageId: "review", type: "review", title: "旧知识复习", steps: [choice("review-1", "review")] },
      { stageId: "phonics", type: "phonics", title: "拼读与词汇", steps: [{ stepId: "teach-1", type: "teach", content: "dog" }] },
      { stageId: "pattern", type: "pattern", title: "句子结构", steps: [{ stepId: "pattern-1", type: "teach", content: "It is a dog." }] },
      { stageId: "reading", type: "reading", title: "阅读与翻译", steps: [{ stepId: "read-1", type: "read-aloud", content: "It is a dog." }] },
      {
        stageId: "test",
        type: "test",
        title: "测验与订正",
        steps: [
          choice("test-p-1", "phonics"), choice("test-p-2", "phonics"),
          choice("test-ez-1", "en-zh", { type: "en-zh", direction: "en-zh", english: "dog" }),
          choice("test-ez-2", "en-zh", { type: "en-zh", direction: "en-zh", english: "It is a dog." }),
          choice("test-ze-1", "zh-en", { type: "zh-en", direction: "zh-en", chinese: "狗" }),
          choice("test-ze-2", "zh-en", { type: "zh-en", direction: "zh-en", chinese: "它是一只狗。" }),
          choice("test-r-1", "reading"), choice("test-r-2", "reading"), choice("test-r-3", "reading"), choice("test-r-4", "reading")
        ]
      },
      { stageId: "summary", type: "summary", title: "总结与预习", steps: [{ stepId: "summary-1", type: "summary", prompt: "请用中文总结。" }] }
    ]
  }, { skipVocabularyValidation: true });
}

function initialPack() {
  const selfStudy = offlineSelfStudyPackage({ enabled: true, lessons: [lesson()], progress: {}, updatedAt: "2026-08-15T00:00:00.000Z" }, { nonce: "offline-test-nonce" });
  return {
    schemaVersion: 1,
    account: { id: "account-a", username: "account-a" },
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    selfStudy,
    selfStudyPublic: publicSelfStudyState(selfStudy)
  };
}

async function operate(pack, path, body, time) {
  return operateSelfStudy(pack, path, body, { crypto: webcrypto, now: new Date(`2026-08-15T00:${String(time).padStart(2, "0")}:00.000Z`) });
}

test("offline self-study hides answers before submission, keeps wrong answers on the same step, and unlocks the reference only after a correct answer", async () => {
  let pack = initialPack();
  assert.doesNotMatch(JSON.stringify(pack.selfStudy), /"acceptedAnswers"|"referenceAnswer"/);
  let result = await operate(pack, "/start", { lessonId: "offline-day-9", startId: "start-1" }, 1);
  pack = result.pack;
  assert.equal(result.selfStudy.current.step.stepId, "review-1");
  assert.equal(Object.hasOwn(result.selfStudy.current.step, "referenceAnswer"), false);
  assert.equal(result.operation.id, "self-start:offline-day-9");

  result = await operate(pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "B", attemptId: "attempt-wrong" }, 2);
  pack = result.pack;
  assert.equal(result.selfStudy.current.step.stepId, "review-1");
  assert.equal(result.selfStudy.current.step.status, "needs-correction");
  assert.equal(result.selfStudy.current.step.attempts[0].correct, false);
  assert.equal(Object.hasOwn(result.selfStudy.current.step, "referenceAnswer"), false);
  assert.equal(result.selfStudy.current.step.attempts[0].formalEvidence, false);

  result = await operate(pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "A", attemptId: "attempt-correct" }, 3);
  pack = result.pack;
  assert.equal(result.selfStudy.current.step.status, "completed");
  assert.equal(result.selfStudy.current.step.referenceAnswer, "A");
  assert.equal(result.selfStudy.current.step.attempts[1].correction, true);
  assert.equal(result.selfStudy.current.step.attempts[1].formalEvidence, false);

  const repeated = await operate(pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "A", attemptId: "attempt-correct" }, 4);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.selfStudy.current.step.attempts.length, 2);
});

test("a reused attempt ID with different lesson, step, or answer cannot change the pack, queue, or replayed answer", async () => {
  const started = await operate(initialPack(), "/start", { lessonId: "offline-day-9", startId: "start-conflict" }, 1);
  const first = await operate(started.pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "B", attemptId: "stable-attempt" }, 2);
  const store = createOfflineStore({ localStorage: new MemoryStorage() });
  await store.savePack(first.pack, "account-a");
  await store.enqueue(first.operation, "account-a");

  const exactRetry = await operate(first.pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "B", attemptId: "stable-attempt" }, 3);
  assert.equal(exactRetry.duplicate, true);
  assert.equal(exactRetry.operation.body.answer, "B");
  await store.enqueue(exactRetry.operation, "account-a");

  await assert.rejects(
    () => operate(first.pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "A", attemptId: "stable-attempt" }, 4),
    /提交标识已用于不同课程、步骤或答案/
  );
  await assert.rejects(
    () => operate(first.pack, "/submit", { lessonId: "offline-day-9", stepId: "teach-1", answer: "B", attemptId: "stable-attempt" }, 5),
    /提交标识已用于不同课程、步骤或答案/
  );

  const beforeReplay = await store.loadPack("account-a");
  assert.equal(beforeReplay.selfStudy.progress["offline-day-9"].steps["review-1"].attempts[0].answer, "B");
  assert.equal((await store.listOutbox("account-a"))[0].body.answer, "B");

  const replayedBodies = [];
  const response = (status, value) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
  const replay = await replayOutbox({
    store,
    accountId: "account-a",
    fetch: async (path, options = {}) => {
      if (path === "/api/auth/status") return response(200, { authenticated: true, user: { id: "account-a" } });
      if (path === "/api/offline/pack") return response(200, first.pack);
      replayedBodies.push(JSON.parse(options.body));
      return response(200, { ok: true });
    }
  });
  assert.equal(replay.replayed, 1);
  assert.deepEqual(replayedBodies.map(body => body.answer), ["B"]);
  assert.equal((await store.loadPack("account-a")).selfStudy.progress["offline-day-9"].steps["review-1"].attempts[0].answer, "B");
});

test("offline course completion remains pending sync and never creates formal evidence", async () => {
  let pack = (await operate(initialPack(), "/start", { lessonId: "offline-day-9" }, 1)).pack;
  let sequence = 2;
  for (let guard = 0; guard < 40; guard += 1) {
    const view = publicSelfStudyState(pack.selfStudy, new Date("2026-08-15T01:00:00.000Z"));
    if (!view.current) break;
    const step = view.current.step;
    if (step.status === "completed" && ["choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction"].includes(step.type)) {
      const continued = await operate(pack, "/continue", { lessonId: view.current.lessonId, stepId: step.stepId, continueId: `continue-${step.stepId}` }, sequence++);
      pack = continued.pack;
      continue;
    }
    const answer = ["teach", "read-aloud"].includes(step.type) ? "已确认" : step.type === "summary" ? "我学会了 dog。" : "A";
    const submitted = await operate(pack, "/submit", { lessonId: view.current.lessonId, stepId: step.stepId, answer, attemptId: `attempt-${step.stepId}` }, sequence++);
    pack = submitted.pack;
  }

  const finished = publicSelfStudyState(pack.selfStudy, new Date("2026-08-15T02:00:00.000Z"));
  assert.equal(finished.current, null);
  assert.equal(finished.pendingSyncLessons, 1);
  assert.equal(finished.completedLessons, 1);
  assert.equal(finished.availableLesson, null);
  assert.doesNotMatch(JSON.stringify(pack), /"formalEvidence":true/);
  assert.equal(pack.selfStudy.progress["offline-day-9"].status, "pending-sync");
  assert.equal(pack.selfStudy.progress["offline-day-9"].promotion, null);
});

test("AI-graded offline steps and tutor questions stay pending without formal evidence", async () => {
  const pack = initialPack();
  pack.selfStudy.lessons[0].stages[0].steps[0].gradingMode = "ai";
  let result = await operate(pack, "/start", { lessonId: "offline-day-9" }, 1);
  result = await operate(result.pack, "/submit", { lessonId: "offline-day-9", stepId: "review-1", answer: "A", attemptId: "ai-pending" }, 2);
  assert.equal(result.pendingOnline, true);
  assert.equal(result.selfStudy.current.step.status, "pending");
  assert.equal(result.selfStudy.current.step.attempts[0].correct, null);
  assert.equal(result.selfStudy.current.step.attempts[0].formalEvidence, false);

  const asked = await operate(result.pack, "/question", { lessonId: "offline-day-9", stepId: "review-1", question: "为什么？", questionId: "question-1" }, 3);
  assert.equal(asked.pendingOnline, true);
  assert.equal(asked.selfStudy.current.step.questions[0].status, "pending");
  assert.equal(asked.operation.id, "self-question:question-1");
});

test("an offline summary is generated from evidence, survives restart, and replays the same snapshot", async () => {
  let pack = (await operate(initialPack(), "/start", { lessonId: "offline-day-9" }, 1)).pack;
  const progress = pack.selfStudy.progress["offline-day-9"];
  progress.stageIndex = 5;
  progress.stepIndex = 0;
  const store = createOfflineStore({ localStorage: new MemoryStorage() });
  await store.savePack(pack, "account-a");
  pack = await store.loadPack("account-a");

  const completed = await operate(pack, "/submit", { lessonId: "offline-day-9", stepId: "summary-1", answer: "", attemptId: "automatic-summary" }, 2);
  assert.equal(completed.courseReadyToSync, true);
  assert.equal(completed.pack.selfStudy.progress["offline-day-9"].status, "pending-sync");
  assert.match(completed.operation.body.answer, /今天学习了 1 个新词、1 个新句型或句子/);
  assert.match(completed.operation.body.answer, /实际完成 0\/11 道题/);
  assert.equal(completed.operation.body.answer, completed.pack.selfStudy.progress["offline-day-9"].steps["summary-1"].automaticSummary.text);

  await store.savePack(completed.pack, "account-a");
  await store.enqueue(completed.operation, "account-a");
  const restored = await store.loadPack("account-a");
  assert.equal(restored.selfStudy.progress["offline-day-9"].steps["summary-1"].automaticSummary.text, completed.operation.body.answer);

  const replayedBodies = [];
  const response = (status, value) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
  const replay = await replayOutbox({
    store,
    accountId: "account-a",
    fetch: async (path, options = {}) => {
      if (path === "/api/auth/status") return response(200, { authenticated: true, user: { id: "account-a" } });
      if (path === "/api/offline/pack") return response(200, completed.pack);
      replayedBodies.push(JSON.parse(options.body));
      return response(200, { ok: true });
    }
  });
  assert.equal(replay.replayed, 1);
  assert.deepEqual(replayedBodies.map(body => body.answer), [completed.operation.body.answer]);
});

test("offline course availability uses the server snapshot and never trusts a changed device clock", async () => {
  const futureLesson = lesson();
  futureLesson.lessonId = "offline-future-day";
  futureLesson.formalDate = "2026-08-20";
  futureLesson.enabledFrom = "2026-08-19T16:00:00.000Z";
  const selfStudy = offlineSelfStudyPackage({ enabled: true, lessons: [futureLesson], progress: {}, updatedAt: "2026-08-15T00:00:00.000Z" }, {
    nonce: "offline-clock-test",
    now: new Date("2026-08-15T00:00:00.000Z")
  });
  assert.equal(selfStudy.lessons[0].availability, "waiting");
  const farFuture = publicSelfStudyState(selfStudy, new Date("2036-08-20T00:00:00.000Z"));
  assert.equal(farFuture.availableLesson, null);
  assert.equal(farFuture.waitingReason, "not-enabled");
  await assert.rejects(
    operateSelfStudy({ account: { id: "account-a" }, selfStudy }, "/start", { lessonId: futureLesson.lessonId }, { crypto: webcrypto, now: new Date("2036-08-20T00:00:00.000Z") }),
    /当前不可开始/
  );

  const legacy = structuredClone(selfStudy);
  delete legacy.lessons[0].availability;
  delete legacy.schedule;
  delete legacy.clock;
  const legacyView = publicSelfStudyState(legacy, new Date("2036-08-20T00:00:00.000Z"));
  assert.equal(legacyView.availableLesson, null);
  assert.equal(legacyView.waitingReason, "schedule-unknown");
});
