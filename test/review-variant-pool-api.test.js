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
const { normalizeEnglish } = require("../review-variants");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-pool-api-")); }

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

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function variantCandidates(family) {
  const values = [];
  if (family === "identity") {
    ["I", "He", "She", "Sam", "Tom"].forEach(subject => ["a man", "a mom", "Sam", "Tom"].forEach(predicate => values.push(`${subject} ${subject === "I" ? "am" : "is"} ${predicate}.`)));
  } else if (family === "description") {
    ["big", "red", "hot"].forEach(adjective => values.push(`It is ${adjective}.`));
    ["big", "red", "hot"].forEach(adjective => ["pig", "cat", "pen", "bed", "box", "mat", "mom", "man"].forEach(noun => values.push(`It is a ${adjective} ${noun}.`)));
  } else if (family === "sat-on") {
    ["I", "A man", "A big pig", "A cat", "A big cat", "A hen", "Tom", "Sam", "He", "She"].forEach(subject => ["a mat", "a box", "a bed"].forEach(surface => values.push(`${subject} ${subject === "I" ? "sat" : "sat"} on ${surface}.`)));
  } else if (family === "inside") {
    ["She", "He", "Tom", "Sam", "It", "A cat", "A pig", "A pen"].forEach(subject => ["a shop", "a box"].forEach(place => values.push(`${subject} is in ${place}.`)));
  } else if (family === "on") {
    ["It", "A cat", "A box", "A pen", "A red pen", "A pig", "A big cat", "Tom", "Sam"].forEach(subject => ["a mat", "a box", "a bed", "top"].forEach(surface => values.push(`${subject} is on ${surface}.`)));
  }
  return Array.from(new Set(values));
}

function createProvider({ delayMs = 0 } = {}) {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404); return res.end();
    }
    const body = await readBody(req);
    calls.push(body);
    const input = JSON.parse(body.messages[1].content);
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const excluded = new Set((Array.isArray(input.excludedEnglish) ? input.excludedEnglish : []).map(normalizeEnglish));
    const variants = input.targets.map((target, index) => {
      const family = target.grammarFamily;
      const chosen = variantCandidates(family).find(sentence => !excluded.has(normalizeEnglish(sentence))) || variantCandidates(family)[index % variantCandidates(family).length];
      excluded.add(normalizeEnglish(chosen));
      return { taskId: target.taskId, english: chosen, chinese: `句子 ${calls.length}-${index}`, acceptedChinese: [`句子 ${calls.length}-${index}`] };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ variants }) } }] }));
  });
  return { provider, calls };
}

async function waitForReadyPool(baseUrl, cookie) {
  let poolState;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    poolState = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    if (poolState.reviewVariantPool.status === "ready") return poolState.reviewVariantPool;
    if (poolState.reviewVariantPool.status === "needs-attention") throw new Error(poolState.reviewVariantPool.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`sentence pool did not become ready: ${JSON.stringify(poolState && poolState.reviewVariantPool)}`);
}

