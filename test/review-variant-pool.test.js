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
  reviewVariantSyncKey,
  sanitizeReviewVariantPool,
  storeReviewVariantPoolResults
} = require("../server/review-variant-pool");

const content = {
  updatedAt: "2026-08-05",
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

test("daily review variant pool keeps 50 variants and stable assignments after serialization", () => {
  let pool = createReviewVariantPool({ date: "2026-08-05", contentSignature: "signature-a" });
  const stored = storeReviewVariantPoolResults(pool, Array.from({ length: REVIEW_VARIANT_POOL_TARGET }, (_, index) => poolVariant(index)), {
    requestedCount: REVIEW_VARIANT_POOL_TARGET
  });
  pool = stored.pool;
  assert.equal(pool.variants.length, 50);
  assert.equal(pool.status, "ready");

  const tasks = [
    { taskId: "sentence-description:en-zh", family: "description" },
    { taskId: "sentence-on:zh-en", family: "on" }
  ];
  const first = assignReviewVariantPoolTasks(pool, tasks);
  const reloaded = sanitizeReviewVariantPool(JSON.parse(JSON.stringify(first.pool)));
  const second = assignReviewVariantPoolTasks(reloaded, tasks);
  assert.deepEqual(second.variants.map(item => item.id), first.variants.map(item => item.id));
  assert.equal(reviewVariantPoolSummary(second.pool).generatedCount, 50);
  assert.equal(reviewVariantPoolSummary(second.pool).remainingCount, 0);
  assert.equal(reviewVariantPoolSummary(second.pool).assignedCount, 2);
});

test("legacy 100-sentence pools are capped at the new 50-sentence target", () => {
  const legacy = {
    ...createReviewVariantPool({ date: "2026-08-05", contentSignature: "signature-a" }),
    targetCount: 100,
    variants: Array.from({ length: 100 }, (_, index) => poolVariant(index)),
    status: "ready"
  };
  const normalized = ensureReviewVariantPool(legacy, { date: "2026-08-05", contentSignature: "signature-a" });
  assert.equal(normalized.pool.targetCount, 50);
  assert.equal(normalized.pool.variants.length, 50);
  assert.equal(reviewVariantPoolSummary(normalized.pool).remainingCount, 0);
});

test("natural date changes keep the pool until a new learning sync cycle arrives", () => {
  const signature = reviewVariantContentSignature(content);
  const syncKey = reviewVariantSyncKey(content);
  const initial = storeReviewVariantPoolResults(createReviewVariantPool({ date: "2026-08-05", syncKey, contentSignature: signature }), [poolVariant(1)], { requestedCount: 1 }).pool;
  const nextDay = ensureReviewVariantPool(initial, { date: "2026-08-06", syncKey, contentSignature: signature });
  assert.equal(nextDay.replaced, false);
  assert.equal(nextDay.pool.date, "2026-08-05");
  assert.equal(nextDay.pool.variants.length, 1);

  const nextSyncContent = { ...content, updatedAt: "2026-08-06" };
  assert.equal(reviewVariantContentSignature(nextSyncContent), signature, "a review-only learning day can keep the same learned content signature");
  const nextSync = ensureReviewVariantPool(initial, { date: "2026-08-06", syncKey: reviewVariantSyncKey(nextSyncContent), contentSignature: signature });
  assert.equal(nextSync.replaced, true);
  assert.equal(nextSync.pool.variants.length, 0);
  assert.deepEqual(nextSync.pool.assignments, {});

  const changedContent = { ...content, words: [...content.words, { id: "word-cat", english: "cat", day: 2 }] };
  const changed = ensureReviewVariantPool(initial, { date: "2026-08-05", syncKey, contentSignature: reviewVariantContentSignature(changedContent) });
  assert.equal(changed.replaced, true);
  assert.equal(changed.pool.variants.length, 0);
});

test("legacy pools gain the current sync key without losing saved sentences", () => {
  const signature = reviewVariantContentSignature(content);
  const legacy = storeReviewVariantPoolResults(createReviewVariantPool({ date: "2026-08-05", contentSignature: signature }), [poolVariant(1)], { requestedCount: 1 }).pool;
  legacy.assignments["sentence-description:en-zh"] = legacy.variants[0].id;
  const migrated = ensureReviewVariantPool(legacy, {
    date: "2026-08-06",
    syncKey: reviewVariantSyncKey(content),
    contentSignature: signature
  });
  assert.equal(migrated.replaced, false);
  assert.equal(migrated.pool.syncKey, reviewVariantSyncKey(content));
  assert.equal(migrated.pool.variants.length, 1);
  assert.equal(migrated.pool.assignments["sentence-description:en-zh"], legacy.variants[0].id);
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

test("a persisted pool variant is used immediately when the current family is not ready", () => {
  let pool = createReviewVariantPool({ date: "2026-08-05", contentSignature: "signature-a" });
  pool = storeReviewVariantPoolResults(pool, [poolVariant(1, "description")]).pool;
  const result = assignReviewVariantPoolTasks(pool, [{ taskId: "inside-one:en-zh", family: "inside" }]);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].id, "ai-description-1");
  assert.equal(result.pool.assignments["inside-one:en-zh"], "ai-description-1");
});

test("persisted pool variants regain formal word-bank Chinese alternatives when assigned", () => {
  const learnedContent = {
    words: [
      { english: "pen", chinese: "笔", acceptedChinese: ["笔", "钢笔"] },
      { english: "box", chinese: "箱子", acceptedChinese: ["箱子", "盒子"] }
    ]
  };
  let pool = createReviewVariantPool({ date: "2026-08-07", contentSignature: "pen-signature" });
  pool = storeReviewVariantPoolResults(pool, [{
    id: "ai-on-pen-box",
    family: "on",
    english: "A big pen is on a box.",
    chinese: "一支大钢笔在一个箱子上。",
    acceptedEnglish: ["a big pen is on a box"],
    acceptedChinese: ["一支大钢笔在一个箱子上。"]
  }]).pool;

  const result = assignReviewVariantPoolTasks(pool, [{ taskId: "pen-base:en-zh", family: "on" }], learnedContent);
  assert.ok(result.variants[0].acceptedChinese.includes("一支大笔在一个箱子上。"));
  assert.ok(result.variants[0].acceptedChinese.includes("一支大笔在一个盒子上。"));
});
