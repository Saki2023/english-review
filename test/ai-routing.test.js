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
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
