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

test("PWA client assets consistently use cache version 15", () => {
  const index = read("index.html");
  const app = read("app.js");
  const serviceWorker = read("sw.js");
  const versionedSources = `${index}\n${app}\n${serviceWorker}`;
  const versions = Array.from(versionedSources.matchAll(/\?v=(\d+)/g), match => match[1]);

  assert.ok(versions.length > 0);
  assert.deepEqual(new Set(versions), new Set(["15"]));
  assert.match(serviceWorker, /const CACHE_NAME = "daily-english-review-v15"/);
});
