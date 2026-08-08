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
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function createPreviewProvider() {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ data: [{ id: "preview-model" }] }));
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404);
      return response.end();
    }
    const body = await readBody(request);
    calls.push(body);
    const input = JSON.parse(body.messages.find(message => message.role === "user").content);
    const sentences = input.targets.map(target => ({
      wordId: target.wordId,
      english: "A pool is deep.",
      chinese: "一个水池是深的。",
      acceptedChinese: ["一个水池是深的。"]
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sentences }) } }] }));
  });
  return { server, calls };
}

async function startApp(dataDir, port, apiToken) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      API_TOKEN: apiToken,
      COOKIE_SECURE: "false",
      REVIEW_VARIANT_POOL_AUTOFILL: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { child, baseUrl };
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  const exited = once(app.child, "exit");
  app.child.kill();
  await exited;
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "preview-owner", password: "preview-test-password" })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

function legacyPreviewState(task) {
  const result = {
    correct: false,
    score: 0,
    gradingStatus: "incorrect",
    explanation: "pool 只能翻译为水池。",
    detailedExplanation: "误译为游泳池改变了原意。",
    problemWords: ["pool"],
    wordResults: [{ english: "pool", correct: false, issue: "meaning" }],
    source: "ai",
    answeredAt: "2026-08-08T01:00:00.000Z"
  };
  return {
    key: "8|9|d9-deep",
    currentDay: 8,
    nextDay: 9,
    mode: "sentence",
    tasks: [task],
    index: 1,
    answers: { [task.id]: "一个游泳池是深的" },
    results: { [task.id]: result },
    pending: { [task.id]: "等待 AI 重试" },
    completed: true,
    roundId: "preview-round-pool",
    historyRecorded: true,
    startedAt: "2026-08-08T00:59:00.000Z",
    generatedAt: "2026-08-08T00:58:00.000Z",
    updatedAt: "2026-08-08T01:00:00.000Z"
  };
}

test("preview pool meanings survive generation, persistence, restart, grading, and sync isolation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-preview-api-"));
  const apiToken = "preview-api-test-token";
  const users = loadUsers(dataDir);
  createUser(users, { username: "preview-owner", password: "preview-test-password", role: "admin" });
  saveUsers(dataDir, users);
  fs.writeFileSync(path.join(dataDir, "content-store.json"), `${JSON.stringify({
    version: 1,
    updatedAt: "2026-08-08",
    currentDay: 8,
    words: [
      { id: "d8-pool", day: 8, learned: "2026-08-07", english: "pool", chinese: "水池；游泳池", acceptedChinese: ["水池", "游泳池", "泳池"], directions: ["en-zh", "zh-en"] },
      { id: "d9-deep", day: 9, learned: "", preview: true, english: "deep", chinese: "深的", acceptedChinese: ["深的"], directions: ["en-zh", "zh-en"] }
    ],
    sentences: [],
    notes: [],
    seedMistakes: [],
    deletedIds: []
  }, null, 2)}\n`, "utf8");

  const provider = createPreviewProvider();
  let app;
  try {
    await new Promise((resolve, reject) => provider.server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = provider.server.address().port;
    app = await startApp(dataDir, await freePort(), apiToken);
    let cookie = await login(app.baseUrl);

    const configured = await fetch(`${app.baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "preview-provider-test-key", models: ["preview-model"], defaultModel: "preview-model", timeoutMs: 10000, rateLimitPerMinute: 60 })
    });
    assert.equal(configured.status, 200);

    const generatedResponse = await fetch(`${app.baseUrl}/api/preview/practice/sentences`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ wordIds: ["d9-deep"], model: "preview-model", reasoningEffort: "high" })
    });
    assert.equal(generatedResponse.status, 200);
    const generated = await generatedResponse.json();
    assert.equal(generated.sentences.length, 1);
    assert.ok(generated.sentences[0].acceptedChinese.includes("一个水池是深的。"));
    assert.ok(generated.sentences[0].acceptedChinese.includes("一个游泳池是深的。"));
    assert.ok(generated.sentences[0].acceptedChinese.includes("一个泳池是深的。"));

    const task = {
      ...generated.sentences[0],
      id: "preview-sentence-d9-deep",
      direction: "en-zh"
    };
    const gradeResponse = await fetch(`${app.baseUrl}/api/preview/practice/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ task, answer: "一个游泳池是深的" })
    });
    assert.equal(gradeResponse.status, 200);
    const grade = await gradeResponse.json();
    assert.equal(grade.correct, true);
    assert.equal(grade.score, 1);
    assert.equal(grade.gradingStatus, "correct");
    assert.equal(provider.calls.length, 1, "registered meanings must be graded locally without another AI call");

    const legacy = legacyPreviewState(task);
    const savedResponse = await fetch(`${app.baseUrl}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        attempts: [],
        mistakes: [],
        previewPractice: legacy,
        previewPracticeHistory: [{ ...legacy, id: "preview-round-pool", score: 0, completedAt: "2026-08-08T01:01:00.000Z" }]
      })
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.previewPractice.results[task.id].correct, true);
    assert.equal(saved.previewPractice.results[task.id].score, 1);
    assert.equal(Object.hasOwn(saved.previewPractice.pending, task.id), false);
    assert.equal(saved.previewPracticeHistory[0].score, 100);
    assert.doesNotMatch(JSON.stringify(saved.previewPracticeHistory[0].results[task.id]), /只能翻译为水池|误译为游泳池|改变了原意/);
    assert.deepEqual(saved.attempts, []);
    assert.deepEqual(saved.mistakes, []);

    const profileResponse = await fetch(`${app.baseUrl}/api/sync/profile?username=preview-owner`, {
      headers: { Authorization: `Bearer ${deriveLearningSyncToken(apiToken)}` }
    });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.summary.previewPracticeRounds, 1);
    assert.equal(profile.summary.previewPracticeFullyCorrect, 1);
    assert.equal(profile.summary.previewPracticeIncorrect, 0);
    assert.equal(profile.previewPracticeHistory[0].formalEvidence, false);
    assert.equal(profile.previewPracticeHistory[0].questions[0].formalEvidence, false);
    assert.equal(profile.previewPracticeHistory[0].questions[0].correct, true);
    assert.equal(profile.summary.recordedMistakes, 0);
    assert.equal(profile.abilities.totalEvidence, 0);

    await stopApp(app);
    app = await startApp(dataDir, await freePort(), apiToken);
    cookie = await login(app.baseUrl);
    const restored = await (await fetch(`${app.baseUrl}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.ok(restored.previewPractice.tasks[0].acceptedChinese.includes("一个游泳池是深的。"));
    assert.equal(restored.previewPractice.results[task.id].correct, true);
    assert.equal(restored.previewPracticeHistory[0].score, 100);
    assert.doesNotMatch(JSON.stringify(restored.previewPracticeHistory[0]), /只能翻译为水池|误译为游泳池|改变了原意/);
  } finally {
    await stopApp(app);
    await new Promise(resolve => provider.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
