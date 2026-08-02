"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");
const { deriveLearningSyncToken, deriveTeachingProfileWriteToken } = require("../server/learning-sync-token");

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

test("teaching profile write token updates only the local teaching profile", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-teaching-sync-"));
  const users = loadUsers(dataDir);
  createUser(users, { username: "learner", password: "teaching-sync-password" });
  saveUsers(dataDir, users);
  const apiToken = "teaching-sync-api-token";
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), API_TOKEN: apiToken, COOKIE_SECURE: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(baseUrl, child);
    const endpoint = `${baseUrl}/api/sync/teaching-profile?username=learner`;
    const body = JSON.stringify({
      updatedAt: "2026-08-02T10:00:00Z",
      progress: { name: "学习进度.md", content: "当前完成第 2 天" },
      mistakes: { name: "错题本.md", content: "cat 不能写成 kat" },
      preview: { name: "第004天预习.md", content: "# 第 4 天预习\n\n学习 hot。" },
      previews: [
        { name: "第003天预习.md", content: "# 第 3 天预习" },
        { name: "第004天预习.md", content: "# 第 4 天预习\n\n学习 hot。" }
      ],
      apiKey: "must-not-be-stored",
      password: "must-not-be-stored"
    });
    const rejected = await fetch(endpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveLearningSyncToken(apiToken)}`, "Content-Type": "application/json" }, body });
    assert.equal(rejected.status, 401);
    const written = await fetch(endpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveTeachingProfileWriteToken(apiToken)}`, "Content-Type": "application/json" }, body });
    assert.equal(written.status, 200);

    const profileResponse = await fetch(`${baseUrl}/api/sync/profile?username=learner`, { headers: { Authorization: `Bearer ${deriveLearningSyncToken(apiToken)}` } });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.localTeachingProfile.progress.content, "当前完成第 2 天");
    assert.equal(profile.localTeachingProfile.previews.length, 2);
    assert.equal(JSON.stringify(profile).includes("must-not-be-stored"), false);

    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "learner", password: "teaching-sync-password" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const anonymousPreview = await fetch(`${baseUrl}/api/preview`);
    assert.equal(anonymousPreview.status, 401);
    const previewResponse = await fetch(`${baseUrl}/api/preview`, { headers: { Cookie: cookie } });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.preview.name, "第004天预习.md");
    assert.equal(preview.previews.length, 2);
    assert.equal(JSON.stringify(preview).includes("must-not-be-stored"), false);
    const state = await (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })).json();
    assert.equal(Object.hasOwn(state, "teachingProfile"), false);
    const abilities = await fetch(`${baseUrl}/api/abilities`, { headers: { Cookie: cookie } });
    assert.equal(abilities.status, 200);
    assert.equal((await abilities.json()).unpracticedAbilities, 7);
  } finally {
    child.kill();
    await new Promise(resolve => child.once("exit", resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
