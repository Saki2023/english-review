"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { dateScope, describeRow, filterItems, revision, sortItems, usageStatus } = require("../library-usage");

const items = [
  { id: "a", preview: false },
  { id: "b", preview: false },
  { id: "c", preview: false },
  { id: "planned", preview: true }
];
const rows = [
  { id: "a", index: 1, periodUsage: 1, independentCorrect: 1, wrong: 0, accuracy: 100, lastUsedAt: "2026-08-19T01:00:00Z", nextDue: "2026-08-20" },
  { id: "b", index: 2, periodUsage: 0, independentCorrect: 0, wrong: 2, accuracy: 0, lastUsedAt: "2026-08-18T01:00:00Z", nextDue: "2026-08-19" },
  { id: "c", index: 3, periodUsage: 0, independentCorrect: 0, wrong: 0, accuracy: null, lastUsedAt: "", nextDue: "" }
];
const ids = value => value.map(item => item.id);

test("library usage sorts before pagination and keeps planned words stably last", () => {
  assert.deepEqual(ids(sortItems(items, rows, "usage", "asc")), ["b", "c", "a", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "usage", "desc")), ["a", "b", "c", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "correct", "desc")), ["a", "b", "c", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "wrong", "desc")), ["b", "a", "c", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "accuracy", "asc")), ["c", "b", "a", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "recent", "asc")), ["c", "b", "a", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "recent", "desc")), ["a", "b", "c", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "due", "asc")), ["c", "b", "a", "planned"]);
  assert.deepEqual(ids(sortItems(items, rows, "index", "desc")), ["c", "b", "a", "planned"]);
  assert.deepEqual(ids(sortItems([items[0], items[2], items[3]], rows, "usage", "asc")), ["c", "a", "planned"], "search/day filtering can run before stable sorting");
});

test("library usage filters learned base words by the server period counters", () => {
  assert.deepEqual(ids(filterItems(items, rows, "used")), ["a"]);
  assert.deepEqual(ids(filterItems(items, rows, "unused")), ["b", "c"]);
  assert.deepEqual(ids(filterItems(items, rows, "all")), ["a", "b", "c", "planned"]);
  assert.equal(usageStatus("used"), "used");
  assert.equal(usageStatus("unused"), "unused");
  assert.equal(usageStatus("unexpected"), "all");
});

test("word usage revisions change when counters change even at the same timestamp", () => {
  const first = { updatedAt: "2026-08-19T01:00:00Z", summary: { events: 1 }, rows: [{ id: "a", todayUsage: 1, totalUsage: 1, nextDue: "2026-08-20" }] };
  const second = { ...first, summary: { events: 2 }, rows: [{ id: "a", todayUsage: 2, totalUsage: 2, nextDue: "2026-08-20" }] };
  assert.notEqual(revision(first), revision(second));
  assert.equal(revision(first), revision(JSON.parse(JSON.stringify(first))));
});

test("library usage labels distinguish selected periods from all-time totals", () => {
  const row = { periodUsage: 0, independentCorrect: 0, wrong: 0, assisted: 0, accuracy: null };
  assert.deepEqual(dateScope("", ""), { active: false, from: "", to: "", label: "全部日期" });
  assert.equal(dateScope("2026-08-18", "2026-08-18").label, "2026-08-18");
  assert.equal(dateScope("2026-08-18", "2026-08-20").label, "2026-08-18 至 2026-08-20");
  assert.equal(dateScope("2026-08-18", "").label, "2026-08-18 起");
  assert.equal(dateScope("", "2026-08-20").label, "截至 2026-08-20");

  assert.deepEqual(describeRow(row, "2026-08-18", "2026-08-18"), {
    scope: { active: true, from: "2026-08-18", to: "2026-08-18", label: "2026-08-18" },
    period: "所选区间 0 次",
    results: "区间对 0 · 错 0 · 提示 0",
    accuracy: "区间正确率 —"
  });
  assert.deepEqual(describeRow({ periodUsage: 3, independentCorrect: 2, wrong: 1, assisted: 0, accuracy: 67 }), {
    scope: { active: false, from: "", to: "", label: "全部日期" },
    period: "",
    results: "累计对 2 · 错 1 · 提示 0",
    accuracy: "累计正确率 67%"
  });
});
