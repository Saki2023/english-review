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

    const courseEndpoint = `${baseUrl}/api/content/batch`;
    const courseBody = JSON.stringify({
      updatedAt: "2026-08-04",
      words: [{ id: "d5-sun", day: 5, learned: "2026-08-04", english: "sun", chinese: "太阳", phonetic: "/sʌn/", acceptedChinese: ["太阳"], directions: ["en-zh", "zh-en"] }],
      previewWords: [
        { id: "d6-dog", day: 6, learned: "", preview: true, english: "dog", chinese: "狗", phonetic: "/dɔɡ/", acceptedChinese: ["狗"], directions: ["en-zh", "zh-en"] },
        { id: "d7-far", day: 7, learned: "", preview: true, english: "far", chinese: "远的", phonetic: "/fɑr/", acceptedChinese: ["远的"], directions: ["en-zh", "zh-en"] },
        { id: "d6-sun-again", day: 6, learned: "", preview: true, english: "sun", chinese: "太阳", phonetic: "/sʌn/", acceptedChinese: ["太阳"], directions: ["en-zh", "zh-en"] }
      ],
      sentences: [{ id: "d5-s1", day: 5, learned: "2026-08-04", english: "It is fun.", chinese: "它很有趣。", acceptedChinese: ["它很有趣"], acceptedEnglish: ["it is fun"], directions: ["en-zh", "zh-en"] }],
      notes: [{ day: 5, date: "2026-08-04", score: "9 / 10", summary: "学习 /ʌ/。", goals: ["拼读 sun"], pronunciation: ["/ʌ/ 要短促。"], patterns: [], mistakes: [], review: "复习 sun。" }]
    });
    const rejectedCourse = await fetch(courseEndpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveLearningSyncToken(apiToken)}`, "Content-Type": "application/json" }, body: courseBody });
    assert.equal(rejectedCourse.status, 401);
    const writtenCourse = await fetch(courseEndpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveTeachingProfileWriteToken(apiToken)}`, "Content-Type": "application/json" }, body: courseBody });
    assert.equal(writtenCourse.status, 200);
    const courseResult = await writtenCourse.json();
    assert.deepEqual({ added: courseResult.added, updated: courseResult.updated, previewWords: courseResult.previewWords, notesAdded: courseResult.notesAdded, currentDay: courseResult.currentDay }, { added: 3, updated: 0, previewWords: 1, notesAdded: 1, currentDay: 5 });
    const repeatedCourse = await (await fetch(courseEndpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveTeachingProfileWriteToken(apiToken)}`, "Content-Type": "application/json" }, body: courseBody })).json();
    assert.deepEqual({ added: repeatedCourse.added, updated: repeatedCourse.updated, previewWords: repeatedCourse.previewWords, notesUpdated: repeatedCourse.notesUpdated }, { added: 0, updated: 3, previewWords: 1, notesUpdated: 1 });
    const syncedCourse = await (await fetch(`${baseUrl}/api/content`)).json();
    assert.equal(syncedCourse.currentDay, 5);
    assert.equal(syncedCourse.words.some(item => item.id === "d5-sun"), true);
    assert.equal(syncedCourse.words.some(item => item.id === "d6-dog" && item.preview === true && item.learned === ""), true);
    assert.equal(syncedCourse.words.some(item => item.id === "d7-far" || item.id === "d6-sun-again"), false);
    assert.equal(syncedCourse.sentences.some(item => item.id === "d5-s1"), true);
    assert.equal(syncedCourse.notes.some(item => item.day === 5 && /sun/.test(item.review)), true);

    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "learner", password: "teaching-sync-password" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const anonymousPreviewWords = await fetch(`${baseUrl}/api/preview/words`);
    assert.equal(anonymousPreviewWords.status, 401);
    const previewWordsResponse = await fetch(`${baseUrl}/api/preview/words`, { headers: { Cookie: cookie } });
    assert.equal(previewWordsResponse.status, 200);
    const previewWords = await previewWordsResponse.json();
    assert.deepEqual({ currentDay: previewWords.currentDay, nextDay: previewWords.nextDay, words: previewWords.words.map(item => item.english) }, { currentDay: 5, nextDay: 6, words: ["dog"] });
    const unavailablePreviewSentences = await fetch(`${baseUrl}/api/preview/practice/sentences`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ wordIds: ["d6-dog"] }) });
    assert.equal(unavailablePreviewSentences.status, 503);
    const unavailableBody = await unavailablePreviewSentences.json();
    assert.equal(Array.isArray(unavailableBody.sentences), false);
    assert.equal(unavailableBody.retryAfterMs, 60 * 60 * 1000);

    const promotedBody = JSON.stringify({
      updatedAt: "2026-08-05",
      words: [{ id: "d6-dog", day: 6, learned: "2026-08-05", english: "dog", chinese: "狗", phonetic: "/dɔɡ/", acceptedChinese: ["狗"], directions: ["en-zh", "zh-en"] }],
      previewWords: [{ id: "d7-run", day: 7, learned: "", preview: true, english: "run", chinese: "跑", phonetic: "/rʌn/", acceptedChinese: ["跑"], directions: ["en-zh", "zh-en"] }],
      sentences: [],
      notes: []
    });
    const promoted = await (await fetch(courseEndpoint, { method: "PUT", headers: { Authorization: `Bearer ${deriveTeachingProfileWriteToken(apiToken)}`, "Content-Type": "application/json" }, body: promotedBody })).json();
    assert.deepEqual({ currentDay: promoted.currentDay, added: promoted.added, updated: promoted.updated, previewWords: promoted.previewWords }, { currentDay: 6, added: 1, updated: 1, previewWords: 1 });
    const promotedContent = await (await fetch(`${baseUrl}/api/content`)).json();
    assert.equal(promotedContent.words.some(item => item.id === "d6-dog" && item.preview === false && item.learned === "2026-08-05"), true);
    assert.equal(promotedContent.words.some(item => item.id === "d7-run" && item.preview === true), true);
    const nextPreviewWords = await (await fetch(`${baseUrl}/api/preview/words`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual({ currentDay: nextPreviewWords.currentDay, nextDay: nextPreviewWords.nextDay, words: nextPreviewWords.words.map(item => item.english) }, { currentDay: 6, nextDay: 7, words: ["run"] });

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