async function startApp(dataDir, port, autofill = true) {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false", REVIEW_VARIANT_POOL_AUTOFILL: String(Boolean(autofill)) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(`http://127.0.0.1:${port}`, child);
  return child;
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "pool-owner", password: "pool-test-password" })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("daily sentence pool survives refresh, stale state PUT, and server restart", async () => {
  const dataDir = temporaryDataDir();
  const providerInfo = createProvider();
  let app;
  let restarted;
  try {
    const users = loadUsers(dataDir);
    createUser(users, { username: "pool-owner", password: "pool-test-password" });
    saveUsers(dataDir, users);
    await new Promise((resolve, reject) => providerInfo.provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = providerInfo.provider.address().port;
    const appPort = await freePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    app = await startApp(dataDir, appPort);
    const cookie = await login(baseUrl);

    const configured = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "pool-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 })
    });
    assert.equal(configured.status, 200);

    const started = await fetch(`${baseUrl}/api/review/sentence-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ prefetch: true, model: "test-model", reasoningEffort: "high" })
    });
    assert.equal(started.status, 202);

    let poolState;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      poolState = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
      if (poolState.reviewVariantPool.status === "ready") break;
      if (poolState.reviewVariantPool.status === "needs-attention") throw new Error(poolState.reviewVariantPool.error);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(poolState.reviewVariantPool.status, "ready");
    assert.equal(poolState.reviewVariantPool.generatedCount, 50);
    assert.ok(providerInfo.calls.length >= 3);

    const diskState = JSON.parse(fs.readFileSync(path.join(dataDir, "user-states.json"), "utf8"));
    const storedState = Object.values(diskState.users)[0];
    assert.equal(storedState.reviewVariantPool.variants.length, 50);

    const assigned = await fetch(`${baseUrl}/api/review/sentence-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskIds: ["d4-s5:en-zh"], model: "test-model", reasoningEffort: "high" })
    });
    const assignedBody = await assigned.json();
    assert.equal(assigned.status, 200);
    assert.equal(assignedBody.variants.length, 1);
    const assignedId = assignedBody.variants[0].id;

    const stale = { ...(await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json()), sessions: {} };
    const stalePut = await fetch(`${baseUrl}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json", "Cookie": cookie }, body: JSON.stringify(stale) });
    assert.equal(stalePut.status, 200);
    const afterStalePut = await (await fetch(`${baseUrl}/api/review/sentence-variants`, { method: "POST", headers: { "Content-Type": "application/json", "Cookie": cookie }, body: JSON.stringify({ taskIds: ["d4-s5:en-zh"] }) })).json();
    assert.equal(afterStalePut.variants[0].id, assignedId);

    app.kill();
    await once(app, "exit");
    const restartedPort = await freePort();
    const restartedUrl = `http://127.0.0.1:${restartedPort}`;
    restarted = await startApp(dataDir, restartedPort);
    const restartedCookie = await login(restartedUrl);
    const persisted = await (await fetch(`${restartedUrl}/api/state`, { headers: { "Cookie": restartedCookie } })).json();
    assert.equal(persisted.reviewVariantPool.status, "ready");
    assert.equal(persisted.reviewVariantPool.generatedCount, 50);
  } finally {
    for (const child of [app, restarted]) {
      if (child && child.exitCode === null) child.kill();
    }
    await new Promise(resolve => providerInfo.provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("course sync automatically replaces and fills the 50-sentence pool exactly once per sync cycle", async () => {
  const dataDir = temporaryDataDir();
  const providerInfo = createProvider({ delayMs: 40 });
  let app;
  try {
    const users = loadUsers(dataDir);
    createUser(users, { username: "pool-owner", password: "pool-test-password" });
    saveUsers(dataDir, users);
    await new Promise((resolve, reject) => providerInfo.provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = providerInfo.provider.address().port;
    const appPort = await freePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    app = await startApp(dataDir, appPort);
    const cookie = await login(baseUrl);

    const configured = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "pool-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 })
    });
    assert.equal(configured.status, 200);

    const syncCourse = async updatedAt => {
      const response = await fetch(`${baseUrl}/api/content/batch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Cookie": cookie },
        body: JSON.stringify({
          updatedAt,
          notes: [{ day: 4, date: updatedAt, score: "已完成", summary: "同步后准备下一轮复习句子。", goals: [], pronunciation: [], patterns: [], mistakes: [], review: "复习已学内容。" }]
        })
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const firstSync = await syncCourse("2026-08-05");
    assert.deepEqual({ cycleChanged: firstSync.reviewSentencePool.cycleChanged, accounts: firstSync.reviewSentencePool.accounts, started: firstSync.reviewSentencePool.started }, { cycleChanged: true, accounts: 1, started: 1 });
    const firstPool = await waitForReadyPool(baseUrl, cookie);
    assert.equal(firstPool.generatedCount, 50);
    const firstSyncKey = firstPool.syncKey;
    const callsAfterFirstFill = providerInfo.calls.length;

    const repeatedSync = await syncCourse("2026-08-05");
    assert.deepEqual({ cycleChanged: repeatedSync.reviewSentencePool.cycleChanged, started: repeatedSync.reviewSentencePool.started, ready: repeatedSync.reviewSentencePool.ready }, { cycleChanged: false, started: 0, ready: 1 });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(providerInfo.calls.length, callsAfterFirstFill, "repeating the same learning sync must not regenerate the pool");
    const repeatedPool = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.equal(repeatedPool.reviewVariantPool.syncKey, firstSyncKey);
    assert.equal(repeatedPool.reviewVariantPool.generatedCount, 50);

    const nextSync = await syncCourse("2026-08-06");
    assert.deepEqual({ cycleChanged: nextSync.reviewSentencePool.cycleChanged, started: nextSync.reviewSentencePool.started }, { cycleChanged: true, started: 1 });
    const clearedPool = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.notEqual(clearedPool.reviewVariantPool.syncKey, firstSyncKey);
    assert.equal(clearedPool.reviewVariantPool.generatedCount, 0, "the previous 50 sentences are removed before the new background request completes");
    const nextPool = await waitForReadyPool(baseUrl, cookie);
    assert.equal(nextPool.generatedCount, 50);
    assert.notEqual(nextPool.syncKey, firstSyncKey);
    assert.ok(providerInfo.calls.length > callsAfterFirstFill);
  } finally {
    if (app && app.exitCode === null) app.kill();
    await new Promise(resolve => providerInfo.provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("review immediately reuses a stored learned sentence even before its matching family is generated", async () => {
  const dataDir = temporaryDataDir();
  const providerInfo = createProvider();
  let app;
  try {
    const users = loadUsers(dataDir);
    createUser(users, { username: "pool-owner", password: "pool-test-password" });
    saveUsers(dataDir, users);
    await new Promise((resolve, reject) => providerInfo.provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const providerPort = providerInfo.provider.address().port;
    const appPort = await freePort();
    const baseUrl = `http://127.0.0.1:${appPort}`;
    app = await startApp(dataDir, appPort, false);
    const cookie = await login(baseUrl);

    const configured = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "pool-test-key", models: ["test-model"], defaultModel: "test-model", timeoutMs: 10000, rateLimitPerMinute: 60 })
    });
    assert.equal(configured.status, 200);

    let response = await fetch(`${baseUrl}/api/review/sentence-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskIds: ["d4-s5:en-zh"], model: "test-model", reasoningEffort: "high", force: true })
    });
    assert.equal(response.status, 202);
    let generated = await response.json();
    for (let attempt = 0; response.status === 202 && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      response = await fetch(`${baseUrl}/api/review/sentence-variants?jobId=${encodeURIComponent(generated.jobId)}`, { headers: { "Cookie": cookie } });
      generated = await response.json();
    }
    assert.equal(response.status, 200);
    assert.equal(generated.variants.length, 1);
    assert.equal(generated.variants[0].family, "description");

    const poolState = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.equal(poolState.reviewVariantPool.generatedCount, 1);
    assert.equal(poolState.reviewVariantPool.remainingCount, 49);

    const reusedResponse = await fetch(`${baseUrl}/api/review/sentence-variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskIds: ["d4-s2:en-zh"], model: "test-model", reasoningEffort: "high" })
    });
    assert.equal(reusedResponse.status, 200, "an existing pool sentence must be returned without waiting for AI");
    const reused = await reusedResponse.json();
    assert.equal(reused.status, "completed");
    assert.equal(reused.cached, true);
    assert.equal(reused.variants[0].id, generated.variants[0].id);
    assert.equal(reused.variants[0].family, "description", "the stored sentence may be reused before the inside family is ready");

    const gradeResponse = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        taskId: "d4-s2:en-zh",
        variantId: reused.variants[0].id,
        reviewVariant: reused.variants[0],
        answer: reused.variants[0].chinese,
        model: "test-model",
        reasoningEffort: "high"
      })
    });
    assert.equal(gradeResponse.status, 200);
    const grade = await gradeResponse.json();
    assert.equal(grade.correct, true);
    assert.equal(grade.source, "local");
  } finally {
    if (app && app.exitCode === null) app.kill();
    await new Promise(resolve => providerInfo.provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
