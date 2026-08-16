"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-state-performance-"));
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

async function startApp(dataDir) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false", REVIEW_VARIANT_POOL_AUTOFILL: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { baseUrl, child };
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  app.child.kill();
  await once(app.child, "exit");
}

function createAccounts(dataDir) {
  const store = loadUsers(dataDir);
  const owner = createUser(store, { username: "performance-owner", password: "performance-owner-password", role: "admin" });
  const other = createUser(store, { username: "performance-other", password: "performance-other-password" });
  saveUsers(dataDir, store);
  return { owner, other };
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
    headers: { Cookie: cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { response, body: await response.json() };
}

function largeAiHistory() {
  const detail = "仅用于性能回归的脱敏历史说明。".repeat(18);
  return Array.from({ length: 1000 }, (_, index) => ({
    id: `large-history-${index}`,
    setId: `large-set-${Math.floor(index / 5)}`,
    answeredAt: `2026-08-${String(index % 16 + 1).padStart(2, "0")}T00:00:00.000Z`,
    date: `2026-08-${String(index % 16 + 1).padStart(2, "0")}`,
    direction: "en-zh",
    prompt: "man",
    userAnswer: "男人",
    correctAnswer: "男人",
    correct: true,
    score: 1,
    gradingStatus: "correct",
    explanation: detail,
    detailedExplanation: detail,
    formalEvidence: true
  }));
}

function largeTutorHistory() {
  const detail = "脱敏问答内容。".repeat(35);
  return Array.from({ length: 1000 }, (_, index) => ({
    id: `large-tutor-${index}`,
    setId: `large-set-${Math.floor(index / 5)}`,
    questionId: `large-question-${index}`,
    question: detail,
    answer: detail,
    askedAt: `2026-08-16T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    answeredAt: `2026-08-16T00:${String(index % 60).padStart(2, "0")}:01.000Z`,
    formalEvidence: false
  }));
}

test("large account review writes stay narrow, preserve protected history, and remain read-idempotent", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  const stateFile = path.join(dataDir, "user-states.json");
  let app;
  try {
    app = await startApp(dataDir);
    let cookie = await login(app.baseUrl, "performance-owner", "performance-owner-password");
    await request(app.baseUrl, cookie, "/api/state");
    await stopApp(app);
    app = null;

    const disk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const account = disk.users[owner.id];
    account.aiPractice.history = largeAiHistory();
    account.aiPractice.tutorHistory = largeTutorHistory();
    account.formalPractice.review.gradingMode = "immediate";
    account.repairSignature = "force-one-startup-migration";
    fs.writeFileSync(stateFile, `${JSON.stringify(disk)}\n`, "utf8");

    app = await startApp(dataDir);
    cookie = await login(app.baseUrl, "performance-owner", "performance-owner-password");
    const initialized = await request(app.baseUrl, cookie, "/api/state");
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.aiPractice.history.length, 1000);
    assert.equal(Object.hasOwn(initialized.body, "repairSignature"), false);
    assert.ok(fs.statSync(stateFile).size > 900000, "fixture should stay close to a real large account state");

    const started = await request(app.baseUrl, cookie, "/api/review/batches/start", {
      method: "POST",
      body: { batchId: "large-state-review", date: "2026-08-16", mode: "word", taskIds: ["d1-man:en-zh"] }
    });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.batch.gradingMode, "immediate");
    const question = started.body.batch.questions[0];
    const answered = await request(app.baseUrl, cookie, "/api/review/batches/answer", {
      method: "POST",
      body: { batchId: started.body.batch.id, questionId: question.id, attemptRequestId: question.attemptRequestId, answer: "男人" }
    });
    assert.equal(answered.response.status, 200);
    assert.equal(answered.body.batch.questions[0].result.correct, true);
    assert.equal(Object.hasOwn(answered.body.state, "aiPractice"), false);
    assert.equal(Object.hasOwn(answered.body.state, "formalPractice"), false);
    assert.equal(Object.hasOwn(answered.body.state, "reviewVariantPool"), false);
    assert.doesNotMatch(JSON.stringify(answered.body), /large-history-999|large-tutor-999/);

    const advanced = await request(app.baseUrl, cookie, "/api/review/batches/advance", {
      method: "POST",
      body: { batchId: started.body.batch.id, questionId: question.id }
    });
    assert.equal(advanced.response.status, 200);
    assert.equal(advanced.body.batch.phase, "completed");
    assert.equal(Object.hasOwn(advanced.body.state, "aiPractice"), false);

    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")).users[owner.id];
    assert.equal(persisted.aiPractice.history.length, 1000);
    assert.equal(persisted.aiPractice.tutorHistory.length, 1000);
    assert.equal(persisted.attempts.at(-1).answer, "男人");
    const stableText = fs.readFileSync(stateFile, "utf8");
    const stableMtime = fs.statSync(stateFile).mtimeMs;
    await request(app.baseUrl, cookie, "/api/review/batches");
    await request(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(fs.readFileSync(stateFile, "utf8"), stableText);
    assert.equal(fs.statSync(stateFile).mtimeMs, stableMtime);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("lightweight study-time and partial state saves preserve evidence and account isolation", async () => {
  const dataDir = temporaryDataDir();
  const { owner, other } = createAccounts(dataDir);
  const stateFile = path.join(dataDir, "user-states.json");
  let app;
  try {
    app = await startApp(dataDir);
    const ownerCookie = await login(app.baseUrl, "performance-owner", "performance-owner-password");
    const otherCookie = await login(app.baseUrl, "performance-other", "performance-other-password");
    await request(app.baseUrl, ownerCookie, "/api/state", {
      method: "PUT",
      body: {
        taskStates: { "d1-man:en-zh": { level: 2, reviewCount: 2, lastReviewed: "2026-08-16", lastResult: true } },
        attempts: [{ id: "owner-attempt", taskId: "d1-man:en-zh", date: "2026-08-16", answer: "男人", correct: true, formalEvidence: true }],
        history: { "2026-08-16": { reviewed: 1, correct: 1 } }
      }
    });
    await request(app.baseUrl, otherCookie, "/api/state");

    const timed = await request(app.baseUrl, ownerCookie, "/api/state/study-time", {
      method: "PUT",
      body: { studyTime: { daily: { "2026-08-16": 120 }, updatedAt: "2026-08-16T01:00:00.000Z" } }
    });
    assert.equal(timed.response.status, 200);
    assert.equal(timed.body.studyTime.daily["2026-08-16"], 120);
    const afterTimed = await request(app.baseUrl, ownerCookie, "/api/state");
    assert.equal(afterTimed.body.taskStates["d1-man:en-zh"].reviewCount, 2);
    assert.equal(afterTimed.body.attempts.some(item => item.id === "owner-attempt"), true);

    const stableText = fs.readFileSync(stateFile, "utf8");
    const stableMtime = fs.statSync(stateFile).mtimeMs;
    await request(app.baseUrl, ownerCookie, "/api/state/study-time", {
      method: "PUT",
      body: { studyTime: timed.body.studyTime }
    });
    assert.equal(fs.readFileSync(stateFile, "utf8"), stableText);
    assert.equal(fs.statSync(stateFile).mtimeMs, stableMtime);

    const partial = await request(app.baseUrl, ownerCookie, "/api/state", {
      method: "PUT",
      body: { studyTime: { daily: { "2026-08-16": 180 } }, aiPractice: {}, formalPractice: {}, selfStudy: {} }
    });
    assert.equal(partial.response.status, 200);
    assert.equal(partial.body.studyTime.daily["2026-08-16"], 180);
    assert.equal(partial.body.taskStates["d1-man:en-zh"].reviewCount, 2);
    assert.equal(partial.body.attempts.some(item => item.id === "owner-attempt"), true);

    await request(app.baseUrl, otherCookie, "/api/state/study-time", {
      method: "PUT",
      body: { studyTime: { daily: { "2026-08-16": 45 } } }
    });
    const ownerState = JSON.parse(fs.readFileSync(stateFile, "utf8")).users[owner.id];
    const otherState = JSON.parse(fs.readFileSync(stateFile, "utf8")).users[other.id];
    assert.equal(ownerState.studyTime.daily["2026-08-16"], 180);
    assert.equal(otherState.studyTime.daily["2026-08-16"], 45);
    assert.equal(otherState.attempts.some(item => item.id === "owner-attempt"), false);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("content changes invalidate one repair signature and later reads stay write-free", async () => {
  const dataDir = temporaryDataDir();
  const { owner } = createAccounts(dataDir);
  const stateFile = path.join(dataDir, "user-states.json");
  let app;
  try {
    app = await startApp(dataDir);
    const cookie = await login(app.baseUrl, "performance-owner", "performance-owner-password");
    await request(app.baseUrl, cookie, "/api/state");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8")).users[owner.id];
    assert.ok(before.repairSignature);

    const content = await (await fetch(`${app.baseUrl}/api/content`)).json();
    const man = content.words.find(item => item.id === "d1-man");
    const patched = await request(app.baseUrl, cookie, `/api/content/${encodeURIComponent(man.id)}`, {
      method: "PATCH",
      body: { acceptedChinese: Array.from(new Set([...(man.acceptedChinese || []), "男子"])) }
    });
    assert.equal(patched.response.status, 200);
    assert.ok(patched.body.acceptedChinese.includes("男子"));
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).users[owner.id].repairSignature, before.repairSignature, "content writes must not eagerly rewrite every account");

    await request(app.baseUrl, cookie, "/api/review/batches");
    const repairedText = fs.readFileSync(stateFile, "utf8");
    const repairedMtime = fs.statSync(stateFile).mtimeMs;
    const repaired = JSON.parse(repairedText).users[owner.id];
    assert.notEqual(repaired.repairSignature, before.repairSignature);
    const publicState = await request(app.baseUrl, cookie, "/api/state");
    assert.equal(Object.hasOwn(publicState.body, "repairSignature"), false);
    assert.equal(fs.readFileSync(stateFile, "utf8"), repairedText);
    assert.equal(fs.statSync(stateFile).mtimeMs, repairedMtime);
    await request(app.baseUrl, cookie, "/api/review/batches");
    assert.equal(fs.readFileSync(stateFile, "utf8"), repairedText);
    assert.equal(fs.statSync(stateFile).mtimeMs, repairedMtime);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
