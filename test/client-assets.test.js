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
  assert.match(html, /id="aiTutorModel"/);
  assert.match(html, /id="aiTutorProvider"/);
  assert.match(app, /message,\s*providerId: practice\.tutorSettings\.providerId,\s*model: practice\.tutorSettings\.model,\s*reasoningEffort: practice\.tutorSettings\.reasoningEffort/s);
  assert.match(app, /data-ai-history-ask/);
  assert.match(app, /const available = aiOptions\.configured && target/);
  assert.match(app, /tutorHistory: \(Array\.isArray\(source\.tutorHistory\)/);
  assert.match(app, /practice\.tutorHistory\.filter\(item => item\.setId === target\.setId && item\.questionId === target\.questionId && \(!resetAt \|\| item\.askedAt > resetAt\)\)/);
  assert.match(app, /normalizeClientTutorExchange\(data\.exchange\)/);
  assert.match(html, /id="aiTutorPersistenceStatus"/);
  assert.match(html, /id="clearAiTutorButton"[^>]*>[\s\S]*清除会话/);
  assert.match(app, /function aiTutorTargetForSavedThread\(practice\)/);
  assert.match(app, /\/api\/ai\/questions\/tutor\/clear/);
  assert.match(app, /tutorResets:/);
  assert.match(app, /旧问答仍保留为学习记录/);
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
  const css = read("styles.css");
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
  const nav = html.slice(html.indexOf('<nav class="side-nav"'), html.indexOf("</nav>"));
  const aiHeading = html.slice(html.indexOf('id="view-ai"'), html.indexOf('id="aiControls"'));
  assert.match(nav, /id="openAiConfigButton"/);
  assert.doesNotMatch(aiHeading, /id="openAiConfigButton"/);
  assert.match(css, /\.ai-settings-nav-item\s*\{[^}]*margin-top:\s*auto/s);
});

test("mistake book automatically closes mastered items while retaining a two-answer threshold", () => {
  const app = read("app.js");
  const answers = read("answer-utils.js");
  const html = read("index.html");
  assert.match(answers, /const MISTAKE_AUTO_RESOLVE_STREAK = 2/);
  assert.match(answers, /function mistakeCorrectStreak\(attempts, taskId\)/);
  assert.match(answers, /attempt\.gradingStatus !== "partial"/);
  assert.match(answers, /function mistakeIsResolved\(attempts, taskId\)/);
  assert.match(app, /model\.mistakes = \(model\.mistakes \|\| \[\]\)\.filter\(mistake => !mistakeIsResolved/);
  assert.match(app, /mistakeIsResolved\(model\.attempts, row\.taskId\)/);
  assert.match(app, /连续答对 \$\{row\.correctStreak\}\/\$\{MISTAKE_AUTO_RESOLVE_STREAK\}/);
  assert.match(html, /连续 2 次完全答对后自动销号/);
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

test("pronunciation lesson lists and filters reference sounds without pretending word speech is isolated IPA", () => {
  const app = read("app.js");
  const html = read("index.html");
  const serviceWorker = read("sw.js");

  assert.match(html, /data-view="pronunciation"/);
  assert.match(html, /id="pronunciationConcepts"/);
  assert.match(html, /data-pronunciation-filter="learned"/);
  assert.match(html, /data-pronunciation-filter="vowel"/);
  assert.match(html, /data-pronunciation-filter="consonant"/);
  assert.match(html, /data-pronunciation-filter="all"/);
  assert.match(html, /pronunciation-data\.js\?v=33/);
  assert.match(app, /function renderPronunciation\(\)/);
  assert.match(app, /item\.learned === true/);
  assert.match(app, /speechButtonHtml\(item\.example/);
  assert.match(app, /中文辅助/);
  assert.match(serviceWorker, /pronunciation-data\.js\?v=33/);
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
  assert.match(sync, /网站课程内容\.json/);
  assert.match(sync, /\/api\/content\/batch/);
  assert.match(sync, /notesAdded/);
});

test("today review removes preview words from new, cached, library, and mistake entry paths", () => {
  const app = read("app.js");
  assert.match(app, /function reviewTaskIsEligible\(task, studyDate = localDate\(\)\)/);
  assert.match(app, /isReviewEligibleItem\(task\.item, DATA\.currentDay, studyDate\)/);
  assert.match(app, /function pruneReviewSession\(session\)/);
  assert.match(app, /let changed = pruneReviewSession\(session\)/);
  assert.match(app, /buildMistakePracticeQueue[\s\S]*\.filter\(candidate => reviewTaskIsEligible\(taskById\.get\(candidate\)\)\)/);
  assert.match(app, /item\.preview \? '<span class="type-badge">预习<\/span>'/);
});

test("filtered word and sentence library rows receive continuous visible sequence numbers", () => {
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(app, /class=\\"sequence-cell\\">序号/);
  assert.match(app, /items\.map\(\(item, index\) =>/);
  assert.match(app, /class="sequence-cell">\$\{index \+ 1\}/);
  assert.match(css, /\.data-table \.sequence-cell\s*\{[^}]*text-align:\s*center/s);
});

test("preview words have a next-day-only page with speech and learned-feature isolation", () => {
  const app = read("app.js");
  const html = read("index.html");
  const css = read("styles.css");
  const server = read("server.js");
  assert.match(html, /data-view="preview-words"/);
  assert.match(html, /id="previewWordsGrid"/);
  assert.match(html, /id="refreshPreviewWordsButton"/);
  assert.match(app, /fetch\("\/api\/preview\/words", \{ cache: "no-store", credentials: "same-origin" \}\)/);
  assert.match(app, /function normalizePreviewWordsResponse\(value\)/);
  assert.match(app, /item => item && item\.day === nextDay/);
  assert.match(app, /speechButtonHtml\(item\.english, `慢速播放预习单词/);
  assert.match(app, /const learnedItems = allItems\.filter\(item => !item\.preview\)/);
  assert.match(css, /\.preview-words-grid\s*\{[^}]*grid-template-columns:/s);
  assert.match(server, /url\.pathname === "\/api\/preview\/words"/);
  assert.match(server, /content\.words\.filter\(item => !item\.preview && item\.learned/);
});

test("partial answers have distinct feedback and preserve mastery", () => {
  const app = read("app.js");
  const css = read("styles.css");
  assert.match(app, /gradingStatus === "partial"/);
  assert.match(app, /基本理解正确/);
  assert.match(app, /state\.level = Math\.max\(1, Number\(state\.level\) \|\| 0\)/);
  assert.match(app, /function aiQuestionScore\(question\)/);
  assert.match(app, /得分 \$\{formatQuestionScore\(earned\)\}/);
  assert.match(app, /score: Number\.isFinite\(Number\(grading\.score\)\)/);
  assert.match(css, /\.feedback\.is-partial/);
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

test("PWA client assets consistently use the displayed cache version 33", () => {
  const index = read("index.html");
  const app = read("app.js");
  const serviceWorker = read("sw.js");
  const versionedSources = `${index}\n${app}\n${serviceWorker}`;
  const versions = Array.from(versionedSources.matchAll(/\?v=(\d+)/g), match => match[1]);
  const displayedVersion = index.match(/id="appVersionBadge"[^>]*>v(\d+)<\/span>/);

  assert.ok(displayedVersion, "the current version should be visible in the page header");
  assert.ok(versions.length > 0);
  assert.deepEqual(new Set(versions), new Set([displayedVersion[1]]));
  assert.equal(displayedVersion[1], "33");
  assert.match(serviceWorker, /const CACHE_NAME = "daily-english-review-v33"/);
});
