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
const { buildChatCompletionsUrl, createAiGrader, createRateLimiter, parseGeneratedQuestions, parseGradeResponse } = require("../server/ai-grader");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-"));
}

function aiConfig(overrides = {}) {
  return {
    apiKey: "secret",
    configured: true,
    endpoint: buildChatCompletionsUrl("https://sub2api.example/v1"),
    model: "test-model",
    reasoningEffort: "",
    timeoutMs: 10000,
    rateLimitPerMinute: 20,
    ...overrides
  };
}

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

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

test("AI configuration builds an OpenAI-compatible chat completions endpoint", () => {
  assert.equal(buildChatCompletionsUrl("https://sub2api.example/v1"), "https://sub2api.example/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://sub2api.example"), "https://sub2api.example/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://sub2api.example/v1/chat/completions"), "https://sub2api.example/v1/chat/completions");
});

test("AI grade parsing requires a boolean result and a Chinese explanation", () => {
  const result = parseGradeResponse({ choices: [{ message: { content: "```json\n{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\uff0c\u53ef\u4ee5\u8fd9\u6837\u7ffb\u8bd1\u3002\"}\n```" } }] });
  assert.deepEqual(result, { correct: true, explanation: "\u610f\u601d\u76f8\u540c\uff0c\u53ef\u4ee5\u8fd9\u6837\u7ffb\u8bd1\u3002" });
  assert.throws(() => parseGradeResponse({ choices: [{ message: { content: "{\"correct\":\"yes\",\"explanation\":\"ok\"}" } }] }), /invalid grade/);
});

test("AI grader retries once without JSON mode when a compatible proxy rejects it", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response("unsupported", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":false,\"explanation\":\"\u4e3b\u8bed\u4e0d\u4e00\u81f4\u3002\"}" } }] }), { status: 200 });
  };
  const config = aiConfig();
  const grader = createAiGrader(config, { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["\u5b83\u5f88\u5927"], answer: "\u4ed6\u5f88\u5927" });

  assert.equal(result.correct, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
});

test("AI grader drops unsupported reasoning effort while retaining JSON mode", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response("unsupported", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\u3002\"}" } }] }), { status: 200 });
  };
  const base = aiConfig();
  const grader = createAiGrader({ ...base, reasoningEffort: "high" }, { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["\u5b83\u5f88\u5927"], answer: "\u5b83\u975e\u5e38\u5927" });

  assert.equal(result.correct, true);
  assert.equal(requests[0].reasoning_effort, "high");
  assert.equal(Object.hasOwn(requests[1], "reasoning_effort"), false);
  assert.deepEqual(requests[1].response_format, { type: "json_object" });
});

test("generated questions reject unlearned English words and duplicates", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ questions: [
    { direction: "en-zh", english: "big cat", chinese: "\u5927\u732b", acceptedEnglish: ["big cat", "large cat"], acceptedChinese: ["\u5927\u732b"], focus: "big" },
    { direction: "en-zh", english: "big cat", chinese: "\u5927\u732b", acceptedEnglish: ["big cat"], acceptedChinese: ["\u5927\u732b"], focus: "\u91cd\u590d" },
    { direction: "zh-en", english: "big dog", chinese: "\u5927\u72d7", acceptedEnglish: ["big dog"], acceptedChinese: ["\u5927\u72d7"], focus: "\u672a\u5b66" },
    { direction: "zh-en", english: "cat", chinese: "\u732b", acceptedEnglish: ["cat"], acceptedChinese: ["\u732b"], focus: "\u5355\u8bcd" }
  ] }) } }] };

  const questions = parseGeneratedQuestions(payload, { allowedWords: ["big", "cat"], count: 2 });
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map(item => item.english), ["big cat", "cat"]);
  assert.deepEqual(questions[0].acceptedEnglish, ["big cat"]);
  assert.throws(() => parseGeneratedQuestions(payload, { allowedWords: ["big", "cat"], count: 3 }), /too few valid/);
});

test("AI rate limiter isolates callers and returns a retry delay", () => {
  let current = 1000;
  const take = createRateLimiter(2, 60000, () => current);
  assert.equal(take("user-a").allowed, true);
  assert.equal(take("user-a").allowed, true);
  assert.equal(take("user-b").allowed, true);
  assert.equal(take("user-a").allowed, false);
  current += 60001;
  assert.equal(take("user-a").allowed, true);
});

