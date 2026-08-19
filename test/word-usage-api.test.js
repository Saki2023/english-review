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
const { activityEvents, appendEvents } = require("../server/word-memory");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-word-usage-api-"));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(port));
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
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { baseUrl, child };
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

function createAccounts(dataDir) {
  const store = loadUsers(dataDir);
  const owner = createUser(store, { username: "usage-owner", password: "usage-owner-password" }, "admin");
  const other = createUser(store, { username: "usage-other", password: "usage-other-password" }, "member");
  saveUsers(dataDir, store);
  return { owner, other };
}

function seedUsage(dataDir, ownerId) {
  const content = {
    words: [
      { id: "d1-man", day: 1, learned: "2026-08-01", english: "man", chinese: "男人", acceptedChinese: ["男人"] },
      { id: "d2-cat", day: 2, learned: "2026-08-01", english: "cat", chinese: "猫", acceptedChinese: ["猫"] }
    ],
    sentences: []
  };
  const events = [
    ...activityEvents({
      eventId: "api-usage-man-wrong",
      source: "review",
      taskId: "d1-man:en-zh",
      wordIds: ["d1-man"],
      kind: "recall",
      result: "wrong",
      formalEvidence: true,
      date: "2026-08-18",
      occurredAt: "2026-08-18T01:00:00.000Z"
    }, content),
    ...activityEvents({
      eventId: "api-usage-man-correct",
      source: "ai",
      taskId: "d1-man:zh-en",
      wordIds: ["d1-man"],
      kind: "recall",
      result: "independent-correct",
      formalEvidence: true,
      date: "2026-08-19",
      occurredAt: "2026-08-19T01:00:00.000Z"
    }, content),
    ...activityEvents({
      eventId: "api-usage-man-exposure",
      source: "reading",
      taskId: "reading-1",
      wordIds: ["d1-man"],
      kind: "exposure",
      result: "completed",
      formalEvidence: true,
      date: "2026-08-17",
      occurredAt: "2026-08-17T01:00:00.000Z"
    }, content)
  ];
  const usage = appendEvents(null, events, content).state;
  fs.writeFileSync(path.join(dataDir, "user-states.json"), `${JSON.stringify({ schema: 1, users: { [ownerId]: { wordUsage: usage } } })}\n`, "utf8");
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function getUsage(baseUrl, cookie, query = "") {
  const response = await fetch(`${baseUrl}/api/word-usage${query}`, { headers: { Cookie: cookie } });
  return { response, body: await response.json() };
}

test("word usage API is date-filtered, account-isolated, read-only, and restart-stable", async () => {
  const dataDir = temporaryDataDir();
  const { owner, other } = createAccounts(dataDir);
  seedUsage(dataDir, owner.id);
  let app;
  try {
    app = await startApp(dataDir);
    const ownerCookie = await login(app.baseUrl, "usage-owner", "usage-owner-password");
    const otherCookie = await login(app.baseUrl, "usage-other", "usage-other-password");

    const inclusive = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-18&to=2026-08-19&sort=usage&order=desc");
    assert.equal(inclusive.response.status, 200);
    const ownerMan = inclusive.body.rows.find(row => row.id === "d1-man");
    assert.equal(ownerMan.periodUsage, 2, "both inclusive dates must be counted");
    assert.equal(ownerMan.independentCorrect, 1);
    assert.equal(ownerMan.wrong, 1);
    assert.equal(ownerMan.accuracy, 50);
    assert.equal(Object.hasOwn(inclusive.body, "events"), false);
    assert.equal(JSON.stringify(inclusive.body).includes("acceptedChinese"), false);
    assert.equal(JSON.stringify(inclusive.body).includes("api-usage-man"), false);
    assert.equal(inclusive.body.rows[0].id, "d1-man", "descending usage order must put the only used word first");

    const ascending = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-18&to=2026-08-19&sort=usage&order=asc");
    assert.notEqual(ascending.body.rows[0].id, "d1-man", "ascending usage order must put unused words before the used word");
    assert.equal(ascending.body.rows.at(-1).id, "d1-man");

    const oneDay = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-19&to=2026-08-19");
    const oneDayMan = oneDay.body.rows.find(row => row.id === "d1-man");
    assert.equal(oneDayMan.periodUsage, 1);
    assert.equal(oneDayMan.independentCorrect, 1);
    assert.equal(oneDayMan.wrong, 0);
    assert.equal(oneDayMan.accuracy, 100);

    const priorDay = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-18&to=2026-08-18");
    const priorDayMan = priorDay.body.rows.find(row => row.id === "d1-man");
    assert.equal(priorDayMan.periodUsage, 1);
    assert.equal(priorDayMan.independentCorrect, 0);
    assert.equal(priorDayMan.wrong, 1);
    assert.equal(priorDayMan.accuracy, 0);

    const emptyPeriod = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-16&to=2026-08-16&sort=usage&order=desc");
    const emptyMan = emptyPeriod.body.rows.find(row => row.id === "d1-man");
    assert.equal(emptyMan.periodUsage, 0);
    assert.equal(emptyMan.independentCorrect, 0);
    assert.equal(emptyMan.wrong, 0);
    assert.equal(emptyMan.accuracy, null);

    const allDates = await getUsage(app.baseUrl, ownerCookie, "?sort=usage&order=desc");
    const allDatesMan = allDates.body.rows.find(row => row.id === "d1-man");
    assert.equal(allDatesMan.periodUsage, 3);
    assert.equal(allDatesMan.totalUsage, 3);
    assert.equal(allDatesMan.independentCorrect, 1);
    assert.equal(allDatesMan.wrong, 1);
    assert.equal(allDatesMan.accuracy, 50);

    const isolated = await getUsage(app.baseUrl, otherCookie, "?from=2026-08-18&to=2026-08-19");
    assert.equal(isolated.response.status, 200);
    assert.equal(isolated.body.rows.find(row => row.id === "d1-man").totalUsage, 0);
    assert.equal(isolated.body.summary.events, 0);

    const invalidDate = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-19x");
    assert.equal(invalidDate.response.status, 400);
    const reversed = await getUsage(app.baseUrl, ownerCookie, "?from=2026-08-20&to=2026-08-19");
    assert.equal(reversed.response.status, 400);

    const statePath = path.join(dataDir, "user-states.json");
    const before = fs.readFileSync(statePath, "utf8");
    const beforeMtime = fs.statSync(statePath).mtimeMs;
    await getUsage(app.baseUrl, ownerCookie, "?sort=correct&order=desc");
    await getUsage(app.baseUrl, ownerCookie, "?sort=recent&order=asc");
    assert.equal(fs.readFileSync(statePath, "utf8"), before, "reading and sorting must not write state");
    assert.equal(fs.statSync(statePath).mtimeMs, beforeMtime);

    await stopApp(app);
    app = await startApp(dataDir);
    const afterRestart = await getUsage(app.baseUrl, await login(app.baseUrl, "usage-owner", "usage-owner-password"), "?from=2026-08-18&to=2026-08-19");
    assert.equal(afterRestart.response.status, 200);
    assert.equal(afterRestart.body.rows.find(row => row.id === "d1-man").periodUsage, 2);
    assert.equal(afterRestart.body.rows.find(row => row.id === "d2-cat").periodUsage, 0);
  } finally {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
