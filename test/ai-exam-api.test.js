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
const { deriveLearningSyncToken } = require("../server/learning-sync-token");

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

function examFixture() {
  return {
    title: "阶段测试卷",
    instructions: "全部完成后交卷。",
    clozePassage: "A big cat [1] on a [2]. It [3] big. I [4] a man.",
    readingPassage: "A big cat sat on a mat.",
    questions: [
      { type: "fill-blank", prompt: "填写单词。", sourceText: "I _ a man.", acceptedAnswers: ["am"] },
      { type: "fill-blank", prompt: "填写单词。", sourceText: "It _ big.", acceptedAnswers: ["is"] },
      { type: "fill-blank", prompt: "填写单词。", sourceText: "A cat _ on a mat.", acceptedAnswers: ["sat"] },
      { type: "single-choice", prompt: "选择单词。", sourceText: "man", options: ["man", "pig"], correctOption: 0 },
      { type: "single-choice", prompt: "选择单词。", sourceText: "cat", options: ["cat", "mat"], correctOption: 0 },
      { type: "single-choice", prompt: "选择单词。", sourceText: "big", options: ["big", "sit"], correctOption: 0 },
      { type: "multiple-choice", prompt: "选择两项。", sourceText: "pig cat mat", options: ["pig", "cat", "mat"], correctOptions: [0, 1] },
      { type: "multiple-choice", prompt: "选择两项。", sourceText: "sat on big", options: ["sat", "on", "big"], correctOptions: [0, 1] },
      { type: "true-false", prompt: "判断句意。", sourceText: "It is big.", correctAnswer: true },
      { type: "true-false", prompt: "判断句意。", sourceText: "A cat sat on a mat.", correctAnswer: true },
      { type: "true-false", prompt: "判断句意。", sourceText: "I am a man.", correctAnswer: true },
      { type: "cloze", prompt: "选择第 1 空。", options: ["sat", "sit"], correctOption: 0 },
      { type: "cloze", prompt: "选择第 2 空。", options: ["mat", "man"], correctOption: 0 },
      { type: "cloze", prompt: "选择第 3 空。", options: ["is", "in"], correctOption: 0 },
      { type: "cloze", prompt: "选择第 4 空。", options: ["am", "is"], correctOption: 0 },
      { type: "reading-comprehension", prompt: "谁坐在垫子上？", sourceText: "", options: ["猫", "猪"], correctOption: 0 },
      { type: "reading-comprehension", prompt: "猫在哪里？", sourceText: "", options: ["垫子上", "里面"], correctOption: 0 },
      { type: "reading-comprehension", prompt: "猫大吗？", sourceText: "", options: ["大", "不大"], correctOption: 0 },
      { type: "translation", prompt: "翻译成中文。", sourceText: "It is big.", direction: "en-zh", acceptedAnswers: ["它很大"] },
      { type: "translation", prompt: "翻译成英文。", sourceText: "它是一只猫。", direction: "zh-en", acceptedAnswers: ["It is a cat."] },
      { type: "translation", prompt: "翻译成中文。", sourceText: "A big pig sat on a mat.", direction: "en-zh", acceptedAnswers: ["一只大猪坐在垫子上"] },
      { type: "listening", prompt: "听音后选择意思。", speechText: "A big pig sat on a mat.", options: ["一只大猪坐在垫子上", "一只大猫坐在垫子上"], correctOption: 0 },
      { type: "listening", prompt: "听音后选择意思。", speechText: "A cat sat on a mat.", options: ["一只猪坐在垫子上", "一只猫坐在垫子上"], correctOption: 1 },
      { type: "listening", prompt: "听音后选择意思。", speechText: "It is a big cat.", options: ["它是一只大猫", "它是一只大猪"], correctOption: 0 }
    ]
  };
}

function completeAnswers(exam) {
  const seen = {};
  return Object.fromEntries(exam.questions.map(question => {
    seen[question.type] = (seen[question.type] || 0) + 1;
    if (question.type === "fill-blank") return [question.id, ["am", "is", "sat"][seen[question.type] - 1]];
    if (["single-choice", "cloze", "reading-comprehension"].includes(question.type)) return [question.id, "A"];
    if (question.type === "multiple-choice") return [question.id, ["A", "B"]];
    if (question.type === "true-false") return [question.id, true];
    if (question.type === "translation") return [question.id, ["它很大", "It is a cat.", "一只大猪坐在垫子上"][seen[question.type] - 1]];
    if (question.type === "listening") return [question.id, ["A", "B", "A"][seen[question.type] - 1]];
    return [question.id, ""];
  }));
}

