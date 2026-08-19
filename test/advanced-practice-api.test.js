"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
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
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

function focusedFixture() {
  return {
    title: "选择专项训练",
    instructions: "完成 5 道选择题。",
    passage: "",
    questions: Array.from({ length: 5 }, (_, index) => ({
      prompt: `选择第 ${index + 1} 题。`,
      sourceText: "cat",
      focus: "词义选择",
      options: [{ id: "A", text: "猫" }, { id: "B", text: "猪" }, { id: "C", text: "垫子" }, { id: "D", text: "大的" }],
      answerKey: { kind: "option", correctOption: "A" }
    }))
  };
}

test("dictation and focused APIs persist private drafts and update shared evidence", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-advanced-api-"));
  const users = loadUsers(dataDir);
  createUser(users, { username: "owner", password: "advanced-api-password" });
  saveUsers(dataDir, users);

  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const content = request.messages.at(-1).content;
      const user = typeof content === "string" ? JSON.parse(content) : {};
      let response;
      if (user.focusedType) response = focusedFixture();
      else if (user.exam && user.allowedWords) response = { subjectiveGrades: [], weakPoints: [], summary: "专项表现稳定。" };
      else if (user.items && Number.isFinite(user.score)) {
        const wrong = user.items.find(item => !item.correct);
        response = { summary: "听写分析完成。", weakWords: wrong ? [{ wordId: wrong.wordId, detail: "拼写需要加强。", recommendation: "慢速重听。" }] : [], recommendations: ["继续复习已学单词。"] };
      } else response = { ok: true };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
    });
  });
  await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));

  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const apiToken = "advanced-sync-api-token";
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(appPort), API_TOKEN: apiToken, COOKIE_SECURE: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "advanced-api-password" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "Content-Type": "application/json", Cookie: cookie };
    const providerPort = provider.address().port;
    const config = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode: "manual", providers: [{ id: "provider", name: "Provider", enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test-key", models: ["test-model"], timeoutMs: 5000 }], manualProviderId: "provider", defaultModel: "test-model", rateLimitPerMinute: 20 })
    });
    assert.equal(config.status, 200);

    const generatedDictation = await fetch(`${baseUrl}/api/ai/dictation/generate`, { method: "POST", headers, body: JSON.stringify({ model: "test-model", count: 5 }) });
    assert.equal(generatedDictation.status, 201);
    let dictation = await generatedDictation.json();
    assert.equal(dictation.currentSession.items.length, 5);
    assert.equal(Object.hasOwn(dictation.currentSession.items[0], "english"), false);
    assert.equal(Object.hasOwn(dictation.currentSession.items[0], "wordId"), false);
    const answers = {};
    const firstDictationWords = [];
    for (const [index, item] of dictation.currentSession.items.entries()) {
      const speech = await fetch(`${baseUrl}/api/ai/dictation/speech`, { method: "POST", headers, body: JSON.stringify({ sessionId: dictation.currentSession.id, itemId: item.id }) });
      const english = (await speech.json()).text;
      firstDictationWords.push(english);
      answers[item.id] = index ? english : "wrong";
    }
    const submittedDictation = await fetch(`${baseUrl}/api/ai/dictation/submit`, { method: "POST", headers, body: JSON.stringify({ sessionId: dictation.currentSession.id, answers }) });
    assert.equal(submittedDictation.status, 200);
    dictation = await submittedDictation.json();
    assert.equal(dictation.currentSession.status, "completed");
    assert.equal(dictation.currentSession.score, 4);
    assert.equal(dictation.weightSummary.highPriorityWords >= 0, true);
    assert.equal(dictation.abilities.abilities.find(item => item.id === "spelling").evidenceCount, 5);

    const nextDictationResponse = await fetch(`${baseUrl}/api/ai/dictation/generate`, { method: "POST", headers, body: JSON.stringify({ model: "test-model", count: 5 }) });
    assert.equal(nextDictationResponse.status, 201);
    const nextDictation = await nextDictationResponse.json();
    const nextDictationWords = [];
    for (const item of nextDictation.currentSession.items) {
      const speech = await fetch(`${baseUrl}/api/ai/dictation/speech`, { method: "POST", headers, body: JSON.stringify({ sessionId: nextDictation.currentSession.id, itemId: item.id }) });
      nextDictationWords.push((await speech.json()).text);
    }
    assert.equal(nextDictationWords.some(word => firstDictationWords.includes(word)), false, "completed words must yield to today's unused coverage candidates");

    const generatedFocused = await fetch(`${baseUrl}/api/ai/focused/generate`, { method: "POST", headers, body: JSON.stringify({ model: "test-model", focusedType: "choice" }) });
    assert.equal(generatedFocused.status, 201);
    let focused = await generatedFocused.json();
    assert.equal(focused.currentSession.questions.length, 5);
    assert.equal(JSON.stringify(focused.currentSession).includes("answerKey"), false);
    const focusedAnswers = Object.fromEntries(focused.currentSession.questions.map(question => [question.id, "A"]));
    const submittedFocused = await fetch(`${baseUrl}/api/ai/focused/submit`, { method: "POST", headers, body: JSON.stringify({ sessionId: focused.currentSession.id, answers: focusedAnswers }) });
    assert.equal(submittedFocused.status, 200);
    focused = await submittedFocused.json();
    assert.equal(focused.currentSession.result.levelScore, 5);
    assert.equal(focused.skills.find(item => item.id === "choice").score, 5);
    assert.equal(focused.abilities.totalEvidence > dictation.abilities.totalEvidence, true);

    const publicState = await (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(Object.hasOwn(publicState, "dictation"), false);
    assert.equal(Object.hasOwn(publicState, "focusedPractice"), false);
    const sync = await (await fetch(`${baseUrl}/api/sync/profile?username=owner`, { headers: { Authorization: `Bearer ${deriveLearningSyncToken(apiToken)}` } })).json();
    assert.equal(sync.summary.dictations, 1);
    assert.equal(sync.summary.focusedSessions, 1);
    assert.equal(sync.focusedSkills.find(item => item.id === "choice").score, 5);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