test("admin configures AI on the web and progress-based questions use the selected capability", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  createUser(store, { username: "owner", password: "strong-ai-password" });
  createUser(store, { username: "member", password: "strong-member-password" });
  saveUsers(dataDir, store);

  const providerRequests = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      providerRequests.push({ authorization: req.headers.authorization, body, url: req.url });
      const system = String(body.messages && body.messages[0] && body.messages[0].content || "");
      let content;
      if (system.includes("Create personalized translation exercises")) {
        content = JSON.stringify({ questions: [
          { direction: "en-zh", english: "It is big.", chinese: "\u5b83\u5f88\u5927\u3002", acceptedEnglish: ["it is big"], acceptedChinese: ["\u5b83\u5f88\u5927"], focus: "big" },
          { direction: "zh-en", english: "A cat sat on a mat.", chinese: "\u4e00\u53ea\u732b\u5750\u5728\u4e00\u5f20\u57ab\u5b50\u4e0a\u3002", acceptedEnglish: ["a cat sat on a mat"], acceptedChinese: ["\u4e00\u53ea\u732b\u5750\u5728\u57ab\u5b50\u4e0a"], focus: "cat" },
          { direction: "en-zh", english: "I am Sam.", chinese: "\u6211\u662f\u8428\u59c6\u3002", acceptedEnglish: ["i am sam"], acceptedChinese: ["\u6211\u662f\u8428\u59c6"], focus: "am" },
          { direction: "zh-en", english: "It is a big pig.", chinese: "\u5b83\u662f\u4e00\u5934\u5927\u732a\u3002", acceptedEnglish: ["it is a big pig"], acceptedChinese: ["\u5b83\u662f\u4e00\u5934\u5927\u732a"], focus: "pig" },
          { direction: "en-zh", english: "A big cat sat on a mat.", chinese: "\u4e00\u53ea\u5927\u732b\u5750\u5728\u4e00\u5f20\u57ab\u5b50\u4e0a\u3002", acceptedEnglish: ["a big cat sat on a mat"], acceptedChinese: ["\u4e00\u53ea\u5927\u732b\u5750\u5728\u57ab\u5b50\u4e0a"], focus: "sat" }
        ] });
      } else if (system.includes("ok set to true")) content = "{\"ok\":true}";
      else content = "{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002\"}";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const providerPort = provider.address().port;
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(appPort),
      COOKIE_SECURE: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.aiGrading, false);
    assert.equal(JSON.stringify(health).includes("private-test-key"), false);

    const unauthenticated = await fetch(`${baseUrl}/api/ai/grade`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "strong-ai-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const configured = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "private-test-key",
        models: ["test-model", "strong-model"],
        defaultModel: "test-model",
        timeoutMs: 10000,
        rateLimitPerMinute: 20
      })
    });
    assert.equal(configured.status, 200);
    assert.equal(JSON.stringify(await configured.json()).includes("private-test-key"), false);

    const visibleConfig = await (await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": cookie } })).json();
    assert.equal(visibleConfig.hasApiKey, true);
    assert.equal(Object.hasOwn(visibleConfig, "apiKey"), false);
    assert.equal(JSON.stringify(visibleConfig).includes("private-test-key"), false);
    assert.equal((await (await fetch(`${baseUrl}/api/health`)).json()).aiGrading, true);

    const connectionTest = await fetch(`${baseUrl}/api/admin/ai-config/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ model: "test-model", reasoningEffort: "medium" })
    });
    assert.equal(connectionTest.status, 200);
    assert.equal(providerRequests.length, 1);

    const localGrade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5927\u732b" })
    });
    assert.equal(localGrade.status, 200);
    assert.equal((await localGrade.json()).source, "local");
    assert.equal(providerRequests.length, 1);

    const grade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5f88\u5927\u7684\u732b", model: "strong-model", reasoningEffort: "high" })
    });
    assert.equal(grade.status, 200);
    assert.deepEqual(await grade.json(), { correct: true, explanation: "\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002", source: "ai" });
    assert.equal(providerRequests.length, 2);
    assert.equal(providerRequests[1].url, "/v1/chat/completions");
    assert.equal(providerRequests[1].authorization, "Bearer private-test-key");
    assert.equal(providerRequests[1].body.model, "strong-model");
    assert.equal(providerRequests[1].body.reasoning_effort, "high");
    assert.deepEqual(providerRequests[1].body.response_format, { type: "json_object" });

    const stateUpdate = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        taskStates: { "d2-cat:en-zh": { level: 0, lastResult: false } },
        attempts: [{ taskId: "d2-cat:en-zh", answer: "\u72d7", correct: false }],
        mistakes: [{ id: "weak-cat", taskId: "d2-cat:en-zh", prompt: "cat", userAnswer: "\u72d7", correctAnswer: "\u732b" }]
      })
    });
    assert.equal(stateUpdate.status, 200);

    const generated = await fetch(`${baseUrl}/api/ai/questions/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ model: "strong-model", reasoningEffort: "high", count: 5 })
    });
    assert.equal(generated.status, 201);
    const generatedBody = await generated.json();
    assert.equal(generatedBody.set.questions.length, 5);
    assert.equal(generatedBody.set.model, "strong-model");
    assert.equal(providerRequests.length, 3);
    const profile = JSON.parse(providerRequests[2].body.messages[1].content);
    assert.equal(profile.recentMistakes[0].correctAnswer, "\u732b");
    assert.equal(providerRequests[2].body.reasoning_effort, "high");

    const firstQuestion = generatedBody.set.questions[0];
    const questionGrade = await fetch(`${baseUrl}/api/ai/questions/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ setId: generatedBody.set.id, questionId: firstQuestion.id, answer: "\u5b83\u975e\u5e38\u5927" })
    });
    assert.equal(questionGrade.status, 200);
    const questionResult = await questionGrade.json();
    assert.equal(questionResult.correct, true);
    assert.equal(questionResult.practice.history.length, 1);
    assert.equal(providerRequests.length, 4);

    const memberLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "member", password: "strong-member-password" })
    });
    const memberCookie = memberLogin.headers.get("set-cookie").split(";")[0];
    const memberState = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": memberCookie } })).json();
    assert.equal(memberState.aiPractice.currentSet, null);
    assert.deepEqual(memberState.aiPractice.history, []);
    const memberOptions = await (await fetch(`${baseUrl}/api/ai/options`, { headers: { "Cookie": memberCookie } })).json();
    assert.equal(memberOptions.selectedModel, "test-model");
    assert.equal(memberOptions.selectedEffort, "medium");
    const forbidden = await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": memberCookie } });
    assert.equal(forbidden.status, 403);
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
