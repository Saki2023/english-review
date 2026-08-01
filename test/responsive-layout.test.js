"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

test("mobile styles keep new AI and notes controls within a narrow viewport", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const tablet = css.slice(css.indexOf("@media (max-width: 760px)"), css.indexOf("@media (max-width: 520px)"));
  const mobile = css.slice(css.indexOf("@media (max-width: 520px)"));

  assert.match(tablet, /\.side-nav\s*\{[^}]*repeat\(6, minmax\(0, 1fr\)\)/s);
  assert.match(tablet, /\.ai-tutor-window\s*\{[^}]*right:\s*10px[^}]*left:\s*10px[^}]*resize:\s*none/s);
  assert.match(mobile, /\.ai-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.ai-history-heading\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(mobile, /\.ai-history-answers\s*>\s*div\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(mobile, /\.notes-columns\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
});
