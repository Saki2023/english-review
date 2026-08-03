"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test("preview Markdown word table becomes bounded next-lesson content", () => {
  const parser = path.join(ROOT, "scripts", "preview-words.ps1");
  const preview = path.resolve(ROOT, "..", "预习", "第005天预习.md");
  const command = `. ${psQuote(parser)}; $words = @(ConvertFrom-PreviewWordTable ${psQuote(preview)}); ConvertTo-Json -InputObject $words -Depth 10 -Compress`;
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const words = JSON.parse(result.stdout.trim());
  assert.equal(words.length, 8);
  assert.deepEqual(words.map(item => item.english), ["sun", "run", "cup", "bus", "fun", "but", "we", "are"]);
  assert.equal(words.every(item => item.day === 5 && item.preview === true && item.learned === ""), true);
  assert.equal(words[0].id, "d5-sun");
  assert.equal(words[0].phonetic, "/sʌn/");
  assert.equal(words[0].chinese, "太阳");
  assert.equal(words[4].acceptedChinese.includes("乐趣"), true);
  assert.match(words[0].pronunciation, /喇叭/);
});

test("learning sync uploads parsed preview words without embedding credentials", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "sync-learning-profile.ps1"), "utf8");
  assert.match(script, /ConvertFrom-PreviewWordTable/);
  assert.match(script, /Add-Member -NotePropertyName previewWords/);
  assert.match(script, /预习单词已同步/);
  assert.doesNotMatch(script, /SYNC_(?:READ|WRITE)_TOKEN\s*=\s*["'][^"']+["']/);
});
