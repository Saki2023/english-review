"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");
const { deriveLearningSyncToken, deriveTeachingProfileWriteToken } = require("../server/learning-sync-token");

const ROOT = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("server did not become healthy");
}

function startServer(dataDir, port, apiToken, extraEnv = {}) {
  return spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), API_TOKEN: apiToken, COOKIE_SECURE: "false", REVIEW_VARIANT_POOL_AUTOFILL: "false", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
}

function choice(stepId, category, overrides = {}) {
  return {
    stepId,
    type: "choice",
    category,
    prompt: "It is a cat.",
    choices: [{ id: "A", text: "A" }, { id: "B", text: "B" }],
    acceptedAnswers: ["A"],
    correctionHint: "当前选择不正确，请重新检查题干。",
    ...overrides
  };
}

function courseLesson(lessonId, day, word, chinese, version = "1") {
  return {
    lessonId,
    studyDay: day,
    title: `第 ${day} 天完整自学课程`,
    version,
    enabledFrom: "2026-08-01T00:00:00.000Z",
    plannedContent: {
      words: [{ id: `travel-d${day}-${word}`, english: word, chinese, phonetic: `/${word}/`, pronunciation: word, directions: ["en-zh", "zh-en"] }],
      sentences: [{ id: `travel-d${day}-sentence`, english: `It is a ${word}.`, chinese: `它是一只${chinese}。`, directions: ["en-zh", "zh-en"] }],
      note: { summary: `学习 ${word}。`, review: `明天复习 ${word}。` }
    },
    stages: [
      { stageId: "review", type: "review", title: "旧知识复习", steps: [choice("review-1", "review")] },
      { stageId: "phonics", type: "phonics", title: "拼读与词汇", steps: [{ stepId: "teach-word", type: "teach", content: word, phonetic: `/${word}/`, pronunciation: word }] },
      { stageId: "pattern", type: "pattern", title: "句子结构", steps: [{ stepId: "teach-pattern", type: "teach", content: `It is a ${word}.` }] },
      { stageId: "reading", type: "reading", title: "阅读与翻译", steps: [{ stepId: "read-sentence", type: "read-aloud", content: `It is a ${word}.` }] },
      {
        stageId: "test",
        type: "test",
        title: "测验与订正",
        steps: [
          choice("test-p-1", "phonics"),
          choice("test-p-2", "phonics"),
          choice("test-ez-1", "en-zh", { type: "en-zh", direction: "en-zh", prompt: word, english: word, acceptedAnswers: [chinese] }),
          choice("test-ez-2", "en-zh", { type: "en-zh", direction: "en-zh", prompt: `It is a ${word}.`, english: `It is a ${word}.`, acceptedAnswers: [`它是一只${chinese}`] }),
          choice("test-ze-1", "zh-en", { type: "zh-en", direction: "zh-en", prompt: chinese, english: word, acceptedAnswers: [word], contentId: `travel-d${day}-${word}` }),
          choice("test-ze-2", "zh-en", { type: "zh-en", direction: "zh-en", prompt: `它是一只${chinese}。`, english: `It is a ${word}.`, acceptedAnswers: [`It is a ${word}.`], contentId: `travel-d${day}-sentence` }),
          choice("test-r-1", "reading"),
          choice("test-r-2", "reading"),
          choice("test-r-3", "reading"),
          choice("test-r-4", "reading")
        ]
      },
      { stageId: "summary", type: "summary", title: "总结与预习", steps: [{ stepId: "summary-1", type: "summary", prompt: "请用中文总结今天的内容。" }] }
    ],
    nextPreview: "下一课继续学习。"
  };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

async function request(baseUrl, cookie, pathName, method = "GET", body) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function answerForStep(step, word, chinese) {
  if (["teach", "read-aloud"].includes(step.type)) return "已完成";
  if (step.type === "summary") return `我学会了 ${word}。`;
  if (step.stepId === "test-ez-1") return chinese;
  if (step.stepId === "test-ez-2") return `它是一只${chinese}`;
  if (step.stepId === "test-ze-1") return word;
  if (step.stepId === "test-ze-2") return `It is a ${word}.`;
  return "A";
}

test("self-study API isolates accounts, resumes after restart, preserves corrections, and promotes only after six stages", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-self-study-api-"));
  const savedUsers = loadUsers(dataDir);
  createUser(savedUsers, { username: "traveler", password: "traveler-password" });
  createUser(savedUsers, { username: "other-user", password: "other-password" });
  saveUsers(dataDir, savedUsers);
  const apiToken = "self-study-api-token";
  const readToken = deriveLearningSyncToken(apiToken);
  const writeToken = deriveTeachingProfileWriteToken(apiToken);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = startServer(dataDir, port, apiToken);

  try {
    await waitForHealth(baseUrl, child);
    const lessons = [courseLesson("trip-day-9", 9, "dog", "狗"), courseLesson("trip-day-10", 10, "duck", "鸭子")];
    const syncUrl = `${baseUrl}/api/sync/self-study-lessons?username=traveler`;
    const rejected = await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${readToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ lessons }) });
    assert.equal(rejected.status, 401);
    const uploaded = await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ lessons }) });
    assert.equal(uploaded.status, 200);
    assert.deepEqual((await uploaded.json()).lessons, 2);
    const repeated = await (await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ lessons }) })).json();
    assert.equal(repeated.lessons, 2);

    const beforeContent = await (await fetch(`${baseUrl}/api/content`)).json();
    assert.equal(beforeContent.words.some(item => item.id === "travel-d9-dog"), false);
    assert.equal(beforeContent.words.some(item => item.id === "travel-d10-duck"), false);

    let travelerCookie = await login(baseUrl, "traveler", "traveler-password");
    const otherCookie = await login(baseUrl, "other-user", "other-password");
    const travelerInitial = await request(baseUrl, travelerCookie, "/api/self-study");
    const otherInitial = await request(baseUrl, otherCookie, "/api/self-study");
    assert.equal(travelerInitial.data.hasLessons, true);
    assert.equal(travelerInitial.data.entryVisible, false);
    assert.equal(otherInitial.data.hasLessons, false);

    const travelerPreviewWords = await request(baseUrl, travelerCookie, "/api/preview/words");
    assert.equal(travelerPreviewWords.response.status, 200);
    assert.equal(travelerPreviewWords.data.nextDay, 9);
    assert.equal(travelerPreviewWords.data.sourceLessonId, "trip-day-9");
    assert.equal(travelerPreviewWords.data.formalEvidence, false);
    assert.deepEqual(travelerPreviewWords.data.words.map(item => item.id), ["travel-d9-dog"]);
    assert.equal(travelerPreviewWords.data.words[0].preview, true);
    assert.equal(travelerPreviewWords.data.words[0].status, "planned");
    assert.equal(travelerPreviewWords.data.words[0].formalEvidence, false);
    const otherPreviewWords = await request(baseUrl, otherCookie, "/api/preview/words");
    assert.equal(otherPreviewWords.data.words.some(item => item.id === "travel-d9-dog"), false);

    const travelerPreview = await request(baseUrl, travelerCookie, "/api/preview");
    assert.match(travelerPreview.data.preview.name, /第 9 天出门自学预习/);
    assert.match(travelerPreview.data.preview.content, /dog：狗/);
    assert.match(travelerPreview.data.preview.content, /It is a dog\./);
    const plannedSentences = await request(baseUrl, travelerCookie, "/api/preview/practice/sentences", "POST", { wordIds: ["travel-d9-dog"] });
    assert.equal(plannedSentences.response.status, 200);
    assert.equal(plannedSentences.data.source, "self-study");
    assert.equal(plannedSentences.data.formalEvidence, false);
    assert.equal(plannedSentences.data.sentences.length, 1);
    assert.equal(plannedSentences.data.sentences[0].sourceContentId, "travel-d9-sentence");
    assert.equal(plannedSentences.data.sentences[0].formalEvidence, false);
    const previewGrade = await request(baseUrl, travelerCookie, "/api/preview/practice/grade", "POST", {
      task: { ...plannedSentences.data.sentences[0], direction: "en-zh" },
      answer: "它是一只狗"
    });
    assert.equal(previewGrade.response.status, 200);
    assert.equal(previewGrade.data.correct, true);
    const stateAfterPreviewGrade = await request(baseUrl, travelerCookie, "/api/state");
    assert.deepEqual(stateAfterPreviewGrade.data.attempts, []);
    assert.deepEqual(stateAfterPreviewGrade.data.mistakes, []);
    const contentAfterPreviewReads = await (await fetch(`${baseUrl}/api/content`)).json();
    assert.equal(contentAfterPreviewReads.words.some(item => item.id === "travel-d9-dog"), false);
    assert.equal(contentAfterPreviewReads.sentences.some(item => item.id === "travel-d9-sentence"), false);

    const userStateFile = path.join(dataDir, "user-states.json");
    const stateBeforeOfflineRead = fs.readFileSync(userStateFile, "utf8");
    const stateMtimeBeforeOfflineRead = fs.statSync(userStateFile).mtimeMs;
    const offlinePack = await request(baseUrl, travelerCookie, "/api/offline/pack");
    assert.equal(offlinePack.response.status, 200);
    assert.equal(offlinePack.data.schemaVersion, 1);
    assert.equal(offlinePack.data.account.username, "traveler");
    assert.ok(offlinePack.data.byteSize <= 6 * 1024 * 1024);
    assert.deepEqual(offlinePack.data.preview.words.map(item => item.id), ["travel-d9-dog"]);
    assert.equal(offlinePack.data.preview.formalEvidence, false);
    assert.equal(offlinePack.data.preview.practiceSentences[0].formalEvidence, false);
    assert.deepEqual(offlinePack.data.selfStudy.lessons.map(item => item.lessonId), ["trip-day-9", "trip-day-10"]);
    const offlineQuestion = offlinePack.data.selfStudy.lessons[0].stages[0].steps[0];
    assert.equal(offlineQuestion.formalEvidence, false);
    assert.equal(typeof offlineQuestion.answerSalt, "string");
    assert.equal(offlineQuestion.answerDigests.length, 1);
    const offlineText = JSON.stringify(offlinePack.data);
    assert.doesNotMatch(offlineText, /"acceptedAnswers"|"referenceAnswer"|"password"|"apiKey"|Bearer\s/i);
    assert.equal(fs.readFileSync(userStateFile, "utf8"), stateBeforeOfflineRead);
    assert.equal(fs.statSync(userStateFile).mtimeMs, stateMtimeBeforeOfflineRead);
    const otherOfflinePack = await request(baseUrl, otherCookie, "/api/offline/pack");
    assert.equal(otherOfflinePack.response.status, 200);
    assert.deepEqual(otherOfflinePack.data.preview.words, []);
    assert.deepEqual(otherOfflinePack.data.selfStudy.lessons, []);
    assert.doesNotMatch(JSON.stringify(otherOfflinePack.data), /travel-d9-dog|trip-day-9/);

    assert.equal((await request(baseUrl, travelerCookie, "/api/self-study/mode", "POST", { enabled: true })).response.status, 200);
    let result = await request(baseUrl, travelerCookie, "/api/self-study/start", "POST", {});
    assert.equal(result.response.status, 200);
    assert.equal(result.data.current.lessonId, "trip-day-9");
    assert.equal(result.data.current.step.stepId, "review-1");
    assert.equal(Object.hasOwn(result.data.current.step, "referenceAnswer"), false);
    assert.equal(Object.hasOwn(result.data.current.step, "acceptedAnswers"), false);
    assert.equal(JSON.stringify(result.data).includes("trip-day-10"), false);

    result = await request(baseUrl, travelerCookie, "/api/self-study/submit", "POST", { lessonId: "trip-day-9", stepId: "review-1", answer: "A", attemptId: "review-attempt" });
    assert.equal(result.data.current.step.stepId, "review-1");
    assert.equal(result.data.current.step.status, "completed");
    assert.equal(result.data.current.step.referenceAnswer, "A");
    const replay = await request(baseUrl, travelerCookie, "/api/self-study/submit", "POST", { lessonId: "trip-day-9", stepId: "review-1", answer: "A", attemptId: "review-attempt" });
    assert.equal(replay.data.duplicate, true);
    result = await request(baseUrl, travelerCookie, "/api/self-study/continue", "POST", { lessonId: "trip-day-9", stepId: "review-1", continueId: "continue-review" });
    assert.equal(result.data.current.step.stepId, "teach-word");

    const draft = await request(baseUrl, travelerCookie, "/api/self-study/draft", "PUT", { lessonId: "trip-day-9", stepId: "teach-word", draft: "尚未提交的草稿" });
    assert.equal(draft.data.current.step.draft, "尚未提交的草稿");
    const paused = await request(baseUrl, travelerCookie, "/api/self-study/pause", "POST", { lessonId: "trip-day-9", reason: "临时外出" });
    assert.equal(paused.data.current.status, "paused");

    await stopServer(child);
    child = startServer(dataDir, port, apiToken);
    await waitForHealth(baseUrl, child);
    result = await request(baseUrl, travelerCookie, "/api/self-study");
    assert.equal(result.data.current.step.stepId, "teach-word");
    assert.equal(result.data.current.step.draft, "尚未提交的草稿");
    assert.equal(result.data.current.status, "paused");
    const restoredPreviewWords = await request(baseUrl, travelerCookie, "/api/preview/words");
    assert.deepEqual(restoredPreviewWords.data.words.map(item => item.id), ["travel-d9-dog"]);
    const restoredOfflinePack = await request(baseUrl, travelerCookie, "/api/offline/pack");
    assert.equal(restoredOfflinePack.data.selfStudyPublic.current.step.stepId, "teach-word");
    assert.equal(restoredOfflinePack.data.selfStudyPublic.current.status, "paused");
    assert.equal(restoredOfflinePack.data.selfStudy.progress["trip-day-9"].steps["teach-word"].draft, "尚未提交的草稿");

    const revised = courseLesson("trip-day-9", 9, "dog", "狗", "2");
    revised.title = "不应覆盖已开始快照的新标题";
    const uploadRevised = await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ lessons: [revised] }) });
    assert.equal(uploadRevised.status, 200);
    result = await request(baseUrl, travelerCookie, "/api/self-study");
    assert.equal(result.data.current.lessonVersion, "1");
    assert.equal(result.data.current.title, "第 9 天完整自学课程");

    assert.equal((await request(baseUrl, travelerCookie, "/api/self-study/resume", "POST", { lessonId: "trip-day-9" })).response.status, 200);
    const pendingQuestion = await request(baseUrl, travelerCookie, "/api/self-study/question", "POST", { lessonId: "trip-day-9", stepId: "teach-word", question: "这个单词怎么读？", questionId: "question-1" });
    assert.equal(pendingQuestion.response.status, 503);
    assert.equal(pendingQuestion.data.selfStudy.current.step.questions[0].status, "pending");

    let wrongTestDone = false;
    for (let guard = 0; guard < 40; guard += 1) {
      result = await request(baseUrl, travelerCookie, "/api/self-study");
      const current = result.data.current;
      if (!current) break;
      const step = current.step;
      if (step.status === "completed" && ["choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction"].includes(step.type)) {
        result = await request(baseUrl, travelerCookie, "/api/self-study/continue", "POST", { lessonId: current.lessonId, stepId: step.stepId, continueId: `continue-${step.stepId}` });
        assert.equal(result.response.status, 200);
        continue;
      }
      if (step.stepId === "test-p-1" && !wrongTestDone) {
        result = await request(baseUrl, travelerCookie, "/api/self-study/submit", "POST", { lessonId: current.lessonId, stepId: step.stepId, answer: "B", attemptId: "test-first-wrong" });
        assert.equal(result.data.current.step.status, "needs-correction");
        assert.equal(Object.hasOwn(result.data.current.step, "referenceAnswer"), false);
        result = await request(baseUrl, travelerCookie, "/api/self-study/submit", "POST", { lessonId: current.lessonId, stepId: step.stepId, answer: "A", attemptId: "test-correction" });
        assert.equal(result.data.current.step.status, "completed");
        wrongTestDone = true;
        continue;
      }
      const answer = answerForStep(step, "dog", "狗");
      result = await request(baseUrl, travelerCookie, "/api/self-study/submit", "POST", { lessonId: current.lessonId, stepId: step.stepId, answer, attemptId: `attempt-${step.stepId}` });
      assert.equal(result.response.status, 200);
    }

    result = await request(baseUrl, travelerCookie, "/api/self-study");
    assert.equal(result.data.current, null);
    assert.equal(result.data.availableLesson.lessonId, "trip-day-10");
    assert.equal(result.data.completedLessons, 1);
    const repeatedOfflineStart = await request(baseUrl, travelerCookie, "/api/self-study/start", "POST", { lessonId: "trip-day-9", startId: "offline-start-trip-day-9" });
    assert.equal(repeatedOfflineStart.response.status, 200);
    assert.equal(repeatedOfflineStart.data.duplicate, true);
    assert.equal(repeatedOfflineStart.data.current, null);
    assert.equal(repeatedOfflineStart.data.availableLesson.lessonId, "trip-day-10");

    const nextPreviewWords = await request(baseUrl, travelerCookie, "/api/preview/words");
    assert.equal(nextPreviewWords.data.nextDay, 10);
    assert.equal(nextPreviewWords.data.sourceLessonId, "trip-day-10");
    assert.deepEqual(nextPreviewWords.data.words.map(item => item.id), ["travel-d10-duck"]);
    assert.equal(nextPreviewWords.data.words.some(item => item.id === "travel-d9-dog"), false);
    const otherPreviewAfterCompletion = await request(baseUrl, otherCookie, "/api/preview/words");
    assert.equal(otherPreviewAfterCompletion.data.words.some(item => ["travel-d9-dog", "travel-d10-duck"].includes(item.id)), false);

    const afterContent = await (await fetch(`${baseUrl}/api/content`)).json();
    const promotedWord = afterContent.words.find(item => item.id === "travel-d9-dog");
    assert.equal(promotedWord.preview, false);
    assert.equal(promotedWord.status, "learned");
    assert.equal(promotedWord.sourceLessonId, "trip-day-9");
    assert.ok(promotedWord.learnedAt);
    assert.ok(promotedWord.firstReviewDue);
    assert.equal(afterContent.words.some(item => item.id === "travel-d10-duck"), false);
    assert.equal(fs.existsSync(path.join(dataDir, "self-study-transaction.json")), false);

    const synced = await (await fetch(`${baseUrl}/api/sync/profile?username=traveler`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
    assert.equal(synced.schemaVersion, 8);
    assert.equal(synced.summary.selfStudyCompletedLessons, 1);
    assert.equal(synced.summary.selfStudyFormalAttempts, 12);
    assert.equal(synced.summary.selfStudyCorrections, 1);
    assert.equal(synced.selfStudyHistory[0].testSummary.firstScore, 9);
    assert.equal(synced.selfStudyHistory[0].testSummary.corrected, 1);
    assert.equal(synced.selfStudyHistory[0].stages[1].steps[0].tutorHistory[0].status, "pending");
    assert.equal(synced.selfStudyPlannedLessons[0].lessonId, "trip-day-10");
    assert.equal(synced.selfStudyPlannedLessons[0].plannedContent.status, "planned");
    const syncedAgain = await (await fetch(`${baseUrl}/api/sync/profile?username=traveler`, { headers: { Authorization: `Bearer ${readToken}` } })).json();
    assert.equal(syncedAgain.summary.selfStudyFormalAttempts, synced.summary.selfStudyFormalAttempts);
    assert.equal(syncedAgain.selfStudyHistory.length, synced.selfStudyHistory.length);

    const otherAfter = await request(baseUrl, otherCookie, "/api/self-study");
    assert.equal(otherAfter.data.hasLessons, false);
    assert.equal(otherAfter.data.completedLessons, 0);
  } finally {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("anchored future lesson dates flow through preview, offline, sync, and restart without account leakage", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-self-study-date-api-"));
  const savedUsers = loadUsers(dataDir);
  createUser(savedUsers, { username: "date-traveler", password: "date-traveler-password" });
  createUser(savedUsers, { username: "date-other", password: "date-other-password" });
  saveUsers(dataDir, savedUsers);
  const apiToken = "self-study-date-api-token";
  const readToken = deriveLearningSyncToken(apiToken);
  const writeToken = deriveTeachingProfileWriteToken(apiToken);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const fixedClock = {
    TEST_FIXED_NOW: "2026-08-17T15:59:59.000Z",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${path.join(ROOT, "test", "support", "fixed-clock.cjs")}`.trim()
  };
  let child = startServer(dataDir, port, apiToken, fixedClock);
  try {
    await waitForHealth(baseUrl, child);
    const lesson = courseLesson("trip-day-12-date", 12, "dog", "狗");
    lesson.formalDate = "2026-08-11";
    lesson.enabledFrom = "2026-08-11T00:00:00+08:00";
    lesson.expiresAt = "2026-09-10T23:59:59+08:00";
    lesson.plannedContent.note.date = "2026-08-11";
    const body = { updatedAt: "2026-08-17T00:00:00.000Z", lessons: [lesson] };
    const syncUrl = `${baseUrl}/api/sync/self-study-lessons?username=date-traveler`;
    const upload = await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(upload.status, 200);
    const repeated = await fetch(syncUrl, { method: "PUT", headers: { Authorization: `Bearer ${writeToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(repeated.status, 200);

    const travelerCookie = await login(baseUrl, "date-traveler", "date-traveler-password");
    const otherCookie = await login(baseUrl, "date-other", "date-other-password");
    const selfStudy = await request(baseUrl, travelerCookie, "/api/self-study");
    assert.equal(selfStudy.data.availableLesson, null);
    assert.equal(selfStudy.data.waitingUntil, "2026-08-17T16:00:00.000Z");
    const previewWords = await request(baseUrl, travelerCookie, "/api/preview/words");
    assert.equal(previewWords.data.nextDay, 12);
    assert.equal(previewWords.data.formalDate, "2026-08-18");
    assert.equal(previewWords.data.enabledFrom, "2026-08-17T16:00:00.000Z");
    assert.equal(previewWords.data.words[0].formalEvidence, false);
    const preview = await request(baseUrl, travelerCookie, "/api/preview");
    assert.match(preview.data.preview.content, /2026-08-18/);
    const offline = await request(baseUrl, travelerCookie, "/api/offline/pack");
    assert.equal(offline.data.preview.formalDate, "2026-08-18");
    assert.equal(offline.data.selfStudy.lessons[0].formalDate, "2026-08-18");
    assert.equal(offline.data.selfStudy.lessons[0].enabledFrom, "2026-08-17T16:00:00.000Z");
    const profile = await fetch(`${baseUrl}/api/sync/profile?username=date-traveler`, { headers: { Authorization: `Bearer ${readToken}` } });
    const profileData = await profile.json();
    assert.equal(profile.status, 200);
    assert.equal(profileData.selfStudyPlannedLessons[0].formalDate, "2026-08-18");
    assert.equal(profileData.selfStudyPlannedLessons[0].enabledFrom, "2026-08-17T16:00:00.000Z");
    assert.equal(profileData.selfStudyPlannedLessons[0].plannedContent.status, "planned");
    const other = await request(baseUrl, otherCookie, "/api/preview/words");
    assert.deepEqual(other.data.words, []);

    await stopServer(child);
    child = startServer(dataDir, port, apiToken, fixedClock);
    await waitForHealth(baseUrl, child);
    const restored = await request(baseUrl, travelerCookie, "/api/self-study");
    assert.equal(restored.data.waitingUntil, "2026-08-17T16:00:00.000Z");
    const restoredPreview = await request(baseUrl, travelerCookie, "/api/preview/words");
    assert.equal(restoredPreview.data.formalDate, "2026-08-18");
    assert.equal((await request(baseUrl, otherCookie, "/api/self-study")).data.hasLessons, false);
  } finally {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
