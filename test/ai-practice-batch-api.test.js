"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");

const ROOT = path.resolve(__dirname, "..");
const QUESTIONS = [
  { direction: "en-zh", english: "It is big.", chinese: "它很大。", acceptedEnglish: ["it is big"], acceptedChinese: ["它很大"], focus: "big" },
  { direction: "zh-en", english: "A cat sat on a mat.", chinese: "一只猫坐在一张垫子上。", acceptedEnglish: ["a cat sat on a mat"], acceptedChinese: ["一只猫坐在一张垫子上"], focus: "cat" },
  { direction: "en-zh", english: "I am Sam.", chinese: "我是萨姆。", acceptedEnglish: ["i am sam"], acceptedChinese: ["我是萨姆"], focus: "am" },
  { direction: "zh-en", english: "It is a big pig.", chinese: "它是一头大猪。", acceptedEnglish: ["it is a big pig"], acceptedChinese: ["它是一头大猪"], focus: "pig" },
  { direction: "en-zh", english: "She is a mom.", chinese: "她是一位妈妈。", acceptedEnglish: ["she is a mom"], acceptedChinese: ["她是一位妈妈", "她是一个妈妈"], focus: "mom" }
];

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-batch-"));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function createProvider() {
  const control = {
    calls: [],
    failGrading: false,
    failNextGeneration: false,
    holdNextGeneration: false,
    generationStarted: null,
    releaseGeneration: null
  };
  const provider = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    }
    const body = await requestBody(req);
    const system = String(body.messages && body.messages[0] && body.messages[0].content || "");
    const generation = system.includes("Create personalized translation exercises");
    control.calls.push({ generation, body });
    if (generation && control.holdNextGeneration) {
      control.holdNextGeneration = false;
      if (control.generationStarted) control.generationStarted();
      await new Promise(resolve => { control.releaseGeneration = resolve; });
      control.releaseGeneration = null;
    }
    if (generation && control.failNextGeneration) {
      control.failNextGeneration = false;
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "temporary generation failure" } }));
    }
    if (!generation && control.failGrading) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "temporary grading failure" } }));
    }
    let content;
    if (generation) {
      const groupCount = Number(system.match(/Return exactly (\d+) independent groups/)?.[1] || 1);
      content = groupCount > 1
        ? JSON.stringify({ groups: Array.from({ length: groupCount }, () => ({ questions: QUESTIONS })) })
        : JSON.stringify({ questions: QUESTIONS });
    } else {
      content = JSON.stringify({ correct: false, score: 0, gradingStatus: "incorrect", explanation: "答案与题意不一致。", problemWords: ["it"] });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  control.hold = () => {
    control.holdNextGeneration = true;
    return new Promise(resolve => { control.generationStarted = resolve; });
  };
  control.release = () => {
    if (control.releaseGeneration) control.releaseGeneration();
    control.generationStarted = null;
  };
  return { provider, control };
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

async function startApp(dataDir) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false", REVIEW_VARIANT_POOL_AUTOFILL: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(baseUrl, child);
  return { baseUrl, child };
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  app.child.kill();
  await once(app.child, "exit");
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, cookie, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), "Cookie": cookie },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const body = await response.json();
  return { response, body };
}

function answerFor(question) {
  const source = QUESTIONS.find(item => (question.direction === "en-zh" ? item.english : item.chinese) === question.prompt);
  assert.ok(source, `missing answer fixture for ${question.prompt}`);
  return question.direction === "en-zh" ? source.chinese : source.english;
}

async function fillAndReview(baseUrl, cookie, set, answers = null, gradeRequestId = "") {
  for (let index = 0; index < set.questions.length; index += 1) {
    const question = set.questions[index];
    const saved = await request(baseUrl, cookie, "/api/ai/questions/batch/draft", {
      method: "PUT",
      body: { setId: set.id, questionId: question.id, index, nextIndex: Math.min(index + 1, set.questions.length - 1), answer: answers ? answers[index] : answerFor(question) }
    });
    assert.equal(saved.response.status, 200);
  }
  const review = await request(baseUrl, cookie, "/api/ai/questions/batch/review", {
    method: "POST",
    body: { setId: set.id, ...(gradeRequestId ? { gradeRequestId } : {}) }
  });
  assert.equal(review.response.status, 200);
  return review.body.practice.currentSet;
}

