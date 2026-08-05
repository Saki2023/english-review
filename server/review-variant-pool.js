"use strict";

const crypto = require("node:crypto");
const { eligibleSentenceVariants, normalizeEnglish, sentenceFamily } = require("../review-variants");

const REVIEW_VARIANT_POOL_SCHEMA = 1;
const REVIEW_VARIANT_POOL_TARGET = 100;
const REVIEW_VARIANT_POOL_BATCH = 20;
const REVIEW_VARIANT_POOL_STATUSES = new Set(["idle", "pending", "ready", "failed", "needs-attention"]);

function cleanText(value, maximum = 180) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function cleanStringList(value, maximumItems = 8, maximumLength = 180) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(item => cleanText(item, maximumLength)).filter(Boolean))).slice(0, maximumItems);
}

function sanitizePoolVariant(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = cleanText(source.id, 120);
  const family = cleanText(source.family, 40);
  const english = cleanText(source.english, 180);
  const chinese = cleanText(source.chinese, 180);
  if (!id || !family || !english || !chinese) return null;
  return {
    id,
    family,
    english,
    chinese,
    acceptedEnglish: cleanStringList(source.acceptedEnglish, 8, 180).length ? cleanStringList(source.acceptedEnglish, 8, 180) : [normalizeEnglish(english)],
    acceptedChinese: cleanStringList(source.acceptedChinese, 8, 180).length ? cleanStringList(source.acceptedChinese, 8, 180) : [chinese],
    requiredWords: cleanStringList(source.requiredWords, 30, 40),
    source: "ai",
    providerId: cleanText(source.providerId, 100),
    providerName: cleanText(source.providerName, 120),
    model: cleanText(source.model, 160),
    reasoningEffort: cleanText(source.reasoningEffort, 20),
    generatedAt: cleanText(source.generatedAt, 40)
  };
}

function reviewVariantContentSignature(content) {
  const source = content && typeof content === "object" ? content : {};
  const currentDay = Math.max(0, Number(source.currentDay) || 0);
  const learned = list => (Array.isArray(list) ? list : [])
    .filter(item => item && item.preview !== true && (Number(item.day) || 0) <= currentDay)
    .map(item => [String(item.id || ""), String(item.english || ""), Number(item.day) || 0]);
  return crypto.createHash("sha256").update(JSON.stringify({
    currentDay,
    words: learned(source.words),
    sentences: learned(source.sentences)
  })).digest("base64url").slice(0, 24);
}

function createReviewVariantPool({ date, contentSignature, targetCount = REVIEW_VARIANT_POOL_TARGET, now = new Date().toISOString() } = {}) {
  return {
    schema: REVIEW_VARIANT_POOL_SCHEMA,
    date: cleanText(date, 10),
    contentSignature: cleanText(contentSignature, 80),
    targetCount: Math.max(1, Math.min(REVIEW_VARIANT_POOL_TARGET, Number(targetCount) || REVIEW_VARIANT_POOL_TARGET)),
    variants: [],
    assignments: {},
    nextSlot: 0,
    status: "idle",
    model: "",
    reasoningEffort: "",
    createdAt: cleanText(now, 40),
    updatedAt: cleanText(now, 40),
    nextRetryAt: "",
    error: ""
  };
}

function sanitizeReviewVariantPool(value) {
  const source = value && typeof value === "object" ? value : {};
  const targetCount = Math.max(1, Math.min(REVIEW_VARIANT_POOL_TARGET, Number(source.targetCount) || REVIEW_VARIANT_POOL_TARGET));
  const variants = [];
  const ids = new Set();
  const english = new Set();
  (Array.isArray(source.variants) ? source.variants : []).forEach(item => {
    const variant = sanitizePoolVariant(item);
    const normalized = variant ? normalizeEnglish(variant.english) : "";
    if (!variant || !normalized || ids.has(variant.id) || english.has(normalized) || variants.length >= targetCount) return;
    ids.add(variant.id);
    english.add(normalized);
    variants.push(variant);
  });
  const assignments = {};
  Object.entries(source.assignments && typeof source.assignments === "object" ? source.assignments : {}).slice(-500).forEach(([taskId, variantId]) => {
    const key = cleanText(taskId, 180);
    const id = cleanText(variantId, 120);
    if (key && ids.has(id)) assignments[key] = id;
  });
  const status = variants.length >= targetCount
    ? "ready"
    : (REVIEW_VARIANT_POOL_STATUSES.has(source.status) ? source.status : "idle");
  return {
    schema: REVIEW_VARIANT_POOL_SCHEMA,
    date: cleanText(source.date, 10),
    contentSignature: cleanText(source.contentSignature, 80),
    targetCount,
    variants,
    assignments,
    nextSlot: Math.max(0, Number(source.nextSlot) || 0),
    status,
    model: cleanText(source.model, 160),
    reasoningEffort: cleanText(source.reasoningEffort, 20),
    createdAt: cleanText(source.createdAt, 40),
    updatedAt: cleanText(source.updatedAt, 40),
    nextRetryAt: cleanText(source.nextRetryAt, 40),
    error: cleanText(source.error, 240)
  };
}

