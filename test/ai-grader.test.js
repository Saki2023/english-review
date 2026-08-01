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
const { buildChatCompletionsUrl, createAiGrader, createRateLimiter, loadAiConfig, parseGradeResponse } = require("../server/ai-grader");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-"));
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

  const config = loadAiConfig({ AI_BASE_URL: "https://sub2api.example/v1", AI_API_KEY: "secret", AI_MODEL: "test-model" });
  assert.equal(config.configured, true);
  assert.equal(config.timeoutMs, 10000);
  assert.equal(config.rateLimitPerMinute, 20);
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
  const config = loadAiConfig({ AI_BASE_URL: "https://sub2api.example/v1", AI_API_KEY: "secret", AI_MODEL: "test-model" });
  const grader = createAiGrader(config, { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["\u5b83\u5f88\u5927"], answer: "\u4ed6\u5f88\u5927" });

  assert.equal(result.correct, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
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

test("authenticated sentence grading calls the configured provider without exposing its key", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  createUser(store, { username: "learner", password: "strong-ai-password" });
  saveUsers(dataDir, store);

  const providerRequests = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      providerRequests.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), url: req.url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002\"}" } }] }));
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
      COOKIE_SECURE: "false",
      AI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      AI_API_KEY: "private-test-key",
      AI_MODEL: "test-model"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.aiGrading, true);
    assert.equal(JSON.stringify(health).includes("private-test-key"), false);

    const unauthenticated = await fetch(`${baseUrl}/api/ai/grade`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "learner", password: "strong-ai-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const localGrade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5927\u732b" })
    });
    assert.equal(localGrade.status, 200);
    assert.equal((await localGrade.json()).source, "local");
    assert.equal(providerRequests.length, 0);

    const grade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5f88\u5927\u7684\u732b" })
    });
    assert.equal(grade.status, 200);
    assert.deepEqual(await grade.json(), { correct: true, explanation: "\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002", source: "ai" });
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0].url, "/v1/chat/completions");
    assert.equal(providerRequests[0].authorization, "Bearer private-test-key");
    assert.equal(providerRequests[0].body.model, "test-model");
    assert.deepEqual(providerRequests[0].body.response_format, { type: "json_object" });
    assert.equal(providerRequests[0].body.messages[1].content.includes("\u5b83\u662f\u4e00\u53ea\u5f88\u5927\u7684\u732b"), true);
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
