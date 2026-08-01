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
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.users, 1);
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

    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.doesNotMatch(html, /data-auth-mode|confirmPasswordWrap|>注册</);
    assert.match(html, /app\.js\?v=9/);
    assert.doesNotMatch(html, /\?v=[78]/);

    const appResponse = await fetch(`${baseUrl}/app.js?v=9`);
    assert.equal(appResponse.status, 200);
    assert.equal(appResponse.headers.get("cache-control"), "no-cache");

    const appSource = await appResponse.text();
    assert.match(appSource, /nextButton"\)\.focus\(\{ preventScroll: true \}\)/);
    assert.match(appSource, /sw\.js\?v=9/);
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
