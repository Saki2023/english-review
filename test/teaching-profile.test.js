"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { deriveLearningSyncToken, deriveTeachingProfileWriteToken, validLearningSyncToken, validTeachingProfileWriteToken } = require("../server/learning-sync-token");
const { sanitizeTeachingProfile, teachingProfileForAi } = require("../server/teaching-profile");

test("read and teaching-write sync tokens have separate capabilities", () => {
  const read = deriveLearningSyncToken("secret-api-token");
  const write = deriveTeachingProfileWriteToken("secret-api-token");
  assert.notEqual(read, write);
  assert.equal(validLearningSyncToken(read, "secret-api-token"), true);
  assert.equal(validTeachingProfileWriteToken(write, "secret-api-token"), true);
  assert.equal(validLearningSyncToken(write, "secret-api-token"), false);
  assert.equal(validTeachingProfileWriteToken(read, "secret-api-token"), false);
});

test("teaching profile accepts only bounded learning documents", () => {
  const profile = sanitizeTeachingProfile({
    updatedAt: "2026-08-02T10:00:00Z",
    progress: { name: "学习进度.md", content: "当前学习到第 2 天" },
    mistakes: { name: "../错题本.md", content: "cat 写成 kat" },
    recentNotes: Array.from({ length: 8 }, (_, index) => ({ name: `第${index}天.md`, content: "笔记" })),
    apiKey: "must-not-survive",
    password: "must-not-survive"
  });
  assert.equal(profile.recentNotes.length, 5);
  assert.equal(profile.mistakes.name.includes("/"), false);
  assert.equal(Object.hasOwn(profile, "apiKey"), false);
  assert.equal(JSON.stringify(profile).includes("must-not-survive"), false);
  assert.equal(teachingProfileForAi(profile).progress.content, "当前学习到第 2 天");
});
