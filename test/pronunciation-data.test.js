"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function loadPronunciationData() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "pronunciation-data.js"), "utf8"), context);
  return JSON.parse(JSON.stringify(context.window.ENGLISH_PRONUNCIATION_DATA));
}

test("pronunciation reference contains 20 vowels and 24 consonants with unique ids", () => {
  const data = loadPronunciationData();
  const phonemes = data.phonemes;
  const requiredFields = ["id", "symbol", "subtype", "example", "exampleZh", "examplePhonetic", "mouth", "action", "chineseHint", "pitfall"];

  assert.equal(data.locale, "en-US");
  assert.equal(phonemes.length, 44);
  assert.equal(phonemes.filter(item => item.type === "vowel").length, 20);
  assert.equal(phonemes.filter(item => item.type === "consonant").length, 24);
  assert.equal(new Set(phonemes.map(item => item.id)).size, phonemes.length);
  phonemes.forEach(item => {
    assert.ok(["vowel", "consonant"].includes(item.type), `${item.id} has an invalid type`);
    assert.equal(typeof item.learned, "boolean", `${item.id} must declare whether it was explicitly learned`);
    requiredFields.forEach(field => assert.ok(String(item[field] || "").trim(), `${item.id}.${field} is required`));
    assert.match(item.symbol, /^\/.+\/$/u);
    assert.match(item.examplePhonetic, /^\/.+\/$/u);
  });
});

test("pronunciation course-first filter starts with the four explicitly taught vowels", () => {
  const data = loadPronunciationData();
  const learned = data.phonemes.filter(item => item.learned).map(item => item.symbol).sort();

  assert.deepEqual(learned, ["/e/", "/æ/", "/ɑ/", "/ɪ/"].sort());
  assert.match(data.summary, /不要求一次背完/);
  assert.match(data.audioNotice, /示范词/);
  assert.match(data.audioNotice, /不是孤立音标/);
  assert.match(data.accentNotice, /\/e\/.*\/ɛ\//);
  assert.match(data.accentNotice, /\/ɑ\/.*\/ɒ\//);
  assert.match(data.accentNotice, /\/oʊ\/.*\/əʊ\//);
});

test("pronunciation foundations explain symbols, vowels, consonants, voicing, syllables, and stress", () => {
  const data = loadPronunciationData();
  const ids = data.concepts.map(item => item.id);

  assert.deepEqual(ids, ["symbols", "vowels", "consonants", "voicing", "syllables"]);
  assert.equal(new Set(ids).size, ids.length);
  data.concepts.forEach(item => {
    ["title", "summary", "action", "example"].forEach(field => assert.ok(String(item[field] || "").trim(), `${item.id}.${field} is required`));
  });
  assert.match(data.concepts.find(item => item.id === "voicing").action, /\/s\/.*\/z\//);
  assert.match(data.concepts.find(item => item.id === "syllables").summary, /ˈ/);
});
