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
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

test("manual mode stays fixed while automatic mode fails over and rotates", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-routing-"));
  const users = loadUsers(dataDir);
  createUser(users, { username: "owner", password: "routing-test-password" });
  saveUsers(dataDir, users);

  let failFirst = true;
  const calls = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const providerId = req.url.startsWith("/first/") ? "first" : req.url.startsWith("/second/") ? "second" : "unknown";
      calls.push(providerId);
      if (providerId === "unknown" || req.method !== "POST") {
        res.writeHead(404);
        return res.end();
      }
      if (providerId === "first" && failFirst) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, "route-model");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ correct: false, explanation: `${providerId} 已判定。` }) } }] }));
    });
  });
  await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));

  const providerPort = provider.address().port;
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(appPort), COOKIE_SECURE: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "routing-test-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { "Content-Type": "application/json", "Cookie": cookie };
    const providers = [
      { id: "first", name: "First", enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/first/v1`, apiKey: "first-key", models: ["route-model"], timeoutMs: 5000 },
      { id: "second", name: "Second", enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/second/v1`, apiKey: "second-key", models: ["route-model"], timeoutMs: 5000 }
    ];
    const saveConfig = mode => fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode, manualProviderId: "first", providers, defaultModel: "route-model", rateLimitPerMinute: 60 })
    });
    const grade = () => fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "完全错误", model: "route-model", reasoningEffort: "medium" })
    });

    assert.equal((await saveConfig("manual")).status, 200);
    calls.length = 0;
    assert.equal((await grade()).status, 503);
    assert.deepEqual(calls, ["first"]);

    assert.equal((await saveConfig("auto")).status, 200);
    calls.length = 0;
    const failover = await grade();
    assert.equal(failover.status, 200);
    assert.equal((await failover.json()).explanation, "second 已判定。");
    assert.deepEqual(calls, ["first", "second"]);
    let visible = await (await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": cookie } })).json();
    assert.equal(visible.rotationCursor, 0);

    failFirst = false;
    calls.length = 0;
    assert.equal((await grade()).status, 200);
    assert.deepEqual(calls, ["first"]);
    visible = await (await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": cookie } })).json();
    assert.equal(visible.rotationCursor, 1);

    calls.length = 0;
    assert.equal((await grade()).status, 200);
    assert.deepEqual(calls, ["second"]);
    visible = await (await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": cookie } })).json();
    assert.equal(visible.rotationCursor, 0);

    assert.equal((await saveConfig("manual")).status, 200);
    const historyId = "tutor-set:tutor-question";
    const savedState = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ aiPractice: {
        settings: { model: "route-model", reasoningEffort: "high", count: 5 },
        tutorSettings: { providerId: "second", model: "route-model", reasoningEffort: "max" },
        history: [{ id: historyId, setId: "tutor-set", direction: "en-zh", prompt: "cat", userAnswer: "狗", correctAnswer: "猫", correct: false, score: 0, gradingStatus: "incorrect" }]
      } })
    });
    assert.equal(savedState.status, 200);

    const options = await (await fetch(`${baseUrl}/api/ai/options`, { headers: { "Cookie": cookie } })).json();
    assert.equal(options.selectedTutorProviderId, "second");
    assert.equal(options.selectedTutorModel, "route-model");
    assert.deepEqual(options.providers.map(item => item.id), ["first", "second"]);
    assert.deepEqual(Object.keys(options.providers[0]).sort(), ["enabled", "id", "models", "name"]);
    assert.equal(JSON.stringify(options).includes("first-key"), false);
    assert.equal(JSON.stringify(options).includes("baseUrl"), false);

    calls.length = 0;
    assert.equal((await grade()).status, 200, "global grading should keep using the manual provider");
    assert.deepEqual(calls, ["first"]);

    calls.length = 0;
    const tutor = await fetch(`${baseUrl}/api/ai/questions/ask`, {
      method: "POST",
      headers,
      body: JSON.stringify({ historyId, message: "请给我一个提示。", providerId: "second", model: "route-model", reasoningEffort: "max" })
    });
    assert.equal(tutor.status, 200);
    assert.deepEqual(calls, ["second"], "tutor selection must not follow the global manual provider");
    const tutorBody = await tutor.json();
    assert.equal(tutorBody.provider.id, "second");
    assert.equal(tutorBody.tutorSettings.providerId, "second");

    let persisted = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.deepEqual(persisted.aiPractice.tutorSettings, { providerId: "second", model: "route-model", reasoningEffort: "max" });
    assert.equal(persisted.aiPractice.tutorHistory[0].providerId, "second");
    assert.equal(persisted.aiPractice.tutorHistory[0].providerName, "Second");
    assert.equal(persisted.aiPractice.tutorHistory[0].model, "route-model");
    assert.equal(persisted.aiPractice.tutorHistory[0].reasoningEffort, "max");

    assert.equal((await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { "Cookie": cookie } })).status, 200);
    const relogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "routing-test-password" })
    });
    const reloginCookie = relogin.headers.get("set-cookie").split(";")[0];
    persisted = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": reloginCookie } })).json();
    assert.equal(persisted.aiPractice.tutorSettings.providerId, "second", "tutor provider should survive a fresh login");
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