async function gradeSet(baseUrl, cookie, set) {
  return request(baseUrl, cookie, "/api/ai/questions/batch/grade", {
    method: "POST",
    body: { setId: set.id, gradeRequestId: set.gradeRequestId }
  });
}

test("AI batches grade atomically while generation requests append idempotently without blocking drafts", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  createUser(store, { username: "ai-owner", password: "ai-owner-password" });
  createUser(store, { username: "ai-other", password: "ai-other-password" });
  saveUsers(dataDir, store);
  const { provider, control } = createProvider();
  let app;
  try {
    await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = provider.address().port;
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "ai-owner", "ai-owner-password");
    const otherCookie = await login(app.baseUrl, "ai-other", "ai-other-password");
    const unavailableOptions = await request(app.baseUrl, cookie, "/api/ai/options");
    assert.equal(unavailableOptions.response.status, 200);
    assert.equal(unavailableOptions.body.configured, false);
    const unavailableGeneration = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "unconfigured-generation", model: "missing-model", reasoningEffort: "high", count: 5, groupCount: 1 }
    });
    assert.equal(unavailableGeneration.response.status, 503);
    assert.equal(unavailableGeneration.body.reasonCode, "not_configured");
    assert.match(unavailableGeneration.body.error, /AI 尚未配置/);
    const queueBeforeConfiguration = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    assert.deepEqual(queueBeforeConfiguration.body.practice.generationQueue, []);
    const configured = await request(app.baseUrl, cookie, "/api/admin/ai-config", {
      method: "PUT",
      body: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "ai-batch-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 }
    });
    assert.equal(configured.response.status, 200);

    const otherInitial = await request(app.baseUrl, otherCookie, "/api/ai/questions/batch");
    assert.equal(otherInitial.body.practice.currentSet, null);
    assert.deepEqual(otherInitial.body.practice.generationQueue, []);

    const first = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "generate-first", model: "test-model", reasoningEffort: "high", count: 5, groupCount: 2 }
    });
    assert.equal(first.response.status, 201);
    const firstSetId = first.body.practice.currentSet.id;
    const firstBatchId = first.body.practice.currentSet.batchId;
    assert.equal(first.body.practice.currentSet.phase, "answering");
    assert.ok(first.body.practice.currentSet.questions.every(question => Object.hasOwn(question, "focus") === false));
    assert.equal(first.body.practice.currentSet.generationRequestId, "generate-first");
    assert.equal(first.body.practice.currentSet.questionVersion, 1);
    assert.equal(first.body.practice.currentSet.requestedCount, 5);
    assert.equal(first.body.practice.generationQueue[0].readyGroups, 1);
    assert.equal(first.body.practice.generationQueue[0].groups.length, 1);
    assert.equal(first.body.practice.generationQueue[0].groups[0].groupNumber, 2);
    assert.equal(first.body.practice.generationQueue[0].groups[0].questionCount, 5);
    assert.ok(first.body.practice.generationQueue[0].groups[0].createdAt);
    assert.deepEqual(first.body.practice.queuedSets, []);
    assert.doesNotMatch(JSON.stringify(first.body.practice.generationQueue), /It is big|一只猫|acceptedChinese|acceptedEnglish/);

    const startedHolding = control.hold();
    const backgroundGeneration = request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "generate-background", model: "test-model", reasoningEffort: "max", count: 5, groupCount: 2 }
    });
    await startedHolding;
    const firstQuestion = first.body.practice.currentSet.questions[0];
    const draftWhileGenerating = await Promise.race([
      request(app.baseUrl, cookie, "/api/ai/questions/batch/draft", {
        method: "PUT",
        body: { setId: firstSetId, questionId: firstQuestion.id, index: 0, nextIndex: 1, answer: answerFor(firstQuestion) }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("draft was blocked by background generation")), 1000))
    ]);
    assert.equal(draftWhileGenerating.response.status, 200);
    control.release();
    const background = await backgroundGeneration;
    assert.equal(background.response.status, 201);
    assert.equal(background.body.practice.currentSet.id, firstSetId);
    assert.deepEqual(background.body.practice.generationQueue.map(item => [item.requestId, item.readyGroups]), [["generate-first", 1], ["generate-background", 2]]);

    const generationCallsBeforeRepeat = control.calls.filter(item => item.generation).length;
    const repeatedGeneration = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "generate-background", model: "test-model", reasoningEffort: "max", count: 5, groupCount: 2 }
    });
    assert.equal(repeatedGeneration.response.status, 200);
    assert.equal(repeatedGeneration.body.reused, true);
    assert.equal(control.calls.filter(item => item.generation).length, generationCallsBeforeRepeat);
    assert.equal(repeatedGeneration.body.practice.generationQueue.reduce((sum, item) => sum + item.readyGroups, 0), 3);

    const offlinePack = await request(app.baseUrl, cookie, "/api/offline/pack");
    assert.equal(offlinePack.response.status, 200);
    assert.equal(offlinePack.body.aiPractice.currentSet.id, firstSetId);
    assert.equal(offlinePack.body.aiPractice.currentSet.questions[0].userAnswer, answerFor(firstQuestion));
    assert.equal(offlinePack.body.aiPractice.preparedSets.length, 3);
    assert.ok(offlinePack.body.aiPractice.preparedSets.every(set => set.questions.length === 5));
    const offlineAiText = JSON.stringify(offlinePack.body.aiPractice);
    assert.doesNotMatch(offlineAiText, /referenceAnswer|acceptedChinese|acceptedEnglish|"correct"\s*:/);
    assert.doesNotMatch(JSON.stringify(offlinePack.body), /ai-batch-test-key|"apiKey"|Bearer\s/i);
    const otherOfflinePack = await request(app.baseUrl, otherCookie, "/api/offline/pack");
    assert.equal(otherOfflinePack.response.status, 200);
    assert.equal(otherOfflinePack.body.aiPractice.currentSet, null);
    assert.deepEqual(otherOfflinePack.body.aiPractice.preparedSets, []);

    const stale = (await request(app.baseUrl, cookie, "/api/state")).body;
    const staleSave = await request(app.baseUrl, cookie, "/api/state", { method: "PUT", body: { ...stale, aiPractice: {} } });
    assert.equal(staleSave.response.status, 200);
    assert.equal(staleSave.body.aiPractice.currentSet.id, firstSetId);
    assert.equal(staleSave.body.aiPractice.generationQueue.reduce((sum, item) => sum + item.readyGroups, 0), 3);

    await stopApp(app);
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "ai-owner", "ai-owner-password");
    const restored = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    assert.equal(restored.body.practice.currentSet.id, firstSetId);
    assert.equal(restored.body.practice.currentSet.questions[0].userAnswer, answerFor(restored.body.practice.currentSet.questions[0]));
    assert.equal(restored.body.practice.generationQueue.reduce((sum, item) => sum + item.readyGroups, 0), 3);

    const answers = restored.body.practice.currentSet.questions.map(answerFor);
    answers[0] = "错误答案";
    const reviewSet = await fillAndReview(app.baseUrl, cookie, restored.body.practice.currentSet, answers, "offline-stable-grade-request");
    assert.equal(reviewSet.phase, "review");
    assert.equal(reviewSet.gradeRequestId, "offline-stable-grade-request");
    const repeatedOfflineReview = await request(app.baseUrl, cookie, "/api/ai/questions/batch/review", {
      method: "POST",
      body: { setId: reviewSet.id, gradeRequestId: "offline-stable-grade-request" }
    });
    assert.equal(repeatedOfflineReview.response.status, 200);
    assert.equal(repeatedOfflineReview.body.practice.currentSet.gradeRequestId, "offline-stable-grade-request");
    const conflictingOfflineReview = await request(app.baseUrl, cookie, "/api/ai/questions/batch/review", {
      method: "POST",
      body: { setId: reviewSet.id, gradeRequestId: "different-grade-request" }
    });
    assert.equal(conflictingOfflineReview.response.status, 409);
    assert.ok(reviewSet.questions.every(question => Object.hasOwn(question, "focus") === false));
    assert.doesNotMatch(JSON.stringify(reviewSet), /referenceAnswer|acceptedChinese|acceptedEnglish|\"correct\"/);
    const beforeFailedGrade = (await request(app.baseUrl, cookie, "/api/state")).body;
    control.failGrading = true;
    const failedGrade = await gradeSet(app.baseUrl, cookie, reviewSet);
    assert.equal(failedGrade.response.status, 503);
    assert.equal(failedGrade.body.practice.currentSet.phase, "review");
    assert.equal(failedGrade.body.practice.history.length, 0);
    assert.doesNotMatch(JSON.stringify(failedGrade.body.practice.currentSet), /referenceAnswer|\"correct\"/);
    const afterFailedGrade = (await request(app.baseUrl, cookie, "/api/state")).body;
    assert.deepEqual(afterFailedGrade.attempts, beforeFailedGrade.attempts);
    assert.deepEqual(afterFailedGrade.taskStates, beforeFailedGrade.taskStates);
    assert.deepEqual(afterFailedGrade.mistakes, beforeFailedGrade.mistakes);
    assert.deepEqual(afterFailedGrade.history, beforeFailedGrade.history);

    control.failGrading = false;
    const successfulGrade = await gradeSet(app.baseUrl, cookie, failedGrade.body.practice.currentSet);
    assert.equal(successfulGrade.response.status, 200);
    assert.equal(successfulGrade.body.practice.currentSet.phase, "completed");
    assert.equal(successfulGrade.body.practice.history.length, 5);
    assert.equal(successfulGrade.body.practice.currentSet.questions[0].correct, false);
    assert.ok(successfulGrade.body.practice.currentSet.questions.every(question => typeof question.referenceAnswer === "string" && question.referenceAnswer.length > 0));
    assert.ok(successfulGrade.body.practice.currentSet.questions.every(question => Object.hasOwn(question, "english") && Object.hasOwn(question, "chinese")));
    const repeatedGrade = await gradeSet(app.baseUrl, cookie, successfulGrade.body.practice.currentSet);
    assert.equal(repeatedGrade.response.status, 200);
    assert.equal(repeatedGrade.body.reused, true);
    assert.equal(repeatedGrade.body.practice.history.length, 5);
    assert.equal(repeatedGrade.body.practice.currentSet.id, firstSetId);

    const expectedNextSetId = successfulGrade.body.practice.generationQueue[0].groups[0].id;
    const next = await request(app.baseUrl, cookie, "/api/ai/questions/next", { method: "POST", body: { setId: expectedNextSetId, nextRequestId: "next-response-loss" } });
    assert.equal(next.response.status, 200);
    assert.equal(next.body.reused, false);
    assert.equal(next.body.set.batchId, firstBatchId);
    assert.equal(next.body.set.groupNumber, 2);
    assert.equal(next.body.practice.history.length, 5);
    const remainingAfterNext = next.body.remainingGroups;
    const repeatedNext = await request(app.baseUrl, cookie, "/api/ai/questions/next", { method: "POST", body: { setId: expectedNextSetId, nextRequestId: "next-response-loss" } });
    assert.equal(repeatedNext.response.status, 200);
    assert.equal(repeatedNext.body.reused, true);
    assert.equal(repeatedNext.body.practice.currentSet.id, expectedNextSetId);
    assert.equal(repeatedNext.body.remainingGroups, remainingAfterNext);

    const otherStillIsolated = await request(app.baseUrl, otherCookie, "/api/ai/questions/batch");
    assert.equal(otherStillIsolated.body.practice.currentSet, null);
    assert.deepEqual(otherStillIsolated.body.practice.generationQueue, []);
  } finally {
    control.release();
    await stopApp(app);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed FIFO generation item blocks later groups and retries in its original position", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  createUser(store, { username: "queue-owner", password: "queue-owner-password" });
  saveUsers(dataDir, store);
  const { provider, control } = createProvider();
  let app;
  try {
    await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = provider.address().port;
    app = await startApp(dataDir);
    const cookie = await login(app.baseUrl, "queue-owner", "queue-owner-password");
    await request(app.baseUrl, cookie, "/api/admin/ai-config", {
      method: "PUT",
      body: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "queue-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 }
    });

    const initial = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "queue-current", model: "test-model", reasoningEffort: "medium", count: 5, groupCount: 1 }
    });
    const reviewed = await fillAndReview(app.baseUrl, cookie, initial.body.practice.currentSet);
    const completed = await gradeSet(app.baseUrl, cookie, reviewed);
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.practice.currentSet.phase, "completed");

    control.failNextGeneration = true;
    const failed = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "queue-failed", model: "test-model", reasoningEffort: "high", count: 5, groupCount: 1 }
    });
    assert.equal(failed.response.status, 502);
    const failedState = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    const failedGroupId = failedState.body.practice.generationQueue.find(item => item.requestId === "queue-failed").groups[0].id;
    const later = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "queue-later", model: "test-model", reasoningEffort: "max", count: 5, groupCount: 1 }
    });
    assert.equal(later.response.status, 201);
    assert.deepEqual(later.body.practice.generationQueue.map(item => item.requestId), ["queue-failed", "queue-later"]);
    assert.deepEqual(later.body.practice.generationQueue.map(item => item.status), ["failed", "ready"]);

    const blocked = await request(app.baseUrl, cookie, "/api/ai/questions/next", { method: "POST", body: {} });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.requestId, "queue-failed");
    assert.equal(blocked.body.practice.currentSet.id, completed.body.practice.currentSet.id);

    const retry = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "queue-failed", model: "ignored-on-retry", reasoningEffort: "low", count: 10, groupCount: 5 }
    });
    assert.equal(retry.response.status, 201, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.practice.generationQueue.map(item => item.requestId), ["queue-failed", "queue-later"]);
    assert.deepEqual(retry.body.practice.generationQueue.map(item => item.status), ["ready", "ready"]);
    assert.equal(retry.body.practice.generationQueue[0].model, "test-model");
    assert.equal(retry.body.practice.generationQueue[0].reasoningEffort, "high");
    assert.equal(retry.body.practice.generationQueue[0].count, 5);
    assert.equal(retry.body.practice.generationQueue[0].groupCount, 1);
    assert.equal(retry.body.practice.generationQueue[0].groups[0].id, failedGroupId);

    const next = await request(app.baseUrl, cookie, "/api/ai/questions/next", { method: "POST", body: {} });
    assert.equal(next.response.status, 200);
    assert.equal(next.body.practice.currentSet.batchId, retry.body.practice.generationQueue[0].batchId);
    assert.equal(next.body.practice.currentSet.id, failedGroupId);
    assert.deepEqual(next.body.practice.generationQueue.map(item => item.requestId), ["queue-later"]);
  } finally {
    control.release();
    await stopApp(app);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the first FIFO request stays first when a later generation finishes sooner", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  createUser(store, { username: "race-owner", password: "race-owner-password" });
  saveUsers(dataDir, store);
  const { provider, control } = createProvider();
  let app;
  try {
    await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = provider.address().port;
    app = await startApp(dataDir);
    const cookie = await login(app.baseUrl, "race-owner", "race-owner-password");
    await request(app.baseUrl, cookie, "/api/admin/ai-config", {
      method: "PUT",
      body: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "race-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 }
    });

    const firstStarted = control.hold();
    const firstRequest = request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "race-first", model: "test-model", reasoningEffort: "high", count: 5, groupCount: 1 }
    });
    await firstStarted;
    const second = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "race-second", model: "test-model", reasoningEffort: "low", count: 5, groupCount: 1 }
    });
    assert.equal(second.response.status, 201);
    assert.equal(second.body.practice.currentSet, null);
    assert.deepEqual(second.body.practice.generationQueue.map(item => [item.requestId, item.status]), [["race-first", "pending"], ["race-second", "ready"]]);
    const firstBatchId = second.body.practice.generationQueue[0].batchId;
    const firstPlannedSetId = second.body.practice.generationQueue[0].groups[0].id;
    assert.doesNotMatch(JSON.stringify(second.body.practice.generationQueue), /It is big|一只猫|acceptedChinese|acceptedEnglish/);

    control.release();
    const first = await firstRequest;
    assert.equal(first.response.status, 201);
    assert.equal(first.body.practice.currentSet.batchId, firstBatchId);
    assert.equal(first.body.practice.currentSet.id, firstPlannedSetId);
    assert.equal(first.body.practice.currentSet.groupNumber, 1);
    assert.deepEqual(first.body.practice.generationQueue.map(item => [item.requestId, item.status, item.readyGroups]), [["race-second", "ready", 1]]);
  } finally {
    control.release();
    await stopApp(app);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("service restart turns interrupted generation and grading into explicit retryable states", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  const owner = createUser(store, { username: "restart-owner", password: "restart-owner-password" });
  saveUsers(dataDir, store);
  const { provider, control } = createProvider();
  let app;
  try {
    await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = provider.address().port;
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "restart-owner", "restart-owner-password");
    await request(app.baseUrl, cookie, "/api/admin/ai-config", {
      method: "PUT",
      body: { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "restart-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 }
    });

    const started = control.hold();
    const interruptedRequest = request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "restart-generation", model: "test-model", reasoningEffort: "high", count: 5, groupCount: 1 }
    }).catch(error => error);
    await started;
    const pending = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    const plannedSetId = pending.body.practice.generationQueue[0].groups[0].id;
    assert.equal(pending.body.practice.generationQueue[0].status, "pending");

    await stopApp(app);
    app = null;
    control.release();
    await interruptedRequest;
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "restart-owner", "restart-owner-password");
    const recoveredGeneration = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    assert.equal(recoveredGeneration.body.practice.generationQueue[0].status, "failed");
    assert.equal(recoveredGeneration.body.practice.generationQueue[0].groups[0].id, plannedSetId);
    assert.match(recoveredGeneration.body.practice.generationQueue[0].error, /服务重启.*原位置重试/);

    const generationCalls = control.calls.filter(item => item.generation).length;
    const retried = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "restart-generation", model: "ignored", reasoningEffort: "low", count: 10, groupCount: 5 }
    });
    assert.equal(retried.response.status, 201, JSON.stringify(retried.body));
    assert.equal(retried.body.practice.currentSet.id, plannedSetId);
    assert.equal(retried.body.practice.currentSet.reasoningEffort, "high");
    assert.equal(retried.body.practice.currentSet.questions.length, 5);
    const repeated = await request(app.baseUrl, cookie, "/api/ai/questions/generate", {
      method: "POST",
      body: { requestId: "restart-generation", model: "test-model", reasoningEffort: "high", count: 5, groupCount: 1 }
    });
    assert.equal(repeated.body.reused, true);
    assert.equal(control.calls.filter(item => item.generation).length, generationCalls + 1);

    const reviewSet = await fillAndReview(app.baseUrl, cookie, retried.body.practice.currentSet);
    await stopApp(app);
    app = null;
    const stateFile = path.join(dataDir, "user-states.json");
    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    disk.users[owner.id].aiPractice.currentSet.phase = "grading";
    disk.users[owner.id].aiPractice.currentSet.gradingStartedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "restart-owner", "restart-owner-password");
    const recoveredGrading = await request(app.baseUrl, cookie, "/api/ai/questions/batch");
    assert.equal(recoveredGrading.body.practice.currentSet.id, reviewSet.id);
    assert.equal(recoveredGrading.body.practice.currentSet.phase, "review");
    assert.match(recoveredGrading.body.practice.currentSet.lastError, /服务重启.*重新点击确认并批改/);
  } finally {
    control.release();
    await stopApp(app);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