test("exam APIs preserve private state, redact draft answers, grade once, and sync evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-exam-api-"));
  const users = loadUsers(dataDir);
  createUser(users, { username: "owner", password: "exam-api-test-password" });
  saveUsers(dataDir, users);
  const providerCalls = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      providerCalls.push(request);
      const userContent = JSON.parse(request.messages.at(-1).content);
      let content;
      if (userContent.allowedWords && userContent.exam) {
        const subjectiveGrades = userContent.exam.questions.filter(question => ["translation", "essay"].includes(question.type)).map(question => ({ questionId: question.id, score: question.points, explanation: "表达正确。" }));
        const listeningId = userContent.exam.questions.find(question => question.type === "listening").id;
        content = { subjectiveGrades, summary: "已完成整卷分析。", weakPoints: [{ category: "listening", severity: "medium", detail: "听音辨句需要加强。", recommendation: "复习后再听。", questionIds: [listeningId], relatedWords: ["pig"] }] };
      } else content = examFixture();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));

  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const apiToken = "exam-sync-token-for-tests";
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(appPort), COOKIE_SECURE: "false", API_TOKEN: apiToken },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "exam-api-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    const providerPort = provider.address().port;
    const config = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode: "manual", providers: [{ id: "exam-provider", name: "Exam Provider", enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test-key", models: ["exam-model"], timeoutMs: 5000 }], manualProviderId: "exam-provider", defaultModel: "exam-model", rateLimitPerMinute: 20 })
    });
    assert.equal(config.status, 200);

    const generatedResponse = await fetch(`${baseUrl}/api/ai/exams/generate`, { method: "POST", headers, body: JSON.stringify({ model: "exam-model", reasoningEffort: "medium", totalPoints: 150, includeListening: true, includeEssay: false }) });
    assert.equal(generatedResponse.status, 201);
    let examState = await generatedResponse.json();
    const exam = examState.currentExam;
    assert.equal(exam.totalPoints, 150);
    assert.equal(exam.includeListening, true);
    assert.equal(JSON.stringify(exam).includes("answerKey"), false);
    assert.equal(exam.questions.filter(question => question.type === "listening").every(question => !question.transcript), true);

    const listeningQuestion = exam.questions.find(question => question.type === "listening");
    const audio = await fetch(`${baseUrl}/api/ai/exams/listening`, { method: "POST", headers, body: JSON.stringify({ examId: exam.id, questionId: listeningQuestion.id }) });
    assert.equal(audio.status, 200);
    assert.equal((await audio.json()).text, "A big pig sat on a mat.");

    const regularState = await (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(Object.hasOwn(regularState, "aiExam"), false);
    const exported = await (await fetch(`${baseUrl}/api/export`, { headers: { Cookie: cookie } })).json();
    assert.equal(Object.hasOwn(exported.state, "aiExam"), false);
    const statePut = await fetch(`${baseUrl}/api/state`, { method: "PUT", headers, body: JSON.stringify(regularState) });
    assert.equal(statePut.status, 200);
    examState = await (await fetch(`${baseUrl}/api/ai/exams`, { headers: { Cookie: cookie } })).json();
    assert.equal(examState.currentExam.id, exam.id);

    const incomplete = await fetch(`${baseUrl}/api/ai/exams/submit`, { method: "POST", headers, body: JSON.stringify({ examId: exam.id, answers: { [exam.questions[0].id]: "am" } }) });
    assert.equal(incomplete.status, 400);
    assert.equal(providerCalls.length, 1);

    const submitted = await fetch(`${baseUrl}/api/ai/exams/submit`, { method: "POST", headers, body: JSON.stringify({ examId: exam.id, answers: completeAnswers(exam) }) });
    assert.equal(submitted.status, 200);
    examState = await submitted.json();
    assert.equal(providerCalls.length, 2);
    assert.equal(examState.currentExam.status, "completed");
    assert.equal(examState.currentExam.result.score, 150);
    assert.equal(examState.currentExam.result.possible, 150);
    assert.equal(examState.currentExam.questions.find(question => question.id === listeningQuestion.id).transcript, "A big pig sat on a mat.");
    assert.equal(examState.history.length, 1);
    assert.equal(examState.weakPoints.some(item => item.category === "listening"), true);
    assert.equal(examState.abilities.abilities.find(item => item.id === "listening").evidenceCount > 0, true);
    assert.equal(Array.isArray(examState.abilityChanges), true);

    const syncToken = deriveLearningSyncToken(apiToken);
    const profileResponse = await fetch(`${baseUrl}/api/sync/profile?username=owner`, { headers: { Authorization: `Bearer ${syncToken}` } });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.summary.exams, 1);
    assert.equal(profile.summary.latestExamScore, 150);
    assert.equal(profile.weakPoints.recentExamWeakPoints.some(item => item.category === "listening"), true);
    assert.equal(profile.examHistory[0].questions.some(question => question.type === "listening" && question.sourceText === "A big pig sat on a mat."), true);
    assert.equal(profile.examHistory[0].questions.some(question => question.type === "cloze" && question.sourceText.includes("[4]")), true);
    assert.equal(profile.examHistory[0].questions.some(question => question.type === "reading-comprehension" && question.sourceText === "A big cat sat on a mat."), true);
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