function ensureReviewVariantPool(value, { date, contentSignature, targetCount = REVIEW_VARIANT_POOL_TARGET, now = new Date().toISOString() } = {}) {
  const expectedDate = cleanText(date, 10);
  const expectedSignature = cleanText(contentSignature, 80);
  const normalized = sanitizeReviewVariantPool(value);
  if (!expectedDate || normalized.date !== expectedDate || normalized.contentSignature !== expectedSignature) {
    return { pool: createReviewVariantPool({ date: expectedDate, contentSignature: expectedSignature, targetCount, now }), changed: true, replaced: true };
  }
  normalized.targetCount = Math.max(1, Math.min(REVIEW_VARIANT_POOL_TARGET, Number(targetCount) || REVIEW_VARIANT_POOL_TARGET));
  if (normalized.variants.length >= normalized.targetCount) normalized.status = "ready";
  const changed = JSON.stringify(normalized) !== JSON.stringify(value && typeof value === "object" ? value : {});
  return { pool: normalized, changed, replaced: false };
}

function reviewVariantPoolSummary(value) {
  const pool = sanitizeReviewVariantPool(value);
  return {
    schema: pool.schema,
    date: pool.date,
    targetCount: pool.targetCount,
    generatedCount: pool.variants.length,
    assignedCount: Object.keys(pool.assignments).length,
    status: pool.status,
    model: pool.model,
    reasoningEffort: pool.reasoningEffort,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
    nextRetryAt: pool.nextRetryAt,
    error: pool.error
  };
}

function learnedSentenceFamilies(content) {
  const currentDay = Math.max(0, Number(content && content.currentDay) || 0);
  const grouped = new Map();
  (Array.isArray(content && content.sentences) ? content.sentences : []).forEach(item => {
    if (!item || item.preview === true || (Number(item.day) || 0) > currentDay) return;
    const family = sentenceFamily(item);
    if (!family) return;
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family).push(item);
  });
  return Array.from(grouped.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([family, items]) => ({ family, items }));
}

function buildReviewVariantPoolTasks(content, value, requestedCount = REVIEW_VARIANT_POOL_BATCH) {
  const pool = sanitizeReviewVariantPool(value);
  const families = learnedSentenceFamilies(content);
  if (!families.length || pool.variants.length >= pool.targetCount) return [];
  const count = Math.max(0, Math.min(REVIEW_VARIANT_POOL_BATCH, Number(requestedCount) || REVIEW_VARIANT_POOL_BATCH, pool.targetCount - pool.variants.length));
  const capacities = families.map(group => Math.max(1, eligibleSentenceVariants(content, group.items[0]).length));
  const minimum = Math.min(5, Math.floor(pool.targetCount / families.length));
  const remaining = Math.max(0, pool.targetCount - minimum * families.length);
  const capacityTotal = capacities.reduce((sum, item) => sum + item, 0);
  const quotas = capacities.map(capacity => minimum + Math.floor((remaining * capacity) / capacityTotal));
  let quotaRemainder = pool.targetCount - quotas.reduce((sum, item) => sum + item, 0);
  capacities
    .map((capacity, index) => ({ capacity, index }))
    .sort((left, right) => right.capacity - left.capacity)
    .forEach(item => { if (quotaRemainder > 0) { quotas[item.index] += 1; quotaRemainder -= 1; } });
  const existingByFamily = Object.fromEntries(families.map(group => [group.family, pool.variants.filter(item => item.family === group.family).length]));
  return Array.from({ length: count }, (_, index) => {
    const slot = pool.nextSlot + index;
    const group = families
      .map((candidate, familyIndex) => ({ candidate, familyIndex, remaining: quotas[familyIndex] - existingByFamily[candidate.family] }))
      .sort((left, right) => right.remaining - left.remaining || ((slot + left.familyIndex) % families.length) - ((slot + right.familyIndex) % families.length))[0].candidate;
    existingByFamily[group.family] += 1;
    const baseItem = group.items[Math.floor(slot / families.length) % group.items.length];
    return {
      taskId: `pool:${pool.date}:${slot}:${group.family}`,
      poolSlot: slot,
      family: group.family,
      baseItem
    };
  });
}

