"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-formal-batch-"));
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

async function jsonRequest(baseUrl, cookie, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), "Cookie": cookie },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  return { response, body };
}

function createAccounts(dataDir) {
  const store = loadUsers(dataDir);
  const owner = createUser(store, { username: "formal-owner", password: "formal-owner-password" });
  const other = createUser(store, { username: "formal-other", password: "formal-other-password" });
  saveUsers(dataDir, store);
  return { owner, other };
}

function writeWordBankContent(dataDir) {
  const taskIds = Array.from({ length: 4 }, (_, index) => `word-bank-pool-${index + 1}:en-zh`);
  fs.writeFileSync(path.join(dataDir, "content-store.json"), `${JSON.stringify({
    version: 2,
    updatedAt: "2026-08-16",
    currentDay: 10,
    words: [
      { id: "d8-pool", day: 8, learned: "2026-08-07", english: "pool", chinese: "水池；游泳池", acceptedChinese: ["水池", "游泳池", "泳池"], directions: ["en-zh", "zh-en"] },
      { id: "d10-snake", day: 10, learned: "2026-08-16", english: "snake", chinese: "蛇", acceptedChinese: ["蛇"], directions: ["en-zh", "zh-en"] }
    ],
    sentences: taskIds.map((taskId, index) => ({
      id: taskId.slice(0, taskId.lastIndexOf(":")),
      day: 10,
      learned: "2026-08-16",
      english: "A snake is in a pool.",
      chinese: "一条蛇在一个池塘里。",
      acceptedChinese: ["一条蛇在一个池塘里。"],
      acceptedEnglish: ["a snake is in a pool"],
      directions: ["en-zh"],
      order: index + 1
    })),
    notes: [],
    deletedIds: []
  }, null, 2)}\n`, "utf8");
  return taskIds;
}

function learnedWordReviewTasks(limit = 20) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data.js"), "utf8"), sandbox, { filename: "data.js" });
  return Array.from(sandbox.window.ENGLISH_REVIEW_DATA.words)
    .filter(item => !item.preview && item.id && (item.acceptedChinese?.[0] || item.chinese))
    .slice(0, limit)
    .map(item => ({ taskId: `${item.id}:en-zh`, answer: String(item.acceptedChinese?.[0] || item.chinese) }));
}

async function completeReviewBatch(baseUrl, cookie, batchId, date, tasks) {
  const started = await jsonRequest(baseUrl, cookie, "/api/review/batches/start", {
    method: "POST",
    body: { batchId, date, mode: "word", taskIds: tasks.map(item => item.taskId) }
  });
  assert.equal(started.response.status, 201);
  for (let index = 0; index < started.body.batch.questions.length; index += 1) {
    const question = started.body.batch.questions[index];
    const answer = tasks.find(item => item.taskId === question.taskId)?.answer || "";
    const drafted = await jsonRequest(baseUrl, cookie, "/api/review/batches/draft", {
      method: "PUT",
      body: {
        batchId,
        questionId: question.id,
        index,
        nextIndex: Math.min(index + 1, started.body.batch.questions.length - 1),
        answer
      }
    });
    assert.equal(drafted.response.status, 200);
  }
  const reviewed = await jsonRequest(baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId } });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.batch.phase, "review");
  const graded = await jsonRequest(baseUrl, cookie, "/api/review/batches/grade", {
    method: "POST",
    body: { batchId, gradeRequestId: reviewed.body.batch.gradeRequestId }
  });
  assert.equal(graded.response.status, 200);
  assert.equal(graded.body.batch.phase, "completed");
  return graded;
}

