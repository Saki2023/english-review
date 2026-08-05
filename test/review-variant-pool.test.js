"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  REVIEW_VARIANT_POOL_TARGET,
  assignReviewVariantPoolTasks,
  buildReviewVariantPoolTasks,
  createReviewVariantPool,
  ensureReviewVariantPool,
  reviewVariantContentSignature,
  reviewVariantPoolSummary,
  sanitizeReviewVariantPool,
  storeReviewVariantPoolResults
} = require("../server/review-variant-pool");

const content = {
  currentDay: 2,
  words: [
    { id: "word-it", english: "it", day: 1 },
    { id: "word-is", english: "is", day: 1 },
    { id: "word-big", english: "big", day: 2 },
    { id: "preview-red", english: "red", day: 3, preview: true }
  ],
  sentences: [
    { id: "sentence-description", english: "It is big.", chinese: "它很大。", day: 2 },
    { id: "sentence-on", english: "It is on a mat.", chinese: "它在垫子上。", day: 2 },
    { id: "preview-sentence", english: "It is red.", chinese: "它是红色的。", day: 3, preview: true }
  ]
};

function poolVariant(index, family = index % 2 ? "description" : "on") {
  return {
    taskId: `pool:2026-08-05:${index}:${family}`,
    id: `ai-${family}-${index}`,
    family,
    english: family === "description" ? `It is big ${index}.` : `It is on a mat ${index}.`,
    chinese: `测试句子 ${index}。`,
    acceptedEnglish: [family === "description" ? `it is big ${index}` : `it is on a mat ${index}`],
    acceptedChinese: [`测试句子 ${index}`],
    requiredWords: family === "description" ? ["it", "is", "big"] : ["it", "is", "on", "a", "mat"],
    source: "ai",
    model: "test-model",
    reasoningEffort: "high",
    generatedAt: "2026-08-05T00:00:00.000Z"
  };
}

test("daily review variant pool keeps 100 variants and stable assignments after serialization", () => {
  let pool = createReviewVariantPool({ date: "2026-08-05", contentSignature: "signature-a" });
  const stored = storeReviewVariantPoolResults(pool, Array.from({ length: REVIEW_VARIANT_POOL_TARGET }, (_, index) => poolVariant(index)), {
    requestedCount: REVIEW_VARIANT_POOL_TARGET
  });
  pool = stored.pool;
  assert.equal(pool.variants.length, 100);
  assert.equal(pool.status, "ready");

  const tasks = [
    { taskId: "sentence-description:en-zh", family: "description" },
    { taskId: "sentence-on:zh-en", family: "on" }
  ];
  const first = assignReviewVariantPoolTasks(pool, tasks);
  const reloaded = sanitizeReviewVariantPool(JSON.parse(JSON.stringify(first.pool)));
  const second = assignReviewVariantPoolTasks(reloaded, tasks);
  assert.deepEqual(second.variants.map(item => item.id), first.variants.map(item => item.id));
  assert.equal(reviewVariantPoolSummary(second.pool).generatedCount, 100);
  assert.equal(reviewVariantPoolSummary(second.pool).assignedCount, 2);
});

test("a new date or changed learned content discards the previous daily pool", () => {
  const signature = reviewVariantContentSignature(content);
  const initial = storeReviewVariantPoolResults(createReviewVariantPool({ date: "2026-08-05", contentSignature: signature }), [poolVariant(1)], { requestedCount: 1 }).pool;
  const nextDay = ensureReviewVariantPool(initial, { date: "2026-08-06", contentSignature: signature });
  assert.equal(nextDay.replaced, true);
  assert.equal(nextDay.pool.variants.length, 0);
  assert.deepEqual(nextDay.pool.assignments, {});

  const changedContent = { ...content, words: [...content.words, { id: "word-cat", english: "cat", day: 2 }] };
  const changed = ensureReviewVariantPool(initial, { date: "2026-08-05", contentSignature: reviewVariantContentSignature(changedContent) });
  assert.equal(changed.replaced, true);
  assert.equal(changed.pool.variants.length, 0);
});

test("pool generation saves batches and resumes with the next slot after reload", () => {
  const signature = reviewVariantContentSignature(content);
  let pool = createReviewVariantPool({ date: "2026-08-05", contentSignature: signature });
  const firstTasks = buildReviewVariantPoolTasks(content, pool, 20);
  assert.equal(firstTasks.length, 20);
  assert.equal(firstTasks[0].poolSlot, 0);
  const taskFamilies = Object.fromEntries(firstTasks.map(task => [task.taskId, task.family]));
  pool = storeReviewVariantPoolResults(pool, firstTasks.map((task, index) => poolVariant(index, task.family)), {
    requestedCount: firstTasks.length,
    taskFamilies
  }).pool;
  const reloaded = sanitizeReviewVariantPool(JSON.parse(JSON.stringify(pool)));
  const secondTasks = buildReviewVariantPoolTasks(content, reloaded, 20);
  assert.equal(reloaded.variants.length, 20);
  assert.equal(secondTasks[0].poolSlot, 20);
  assert.equal(secondTasks.length, 20);
});

test("assignments only use variants from the same sentence family and prefer different sentences", () => {
  let pool = createReviewVariantPool({ date: "2026-08-05", contentSignature: "signature-a" });
  pool = storeReviewVariantPoolResults(pool, [poolVariant(1, "description"), poolVariant(3, "description"), poolVariant(2, "on")]).pool;
  const result = assignReviewVariantPoolTasks(pool, [
    { taskId: "description-one:en-zh", family: "description" },
    { taskId: "description-two:en-zh", family: "description" },
    { taskId: "on-one:en-zh", family: "on" }
  ]);
  assert.deepEqual(result.variants.map(item => item.family), ["description", "description", "on"]);
  assert.notEqual(result.variants[0].id, result.variants[1].id);
});

