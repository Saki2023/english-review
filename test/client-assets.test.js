"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

test("AI tutor Enter handling is wired to form submission", () => {
  const app = read("app.js");
  const html = read("index.html");
  assert.match(app, /aiTutorInput"\)\.addEventListener\("keydown", event => \{\s*if \(!shouldSubmitOnEnter\(event\)\) return;\s*event\.preventDefault\(\);\s*\$\("#aiTutorForm"\)\.requestSubmit\(\);/s);
  assert.match(html, /id="aiTutorEffort"/);
  assert.match(app, /message,\s*reasoningEffort: practice\.tutorSettings\.reasoningEffort/s);
  assert.match(app, /data-ai-history-ask/);
  assert.match(app, /const available = aiOptions\.configured && target/);
});

test("AI settings UI manages providers and exposes manual or automatic routing", () => {
  const app = read("app.js");
  const html = read("index.html");
  assert.match(html, /data-ai-routing-mode="manual"/);
  assert.match(html, /data-ai-routing-mode="auto"/);
  assert.match(html, /id="aiManualProvider"/);
  assert.match(html, /id="aiProviderList"/);
  assert.match(html, /id="addAiProviderButton"/);
  assert.match(app, /mode: aiConfigDraft\.mode/);
  assert.match(app, /manualProviderId: aiConfigDraft\.manualProviderId/);
  assert.match(app, /providers: aiConfigDraft\.providers\.map/);
  assert.match(app, /providerId: provider\.id/);
});

test("exam UI uses dedicated APIs, optional listening, and whole-paper submission", () => {
  const app = read("app.js");
  const html = read("index.html");
  assert.match(html, /data-view="exam"/);
  assert.match(html, /id="examIncludeEssay"/);
  assert.match(html, /id="examIncludeListening"/);
  assert.match(html, /data-exam-points="100"/);
  assert.match(html, /data-exam-points="150"/);
  assert.match(app, /speechSynthesisAvailable/);
  assert.match(app, /utterance\.rate = 0\.75/);
  assert.match(app, /\/api\/ai\/exams\/listening/);
  assert.match(app, /\/api\/ai\/exams\/current/);
  assert.match(app, /\/api\/ai\/exams\/submit/);
  assert.match(app, /exam\.questions\.find\(question => !examAnswerComplete/);
  assert.match(app, /完形填空材料/);
  assert.match(app, /exam\.clozePassage/);
  assert.match(app, /材料题材料/);
});

test("ability, dictation, and focused practice UI share speech and evidence controls", () => {
  const app = read("app.js");
  const html = read("index.html");
  assert.match(html, /data-view="abilities"/);
  assert.match(html, /id="abilityRadar"/);
  assert.match(app, /\/api\/abilities/);
  assert.match(html, /data-view="dictation"/);
  assert.match(app, /\/api\/ai\/dictation\/speech/);
  assert.match(app, /\/api\/ai\/dictation\/submit/);
  assert.match(html, /data-view="focused"/);
  assert.match(app, /\/api\/ai\/focused\/submit/);
  assert.match(app, /Array\.from\(\{ length: 5 \}/);
  assert.match(app, /speechButtonHtml/);
  assert.match(app, /question\.direction === "en-zh" \? speechButtonHtml/);
});

test("exam UI supports A3 pages, printing, draft recovery, and paper-photo grading", () => {
  const app = read("app.js");
  const html = read("index.html");
  const css = read("styles.css");
  assert.match(html, /id="printExamButton"/);
  assert.match(html, /id="examPhotoInput"[^>]*multiple/);
  assert.match(app, /window\.print\(\)/);
  assert.match(app, /compressExamPhoto/);
  assert.match(app, /\/api\/ai\/exams\/photo-grade/);
  assert.match(app, /class="exam-page"/);
  assert.match(css, /aspect-ratio:\s*420\s*\/\s*297/);
  assert.match(css, /@page\s*\{\s*size:\s*A3 landscape/);
  assert.match(css, /\.exam-page-content\s*\{[^}]*column-count:\s*2/s);
});

test("PWA client assets consistently use cache version 19", () => {
  const index = read("index.html");
  const app = read("app.js");
  const serviceWorker = read("sw.js");
  const versionedSources = `${index}\n${app}\n${serviceWorker}`;
  const versions = Array.from(versionedSources.matchAll(/\?v=(\d+)/g), match => match[1]);

  assert.ok(versions.length > 0);
  assert.deepEqual(new Set(versions), new Set(["19"]));
  assert.match(serviceWorker, /const CACHE_NAME = "daily-english-review-v19"/);
});