test("per-question grading persists by account and records corrections idempotently", async () => {
  const dataDir = temporaryDataDir();
  createAccounts(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const otherCookie = await login(app.baseUrl, "formal-other", "formal-other-password");
    const initialState = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.equal(initialState.formalPractice.review.gradingMode, "group");

    const selected = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", {
      method: "POST",
      body: { gradingMode: "immediate" }
    });
    assert.equal(selected.response.status, 200);
    assert.equal(selected.body.appliesTo, "next");
    assert.equal(selected.body.state.formalPractice.review.gradingMode, "immediate");

    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "review-immediate-fixed", date: "2026-08-16", mode: "word", taskIds: ["d1-man:en-zh", "d1-mat:en-zh"] }
    });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.batch.gradingMode, "immediate");
    assert.equal(started.body.batch.questions[0].answer, "");
    assert.ok(started.body.batch.questions[0].attemptRequestId);
    assert.doesNotMatch(JSON.stringify(started.body.batch.questions), /referenceAnswer|acceptedChinese|男人|垫子/);

    const switchedPristine = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", {
      method: "POST",
      body: { gradingMode: "group" }
    });
    assert.equal(switchedPristine.body.appliesTo, "current");
    assert.equal(switchedPristine.body.batch.gradingMode, "group");
    const switchedBack = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", {
      method: "POST",
      body: { gradingMode: "immediate" }
    });
    assert.equal(switchedBack.body.appliesTo, "current");
    assert.equal(switchedBack.body.batch.gradingMode, "immediate");

    const firstQuestion = switchedBack.body.batch.questions[0];
    const wrongRequest = {
      method: "POST",
      body: {
        batchId: switchedBack.body.batch.id,
        questionId: firstQuestion.id,
        attemptRequestId: firstQuestion.attemptRequestId,
        answer: "错误"
      }
    };
    const duplicateResponses = await Promise.all([
      jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", wrongRequest),
      jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", wrongRequest)
    ]);
    assert.deepEqual(duplicateResponses.map(item => item.response.status), [200, 200]);
    assert.deepEqual(duplicateResponses.map(item => item.body.reused).sort(), [false, true]);
    const afterWrong = duplicateResponses.find(item => item.body.reused === false).body.batch;
    assert.equal(afterWrong.index, 0);
    assert.equal(afterWrong.questions[0].result.gradingStatus, "incorrect");
    assert.equal(afterWrong.questions[0].referenceAnswer, "男人");
    assert.equal(afterWrong.questions[0].attemptCount, 1);
    assert.equal(afterWrong.questions[0].completedAt, "");
    assert.notEqual(afterWrong.questions[0].attemptRequestId, firstQuestion.attemptRequestId);
    const afterWrongState = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.equal(afterWrongState.attempts.length - initialState.attempts.length, 1);
    assert.equal(afterWrongState.history["2026-08-16"].reviewed, 1);

    const conflictingRetry = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", {
      method: "POST",
      body: { ...wrongRequest.body, answer: "男人" }
    });
    assert.equal(conflictingRetry.response.status, 409);
    assert.match(conflictingRetry.body.error, /同一提交标识不能改写/);

    const nextMode = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", {
      method: "POST",
      body: { gradingMode: "group" }
    });
    assert.equal(nextMode.body.appliesTo, "next");
    assert.equal(nextMode.body.batch.gradingMode, "immediate");
    assert.equal(nextMode.body.state.formalPractice.review.gradingMode, "group");
    const isolated = await jsonRequest(app.baseUrl, otherCookie, "/api/state");
    assert.equal(isolated.body.formalPractice.review.gradingMode, "group");
    assert.equal(isolated.body.formalPractice.review.current, null);

    const corrected = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", {
      method: "POST",
      body: {
        batchId: afterWrong.id,
        questionId: afterWrong.questions[0].id,
        attemptRequestId: afterWrong.questions[0].attemptRequestId,
        answer: "男人"
      }
    });
    assert.equal(corrected.response.status, 200);
    assert.equal(corrected.body.batch.questions[0].result.gradingStatus, "correct");
    assert.equal(corrected.body.batch.questions[0].attemptCount, 2);
    assert.ok(corrected.body.batch.questions[0].completedAt);
    assert.equal(corrected.body.batch.index, 0, "a correct answer still requires an explicit next action");

    await stopApp(app);
    app = null;
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const restored = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(restored.body.batch.id, "review-immediate-fixed");
    assert.equal(restored.body.batch.index, 0);
    assert.equal(restored.body.batch.questions[0].attemptCount, 2);
    assert.ok(restored.body.batch.questions[0].completedAt);

    const advanced = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/advance", {
      method: "POST",
      body: { batchId: restored.body.batch.id, questionId: restored.body.batch.questions[0].id }
    });
    assert.equal(advanced.response.status, 200);
    assert.equal(advanced.body.batch.index, 1);
    assert.equal(advanced.body.batch.questions[1].answer, "");
    assert.doesNotMatch(JSON.stringify(advanced.body.batch.questions[1]), /referenceAnswer|垫子/);
    const secondQuestion = advanced.body.batch.questions[1];
    const secondAnswer = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", {
      method: "POST",
      body: {
        batchId: advanced.body.batch.id,
        questionId: secondQuestion.id,
        attemptRequestId: secondQuestion.attemptRequestId,
        answer: "垫子"
      }
    });
    assert.equal(secondAnswer.response.status, 200);
    assert.equal(secondAnswer.body.batch.questions[1].result.gradingStatus, "correct");
    const completed = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/advance", {
      method: "POST",
      body: { batchId: secondAnswer.body.batch.id, questionId: secondAnswer.body.batch.questions[1].id }
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.batch.phase, "completed");
    const completedState = completed.body.state;
    assert.equal(completedState.attempts.length - initialState.attempts.length, 3);
    assert.equal(completedState.history["2026-08-16"].reviewed, 3);
    assert.equal(completedState.history["2026-08-16"].correct, 2);
    assert.deepEqual(new Set(completedState.sessions["2026-08-16"].doneTaskIds), new Set(["d1-man:en-zh", "d1-mat:en-zh"]));

    const advanceRetry = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/advance", {
      method: "POST",
      body: { batchId: completed.body.batch.id, questionId: completed.body.batch.questions[1].id }
    });
    assert.equal(advanceRetry.response.status, 200);
    assert.equal(advanceRetry.body.reused, true);
    assert.equal(advanceRetry.body.state.attempts.length, completedState.attempts.length);

    const archived = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", {
      method: "POST",
      body: { batchId: completed.body.batch.id }
    });
    assert.equal(archived.response.status, 200);
    const nextGroup = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "review-group-after-immediate", date: "2026-08-16", mode: "word", taskIds: ["d1-sat:en-zh"] }
    });
    assert.equal(nextGroup.response.status, 201);
    assert.equal(nextGroup.body.batch.gradingMode, "group");
    assert.notEqual(nextGroup.body.batch.id, completed.body.batch.id);
    assert.equal(nextGroup.body.batch.questions.some(question => completed.body.batch.questions.some(oldQuestion => oldQuestion.taskId === question.taskId)), false);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("per-question AI failure keeps the current sentence and writes zero formal evidence", async () => {
  const dataDir = temporaryDataDir();
  createAccounts(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    const cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const baseline = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", { method: "POST", body: { gradingMode: "immediate" } });
    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "review-immediate-ai-failure", date: "2026-08-16", mode: "sentence", taskIds: ["d1-s1:en-zh"] }
    });
    const question = started.body.batch.questions[0];
    const failed = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", {
      method: "POST",
      body: { batchId: started.body.batch.id, questionId: question.id, attemptRequestId: question.attemptRequestId, answer: "完全不相关" }
    });
    assert.equal(failed.response.status, 503);
    assert.match(failed.body.error, /尚未记分|not configured/);
    assert.equal(failed.body.batch.index, 0);
    assert.equal(failed.body.batch.questions[0].answer, "");
    assert.equal(failed.body.batch.questions[0].attemptRequestId, question.attemptRequestId);
    assert.doesNotMatch(JSON.stringify(failed.body.batch.questions[0]), /referenceAnswer/);
    const after = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.deepEqual(after.attempts, baseline.attempts);
    assert.deepEqual(after.mistakes, baseline.mistakes);
    assert.deepEqual(after.history, baseline.history);
    assert.deepEqual(after.taskStates, baseline.taskStates);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("formal grading repairs persisted pool meanings and rejects conflicting AI senses", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  const taskIds = writeWordBankContent(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const otherCookie = await login(app.baseUrl, "formal-other", "formal-other-password");
    await jsonRequest(app.baseUrl, cookie, "/api/state");
    await jsonRequest(app.baseUrl, otherCookie, "/api/state");
    await stopApp(app);
    app = null;

    const stateFile = path.join(dataDir, "user-states.json");
    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const pool = disk.users[owner.id].reviewVariantPool;
    pool.variants = [{
      id: "legacy-pool-pond",
      family: "inside",
      english: "A snake is in a pool.",
      chinese: "一条蛇在一个池塘里。",
      acceptedEnglish: ["a snake is in a pool"],
      acceptedChinese: ["一条蛇在一个池塘里。"],
      requiredWords: ["a", "snake", "is", "in", "pool"],
      source: "ai"
    }];
    pool.assignments = Object.fromEntries(taskIds.map(taskId => [taskId, "legacy-pool-pond"]));
    pool.status = "idle";
    fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");

    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const migrated = await jsonRequest(app.baseUrl, cookie, "/api/state");
    const migratedSentence = migrated.body.reviewVariantPool.sentences.find(item => item.id === "legacy-pool-pond");
    assert.equal(migratedSentence.chinese, "一条蛇在一个水池里。");
    assert.doesNotMatch(JSON.stringify(migratedSentence), /池塘/);
    const isolatedAfterRestart = await jsonRequest(app.baseUrl, await login(app.baseUrl, "formal-other", "formal-other-password"), "/api/state");
    assert.equal(isolatedAfterRestart.body.reviewVariantPool.sentences.some(item => item.id === "legacy-pool-pond"), false);
    const migratedDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const storedVariant = migratedDisk.users[owner.id].reviewVariantPool.variants.find(item => item.id === "legacy-pool-pond");
    assert.equal(storedVariant.chinese, "一条蛇在一个水池里。");
    assert.ok(storedVariant.acceptedChinese.includes("一条蛇在一个游泳池里。"));
    assert.ok(storedVariant.acceptedChinese.includes("一条蛇在一个泳池里。"));
    assert.doesNotMatch(JSON.stringify(storedVariant), /池塘/);
    const stableContents = fs.readFileSync(stateFile, "utf8");
    const stableMtime = fs.statSync(stateFile).mtimeMs;
    await jsonRequest(app.baseUrl, cookie, "/api/state");
    assert.equal(fs.readFileSync(stateFile, "utf8"), stableContents);
    assert.equal(fs.statSync(stateFile).mtimeMs, stableMtime);

    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: {
        batchId: "review-word-bank-meanings",
        date: "2026-08-16",
        mode: "sentence",
        taskIds,
        variantIds: Object.fromEntries(taskIds.map(taskId => [taskId, "legacy-pool-pond"]))
      }
    });
    assert.equal(started.response.status, 201);
    assert.deepEqual(started.body.batch.questions.map(question => question.prompt), taskIds.map(() => "A snake is in a pool."));
    assert.doesNotMatch(JSON.stringify(started.body.batch.questions), /池塘|referenceAnswer|acceptedChinese/);
    const answers = ["一条蛇在一个水池里", "一条蛇在一个游泳池里", "一条蛇在一个泳池里", "一条蛇在一个池塘里"];
    for (let index = 0; index < started.body.batch.questions.length; index += 1) {
      const drafted = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
        method: "PUT",
        body: {
          batchId: started.body.batch.id,
          questionId: started.body.batch.questions[index].id,
          index,
          nextIndex: Math.min(index + 1, started.body.batch.questions.length - 1),
          answer: answers[index]
        }
      });
      assert.equal(drafted.response.status, 200);
    }
    const review = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: started.body.batch.id } });
    const graded = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", {
      method: "POST",
      body: { batchId: started.body.batch.id, gradeRequestId: review.body.batch.gradeRequestId }
    });
    assert.equal(graded.response.status, 200, "the word-bank conflict must be graded locally instead of waiting for AI");
    assert.deepEqual(graded.body.batch.questions.map(question => question.result.gradingStatus), ["correct", "correct", "correct", "incorrect"]);
    assert.deepEqual(graded.body.batch.questions.map(question => question.result.score), [1, 1, 1, 0]);
    assert.equal(graded.body.batch.questions[3].result.source, "word-bank");
    assert.match(graded.body.batch.questions[3].result.explanation, /pool.*水池.*池塘/);
    assert.equal(graded.body.batch.questions.every(question => !question.referenceAnswer.includes("池塘")), true);
    assert.equal(graded.body.state.attempts.slice(-4).every(item => item.formalEvidence === true), true);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("formal review batches keep drafts private and write evidence once after whole-group grading", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const otherCookie = await login(app.baseUrl, "formal-other", "formal-other-password");
    const initialState = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;

    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: {
        batchId: "review-batch-fixed",
        date: "2026-08-09",
        mode: "word",
        taskIds: ["d1-man:en-zh", "d1-mat:zh-en"]
      }
    });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.batch.phase, "answering");
    assert.deepEqual(started.body.batch.questions.map(question => question.prompt), ["man", "垫子"]);
    assert.doesNotMatch(JSON.stringify(started.body), /acceptedChinese|acceptedEnglish|referenceAnswer|男人/);
    assert.equal(Object.hasOwn(started.body.batch.questions[0], "chinese"), false);
    assert.equal(Object.hasOwn(started.body.batch.questions[1], "english"), false);

    const isolated = await jsonRequest(app.baseUrl, otherCookie, "/api/review/batches");
    assert.equal(isolated.body.batch, null);

    const firstDraft = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
      method: "PUT",
      body: { batchId: "review-batch-fixed", questionId: started.body.batch.questions[0].id, index: 0, nextIndex: 1, answer: "男人" }
    });
    assert.equal(firstDraft.response.status, 200);
    assert.equal(firstDraft.body.batch.index, 1);
    assert.equal(firstDraft.body.batch.questions[0].answer, "男人");

    const blocked = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: "review-batch-fixed" } });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.missingIndex, 1);
    const beforeConfirmation = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.deepEqual(beforeConfirmation.attempts, initialState.attempts);
    assert.deepEqual(beforeConfirmation.taskStates, initialState.taskStates);
    assert.deepEqual(beforeConfirmation.history, initialState.history);

    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
      method: "PUT",
      body: { batchId: "review-batch-fixed", questionId: started.body.batch.questions[1].id, index: 1, nextIndex: 1, answer: "mat" }
    });
    const review = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: "review-batch-fixed" } });
    assert.equal(review.response.status, 200);
    assert.equal(review.body.batch.phase, "review");
    assert.ok(review.body.batch.gradeRequestId);
    assert.doesNotMatch(JSON.stringify(review.body), /acceptedChinese|acceptedEnglish|referenceAnswer/);

    const stalePut = await jsonRequest(app.baseUrl, cookie, "/api/state", { method: "PUT", body: { ...beforeConfirmation, formalPractice: null } });
    assert.equal(stalePut.response.status, 200);
    assert.equal(stalePut.body.formalPractice.review.current.phase, "review");

    await stopApp(app);
    const interruptedStateFile = path.join(dataDir, "user-states.json");
    const interruptedDisk = JSON.parse(fs.readFileSync(interruptedStateFile, "utf8"));
    interruptedDisk.users[owner.id].formalPractice.review.current.phase = "grading";
    interruptedDisk.users[owner.id].formalPractice.review.current.gradingStartedAt = new Date().toISOString();
    fs.writeFileSync(interruptedStateFile, `${JSON.stringify(interruptedDisk, null, 2)}\n`, "utf8");
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const restored = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(restored.body.batch.id, "review-batch-fixed");
    assert.equal(restored.body.batch.phase, "review");
    assert.match(restored.body.batch.lastError, /服务重启.*重新点击确认并批改/);
    assert.deepEqual(restored.body.batch.questions.map(question => question.answer), ["男人", "mat"]);

    const graded = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", {
      method: "POST",
      body: { batchId: "review-batch-fixed", gradeRequestId: restored.body.batch.gradeRequestId }
    });
    assert.equal(graded.response.status, 200);
    assert.equal(graded.body.batch.phase, "completed");
    assert.deepEqual(graded.body.batch.questions.map(question => question.result.correct), [true, true]);
    assert.deepEqual(graded.body.batch.questions.map(question => question.referenceAnswer), ["男人", "mat"]);
    const completedState = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.equal(completedState.attempts.length - initialState.attempts.length, 2);
    assert.equal(completedState.attempts.slice(-2).every(item => item.formalEvidence === true && item.batchId === "review-batch-fixed"), true);
    assert.equal(completedState.history["2026-08-09"].reviewed, 2);
    assert.equal(completedState.history["2026-08-09"].correct, 2);
    assert.deepEqual(completedState.sessions["2026-08-09"].doneTaskIds.sort(), ["d1-man:en-zh", "d1-mat:zh-en"].sort());

    const staleCompletionPut = await jsonRequest(app.baseUrl, cookie, "/api/state", {
      method: "PUT",
      body: {
        ...completedState,
        sessions: {
          ...completedState.sessions,
          "2026-08-09": { ...completedState.sessions["2026-08-09"], doneTaskIds: [], updatedAt: "2099-01-01T00:00:00.000Z" }
        }
      }
    });
    assert.equal(staleCompletionPut.response.status, 200);
    assert.deepEqual(staleCompletionPut.body.sessions["2026-08-09"].doneTaskIds.sort(), ["d1-man:en-zh", "d1-mat:zh-en"].sort());

    const repeated = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", {
      method: "POST",
      body: { batchId: "review-batch-fixed", gradeRequestId: restored.body.batch.gradeRequestId }
    });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.reused, true);
    const repeatedState = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.equal(repeatedState.attempts.length, completedState.attempts.length);
    assert.deepEqual(repeatedState.history, completedState.history);
    assert.deepEqual(repeatedState.taskStates, completedState.taskStates);

    const archived = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", {
      method: "POST",
      body: { batchId: "review-batch-fixed" }
    });
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.batch, null);
    assert.equal(archived.body.archivedBatchId, "review-batch-fixed");
    assert.equal(archived.body.state.sessions["2026-08-09"].batchId, "");
    assert.deepEqual(archived.body.state.sessions["2026-08-09"].taskIds, []);
    assert.equal(archived.body.state.sessions["2026-08-09"].batchComplete, true);
    assert.deepEqual(archived.body.state.sessions["2026-08-09"].retiredBatchIds, ["review-batch-fixed"]);
    assert.deepEqual(archived.body.state.sessions["2026-08-09"].doneTaskIds.sort(), ["d1-man:en-zh", "d1-mat:zh-en"].sort());

    const archiveRetry = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", {
      method: "POST",
      body: { batchId: "review-batch-fixed" }
    });
    assert.equal(archiveRetry.response.status, 200);
    assert.equal(archiveRetry.body.reused, true);

    const delayedOldPut = await jsonRequest(app.baseUrl, cookie, "/api/state", {
      method: "PUT",
      body: {
        ...archived.body.state,
        sessions: {
          ...archived.body.state.sessions,
          "2026-08-09": {
            ...completedState.sessions["2026-08-09"],
            batchId: "review-batch-fixed",
            taskIds: ["d1-man:en-zh", "d1-mat:zh-en"],
            index: 0,
            batchComplete: false,
            updatedAt: "2099-01-01T00:00:00.000Z"
          }
        }
      }
    });
    assert.equal(delayedOldPut.response.status, 200);
    assert.equal(delayedOldPut.body.sessions["2026-08-09"].batchId, "");
    assert.deepEqual(delayedOldPut.body.sessions["2026-08-09"].taskIds, []);
    assert.deepEqual(delayedOldPut.body.sessions["2026-08-09"].doneTaskIds.sort(), ["d1-man:en-zh", "d1-mat:zh-en"].sort());

    const blockedDuplicateStart = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: {
        batchId: "review-batch-stale-client",
        date: "2026-08-09",
        mode: "word",
        taskIds: ["d1-man:en-zh", "d2-sit:en-zh"]
      }
    });
    assert.equal(blockedDuplicateStart.response.status, 409);
    assert.equal(blockedDuplicateStart.body.code, "review_tasks_already_completed");
    assert.deepEqual(blockedDuplicateStart.body.completedTaskIds, ["d1-man:en-zh"]);
    assert.equal((await jsonRequest(app.baseUrl, cookie, "/api/review/batches")).body.batch, null);

    const nextStarted = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: {
        batchId: "review-batch-next",
        date: "2026-08-09",
        mode: "word",
        taskIds: ["d2-sit:en-zh", "d2-cat:zh-en"]
      }
    });
    assert.equal(nextStarted.response.status, 201);
    assert.notEqual(nextStarted.body.batch.id, "review-batch-fixed");
    assert.deepEqual(nextStarted.body.batch.questions.map(question => question.taskId), ["d2-sit:en-zh", "d2-cat:zh-en"]);
    assert.deepEqual(nextStarted.body.batch.questions.map(question => question.taskId).filter(taskId => completedState.sessions["2026-08-09"].doneTaskIds.includes(taskId)), []);

    await stopApp(app);
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const nextAfterRestart = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(nextAfterRestart.body.batch.id, "review-batch-next");
    assert.deepEqual(nextAfterRestart.body.batch.questions, nextStarted.body.batch.questions);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("two complete ten-question groups archive into different IDs with no repeated task or evidence", async () => {
  const dataDir = temporaryDataDir();
  createAccounts(dataDir);
  let app;
  const studyDate = "2026-08-16";
  const tasks = learnedWordReviewTasks(20);
  assert.equal(tasks.length, 20);
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const firstTasks = tasks.slice(0, 10);
    const secondTasks = tasks.slice(10, 20);
    const first = await completeReviewBatch(app.baseUrl, cookie, "review-batch-ten-a", studyDate, firstTasks);
    assert.equal(first.body.batch.questions.length, 10);
    assert.equal(first.body.state.sessions[studyDate].index, 10);
    assert.deepEqual(first.body.state.sessions[studyDate].doneTaskIds.sort(), firstTasks.map(item => item.taskId).sort());

    const firstArchive = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", {
      method: "POST",
      body: { batchId: "review-batch-ten-a" }
    });
    assert.equal(firstArchive.response.status, 200);
    assert.equal(firstArchive.body.batch, null);
    assert.equal(firstArchive.body.state.sessions[studyDate].batchId, "");
    assert.deepEqual(firstArchive.body.state.sessions[studyDate].taskIds, []);

    const secondStart = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "review-batch-ten-b", date: studyDate, mode: "word", taskIds: secondTasks.map(item => item.taskId) }
    });
    assert.equal(secondStart.response.status, 201);
    assert.notEqual(secondStart.body.batch.id, first.body.batch.id);
    const firstIds = new Set(first.body.batch.questions.map(question => question.taskId));
    assert.equal(secondStart.body.batch.questions.length, 10);
    assert.deepEqual(secondStart.body.batch.questions.map(question => question.taskId).filter(taskId => firstIds.has(taskId)), []);

    await stopApp(app);
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const restoredSecond = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(restoredSecond.body.batch.id, "review-batch-ten-b");
    assert.deepEqual(restoredSecond.body.batch.questions, secondStart.body.batch.questions);

    for (let index = 0; index < restoredSecond.body.batch.questions.length; index += 1) {
      const question = restoredSecond.body.batch.questions[index];
      const answer = secondTasks.find(item => item.taskId === question.taskId)?.answer || "";
      await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
        method: "PUT",
        body: { batchId: "review-batch-ten-b", questionId: question.id, index, nextIndex: Math.min(index + 1, 9), answer }
      });
    }
    const secondReview = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: "review-batch-ten-b" } });
    const secondGrade = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", {
      method: "POST",
      body: { batchId: "review-batch-ten-b", gradeRequestId: secondReview.body.batch.gradeRequestId }
    });
    assert.equal(secondGrade.body.batch.phase, "completed");
    const repeatedGrade = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", {
      method: "POST",
      body: { batchId: "review-batch-ten-b", gradeRequestId: secondReview.body.batch.gradeRequestId }
    });
    assert.equal(repeatedGrade.body.reused, true);
    assert.equal(repeatedGrade.body.state.attempts.length, 20);
    assert.equal(new Set(repeatedGrade.body.state.attempts.map(item => item.id)).size, 20);
    assert.deepEqual(new Set(repeatedGrade.body.state.sessions[studyDate].doneTaskIds), new Set(tasks.map(item => item.taskId)));
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent review starts converge, stay evidence-free, and survive relogin and restart", async () => {
  const dataDir = temporaryDataDir();
  createAccounts(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const before = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    const startBody = batchId => ({
      method: "POST",
      body: {
        batchId,
        date: "2026-08-15",
        mode: "word",
        taskIds: ["d1-man:en-zh", "d1-mat:zh-en"]
      }
    });
    const [left, right] = await Promise.all([
      jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", startBody("review-tab-left")),
      jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", startBody("review-tab-right"))
    ]);
    assert.deepEqual([left.response.status, right.response.status].sort(), [201, 409]);
    assert.equal(left.body.batch.id, right.body.batch.id);
    assert.deepEqual(left.body.batch.questions, right.body.batch.questions);

    const recovered = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.batch.id, left.body.batch.id);
    assert.deepEqual(recovered.body.batch.questions, left.body.batch.questions);
    const beforeRestart = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.deepEqual(beforeRestart.attempts, before.attempts);
    assert.deepEqual(beforeRestart.taskStates, before.taskStates);
    assert.deepEqual(beforeRestart.history, before.history);
    assert.deepEqual(beforeRestart.mistakes, before.mistakes);

    await stopApp(app);
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const afterRestart = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(afterRestart.body.batch.id, left.body.batch.id);
    assert.deepEqual(afterRestart.body.batch.questions, left.body.batch.questions);
    const retried = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", startBody(left.body.batch.id));
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.reused, true);
    assert.deepEqual(retried.body.batch.questions, left.body.batch.questions);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("legacy repeated batches retire empty state without evidence and protect drafts until an explicit choice", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  let app;
  const studyDate = "2026-08-15";
  const legacyBatchId = "review-legacy-repeated";
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: legacyBatchId, date: studyDate, mode: "word", taskIds: ["d1-man:en-zh", "d1-mat:zh-en"] }
    });
    for (let index = 0; index < started.body.batch.questions.length; index += 1) {
      const question = started.body.batch.questions[index];
      await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
        method: "PUT",
        body: { batchId: legacyBatchId, questionId: question.id, index, nextIndex: Math.min(index + 1, 1), answer: index === 0 ? "男人" : "mat" }
      });
    }
    const review = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: legacyBatchId } });
    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", { method: "POST", body: { batchId: legacyBatchId, gradeRequestId: review.body.batch.gradeRequestId } });
    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", { method: "POST", body: { batchId: legacyBatchId } });
    const baseline = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;

    const installLegacyDuplicate = async firstAnswer => {
      await stopApp(app);
      const stateFile = path.join(dataDir, "user-states.json");
      const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const accountState = disk.users[owner.id];
      const completed = accountState.formalPractice.review.history.find(item => item.id === legacyBatchId);
      const duplicate = JSON.parse(JSON.stringify(completed));
      duplicate.phase = "answering";
      duplicate.index = 0;
      duplicate.allowRepeat = false;
      duplicate.completedAt = "";
      duplicate.gradeRequestId = "";
      duplicate.questions = duplicate.questions.map((question, index) => ({
        ...question,
        answer: index === 0 ? firstAnswer : "",
        draftUpdatedAt: index === 0 && firstAnswer ? "2026-08-15T12:00:00.000Z" : "",
        result: null
      }));
      accountState.formalPractice.review.current = duplicate;
      accountState.sessions[studyDate] = {
        ...accountState.sessions[studyDate],
        taskIds: duplicate.questions.map(question => question.taskId),
        index: 0,
        currentTaskId: duplicate.questions[0].taskId,
        batchId: legacyBatchId,
        batchComplete: false,
        allowRepeat: false,
        retiredBatchIds: [],
        updatedAt: "2026-08-15T12:00:00.000Z"
      };
      fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
      app = await startApp(dataDir);
      cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    };

    await installLegacyDuplicate("");
    const retired = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "discard" }
    });
    assert.equal(retired.response.status, 200);
    assert.equal(retired.body.batch, null);
    assert.equal(retired.body.state.sessions[studyDate].batchId, "");
    assert.deepEqual(retired.body.state.sessions[studyDate].taskIds, []);
    assert.deepEqual(retired.body.state.sessions[studyDate].retiredBatchIds, [legacyBatchId]);
    assert.equal(retired.body.state.attempts.length, baseline.attempts.length);
    assert.deepEqual(retired.body.state.history, baseline.history);
    assert.deepEqual(retired.body.state.mistakes, baseline.mistakes);
    const retiredAgain = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "discard" }
    });
    assert.equal(retiredAgain.response.status, 200);
    assert.equal(retiredAgain.body.reused, true);

    await installLegacyDuplicate("男人");
    const blockedDiscard = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "discard" }
    });
    assert.equal(blockedDiscard.response.status, 409);
    assert.equal(blockedDiscard.body.requiresConfirmation, true);
    assert.equal(blockedDiscard.body.batch.questions[0].answer, "男人");
    const preserved = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(preserved.body.batch.questions[0].answer, "男人");

    const continued = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "continue" }
    });
    assert.equal(continued.response.status, 200);
    assert.notEqual(continued.body.batch.id, legacyBatchId);
    assert.equal(continued.body.batch.allowRepeat, true);
    assert.equal(continued.body.batch.recoveredFromBatchId, legacyBatchId);
    assert.equal(continued.body.batch.questions[0].answer, "男人");
    assert.equal(continued.body.state.sessions[studyDate].batchId, continued.body.batch.id);
    assert.ok(continued.body.state.sessions[studyDate].retiredBatchIds.includes(legacyBatchId));
    assert.equal(continued.body.state.attempts.length, baseline.attempts.length);
    assert.deepEqual(continued.body.state.history, baseline.history);
    assert.deepEqual(continued.body.state.mistakes, baseline.mistakes);
    const lostContinueResponseRetry = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "continue" }
    });
    assert.equal(lostContinueResponseRetry.response.status, 200);
    assert.equal(lostContinueResponseRetry.body.reused, true);
    assert.equal(lostContinueResponseRetry.body.batch.id, continued.body.batch.id);
    assert.equal(lostContinueResponseRetry.body.batch.questions[0].answer, "男人");
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("per-question repeated drafts require explicit discard and retire without losing formal evidence", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  const studyDate = "2026-08-16";
  const originalBatchId = "review-immediate-original";
  const legacyBatchId = "review-immediate-legacy-draft";
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const selected = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/mode", {
      method: "POST",
      body: { gradingMode: "immediate" }
    });
    assert.equal(selected.response.status, 200);
    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: {
        batchId: originalBatchId,
        date: studyDate,
        mode: "word",
        taskIds: ["d1-man:en-zh", "d1-mat:en-zh"]
      }
    });
    assert.equal(started.response.status, 201);
    const answers = { "d1-man:en-zh": "男人", "d1-mat:en-zh": "垫子" };
    for (const question of started.body.batch.questions) {
      const answered = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/answer", {
        method: "POST",
        body: {
          batchId: originalBatchId,
          questionId: question.id,
          attemptRequestId: question.attemptRequestId,
          answer: answers[question.taskId]
        }
      });
      assert.equal(answered.response.status, 200);
      const advanced = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/advance", {
        method: "POST",
        body: { batchId: originalBatchId, questionId: question.id }
      });
      assert.equal(advanced.response.status, 200);
    }
    const archived = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", {
      method: "POST",
      body: { batchId: originalBatchId }
    });
    assert.equal(archived.response.status, 200);
    const baseline = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    assert.equal(baseline.attempts.length, 2);

    await stopApp(app);
    app = null;
    const stateFile = path.join(dataDir, "user-states.json");
    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const accountState = disk.users[owner.id];
    const completed = accountState.formalPractice.review.history.find(item => item.id === originalBatchId);
    assert.ok(completed, "the completed immediate batch must remain authoritative history");
    const duplicate = JSON.parse(JSON.stringify(completed));
    duplicate.id = legacyBatchId;
    duplicate.phase = "answering";
    duplicate.gradingMode = "immediate";
    duplicate.index = 0;
    duplicate.allowRepeat = false;
    duplicate.completedAt = "";
    duplicate.gradeRequestId = "";
    duplicate.questions = duplicate.questions.map((question, index) => ({
      ...question,
      answer: index === 0 ? "暂存答案" : "",
      draftUpdatedAt: index === 0 ? "2026-08-16T12:00:00.000Z" : "",
      result: null,
      completedAt: "",
      attempts: [],
      attemptRequestId: `reviewattempt-legacy-${index}`
    }));
    accountState.formalPractice.review.current = duplicate;
    accountState.sessions[studyDate] = {
      ...accountState.sessions[studyDate],
      date: studyDate,
      taskIds: duplicate.questions.map(question => question.taskId),
      doneTaskIds: [],
      index: 0,
      currentTaskId: duplicate.questions[0].taskId,
      batchId: legacyBatchId,
      batchComplete: false,
      allowRepeat: false,
      retiredBatchIds: [],
      updatedAt: "2026-08-16T12:00:00.000Z"
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");

    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const automatic = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "discard", confirmDiscard: false }
    });
    assert.equal(automatic.response.status, 409);
    assert.equal(automatic.body.code, "review_repeat_requires_explicit_choice");
    assert.equal(automatic.body.requiresConfirmation, true);
    assert.equal(automatic.body.batch.id, legacyBatchId);
    assert.equal(automatic.body.batch.questions[0].answer, "", "unsubmitted immediate drafts must stay private");
    const blockedDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(blockedDisk.users[owner.id].formalPractice.review.current.questions[0].answer, "暂存答案");
    assert.equal(blockedDisk.users[owner.id].attempts.length, baseline.attempts.length);

    const continued = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "continue" }
    });
    assert.equal(continued.response.status, 200);
    assert.notEqual(continued.body.batch.id, legacyBatchId);
    assert.equal(continued.body.batch.recoveredFromBatchId, legacyBatchId);
    assert.equal(continued.body.state.attempts.length, baseline.attempts.length);
    assert.deepEqual(continued.body.state.history, baseline.history);
    const continuedBatchId = continued.body.batch.id;
    const continuedDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(continuedDisk.users[owner.id].formalPractice.review.current.id, continuedBatchId);
    assert.equal(continuedDisk.users[owner.id].formalPractice.review.current.questions[0].answer, "暂存答案");

    const continuedAgain = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "continue" }
    });
    assert.equal(continuedAgain.response.status, 200);
    assert.equal(continuedAgain.body.reused, true);
    assert.equal(continuedAgain.body.batch.id, continuedBatchId);

    await stopApp(app);
    app = null;
    const discardBatchId = "review-immediate-legacy-discard";
    const discardDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const discardState = discardDisk.users[owner.id];
    discardState.formalPractice.review.current.id = discardBatchId;
    discardState.formalPractice.review.current.allowRepeat = false;
    discardState.formalPractice.review.current.recoveredFromBatchId = "";
    discardState.sessions[studyDate] = {
      ...discardState.sessions[studyDate],
      batchId: discardBatchId,
      allowRepeat: false,
      batchComplete: false,
      currentTaskId: discardState.formalPractice.review.current.questions[0].taskId,
      updatedAt: "2026-08-16T12:05:00.000Z"
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(discardDisk, null, 2)}\n`, "utf8");
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");

    const discarded = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: discardBatchId, action: "discard", confirmDiscard: true }
    });
    assert.equal(discarded.response.status, 200);
    assert.equal(discarded.body.batch, null);
    assert.equal(discarded.body.state.attempts.length, baseline.attempts.length);
    assert.deepEqual(discarded.body.state.history, baseline.history);
    assert.ok(discarded.body.state.sessions[studyDate].retiredBatchIds.includes(discardBatchId));
    assert.deepEqual(new Set(discarded.body.state.sessions[studyDate].doneTaskIds), new Set(["d1-man:en-zh", "d1-mat:en-zh"]));

    const retried = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: discardBatchId, action: "discard", confirmDiscard: true }
    });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.reused, true);
    assert.equal(retried.body.batch, null);

    await stopApp(app);
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const restored = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(restored.body.batch, null);
    assert.ok(restored.body.state.sessions[studyDate].retiredBatchIds.includes(discardBatchId));
    assert.equal(restored.body.state.attempts.length, baseline.attempts.length);

    const nextTask = learnedWordReviewTasks(8).find(item => !["d1-man:en-zh", "d1-mat:en-zh"].includes(item.taskId));
    assert.ok(nextTask, "a non-completed task is required for the replacement batch");
    const replacement = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "review-immediate-replacement", date: studyDate, mode: "word", taskIds: [nextTask.taskId] }
    });
    assert.equal(replacement.response.status, 201);
    assert.notEqual(replacement.body.batch.id, legacyBatchId);
    assert.notEqual(replacement.body.batch.id, discardBatchId);
    assert.equal(new Set(["d1-man:en-zh", "d1-mat:en-zh"]).has(replacement.body.batch.questions[0].taskId), false);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("completed formal evidence repairs a missing doneTaskIds index before an empty legacy batch retires", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  let app;
  const studyDate = "2026-08-16";
  const legacyBatchId = "review-legacy-missing-completion-index";
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const started = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: legacyBatchId, date: studyDate, mode: "word", taskIds: ["d1-man:en-zh", "d1-mat:zh-en"] }
    });
    for (let index = 0; index < started.body.batch.questions.length; index += 1) {
      const question = started.body.batch.questions[index];
      await jsonRequest(app.baseUrl, cookie, "/api/review/batches/draft", {
        method: "PUT",
        body: { batchId: legacyBatchId, questionId: question.id, index, nextIndex: Math.min(index + 1, 1), answer: index === 0 ? "男人" : "mat" }
      });
    }
    const review = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/review", { method: "POST", body: { batchId: legacyBatchId } });
    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/grade", { method: "POST", body: { batchId: legacyBatchId, gradeRequestId: review.body.batch.gradeRequestId } });
    await jsonRequest(app.baseUrl, cookie, "/api/review/batches/archive", { method: "POST", body: { batchId: legacyBatchId } });
    const baseline = (await jsonRequest(app.baseUrl, cookie, "/api/state")).body;
    const baselineAttempts = baseline.attempts.length;
    const baselineHistory = JSON.parse(JSON.stringify(baseline.history));

    await stopApp(app);
    app = null;
    const stateFile = path.join(dataDir, "user-states.json");
    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const accountState = disk.users[owner.id];
    const completed = accountState.formalPractice.review.history.find(item => item.id === legacyBatchId);
    const duplicate = JSON.parse(JSON.stringify(completed));
    duplicate.phase = "answering";
    duplicate.index = 0;
    duplicate.allowRepeat = false;
    duplicate.completedAt = "";
    duplicate.gradeRequestId = "";
    duplicate.questions = duplicate.questions.map(question => ({ ...question, answer: "", draftUpdatedAt: "", result: null }));
    accountState.formalPractice.review.current = duplicate;
    accountState.sessions[studyDate] = {
      ...accountState.sessions[studyDate],
      taskIds: duplicate.questions.map(question => question.taskId),
      index: 0,
      doneTaskIds: [],
      currentTaskId: duplicate.questions[0].taskId,
      batchId: legacyBatchId,
      batchComplete: false,
      allowRepeat: false,
      retiredBatchIds: [],
      updatedAt: "2026-08-16T12:00:00.000Z"
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");

    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const beforeRead = fs.statSync(stateFile);
    const beforeContents = fs.readFileSync(stateFile, "utf8");
    const beforeResolve = await jsonRequest(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(beforeResolve.body.batch.id, legacyBatchId);
    assert.deepEqual(new Set(beforeResolve.body.state.sessions[studyDate].doneTaskIds), new Set(duplicate.questions.map(question => question.taskId)));
    const afterRead = fs.statSync(stateFile);
    assert.equal(fs.readFileSync(stateFile, "utf8"), beforeContents, "the authoritative completion projection must remain read-only");
    assert.equal(afterRead.mtimeMs, beforeRead.mtimeMs, "a recovery GET must not rewrite account state");
    const retired = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: legacyBatchId, action: "discard" }
    });
    assert.equal(retired.response.status, 200);
    assert.equal(retired.body.batch, null);
    assert.deepEqual(new Set(retired.body.state.sessions[studyDate].doneTaskIds), new Set(duplicate.questions.map(question => question.taskId)));
    assert.ok(retired.body.state.sessions[studyDate].retiredBatchIds.includes(legacyBatchId));
    assert.equal(retired.body.state.attempts.length, baselineAttempts);
    assert.deepEqual(retired.body.state.history, baselineHistory);
    assert.equal(retired.body.state.mistakes.length, baseline.mistakes.length);

    await stopApp(app);
    app = null;
    const rejectedDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const rejectedState = rejectedDisk.users[owner.id];
    const unprovenId = "review-unproven-empty";
    const unproven = { ...JSON.parse(JSON.stringify(duplicate)), id: unprovenId };
    rejectedState.formalPractice.review.current = unproven;
    rejectedState.formalPractice.review.history = [];
    rejectedState.attempts = [];
    rejectedState.sessions[studyDate] = {
      ...rejectedState.sessions[studyDate],
      taskIds: unproven.questions.map(question => question.taskId),
      index: 0,
      doneTaskIds: unproven.questions.map(question => question.taskId),
      currentTaskId: unproven.questions[0].taskId,
      batchId: unprovenId,
      batchComplete: false,
      retiredBatchIds: [],
      updatedAt: "2026-08-16T13:00:00.000Z"
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(rejectedDisk, null, 2)}\n`, "utf8");
    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const rejected = await jsonRequest(app.baseUrl, cookie, "/api/review/batches/resolve-repeat", {
      method: "POST",
      body: { batchId: unprovenId, action: "discard" }
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.code, "review_repeat_not_confirmed");
    assert.equal(rejected.body.batch.id, unprovenId);
    assert.deepEqual(rejected.body.batch.questions.map(question => question.answer), ["", ""]);
    assert.deepEqual(new Set(rejected.body.state.sessions[studyDate].doneTaskIds), new Set(unproven.questions.map(question => question.taskId)));
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sentence-pool statistics are account-isolated, date-filtered, stable, and read-only", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const otherCookieBeforeRestart = await login(app.baseUrl, "formal-other", "formal-other-password");
    await jsonRequest(app.baseUrl, cookie, "/api/state");
    await jsonRequest(app.baseUrl, otherCookieBeforeRestart, "/api/state");
    await stopApp(app);
    app = null;

    const stateFile = path.join(dataDir, "user-states.json");
    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const state = disk.users[owner.id];
    const basePool = state.reviewVariantPool;
    basePool.variants = [
      { id: "pool-a", family: "identity", english: "I am Sam.", chinese: "我是萨姆。", acceptedChinese: ["我是萨姆"], acceptedEnglish: ["i am sam"], requiredWords: ["i", "am", "sam"] },
      { id: "pool-b", family: "description", english: "It is big.", chinese: "它很大。", acceptedChinese: ["它很大"], acceptedEnglish: ["it is big"], requiredWords: ["it", "is", "big"] },
      { id: "pool-c", family: "sat-on", english: "I sat on a mat.", chinese: "我坐在一张垫子上。", acceptedChinese: ["我坐在一张垫子上"], acceptedEnglish: ["i sat on a mat"], requiredWords: ["i", "sat", "on", "a", "mat"] }
    ];
    basePool.assignments = { "d1-s1:en-zh": "pool-a", "d2-s5:en-zh": "pool-b", "d1-s2:en-zh": "pool-c" };
    state.attempts = [
      { id: "formal-a-correct", variantId: "pool-a", date: "2026-08-08", submittedAt: "2026-08-08T08:00:00.000Z", correct: true, score: 1, gradingStatus: "correct", formalEvidence: true },
      { id: "formal-a-partial", variantId: "pool-a", date: "2026-08-09", submittedAt: "2026-08-09T08:00:00.000Z", correct: true, score: 0.8, gradingStatus: "partial", formalEvidence: true },
      { id: "formal-b-wrong", variantId: "pool-b", date: "2026-08-09", submittedAt: "2026-08-09T09:00:00.000Z", correct: false, score: 0, gradingStatus: "incorrect", formalEvidence: true },
      { id: "preview-a", variantId: "pool-a", date: "2026-08-09", submittedAt: "2026-08-09T10:00:00.000Z", correct: false, score: 0, gradingStatus: "incorrect", formalEvidence: false }
    ];
    state.sentencePracticeEvents = [
      { id: "archived-formal-a", variantId: "pool-a", date: "2026-08-06", practicedAt: "2026-08-06T08:00:00.000Z", correct: true, source: "review" }
    ];
    state.aiPractice = {
      history: [
        { id: "ai-b-correct", setId: "set-b", poolVariantId: "pool-b", date: "2026-08-09", answeredAt: "2026-08-09T11:00:00.000Z", direction: "en-zh", prompt: "It is big.", userAnswer: "它很大", correctAnswer: "它很大。", correct: true, score: 1, gradingStatus: "correct" },
        { id: "ai-c-partial", setId: "set-c", poolVariantId: "pool-c", date: "2026-08-07", answeredAt: "2026-08-07T11:00:00.000Z", direction: "en-zh", prompt: "I sat on a mat.", userAnswer: "我坐在垫子", correctAnswer: "我坐在一张垫子上。", correct: true, score: 0.8, gradingStatus: "partial" }
      ]
    };
    fs.writeFileSync(stateFile, `${JSON.stringify(disk, null, 2)}\n`, "utf8");

    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "formal-owner", "formal-owner-password");
    const initialized = await jsonRequest(app.baseUrl, cookie, "/api/review/sentence-stats");
    assert.equal(initialized.response.status, 200);
    const byId = new Map(initialized.body.stats.map(item => [item.id, item]));
    assert.deepEqual({ attempts: byId.get("pool-a").attempts, correct: byId.get("pool-a").correct, wrong: byId.get("pool-a").wrong, accuracy: byId.get("pool-a").accuracy }, { attempts: 3, correct: 2, wrong: 1, accuracy: 67 });
    assert.deepEqual({ attempts: byId.get("pool-b").attempts, correct: byId.get("pool-b").correct, wrong: byId.get("pool-b").wrong, accuracy: byId.get("pool-b").accuracy }, { attempts: 2, correct: 1, wrong: 1, accuracy: 50 });
    assert.deepEqual({ attempts: byId.get("pool-c").attempts, correct: byId.get("pool-c").correct, wrong: byId.get("pool-c").wrong, accuracy: byId.get("pool-c").accuracy }, { attempts: 1, correct: 0, wrong: 1, accuracy: 0 });
    assert.doesNotMatch(JSON.stringify(initialized.body), /userAnswer|correctAnswer|acceptedChinese|acceptedEnglish|preview-a/);
    const publicState = await jsonRequest(app.baseUrl, cookie, "/api/state");
    assert.equal(Object.hasOwn(publicState.body, "sentencePracticeEvents"), false);

    const stateText = fs.readFileSync(stateFile, "utf8");
    const stateMtime = fs.statSync(stateFile).mtimeMs;
    const dated = await jsonRequest(app.baseUrl, cookie, "/api/review/sentence-stats?from=2026-08-09&to=2026-08-09&sort=attempts&order=desc");
    assert.equal(dated.response.status, 200);
    assert.deepEqual(dated.body.stats.slice(0, 2).map(item => item.id), ["pool-b", "pool-a"]);
    const datedById = new Map(dated.body.stats.map(item => [item.id, item]));
    assert.deepEqual({ attempts: datedById.get("pool-a").attempts, correct: datedById.get("pool-a").correct, wrong: datedById.get("pool-a").wrong }, { attempts: 1, correct: 0, wrong: 1 });
    assert.deepEqual({ attempts: datedById.get("pool-b").attempts, correct: datedById.get("pool-b").correct, wrong: datedById.get("pool-b").wrong }, { attempts: 2, correct: 1, wrong: 1 });
    assert.equal(fs.readFileSync(stateFile, "utf8"), stateText);
    assert.equal(fs.statSync(stateFile).mtimeMs, stateMtime);

    const invalidDates = await jsonRequest(app.baseUrl, cookie, "/api/review/sentence-stats?from=2026-08-10&to=2026-08-09");
    assert.equal(invalidDates.response.status, 400);
    assert.match(invalidDates.body.error, /开始日期不能晚于结束日期/);
    const impossibleDate = await jsonRequest(app.baseUrl, cookie, "/api/review/sentence-stats?from=2026-02-30");
    assert.equal(impossibleDate.response.status, 400);
    assert.match(impossibleDate.body.error, /开始日期格式不正确/);
    const otherCookie = await login(app.baseUrl, "formal-other", "formal-other-password");
    const isolated = await jsonRequest(app.baseUrl, otherCookie, "/api/review/sentence-stats");
    assert.equal(isolated.body.stats.some(item => ["pool-a", "pool-b", "pool-c"].includes(item.id)), false);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
