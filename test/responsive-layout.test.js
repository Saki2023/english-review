"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("mobile styles keep AI, exam, ability, dictation, focused, pronunciation, notes, and preview controls within a narrow viewport", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const tablet = css.slice(css.indexOf("@media (max-width: 760px)"), css.indexOf("@media (max-width: 520px)"));
  const mobile = css.slice(css.indexOf("@media (max-width: 520px)"));

  assert.match(tablet, /\.side-nav\s*\{[^}]*grid-auto-flow:\s*column[^}]*grid-auto-columns:\s*minmax\(62px, 1fr\)[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.side-nav\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(tablet, /\.ai-settings-nav-item\s*\{[^}]*margin-top:\s*0/s);
  assert.match(tablet, /\.ai-tutor-window\s*\{[^}]*right:\s*10px[^}]*left:\s*10px[^}]*resize:\s*none/s);
  assert.match(css, /\.ai-tutor-control-actions\s*\{[^}]*display:\s*grid[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.brand-name\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(mobile, /\.topbar-actions\s*\{[^}]*gap:\s*8px/s);
  assert.match(mobile, /\.brand-mark\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/s);
  assert.match(mobile, /\.user-badge\s*\{[^}]*max-width:\s*64px/s);
  assert.match(mobile, /\.ai-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.exam-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.exam-options,\s*\.exam-generate-button\s*\{[^}]*grid-column:\s*1/s);
  assert.match(mobile, /\.exam-type-scores\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(tablet, /\.exam-page\s*\{[^}]*aspect-ratio:\s*auto[^}]*overflow:\s*visible/s);
  assert.match(tablet, /\.exam-page-content\s*\{[^}]*column-count:\s*1/s);
  assert.match(mobile, /\.dictation-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.focused-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.focused-skill-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(tablet, /\.pronunciation-concepts,\s*\.pronunciation-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(tablet, /\.pronunciation-controls\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.pronunciation-filter\s*\{[^}]*width:\s*100%[^}]*overflow-x:\s*auto/s);
  assert.match(mobile, /\.pronunciation-filter \.segment\s*\{[^}]*flex:\s*1/s);
  assert.match(mobile, /\.ai-history-heading\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.ai-history-answers\s*>\s*div\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.notes-columns\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.preview-toolbar\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.preview-toolbar \.notes-day-picker,\s*\.preview-toolbar \.secondary-button\s*\{[^}]*width:\s*100%/s);
  assert.match(tablet, /\.preview-heading,\s*\.preview-words-heading,\s*\.preview-practice-heading\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.preview-words-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.preview-words-heading \.secondary-button,\s*\.preview-words-actions\s*\{[^}]*width:\s*100%/s);
  assert.match(tablet, /\.ai-provider-workspace\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.ai-routing-settings\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.ai-provider-list\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(mobile, /\.library-pagination\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.library-page-actions\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/s);
});
