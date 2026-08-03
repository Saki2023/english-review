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
  assert.match(app, /tutorHistory: \(Array\.isArray\(source\.tutorHistory\)/);
  assert.match(app, /practice\.tutorHistory\.filter\(item => item\.setId === target\.setId && item\.questionId === target\.questionId\)/);
  assert.match(app, /normalizeClientTutorExchange\(data\.exchange\)/);
});

test("AI tutor launcher supports persistent pointer dragging", () => {
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(app, /function startAiTutorLaunchDrag\(event\)/);
  assert.match(app, /Math\.hypot\(event\.clientX - drag\.startX, event\.clientY - drag\.startY\) < 6/);
  assert.match(app, /localStorage\.setItem\(aiTutorLaunchPositionKey\(\)/);
  assert.match(app, /ai-tutor-launch-position-v2/);
  assert.match(app, /if \(!value \|\| typeof value !== "object" \|\| Array\.isArray\(value\)\) return null/);
  assert.match(app, /Date\.now\(\) < aiTutorLaunchSuppressClickUntil/);
  assert.match(app, /window\.addEventListener\("pointermove", moveAiTutorLaunchButton\)/);
  assert.match(app, /window\.addEventListener\("pointerup", endAiTutorLaunchDrag\)/);
  assert.match(app, /window\.addEventListener\("pointercancel", endAiTutorLaunchDrag\)/);
  assert.match(app, /window\.addEventListener\("resize", constrainAiTutorLaunchPosition\)/);
  assert.match(app, /window\.addEventListener\("orientationchange", constrainAiTutorLaunchPosition\)/);
  assert.match(css, /\.ai-tutor-launch\s*\{[^}]*cursor:\s*grab[^}]*touch-action:\s*none[^}]*user-select:\s*none/s);
});

test("exam weaknesses jump to and highlight their related wrong questions", () => {
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(app, /function examWeaknessQuestionId\(exam, weakness\)/);
  assert.match(app, /data-exam-jump-question/);
  assert.match(app, /function jumpToExamQuestion\(questionId\)/);
  assert.match(app, /const scrollTop = Math\.max\(0, window\.scrollY \+ targetRect\.top - desiredTop\)/);
  assert.match(app, /window\.scrollTo\(\{ top: scrollTop, behavior: "smooth" \}\)/);
  assert.match(app, /summary !== "\[object Object\]"/);
  assert.match(css, /\.exam-question\.is-weakness-target/);
  assert.match(css, /\.exam-weakness-link/);
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
  assert.match(app, /const testEffort = selectedAiSettings\(\)\.reasoningEffort/);
  assert.match(app, /appliedReasoningEffort/);
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
  assert.match(app, /EXAM_GENERATION_POLL_MS/);
  assert.match(app, /monitorExamGeneration\(examState\.generation\.id\)/);
  assert.match(app, /generation\.status === "failed"/);
  assert.match(app, /"X-English-Review-Exam-Version": EXAM_GENERATION_API_VERSION/);
  assert.match(app, /\[504, 524\]\.includes\(response\.status\)/);
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

test("daily preview loads the latest synced document and renders bounded Markdown safely", () => {
  const app = read("app.js");
  const html = read("index.html");
  const css = read("styles.css");
  const sync = read("scripts/sync-learning-profile.ps1");
  assert.match(html, /data-view="preview"/);
  assert.match(html, /id="previewHistorySelect"/);
  assert.match(html, /id="refreshPreviewButton"/);
  assert.match(app, /fetch\("\/api\/preview", \{ cache: "no-store", credentials: "same-origin" \}\)/);
  assert.match(app, /function previewMarkdownHtml\(value\)/);
  assert.match(app, /escapeHtml\(code\.join\("\\n"\)\)/);
  assert.match(app, /previewState\.previews/);
  assert.doesNotMatch(app, /documents\.map\(document\s*=>\s*\{\s*const option = document\.createElement/);
  assert.match(css, /\.preview-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(sync, /Select-Object -First 30/);
  assert.match(sync, /previews = \$previewDocuments/);
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

test("PWA client assets consistently use the displayed cache version 29", () => {
  const index = read("index.html");
  const app = read("app.js");
  const serviceWorker = read("sw.js");
  const versionedSources = `${index}\n${app}\n${serviceWorker}`;
  const versions = Array.from(versionedSources.matchAll(/\?v=(\d+)/g), match => match[1]);
  const displayedVersion = index.match(/id="appVersionBadge"[^>]*>v(\d+)<\/span>/);

  assert.ok(displayedVersion, "the current version should be visible in the page header");
  assert.ok(versions.length > 0);
  assert.deepEqual(new Set(versions), new Set([displayedVersion[1]]));
  assert.equal(displayedVersion[1], "29");
  assert.match(serviceWorker, /const CACHE_NAME = "daily-english-review-v29"/);
});