function storeReviewVariantPoolResults(value, results, { requestedCount = 0, taskFamilies = {} } = {}) {
  const pool = sanitizeReviewVariantPool(value);
  const byId = new Map(pool.variants.map(item => [item.id, item]));
  const byEnglish = new Map(pool.variants.map(item => [normalizeEnglish(item.english), item]));
  const storedByTaskId = {};
  let added = 0;
  (Array.isArray(results) ? results : []).forEach(item => {
    const variant = sanitizePoolVariant(item);
    if (!variant) return;
    const taskId = cleanText(item.taskId, 180);
    const expectedFamily = cleanText(taskFamilies[taskId], 40);
    if (expectedFamily && variant.family !== expectedFamily) return;
    const normalized = normalizeEnglish(variant.english);
    let stored = byId.get(variant.id) || byEnglish.get(normalized);
    if (!stored && pool.variants.length < pool.targetCount) {
      stored = variant;
      pool.variants.push(stored);
      byId.set(stored.id, stored);
      byEnglish.set(normalized, stored);
      added += 1;
    }
    if (taskId && stored) {
      storedByTaskId[taskId] = stored;
      if (!taskId.startsWith("pool:")) pool.assignments[taskId] = stored.id;
    }
  });
  pool.nextSlot += Math.max(0, Number(requestedCount) || 0);
  pool.updatedAt = new Date().toISOString();
  if (pool.variants.length >= pool.targetCount) {
    pool.status = "ready";
    pool.nextRetryAt = "";
    pool.error = "";
  }
  return { pool, added, storedByTaskId };
}

function stableIndex(value, length) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return length ? (hash >>> 0) % length : 0;
}

function assignReviewVariantPoolTasks(value, tasks) {
  const pool = sanitizeReviewVariantPool(value);
  const byId = new Map(pool.variants.map(item => [item.id, item]));
  const used = new Set(Object.values(pool.assignments));
  const variants = [];
  (Array.isArray(tasks) ? tasks : []).forEach(task => {
    const taskId = cleanText(task && task.taskId, 180);
    const family = cleanText(task && (task.family || sentenceFamily(task.baseItem)), 40);
    if (!taskId || !family) return;
    let variant = byId.get(pool.assignments[taskId]);
    if (!variant || variant.family !== family) {
      const candidates = pool.variants.filter(item => item.family === family);
      if (!candidates.length) return;
      const start = stableIndex(`${pool.date}|${taskId}`, candidates.length);
      for (let offset = 0; offset < candidates.length; offset += 1) {
        const candidate = candidates[(start + offset) % candidates.length];
        if (!used.has(candidate.id)) { variant = candidate; break; }
      }
      if (!variant) variant = candidates[start];
      pool.assignments[taskId] = variant.id;
      used.add(variant.id);
    }
    variants.push({ ...variant, taskId });
  });
  pool.updatedAt = new Date().toISOString();
  return { pool, variants };
}

module.exports = {
  REVIEW_VARIANT_POOL_BATCH,
  REVIEW_VARIANT_POOL_SCHEMA,
  REVIEW_VARIANT_POOL_TARGET,
  assignReviewVariantPoolTasks,
  buildReviewVariantPoolTasks,
  createReviewVariantPool,
  ensureReviewVariantPool,
  reviewVariantContentSignature,
  reviewVariantPoolSummary,
  sanitizeReviewVariantPool,
  storeReviewVariantPoolResults
};
