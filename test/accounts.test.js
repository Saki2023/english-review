"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers, validPassword } = require("../server/accounts");
const { deriveLearningSyncToken } = require("../server/learning-sync-token");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-"));
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

test("account store hashes passwords and assigns roles", () => {
  const dataDir = temporaryDataDir();
  try {
    const store = loadUsers(dataDir);
    const admin = createUser(store, { username: "owner", password: "strong-pass-1" });
    const member = createUser(store, { username: "student", password: "strong-pass-2" });
    const secondAdmin = createUser(store, { username: "helper", password: "strong-pass-3" }, "admin");
    saveUsers(dataDir, store);

    assert.equal(admin.role, "admin");
    assert.equal(member.role, "member");
    assert.equal(secondAdmin.role, "admin");
    assert.notEqual(admin.passwordHash, "strong-pass-1");
    assert.equal(validPassword("strong-pass-1", admin.passwordSalt, admin.passwordHash), true);
    assert.equal(validPassword("wrong-pass", admin.passwordSalt, admin.passwordHash), false);
    assert.equal(loadUsers(dataDir).users.length, 3);
    assert.throws(() => createUser(store, { username: "OWNER", password: "another-pass" }), /用户名已存在/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SSH-created account can log in and public registration is absent", async () => {
  const dataDir = temporaryDataDir();
  fs.writeFileSync(path.join(dataDir, "content-store.json"), `${JSON.stringify({ updatedAt: "2026-08-01", words: [], sentences: [], deletedIds: [] })}\n`, "utf8");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "server", "create-user.js"), "--username", "sshowner", "--password-stdin"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: dataDir },
    input: "strong-ssh-password\n"
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /账号已创建：sshowner/);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false", API_TOKEN: "profile-sync-test-token" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.users, 1);
    assert.deepEqual({ currentDay: health.currentDay, words: health.words, sentences: health.sentences, notes: health.notes }, { currentDay: 4, words: 29, sentences: 20, notes: 4 });
    assert.equal(Object.hasOwn(health, "registrationOpen"), false);

    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "password123" })
    });
    assert.equal(registerResponse.status, 404);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "sshowner", password: "strong-ssh-password" })
    });
    assert.equal(loginResponse.status, 200);
    assert.equal((await loginResponse.json()).user.role, "admin");

    const statusResponse = await fetch(`${baseUrl}/api/auth/status`);
    const status = await statusResponse.json();
    assert.equal(Object.hasOwn(status, "registrationOpen"), false);

    const contentResponse = await fetch(`${baseUrl}/api/content`);
    assert.equal(contentResponse.status, 200);
    const content = await contentResponse.json();
    assert.equal(content.notes.length, 4);
    assert.match(content.notes[3].review, /box/);
    assert.equal(content.words.length, 29);
    assert.equal(content.sentences.length, 20);
    assert.equal(content.updatedAt, "2026-08-03");

    const blockedSync = await fetch(`${baseUrl}/api/sync/profile?username=sshowner`);
    assert.equal(blockedSync.status, 401);
    const overprivilegedSync = await fetch(`${baseUrl}/api/sync/profile?username=sshowner`, { headers: { "Authorization": "Bearer profile-sync-test-token" } });
    assert.equal(overprivilegedSync.status, 401);
    const readToken = deriveLearningSyncToken("profile-sync-test-token");
    const syncResponse = await fetch(`${baseUrl}/api/sync/profile?username=sshowner`, { headers: { "Authorization": `Bearer ${readToken}` } });
    assert.equal(syncResponse.status, 200);
    const syncProfile = await syncResponse.json();
    assert.equal(syncProfile.user.username, "sshowner");
    assert.equal(syncProfile.course.currentDay, 4);
    assert.deepEqual({ words: syncProfile.course.words, sentences: syncProfile.course.sentences, notes: syncProfile.course.notes }, { words: 29, sentences: 20, notes: 4 });
    assert.equal(syncProfile.summary.aiQuestions, 0);
    assert.equal(Object.hasOwn(syncProfile.user, "passwordHash"), false);
    assert.equal(JSON.stringify(syncProfile).includes("profile-sync-test-token"), false);
    assert.equal(JSON.stringify(syncProfile).includes(readToken), false);

    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.doesNotMatch(html, /data-auth-mode|confirmPasswordWrap|>注册</);
    assert.match(html, /app\.js\?v=67/);
    assert.match(html, /pronunciation-data\.js\?v=67/);
    assert.match(html, /data-view="notes"/);
    assert.match(html, /id="aiTutorWindow"/);
    assert.match(html, /id="aiHistoryList"/);
    assert.doesNotMatch(html, /\?v=(?:[7-9]|1[0-4])(?:\D|$)/);

    const appResponse = await fetch(`${baseUrl}/app.js?v=67`);
    assert.equal(appResponse.status, 200);
    assert.equal(appResponse.headers.get("cache-control"), "no-cache");

    const appSource = await appResponse.text();
    assert.match(appSource, /nextButton"\)\.focus\(\{ preventScroll: true \}\)/);
    assert.match(appSource, /nextAiQuestion"\)\.addEventListener\("keydown"/);
    assert.match(appSource, /sw\.js\?v=67/);
    const pronunciationResponse = await fetch(`${baseUrl}/pronunciation-data.js?v=67`);
    assert.equal(pronunciationResponse.status, 200);
    assert.equal(pronunciationResponse.headers.get("cache-control"), "no-cache");
    const phonemeResponse = await fetch(`${baseUrl}/audio/phonemes/v-close-front.ogg`);
    assert.equal(phonemeResponse.status, 200);
    assert.equal(phonemeResponse.headers.get("content-type"), "audio/ogg");
    assert.ok((await phonemeResponse.arrayBuffer()).byteLength > 256);
    const diphthongResponse = await fetch(`${baseUrl}/audio/phonemes/v-au.wav`);
    assert.equal(diphthongResponse.status, 200);
    assert.equal(diphthongResponse.headers.get("content-type"), "audio/wav");
    assert.match(appSource, /api\/admin\/ai-config\/models/);
    assert.match(appSource, /api\/ai\/questions\/ask/);
    assert.match(appSource, /function renderAiHistory/);
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
