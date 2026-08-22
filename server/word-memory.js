"use strict";

const WORD_USAGE_SCHEMA = 1;
const WORD_USAGE_MIGRATION_VERSION = 1;
const MAX_WORD_USAGE_EVENTS = 50000;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const RECALL_RESULTS = new Set(["independent-correct", "assisted", "revealed", "wrong"]);
const USAGE_KINDS = new Set(["recall", "exposure"]);
const USAGE_RESULTS = new Set([...RECALL_RESULTS, "completed"]);

function cleanText(value, maximum = 180) {
  return String(value || "").trim().slice(0, maximum);
}

function validDate(value) {
  const text = cleanText(value, 20);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]) ? text : "";
}

function studyDate(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  if (typeof value === "string" && validDate(value)) return validDate(value);
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(safe);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
  const valid = validDate(date);
  if (!valid) return "";
  const parsed = new Date(`${valid}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const left = Date.parse(`${validDate(from)}T00:00:00.000Z`);
  const right = Date.parse(`${validDate(to)}T00:00:00.000Z`);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.round((right - left) / 86400000) : 0;
}

function normalizeEnglish(value) {
  return cleanText(value, 1000).toLocaleLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z']+/g, " ").replace(/\s+/g, " ").trim();
}

function englishTokens(value) {
  return normalizeEnglish(value).match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

function learnedWord(item, date) {
  return Boolean(item && item.preview !== true && item.status !== "planned" && cleanText(item.learned, 20) && cleanText(item.learned, 20) <= date);
}

function wordCatalog(content, date = studyDate()) {
  const words = Array.isArray(content && content.words) ? content.words : [];
  const byId = new Map();
  const byToken = new Map();
  const byFormToken = new Map();
  words.forEach(item => {
    const id = cleanText(item && item.id, 120);
    if (!id) return;
    byId.set(id, item);
    const tokens = englishTokens(item.english);
    if (tokens.length === 1 && !byToken.has(tokens[0])) byToken.set(tokens[0], item);
  });
  const forms = [
    ...(Array.isArray(content && content.wordForms) ? content.wordForms : []),
    ...words.flatMap(word => (Array.isArray(word && word.forms) ? word.forms.map(form => ({ ...form, wordId: form.wordId || word.id, lemma: form.lemma || word.english })) : []))
  ];
  forms.forEach(raw => {
    const form = raw && typeof raw === "object" ? raw : {};
    const wordId = cleanText(form.wordId, 120);
    const id = cleanText(form.id || form.formId, 120);
    const tokens = englishTokens(form.english || form.form);
    const base = byId.get(wordId);
    const lemma = normalizeEnglish(form.lemma);
    if (!id || !base || tokens.length !== 1 || lemma !== normalizeEnglish(base.english) || byFormToken.has(tokens[0])) return;
    byFormToken.set(tokens[0], { id, wordId, lemma, english: tokens[0], supplementId: cleanText(form.supplementId, 120) });
  });
  return { date, words, byId, byToken, byFormToken };
}

function wordIdsForEnglish(content, english, options = {}) {
  const catalog = wordCatalog(content, options.date || studyDate());
  const includePlanned = options.includePlanned === true;
  const ids = [];
  const seen = new Set();
  englishTokens(english).forEach(token => {
    const form = catalog.byFormToken.get(token);
    const item = form ? catalog.byId.get(form.wordId) : catalog.byToken.get(token);
    const id = cleanText(item && item.id, 120);
    if (!id || seen.has(id) || (!includePlanned && !learnedWord(item, catalog.date))) return;
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

function sanitizeEvent(value) {
  if (!value || typeof value !== "object") return null;
  const eventId = cleanText(value.eventId || value.id, 220);
  const wordId = cleanText(value.wordId, 120);
  const kind = USAGE_KINDS.has(value.kind) ? value.kind : "";
  const result = USAGE_RESULTS.has(value.result) ? value.result : "";
  const date = validDate(value.date || value.studyDate);
  if (!eventId || !wordId || !kind || !result || !date) return null;
  if (kind === "recall" && !RECALL_RESULTS.has(result)) return null;
  if (kind === "exposure" && result !== "completed" && result !== "assisted" && result !== "revealed" && result !== "wrong") return null;
  const occurredAt = cleanText(value.occurredAt || value.completedAt || `${date}T00:00:00.000Z`, 40);
  return {
    eventId,
    wordId,
    source: cleanText(value.source, 40) || "unknown",
    taskId: cleanText(value.taskId || value.stepId, 180),
    kind,
    result,
    formalEvidence: value.formalEvidence === true,
    date,
    occurredAt,
    ...(cleanText(value.formId, 120) ? {
      formId: cleanText(value.formId, 120),
      surfaceForm: cleanText(value.surfaceForm || value.form, 120).toLocaleLowerCase(),
      lemma: cleanText(value.lemma, 120).toLocaleLowerCase(),
      supplementId: cleanText(value.supplementId, 120)
    } : {}),
    legacy: value.legacy === true
  };
}

function sanitizeMemory(value, wordId = "") {
  const source = value && typeof value === "object" ? value : {};
  const id = cleanText(source.wordId || wordId, 120);
  if (!id) return null;
  const lastReviewDate = validDate(source.lastReviewDate);
  const nextDue = validDate(source.nextDue);
  return {
    wordId: id,
    repetitions: Math.max(0, Math.min(1000, Number(source.repetitions) || 0)),
    intervalDays: Math.max(0, Math.min(3650, Number(source.intervalDays) || 0)),
    easiness: Math.max(1.3, Math.min(3, Number(source.easiness) || 2.5)),
    lapses: Math.max(0, Math.min(10000, Number(source.lapses) || 0)),
    assistedCount: Math.max(0, Math.min(10000, Number(source.assistedCount) || 0)),
    lastResult: RECALL_RESULTS.has(source.lastResult) ? source.lastResult : "",
    lastReviewDate,
    lastReviewedAt: cleanText(source.lastReviewedAt, 40),
    nextDue,
    updatedAt: cleanText(source.updatedAt, 40),
    migratedFromTaskStates: source.migratedFromTaskStates === true
  };
}

function sanitizeWordUsage(value) {
  const source = value && typeof value === "object" ? value : {};
  const events = new Map();
  (Array.isArray(source.events) ? source.events : []).map(sanitizeEvent).filter(Boolean).forEach(event => {
    if (!events.has(event.eventId)) events.set(event.eventId, event);
  });
  const memories = {};
  Object.entries(source.memories && typeof source.memories === "object" ? source.memories : {}).forEach(([wordId, raw]) => {
    const memory = sanitizeMemory(raw, wordId);
    if (memory) memories[memory.wordId] = memory;
  });
  return {
    schema: WORD_USAGE_SCHEMA,
    migrationVersion: Math.max(0, Math.min(WORD_USAGE_MIGRATION_VERSION, Number(source.migrationVersion) || 0)),
    events: Array.from(events.values()).slice(-MAX_WORD_USAGE_EVENTS),
    memories,
    updatedAt: cleanText(source.updatedAt, 40)
  };
}

function activityEvents(activity, content, options = {}) {
  const source = activity && typeof activity === "object" ? activity : {};
  const baseId = cleanText(source.eventId || source.id, 180);
  const date = validDate(source.date) || studyDate(source.occurredAt || options.now || new Date(), options.timeZone);
  const kind = USAGE_KINDS.has(source.kind) ? source.kind : "exposure";
  const result = USAGE_RESULTS.has(source.result) ? source.result : (kind === "recall" ? "wrong" : "completed");
  if (!baseId || !date || (kind === "recall" && !RECALL_RESULTS.has(result))) return [];
  const catalog = wordCatalog(content, date);
  const sourceTokens = englishTokens(source.english || source.prompt || source.sourceText);
  const matchedForms = new Map(sourceTokens.flatMap(token => {
    const form = catalog.byFormToken.get(token);
    return form ? [[form.wordId, form]] : [];
  }));
  const explicitForm = source.formEvidence && typeof source.formEvidence === "object" ? source.formEvidence : null;
  const explicitIds = Array.isArray(source.wordIds) ? source.wordIds : [source.wordId];
  const ids = [
    ...explicitIds.map(value => cleanText(value, 120)).filter(Boolean),
    ...wordIdsForEnglish(content, source.english || source.prompt || source.sourceText, { date, includePlanned: source.formalEvidence !== true })
  ];
  const seen = new Set();
  return ids.flatMap(wordId => {
    if (!wordId || seen.has(wordId)) return [];
    const item = catalog.byId.get(wordId);
    if (source.formalEvidence === true && kind === "recall" && !learnedWord(item, date)) return [];
    seen.add(wordId);
    const explicitSurface = cleanText(explicitForm && (explicitForm.english || explicitForm.surfaceForm), 120).toLocaleLowerCase();
    const registeredExplicitForm = catalog.byFormToken.get(explicitSurface);
    const form = explicitForm
      && registeredExplicitForm
      && registeredExplicitForm.wordId === wordId
      && registeredExplicitForm.id === cleanText(explicitForm.id || explicitForm.formId, 120)
      ? registeredExplicitForm
      : matchedForms.get(wordId);
    return [sanitizeEvent({
      eventId: `${baseId}:${wordId}`,
      wordId,
      source: source.source,
      taskId: source.taskId || source.stepId,
      kind,
      result,
      formalEvidence: source.formalEvidence === true,
      date,
      occurredAt: source.occurredAt || source.completedAt || new Date().toISOString(),
      formId: form && form.id,
      surfaceForm: form && form.english,
      lemma: form && form.lemma,
      supplementId: form && form.supplementId,
      legacy: source.legacy === true
    })];
  }).filter(Boolean);
}

function recallQuality(result) {
  if (result === "independent-correct") return 5;
  if (result === "assisted") return 3;
  return 1;
}

function applyRecall(memoryValue, eventValue) {
  const event = sanitizeEvent(eventValue);
  const memory = sanitizeMemory(memoryValue, event && event.wordId);
  if (!event || !memory || event.kind !== "recall" || event.formalEvidence !== true) return memory;
  const quality = recallQuality(event.result);
  const next = { ...memory };
  if (quality < 3 || event.result === "revealed") {
    next.repetitions = 0;
    next.intervalDays = 1;
    next.easiness = Math.max(1.3, Math.round((next.easiness - 0.2) * 100) / 100);
    next.lapses += 1;
  } else if (event.result === "assisted") {
    next.repetitions = Math.max(1, Math.min(next.repetitions, 2));
    next.intervalDays = 1;
    next.easiness = Math.max(1.3, Math.round((next.easiness - 0.15) * 100) / 100);
    next.assistedCount += 1;
  } else {
    next.repetitions += 1;
    if (next.repetitions === 1) next.intervalDays = 1;
    else if (next.repetitions === 2) next.intervalDays = 3;
    else next.intervalDays = Math.max(4, Math.round(Math.max(1, next.intervalDays) * next.easiness));
    next.easiness = Math.min(3, Math.round((next.easiness + 0.1) * 100) / 100);
  }
  next.lastResult = event.result;
  next.lastReviewDate = event.date;
  next.lastReviewedAt = event.occurredAt;
  next.nextDue = addDays(event.date, next.intervalDays);
  next.updatedAt = event.occurredAt;
  return next;
}

function appendEvents(value, rawEvents, content, options = {}) {
  const state = sanitizeWordUsage(value);
  const existing = new Map(state.events.map(event => [event.eventId, event]));
  const added = [];
  const conflicts = [];
  (Array.isArray(rawEvents) ? rawEvents : []).map(sanitizeEvent).filter(Boolean).forEach(event => {
    const previous = existing.get(event.eventId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) conflicts.push(event.eventId);
      return;
    }
    existing.set(event.eventId, event);
    added.push(event);
    if (options.applyMemory !== false && event.kind === "recall" && event.formalEvidence === true) {
      const catalog = wordCatalog(content, event.date);
      if (learnedWord(catalog.byId.get(event.wordId), event.date)) {
        state.memories[event.wordId] = applyRecall(state.memories[event.wordId] || { wordId: event.wordId }, event);
      }
    }
  });
  state.events = Array.from(existing.values()).slice(-MAX_WORD_USAGE_EVENTS);
  if (added.length) state.updatedAt = added.map(event => event.occurredAt).sort().at(-1) || new Date().toISOString();
  return { state, added, conflicts, reused: added.length === 0 };
}

function taskItemId(taskId) {
  const value = cleanText(taskId, 180);
  const separator = value.lastIndexOf(":");
  return separator > 0 ? value.slice(0, separator) : value;
}

function resultFromGrade(value) {
  if (value && value.assistance === "revealed") return "revealed";
  if (value && value.assistance === "assisted") return "assisted";
  return value && value.correct === true && value.gradingStatus !== "partial" && Number(value.score) >= 1
    ? "independent-correct"
    : "wrong";
}

function legacyMemoryForWord(word, taskStates) {
  const directions = Array.isArray(word && word.directions) && word.directions.length ? word.directions : ["en-zh", "zh-en"];
  const states = directions.map(direction => taskStates && taskStates[`${word.id}:${direction}`]).filter(value => value && typeof value === "object");
  if (!states.length) return null;
  const latest = [...states].sort((left, right) => cleanText(right.lastReviewed, 20).localeCompare(cleanText(left.lastReviewed, 20)))[0];
  const repetitions = Math.max(0, ...states.map(item => Number(item.level) || 0));
  const lastReviewDate = validDate(latest.lastReviewed);
  const nextDue = validDate(latest.nextDue) || (lastReviewDate ? addDays(lastReviewDate, repetitions > 1 ? 3 : 1) : "");
  return sanitizeMemory({
    wordId: word.id,
    repetitions,
    intervalDays: lastReviewDate && nextDue ? Math.max(1, daysBetween(lastReviewDate, nextDue)) : 0,
    easiness: 2.5,
    lapses: states.some(item => item.lastResult === false) ? 1 : 0,
    lastResult: latest.lastResult === false ? "wrong" : latest.lastResult === true ? "independent-correct" : "",
    lastReviewDate,
    lastReviewedAt: latest.lastReviewed ? `${latest.lastReviewed}T12:00:00.000Z` : "",
    nextDue,
    updatedAt: latest.lastReviewed ? `${latest.lastReviewed}T12:00:00.000Z` : "",
    migratedFromTaskStates: true
  });
}

function migrateWordUsage(value, accountState, content, options = {}) {
  const state = sanitizeWordUsage(value);
  if (state.migrationVersion >= WORD_USAGE_MIGRATION_VERSION) return { state, changed: false };
  const account = accountState && typeof accountState === "object" ? accountState : {};
  const catalog = wordCatalog(content, options.date || studyDate(options.now || new Date(), options.timeZone));
  const activities = [];
  (Array.isArray(account.attempts) ? account.attempts : []).forEach((attempt, index) => {
    if (!attempt || attempt.formalEvidence !== true || typeof attempt.correct !== "boolean") return;
    const itemId = taskItemId(attempt.taskId);
    const item = catalog.byId.get(itemId);
    const directWord = Boolean(item && Object.hasOwn(item, "phonetic"));
    activities.push({
      eventId: `legacy-review:${cleanText(attempt.id || attempt.attemptId || `${attempt.taskId}:${index}`, 160)}`,
      source: "review",
      taskId: attempt.taskId,
      wordIds: directWord ? [itemId] : [],
      english: directWord ? "" : (attempt.english || (attempt.direction === "zh-en" ? attempt.expected : attempt.prompt)),
      kind: directWord ? "recall" : "exposure",
      result: directWord ? resultFromGrade(attempt) : "completed",
      formalEvidence: true,
      date: validDate(attempt.date) || catalog.date,
      occurredAt: attempt.submittedAt,
      legacy: true
    });
  });
  const aiHistory = account.aiPractice && Array.isArray(account.aiPractice.history) ? account.aiPractice.history : [];
  aiHistory.forEach((item, index) => {
    if (!item || item.formalEvidence === false || typeof item.correct !== "boolean") return;
    const wordId = cleanText(item.wordId, 120);
    const directWord = item.contentType === "word" && catalog.byId.has(wordId);
    activities.push({
      eventId: `legacy-ai:${cleanText(item.id || index, 160)}`,
      source: "ai",
      taskId: item.id,
      wordIds: directWord ? [wordId] : [],
      english: directWord ? "" : (item.direction === "zh-en" ? item.correctAnswer : item.prompt),
      kind: directWord ? "recall" : "exposure",
      result: directWord ? resultFromGrade(item) : "completed",
      formalEvidence: true,
      date: validDate(item.date) || catalog.date,
      occurredAt: item.answeredAt,
      legacy: true
    });
  });
  const dictationHistory = account.dictation && Array.isArray(account.dictation.history) ? account.dictation.history : [];
  dictationHistory.forEach(session => (Array.isArray(session && session.items) ? session.items : []).forEach((item, index) => {
    const wordId = cleanText(item && (item.wordId || item.id), 120);
    if (!catalog.byId.has(wordId) || typeof item.correct !== "boolean") return;
    activities.push({
      eventId: `legacy-dictation:${cleanText(session.id, 120)}:${cleanText(item.id || index, 80)}`,
      source: "dictation",
      taskId: item.id,
      wordIds: [wordId],
      kind: "recall",
      result: item.correct ? "independent-correct" : "wrong",
      formalEvidence: true,
      date: studyDate(session.completedAt || catalog.date, options.timeZone),
      occurredAt: session.completedAt,
      legacy: true
    });
  }));

  const rawEvents = activities.flatMap(activity => activityEvents(activity, content, options));
  const appended = appendEvents(state, rawEvents, content, { applyMemory: false });
  const next = appended.state;
  (Array.isArray(content && content.words) ? content.words : []).filter(word => learnedWord(word, catalog.date)).forEach(word => {
    if (next.memories[word.id]) return;
    const migrated = legacyMemoryForWord(word, account.taskStates);
    if (migrated) next.memories[word.id] = migrated;
  });
  next.events.filter(event => event.kind === "recall" && event.formalEvidence === true).forEach(event => {
    if (next.memories[event.wordId]) return;
    next.memories[event.wordId] = applyRecall({ wordId: event.wordId }, event);
  });
  next.migrationVersion = WORD_USAGE_MIGRATION_VERSION;
  next.updatedAt = next.updatedAt || new Date().toISOString();
  return { state: next, changed: true };
}

function rowCounters(events) {
  const result = { usage: events.length, independentCorrect: 0, wrong: 0, assisted: 0, revealed: 0, exposure: 0 };
  events.forEach(event => {
    if (event.kind === "exposure") result.exposure += 1;
    else if (event.result === "independent-correct") result.independentCorrect += 1;
    else if (event.result === "wrong") result.wrong += 1;
    else if (event.result === "assisted") result.assisted += 1;
    else if (event.result === "revealed") result.revealed += 1;
  });
  return result;
}

function compareRows(sort, order) {
  const multiplier = order === "desc" ? -1 : 1;
  return (left, right) => {
    const value = (() => {
      if (sort === "usage") return left.periodUsage - right.periodUsage;
      if (sort === "correct") return left.independentCorrect - right.independentCorrect;
      if (sort === "wrong") return left.wrong - right.wrong;
      if (sort === "accuracy") return (left.accuracy ?? -1) - (right.accuracy ?? -1);
      if (sort === "recent") return left.lastUsedAt.localeCompare(right.lastUsedAt);
      if (sort === "due") return left.nextDue.localeCompare(right.nextDue);
      return left.index - right.index;
    })();
    return value * multiplier || left.index - right.index || left.id.localeCompare(right.id);
  };
}

function usageRows(value, content, options = {}) {
  const state = sanitizeWordUsage(value);
  const date = validDate(options.date) || studyDate(options.now || new Date(), options.timeZone);
  const from = validDate(options.from);
  const to = validDate(options.to);
  const range = ["today", "3d", "7d", "custom", "all"].includes(options.range)
    ? options.range
    : (from || to ? "custom" : "all");
  const usageStatus = ["used", "unused"].includes(options.usageStatus) ? options.usageStatus : "all";
  const sort = ["index", "usage", "correct", "wrong", "accuracy", "recent", "due"].includes(options.sort) ? options.sort : "index";
  const order = options.order === "desc" ? "desc" : "asc";
  const allByWord = new Map();
  const formalEvents = state.events.filter(event => event.formalEvidence === true);
  formalEvents.forEach(event => {
    if (!allByWord.has(event.wordId)) allByWord.set(event.wordId, []);
    allByWord.get(event.wordId).push(event);
  });
  const allRows = (Array.isArray(content && content.words) ? content.words : []).filter(word => learnedWord(word, date)).map((word, index) => {
    const all = allByWord.get(word.id) || [];
    const period = all.filter(event => (!from || event.date >= from) && (!to || event.date <= to));
    const total = rowCounters(all);
    const periodCounts = rowCounters(period);
    const todayUsage = all.filter(event => event.date === date).length;
    const recallDenominator = periodCounts.independentCorrect + periodCounts.wrong + periodCounts.assisted + periodCounts.revealed;
    const memory = sanitizeMemory(state.memories[word.id], word.id);
    const last = [...all].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
    const lastUsedDate = last ? last.date : "";
    const active = !memory || memory.repetitions < 3 || memory.lastResult !== "independent-correct";
    const absentDays = lastUsedDate ? Math.max(0, daysBetween(lastUsedDate, date)) : 9999;
    const due = Boolean(memory && memory.nextDue && memory.nextDue <= date);
    const coverageDue = due || (active && absentDays >= 3) || absentDays >= 7;
    return {
      id: word.id,
      index: index + 1,
      day: Number(word.day) || 0,
      english: cleanText(word.english, 200),
      chinese: cleanText(word.chinese, 300),
      todayUsage,
      totalUsage: total.usage,
      periodUsage: periodCounts.usage,
      independentCorrect: periodCounts.independentCorrect,
      wrong: periodCounts.wrong,
      assisted: periodCounts.assisted + periodCounts.revealed,
      exposure: periodCounts.exposure,
      accuracy: recallDenominator ? Math.round((periodCounts.independentCorrect / recallDenominator) * 100) : null,
      lastUsedAt: last ? last.occurredAt : "",
      lastUsedDate,
      nextDue: memory ? memory.nextDue : "",
      repetitions: memory ? memory.repetitions : 0,
      intervalDays: memory ? memory.intervalDays : 0,
      lapses: memory ? memory.lapses : 0,
      due,
      active,
      absentDays,
      coverageDue,
      coverageStatus: due ? "due" : absentDays >= 7 ? "overdue-coverage" : active && absentDays >= 3 ? "needs-coverage" : todayUsage ? "covered-today" : "scheduled"
    };
  });
  const periodCovered = allRows.filter(row => row.periodUsage > 0).length;
  const rows = allRows.filter(row => usageStatus === "used"
    ? row.periodUsage > 0
    : usageStatus === "unused"
      ? row.periodUsage === 0
      : true);
  rows.sort(compareRows(sort, order));
  const uncoveredToday = allRows.filter(row => row.todayUsage === 0).length;
  const urgentCoverage = allRows.filter(row => row.coverageDue).length;
  return {
    schema: WORD_USAGE_SCHEMA,
    date,
    from,
    to,
    range,
    usageStatus,
    sort,
    order,
    rows,
    summary: {
      learnedWords: allRows.length,
      filteredWords: rows.length,
      periodCovered,
      periodUncovered: allRows.length - periodCovered,
      coveredToday: allRows.length - uncoveredToday,
      uncoveredToday,
      urgentCoverage,
      events: formalEvents.length,
      capacityLimited: Math.max(0, urgentCoverage - Math.max(1, Number(options.capacity) || 10))
    },
    updatedAt: state.updatedAt
  };
}

function rankedWordIds(value, content, options = {}) {
  const result = usageRows(value, content, { ...options, sort: "index", order: "asc" });
  return [...result.rows].sort((left, right) => {
    const dueLeft = left.due ? 0 : 1;
    const dueRight = right.due ? 0 : 1;
    const weakLeft = left.lapses > 0 || left.repetitions < 2 ? 0 : 1;
    const weakRight = right.lapses > 0 || right.repetitions < 2 ? 0 : 1;
    const unusedLeft = left.todayUsage === 0 ? 0 : 1;
    const unusedRight = right.todayUsage === 0 ? 0 : 1;
    return dueLeft - dueRight
      || weakLeft - weakRight
      || unusedLeft - unusedRight
      || right.absentDays - left.absentDays
      || left.day - right.day
      || left.id.localeCompare(right.id);
  }).slice(0, Math.max(1, Number(options.limit) || 1000)).map(row => row.id);
}

function publicWordUsage(value, content, options = {}) {
  const aggregate = usageRows(value, content, options);
  return {
    schema: aggregate.schema,
    date: aggregate.date,
    summary: aggregate.summary,
    // Rows contain only public aggregate counters and catalog text.  Never
    // include original answers, accepted-answer lists, or event payloads.
    rows: aggregate.rows.map(row => ({
      id: row.id,
      index: row.index,
      day: row.day,
      english: row.english,
      chinese: row.chinese,
      todayUsage: row.todayUsage,
      totalUsage: row.totalUsage,
      periodUsage: row.periodUsage,
      independentCorrect: row.independentCorrect,
      wrong: row.wrong,
      assisted: row.assisted,
      exposure: row.exposure,
      accuracy: row.accuracy,
      lastUsedAt: row.lastUsedAt,
      lastUsedDate: row.lastUsedDate,
      nextDue: row.nextDue,
      repetitions: row.repetitions,
      intervalDays: row.intervalDays,
      lapses: row.lapses,
      due: row.due,
      active: row.active,
      absentDays: row.absentDays,
      coverageDue: row.coverageDue,
      coverageStatus: row.coverageStatus
    })),
    rankedWordIds: rankedWordIds(value, content, { ...options, date: aggregate.date }),
    memories: Object.fromEntries(aggregate.rows.map(row => [row.id, {
      repetitions: row.repetitions,
      intervalDays: row.intervalDays,
      lapses: row.lapses,
      nextDue: row.nextDue,
      due: row.due,
      todayUsage: row.todayUsage,
      lastUsedDate: row.lastUsedDate
    }])),
    updatedAt: aggregate.updatedAt
  };
}

module.exports = {
  MAX_WORD_USAGE_EVENTS,
  WORD_USAGE_MIGRATION_VERSION,
  activityEvents,
  addDays,
  appendEvents,
  applyRecall,
  englishTokens,
  migrateWordUsage,
  publicWordUsage,
  rankedWordIds,
  sanitizeEvent,
  sanitizeMemory,
  sanitizeWordUsage,
  studyDate,
  usageRows,
  validDate,
  wordIdsForEnglish
};
