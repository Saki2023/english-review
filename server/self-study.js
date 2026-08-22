"use strict";

const crypto = require("node:crypto");
const {
  NATURAL_DEEP_EXPLANATION,
  buildTranslationExplanation,
  chineseAnswerQuality,
  chineseNaturalDeepMatches,
  englishAnswerDifferences,
  englishAnswerMatches,
  englishSourceWordResults,
  englishWordResults,
  normalizeChinese,
  normalizeEnglish
} = require("../answer-utils");
const { expandNaturalChineseAnswers, naturalizePlainDeepChinese } = require("../review-variants");

const SELF_STUDY_STAGE_TYPES = Object.freeze(["review", "phonics", "pattern", "reading", "test", "summary"]);
const SELF_STUDY_STEP_TYPES = new Set(["teach", "read-aloud", "choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction", "summary"]);
const QUESTION_STEP_TYPES = new Set(["choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction"]);
const TEST_BLUEPRINT = Object.freeze({ phonics: 2, "en-zh": 2, "zh-en": 2, reading: 4 });
const MAX_LESSONS = 60;
const MAX_ATTEMPTS_PER_STEP = 20;
const MAX_QUESTIONS_PER_STEP = 50;
const MAX_HINT_RECEIPTS_PER_STEP = 20;
const SELF_STUDY_SCHEDULE_ANCHOR_DAY = 12;
const SELF_STUDY_SCHEDULE_ANCHOR_DATE = "2026-08-18";
const SELF_STUDY_SCHEDULE_SCHEMA = 1;
const SELF_STUDY_SCHEDULE_REVISION = "beijing-absolute-v1";
const SELF_STUDY_TIME_ZONE = "Asia/Shanghai";

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function cleanText(value, maximum = 1000) {
  return Array.from(String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\r\n?/g, "\n").trim()).slice(0, maximum).join("");
}

function cleanInline(value, maximum = 300) {
  return cleanText(value, maximum).replace(/\s+/g, " ").trim();
}

function cleanId(value, label = "id") {
  const id = cleanInline(value, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) fail(`${label} must contain only letters, numbers, dot, underscore, colon, or hyphen`);
  return id;
}

function cleanIso(value) {
  const text = cleanInline(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function addCalendarDays(dateText, days) {
  const match = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function selfStudyScheduledDate(studyDay) {
  const day = Number(studyDay);
  if (!Number.isInteger(day) || day < SELF_STUDY_SCHEDULE_ANCHOR_DAY) return "";
  return addCalendarDays(SELF_STUDY_SCHEDULE_ANCHOR_DATE, day - SELF_STUDY_SCHEDULE_ANCHOR_DAY);
}

function alignSelfStudyLessonSchedule(lesson) {
  const scheduledDate = selfStudyScheduledDate(lesson && lesson.studyDay);
  if (!scheduledDate || !lesson || typeof lesson !== "object") return lesson;
  const originalStart = Date.parse(lesson.enabledFrom || "");
  const originalExpiry = Date.parse(lesson.expiresAt || "");
  const duration = Number.isFinite(originalStart) && Number.isFinite(originalExpiry) && originalExpiry > originalStart
    ? originalExpiry - originalStart
    : 0;
  const next = {
    ...lesson,
    formalDate: scheduledDate,
    enabledFrom: new Date(`${scheduledDate}T00:00:00+08:00`).toISOString(),
    expiresAt: duration ? new Date(Date.parse(`${scheduledDate}T00:00:00+08:00`) + duration).toISOString() : lesson.expiresAt,
    plannedContent: {
      ...(lesson.plannedContent || {}),
      note: lesson.plannedContent && lesson.plannedContent.note
        ? { ...lesson.plannedContent.note, date: scheduledDate }
        : lesson.plannedContent?.note
    }
  };
  return next;
}

function preserveSelfStudyHistorySchedule(lesson, progress) {
  const snapshot = progress && progress.snapshot && typeof progress.snapshot === "object" ? progress.snapshot : null;
  if (!snapshot) return lesson;
  const historicalDate = cleanDate(snapshot.formalDate);
  const historicalStart = cleanIso(snapshot.enabledFrom);
  const historicalExpiry = cleanIso(snapshot.expiresAt);
  const historicalNoteDate = cleanDate(snapshot.plannedContent && snapshot.plannedContent.note && snapshot.plannedContent.note.date);
  if (!historicalDate && !historicalStart && !historicalExpiry && !historicalNoteDate) return lesson;
  return {
    ...lesson,
    formalDate: historicalDate || lesson.formalDate,
    enabledFrom: historicalStart || lesson.enabledFrom,
    expiresAt: historicalExpiry || lesson.expiresAt,
    plannedContent: {
      ...(lesson.plannedContent || {}),
      note: lesson.plannedContent && lesson.plannedContent.note
        ? { ...lesson.plannedContent.note, date: historicalNoteDate || lesson.plannedContent.note.date }
        : lesson.plannedContent?.note
    }
  };
}

function knownLegacyTripLesson(lesson) {
  return String(lesson && lesson.lessonId || "").startsWith("trip-day-");
}

function scheduleEntryFromLesson(lesson, source = "lesson") {
  const enabledFrom = cleanIso(lesson && lesson.enabledFrom);
  const formalDate = cleanDate(lesson && lesson.formalDate)
    || (enabledFrom ? new Date(Date.parse(enabledFrom) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "");
  const expiresAt = cleanIso(lesson && lesson.expiresAt);
  return {
    lessonId: cleanInline(lesson && lesson.lessonId, 120),
    studyDay: Math.max(0, Number(lesson && lesson.studyDay) || 0),
    formalDate,
    enabledFrom,
    expiresAt,
    status: formalDate && enabledFrom ? "known" : "unknown",
    source: cleanInline(source, 40) || "lesson"
  };
}

function legacyScheduleEntry(lesson, progress) {
  if (progress && ["completed", "cancelled", "expired"].includes(progress.status) && progress.snapshot) {
    return scheduleEntryFromLesson(progress.snapshot, "completed-history");
  }
  const migrated = knownLegacyTripLesson(lesson) && Number(lesson.studyDay) >= SELF_STUDY_SCHEDULE_ANCHOR_DAY
    ? alignSelfStudyLessonSchedule(lesson)
    : lesson;
  return scheduleEntryFromLesson(migrated, migrated === lesson ? "lesson" : "legacy-trip-migration");
}

function sanitizeScheduleEntry(value) {
  const source = value && typeof value === "object" ? value : {};
  const lessonId = cleanInline(source.lessonId, 120);
  const studyDay = Number(source.studyDay);
  if (!lessonId || !Number.isInteger(studyDay) || studyDay < 1) return null;
  const entry = scheduleEntryFromLesson({ ...source, lessonId, studyDay }, source.source || "stored");
  return { ...entry, status: source.status === "unknown" || entry.status === "unknown" ? "unknown" : "known" };
}

function applyScheduleEntry(lesson, entry) {
  if (!lesson || !entry || entry.lessonId !== lesson.lessonId || Number(entry.studyDay) !== Number(lesson.studyDay)) return lesson;
  return {
    ...lesson,
    formalDate: entry.formalDate,
    enabledFrom: entry.enabledFrom,
    expiresAt: entry.expiresAt,
    plannedContent: {
      ...(lesson.plannedContent || {}),
      note: lesson.plannedContent && lesson.plannedContent.note
        ? { ...lesson.plannedContent.note, date: entry.formalDate || lesson.plannedContent.note.date }
        : lesson.plannedContent?.note
    }
  };
}

function buildSelfStudySchedule(sourceValue, lessons, progress, options = {}) {
  const source = sourceValue && typeof sourceValue === "object" ? sourceValue : {};
  const stored = new Map((Array.isArray(source.entries) ? source.entries : [])
    .map(sanitizeScheduleEntry)
    .filter(Boolean)
    .map(entry => [entry.lessonId, entry]));
  const overrides = options.overrides instanceof Map ? options.overrides : new Map();
  const entries = lessons.map(lesson => {
    const progressItem = progress[lesson.lessonId];
    if (progressItem && ["completed", "cancelled", "expired"].includes(progressItem.status) && progressItem.snapshot) {
      return scheduleEntryFromLesson(progressItem.snapshot, "completed-history");
    }
    const override = sanitizeScheduleEntry(overrides.get(lesson.lessonId));
    if (override && Number(override.studyDay) === Number(lesson.studyDay)) return override;
    const existing = stored.get(lesson.lessonId);
    if (existing && Number(existing.studyDay) === Number(lesson.studyDay)) return existing;
    return legacyScheduleEntry(lesson, progressItem);
  }).sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId));
  return {
    schema: SELF_STUDY_SCHEDULE_SCHEMA,
    revision: cleanInline(options.revision || source.revision, 120) || SELF_STUDY_SCHEDULE_REVISION,
    timeZone: SELF_STUDY_TIME_ZONE,
    synchronizedAt: cleanIso(options.synchronizedAt || source.synchronizedAt),
    entries
  };
}

function cleanDate(value) {
  const text = cleanInline(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(value, maximumItems = 20, maximumLength = 500) {
  const result = [];
  const seen = new Set();
  (Array.isArray(value) ? value : []).forEach(item => {
    const text = cleanInline(item, maximumLength);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key) || result.length >= maximumItems) return;
    seen.add(key);
    result.push(text);
  });
  return result;
}

function englishTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

function answerKey(value) {
  const english = normalizeEnglish(value);
  return englishTokens(value).length ? `en:${english}` : `zh:${normalizeChinese(value)}`;
}

function isQuestionStep(step) {
  return Boolean(step && QUESTION_STEP_TYPES.has(step.type));
}

function sanitizeChoice(value, index) {
  if (typeof value === "string") return { id: String.fromCharCode(65 + index), text: cleanInline(value, 300) };
  const source = value && typeof value === "object" ? value : {};
  return {
    id: cleanId(source.id || String.fromCharCode(65 + index), "choice id"),
    text: cleanInline(source.text || source.label, 300)
  };
}

function acceptedAnswersForStep(source, direction) {
  const candidates = [
    ...(Array.isArray(source.acceptedAnswers) ? source.acceptedAnswers : []),
    ...(direction === "zh-en" && Array.isArray(source.acceptedEnglish) ? source.acceptedEnglish : []),
    ...(direction === "en-zh" && Array.isArray(source.acceptedChinese) ? source.acceptedChinese : []),
    source.referenceAnswer,
    source.correctAnswer,
    source.answer
  ];
  return uniqueStrings(candidates, 20, 500);
}

function defaultStepHints(step) {
  const type = String(step && step.type || "");
  const direction = String(step && step.direction || "");
  const reference = cleanInline(step && step.referenceAnswer, 1000);
  const words = englishTokens(reference);
  let first = "先看题目要求，再找主语、动作和关键词。";
  if (type === "choice") first = "先判断题目在问什么，再逐项比较主语、动作和关键词。";
  else if (direction === "zh-en" || type === "zh-en") first = "先写主语，再检查系动词或动作，最后补全对象和位置。";
  else if (direction === "en-zh" || type === "en-zh") first = "先找英文里的主语、动作、对象和位置，再按原顺序表达。";
  else if (type === "reading-question") first = "回到短文中找到与题干相同的主语或关键词，再判断答案。";
  else if (type === "correction") first = "先对照题干检查主语、冠词、系动词、介词和关键词。";
  const second = (() => {
    if ((direction === "zh-en" || type === "zh-en") && words.length) {
      return `英文答案共 ${words.length} 个词，首字母依次是：${words.map(word => word[0]).join(" · ")}。`;
    }
    if ((direction === "en-zh" || type === "en-zh") && reference) {
      return `中文答案的第一个字是“${Array.from(reference)[0]}”，先确认主语和核心意思。`;
    }
    if (type === "choice" && reference) return `正确选项以“${Array.from(reference)[0]}”开头。`;
    return "再缩小范围：优先检查题干中重复出现的关键词。";
  })();
  return [first, second];
}

function sanitizeStepHints(source, step) {
  const supplied = uniqueStrings([
    ...(Array.isArray(source && source.hints) ? source.hints : []),
    ...(Array.isArray(source && source.hintLayers) ? source.hintLayers : [])
  ], 2, 500);
  const defaults = defaultStepHints(step);
  return [supplied[0] || defaults[0], supplied[1] || defaults[1]];
}

function sanitizeStep(value, index, stageType) {
  const source = value && typeof value === "object" ? value : {};
  const type = cleanInline(source.type, 40).toLocaleLowerCase();
  if (!SELF_STUDY_STEP_TYPES.has(type)) fail(`unsupported self-study step type: ${type || "empty"}`);
  const direction = type === "zh-en" ? "zh-en" : type === "en-zh" ? "en-zh" : (["en-zh", "zh-en"].includes(source.direction) ? source.direction : "");
  const choices = (Array.isArray(source.choices) ? source.choices : []).slice(0, 12).map(sanitizeChoice).filter(item => item.text);
  const english = cleanInline(source.english, 1000);
  const sourceChinese = cleanInline(source.chinese, 1000);
  const chinese = naturalizePlainDeepChinese(english || source.prompt, sourceChinese);
  const sourceAcceptedAnswers = acceptedAnswersForStep(source, direction);
  const acceptedAnswers = direction === "en-zh"
    ? expandNaturalChineseAnswers(english || source.prompt, [
      ...sourceAcceptedAnswers.map(answer => naturalizePlainDeepChinese(english || source.prompt, answer)),
      ...sourceAcceptedAnswers
    ], 20)
    : sourceAcceptedAnswers;
  const question = QUESTION_STEP_TYPES.has(type);
  if (question && !acceptedAnswers.length) fail(`step ${source.stepId || index + 1} requires acceptedAnswers`);
  if (type === "choice" && choices.length < 2) fail(`choice step ${source.stepId || index + 1} requires at least two choices`);
  const category = cleanInline(source.category || (type === "reading-question" ? "reading" : (["en-zh", "zh-en"].includes(type) ? type : "")), 40).toLocaleLowerCase();
  const gradingMode = source.gradingMode === "ai" ? "ai" : "local";
  const correctionHints = uniqueStrings([
    ...(Array.isArray(source.correctionHints) ? source.correctionHints : []),
    source.correctionHint,
    source.hint
  ], 10, 500);
  const step = {
    stepId: cleanId(source.stepId || `step-${index + 1}`, "stepId"),
    type,
    category,
    title: cleanInline(source.title, 160),
    instruction: cleanText(source.instruction, 1000),
    content: cleanText(source.content || source.teachingText, 5000),
    prompt: cleanText(source.prompt || source.question, 2000),
    passage: cleanText(source.passage || source.reading, 5000),
    english,
    chinese,
    phonetic: cleanInline(source.phonetic, 200),
    pronunciation: cleanInline(source.pronunciation, 500),
    choices,
    direction,
    focus: cleanInline(source.focus, 160),
    contentId: cleanInline(source.contentId || source.itemId, 120),
    gradingMode,
    formalEvidence: question ? source.formalEvidence !== false : false,
    acceptedAnswers,
    referenceAnswer: acceptedAnswers[0] || "",
    correctionHints,
    required: source.required !== false,
    stageType
  };
  step.hints = question ? sanitizeStepHints(source, step) : [];
  return step;
}

function sanitizePlannedWord(value, lessonDay) {
  const source = value && typeof value === "object" ? value : {};
  const english = cleanInline(source.english, 200);
  const chinese = cleanInline(source.chinese, 300);
  if (!english || !chinese) fail("planned word requires english and chinese");
  return {
    id: cleanId(source.id, "planned word id"),
    day: lessonDay,
    status: "planned",
    learned: "",
    preview: false,
    english,
    chinese,
    phonetic: cleanInline(source.phonetic, 200),
    pronunciation: cleanInline(source.pronunciation, 500),
    acceptedChinese: uniqueStrings([...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : []), chinese], 20, 300),
    directions: uniqueStrings(Array.isArray(source.directions) ? source.directions : ["en-zh", "zh-en"], 2, 20).filter(item => ["en-zh", "zh-en"].includes(item)),
    example: cleanInline(source.example, 500),
    exampleZh: cleanInline(source.exampleZh, 500)
  };
}

function sanitizePlannedSentence(value, lessonDay) {
  const source = value && typeof value === "object" ? value : {};
  const english = cleanInline(source.english, 1000);
  const sourceChinese = cleanInline(source.chinese, 1000);
  const chinese = naturalizePlainDeepChinese(english, sourceChinese);
  if (!english || !sourceChinese || !chinese) fail("planned sentence requires english and chinese");
  return {
    id: cleanId(source.id, "planned sentence id"),
    day: lessonDay,
    status: "planned",
    learned: "",
    preview: false,
    english,
    chinese,
    acceptedChinese: expandNaturalChineseAnswers(english, [chinese, sourceChinese, ...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : [])], 20),
    acceptedEnglish: uniqueStrings([...(Array.isArray(source.acceptedEnglish) ? source.acceptedEnglish : []), english], 20, 1000),
    directions: uniqueStrings(Array.isArray(source.directions) ? source.directions : ["en-zh", "zh-en"], 2, 20).filter(item => ["en-zh", "zh-en"].includes(item))
  };
}

function sanitizePlannedNote(value, lessonDay) {
  const source = value && typeof value === "object" ? value : {};
  const patterns = (Array.isArray(source.patterns) ? source.patterns : []).slice(0, 20).map(pattern => ({
    title: cleanInline(pattern && pattern.title, 160),
    note: cleanText(pattern && pattern.note, 1000),
    examples: (Array.isArray(pattern && pattern.examples) ? pattern.examples : []).slice(0, 12).map(example => ({
      english: cleanInline(example && example.english, 500),
      chinese: cleanInline(example && example.chinese, 500)
    })).filter(example => example.english && example.chinese)
  })).filter(pattern => pattern.title || pattern.note || pattern.examples.length);
  return {
    day: lessonDay,
    date: cleanDate(source.date),
    score: cleanInline(source.score, 80),
    summary: cleanText(source.summary, 2000),
    goals: uniqueStrings(source.goals, 30, 1000),
    pronunciation: uniqueStrings(source.pronunciation, 30, 1000),
    patterns,
    mistakes: uniqueStrings(source.mistakes, 30, 1000),
    review: cleanText(source.review, 2000)
  };
}

function validateLessonVocabulary(lesson, learnedWords) {
  const baseAllowed = new Set([...(Array.isArray(learnedWords) ? learnedWords : []), ...lesson.plannedContent.words.flatMap(item => englishTokens(item.english))].map(item => String(item).toLocaleLowerCase()).filter(Boolean));
  const assertAllowed = (value, allowed, label) => {
    const invalid = Array.from(new Set(englishTokens(value).filter(token => !allowed.has(token))));
    if (invalid.length) fail(`${label} contains unapproved English words: ${invalid.join(", ")}`);
  };
  lesson.stages.forEach(stage => stage.steps.forEach(step => {
    const questionVisible = new Set([
      ...baseAllowed,
      ...englishTokens(step.prompt),
      ...englishTokens(step.passage),
      ...englishTokens(step.english),
      ...step.choices.flatMap(choice => englishTokens(choice.text))
    ]);
    if (!isQuestionStep(step)) {
      [step.title, step.instruction, step.content, step.prompt, step.passage, step.english, step.pronunciation].forEach((text, index) => assertAllowed(text, baseAllowed, `${lesson.lessonId}/${step.stepId}/visible-${index + 1}`));
    }
    step.acceptedAnswers.forEach(answer => assertAllowed(answer, questionVisible, `${lesson.lessonId}/${step.stepId}/accepted answer`));
    step.correctionHints.forEach(hint => {
      assertAllowed(hint, questionVisible, `${lesson.lessonId}/${step.stepId}/correction hint`);
      if (step.referenceAnswer && answerKey(hint) === answerKey(step.referenceAnswer)) fail(`${lesson.lessonId}/${step.stepId} correction hint reveals the full answer`);
    });
  }));
  lesson.plannedContent.sentences.forEach(sentence => {
    assertAllowed(sentence.english, baseAllowed, `${lesson.lessonId}/planned sentence`);
    sentence.acceptedEnglish.forEach(answer => assertAllowed(answer, baseAllowed, `${lesson.lessonId}/planned sentence answer`));
  });
}

function validateTestBlueprint(lesson) {
  const testStage = lesson.stages.find(stage => stage.type === "test");
  const questions = testStage.steps.filter(isQuestionStep);
  if (questions.length !== 10) fail(`${lesson.lessonId} test stage must contain exactly 10 questions`);
  const counts = questions.reduce((result, step) => {
    const category = step.category === "reading-question" ? "reading" : step.category;
    result[category] = (result[category] || 0) + 1;
    return result;
  }, {});
  Object.entries(TEST_BLUEPRINT).forEach(([category, count]) => {
    if (counts[category] !== count) fail(`${lesson.lessonId} test stage requires ${count} ${category} questions`);
  });
}

function sanitizeSelfStudyLesson(value, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const lessonId = cleanId(source.lessonId, "lessonId");
  const studyDay = Number(source.studyDay || source.day);
  if (!Number.isInteger(studyDay) || studyDay < 1) fail(`${lessonId} studyDay must be a positive integer`);
  const rawStages = Array.isArray(source.stages) ? source.stages : [];
  if (rawStages.length !== SELF_STUDY_STAGE_TYPES.length) fail(`${lessonId} must contain exactly six stages`);
  const stageIds = new Set();
  const stages = rawStages.map((rawStage, index) => {
    const stageSource = rawStage && typeof rawStage === "object" ? rawStage : {};
    const type = cleanInline(stageSource.type || SELF_STUDY_STAGE_TYPES[index], 40).toLocaleLowerCase();
    if (type !== SELF_STUDY_STAGE_TYPES[index]) fail(`${lessonId} stage ${index + 1} must be ${SELF_STUDY_STAGE_TYPES[index]}`);
    const stageId = cleanId(stageSource.stageId || type, "stageId");
    if (stageIds.has(stageId)) fail(`${lessonId} contains duplicate stageId: ${stageId}`);
    stageIds.add(stageId);
    const rawSteps = Array.isArray(stageSource.steps) ? stageSource.steps : [];
    if (!rawSteps.length) fail(`${lessonId}/${stageId} requires at least one step`);
    const stepIds = new Set();
    const steps = rawSteps.slice(0, 100).map((step, stepIndex) => {
      const normalized = sanitizeStep(step, stepIndex, type);
      if (stepIds.has(normalized.stepId)) fail(`${lessonId}/${stageId} contains duplicate stepId: ${normalized.stepId}`);
      stepIds.add(normalized.stepId);
      return normalized;
    });
    return { stageId, type, title: cleanInline(stageSource.title, 160) || ["旧知识复习", "拼读与词汇", "句子结构", "阅读与翻译", "测验与订正", "总结与预习"][index], steps };
  });
  const plannedSource = source.plannedContent && typeof source.plannedContent === "object" ? source.plannedContent : {};
  const plannedWords = (Array.isArray(plannedSource.words) ? plannedSource.words : (Array.isArray(source.words) ? source.words : [])).slice(0, 100).map(item => sanitizePlannedWord(item, studyDay));
  const plannedSentences = (Array.isArray(plannedSource.sentences) ? plannedSource.sentences : (Array.isArray(source.sentences) ? source.sentences : [])).slice(0, 100).map(item => sanitizePlannedSentence(item, studyDay));
  const contentIds = new Set();
  [...plannedWords, ...plannedSentences].forEach(item => {
    if (contentIds.has(item.id)) fail(`${lessonId} contains duplicate planned content id: ${item.id}`);
    contentIds.add(item.id);
  });
  const formalDate = cleanDate(source.formalDate || source.date);
  const enabledFrom = cleanIso(source.enabledFrom || source.availableFrom);
  const publishedAt = cleanIso(source.publishedAt)
    || enabledFrom
    || (formalDate ? new Date(`${formalDate}T00:00:00+08:00`).toISOString() : "");
  const lesson = {
    lessonId,
    studyDay,
    formalDate,
    title: cleanInline(source.title, 200) || `第 ${studyDay} 天自学课程`,
    version: cleanInline(source.version, 80) || "1",
    enabledFrom,
    expiresAt: cleanIso(source.expiresAt),
    publishedAt,
    stages,
    plannedContent: {
      words: plannedWords,
      sentences: plannedSentences,
      note: sanitizePlannedNote(plannedSource.note || source.note, studyDay)
    },
    nextPreview: cleanText(source.nextPreview || source.preview, 5000)
  };
  validateTestBlueprint(lesson);
  if (options.skipVocabularyValidation !== true) validateLessonVocabulary(lesson, options.learnedWords || []);
  return lesson;
}

function sanitizeAttempt(value) {
  const source = value && typeof value === "object" ? value : {};
  const attemptId = cleanInline(source.attemptId, 160);
  if (!attemptId) return null;
  return {
    attemptId,
    answer: cleanText(source.answer, 2000),
    status: ["pending", "graded", "invalidated"].includes(source.status) ? source.status : "graded",
    correct: typeof source.correct === "boolean" ? source.correct : null,
    score: Number.isFinite(Number(source.score)) ? Math.max(0, Math.min(1, Number(source.score))) : null,
    gradingStatus: ["correct", "partial", "incorrect", "pending"].includes(source.gradingStatus) ? source.gradingStatus : "pending",
    explanation: cleanText(source.explanation, 1000),
    detailedExplanation: cleanText(source.detailedExplanation, 2000),
    problemWords: uniqueStrings(source.problemWords, 20, 100),
    wordResults: (Array.isArray(source.wordResults) ? source.wordResults : []).slice(0, 50).map(item => ({ english: cleanInline(item && item.english, 100), correct: item && typeof item.correct === "boolean" ? item.correct : null })),
    source: cleanInline(source.source, 40),
    model: cleanInline(source.model, 160),
    providerName: cleanInline(source.providerName, 160),
    reasoningEffort: cleanInline(source.reasoningEffort, 40),
    submittedAt: cleanIso(source.submittedAt) || new Date().toISOString(),
    gradedAt: cleanIso(source.gradedAt),
    correction: source.correction === true,
    assistance: ["assisted", "revealed"].includes(source.assistance) ? source.assistance : "",
    hintLevel: Math.max(0, Math.min(3, Number(source.hintLevel) || 0)),
    formalEvidence: source.formalEvidence === true,
    referenceAnswer: cleanText(source.referenceAnswer, 1000),
    acceptedAnswerVersion: cleanInline(source.acceptedAnswerVersion, 80)
  };
}

function sanitizeTutorQuestion(value) {
  const source = value && typeof value === "object" ? value : {};
  const id = cleanInline(source.id, 160);
  const question = cleanText(source.question, 500);
  if (!id || !question) return null;
  return {
    id,
    question,
    answer: cleanText(source.answer, 1200),
    status: ["pending", "answered", "failed"].includes(source.status) ? source.status : (source.answer ? "answered" : "pending"),
    askedAt: cleanIso(source.askedAt) || new Date().toISOString(),
    answeredAt: cleanIso(source.answeredAt),
    providerName: cleanInline(source.providerName, 160),
    model: cleanInline(source.model, 160),
    reasoningEffort: cleanInline(source.reasoningEffort, 40)
  };
}

function sanitizeStepProgress(value) {
  const source = value && typeof value === "object" ? value : {};
  const attempts = (Array.isArray(source.attempts) ? source.attempts : []).map(sanitizeAttempt).filter(Boolean).slice(-MAX_ATTEMPTS_PER_STEP);
  return {
    status: ["unattempted", "pending", "needs-correction", "completed", "skipped"].includes(source.status) ? source.status : "unattempted",
    draft: cleanText(source.draft, 2000),
    attempts,
    confirmationId: cleanInline(source.confirmationId, 160),
    continueId: cleanInline(source.continueId, 160),
    firstAttemptId: cleanInline(source.firstAttemptId, 160),
    hintLevel: Math.max(0, Math.min(3, Number(source.hintLevel) || 0)),
    assistance: ["assisted", "revealed"].includes(source.assistance) ? source.assistance : "",
    hintReceipts: (Array.isArray(source.hintReceipts) ? source.hintReceipts : []).slice(-MAX_HINT_RECEIPTS_PER_STEP).map(item => ({
      id: cleanInline(item && item.id, 160),
      level: Math.max(1, Math.min(3, Number(item && item.level) || 1)),
      requestedAt: cleanIso(item && item.requestedAt)
    })).filter(item => item.id),
    automaticSummary: source.automaticSummary && typeof source.automaticSummary === "object" ? clone(source.automaticSummary) : null,
    completedAt: cleanIso(source.completedAt),
    skippedAt: cleanIso(source.skippedAt),
    questions: (Array.isArray(source.questions) ? source.questions : []).map(sanitizeTutorQuestion).filter(Boolean).slice(-MAX_QUESTIONS_PER_STEP)
  };
}

function repairNaturalDeepStepProgress(step, value) {
  const progress = value && typeof value === "object" ? value : sanitizeStepProgress({});
  if (!step || (step.direction !== "en-zh" && step.type !== "en-zh")) return progress;
  const english = step.english || step.prompt;
  let changed = false;
  const attempts = progress.attempts.map(attempt => {
    if (attempt.status !== "graded" || !chineseNaturalDeepMatches(attempt.answer, step.acceptedAnswers, english)) return attempt;
    const repaired = {
      ...attempt,
      correct: true,
      score: 1,
      gradingStatus: "correct",
      explanation: NATURAL_DEEP_EXPLANATION,
      detailedExplanation: buildTranslationExplanation({ direction: "en-zh", referenceAnswer: step.referenceAnswer, answer: attempt.answer, correct: true, gradingStatus: "correct", explanation: NATURAL_DEEP_EXPLANATION, problemWords: [] }),
      problemWords: [],
      wordResults: englishSourceWordResults(english, true),
      referenceAnswer: step.referenceAnswer
    };
    if (JSON.stringify(repaired) !== JSON.stringify(attempt)) changed = true;
    return repaired;
  });
  const last = attempts.at(-1);
  const complete = last && last.status === "graded" && last.correct === true && last.gradingStatus === "correct";
  if (!changed && !(complete && ["pending", "needs-correction"].includes(progress.status))) return progress;
  return {
    ...progress,
    status: complete && ["pending", "needs-correction"].includes(progress.status) ? "completed" : progress.status,
    completedAt: complete && !progress.completedAt ? (last.gradedAt || last.submittedAt) : progress.completedAt,
    attempts
  };
}

function sanitizeProgress(value) {
  const source = value && typeof value === "object" ? value : {};
  let snapshot = null;
  try { if (source.snapshot) snapshot = sanitizeSelfStudyLesson(source.snapshot, { skipVocabularyValidation: true }); } catch (_) { snapshot = null; }
  if (!snapshot) return null;
  const steps = {};
  Object.entries(source.steps && typeof source.steps === "object" ? source.steps : {}).forEach(([stepId, step]) => {
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(stepId)) steps[stepId] = sanitizeStepProgress(step);
  });
  snapshot.stages.forEach(stage => stage.steps.forEach(step => {
    if (steps[step.stepId]) steps[step.stepId] = repairNaturalDeepStepProgress(step, steps[step.stepId]);
  }));
  return {
    lessonId: snapshot.lessonId,
    lessonVersion: cleanInline(source.lessonVersion || snapshot.version, 80),
    status: ["in-progress", "paused", "ready", "completed", "cancelled", "expired"].includes(source.status) ? source.status : "in-progress",
    startedAt: cleanIso(source.startedAt),
    updatedAt: cleanIso(source.updatedAt),
    completedAt: cleanIso(source.completedAt),
    pausedAt: cleanIso(source.pausedAt),
    pauseReason: cleanText(source.pauseReason, 500),
    activeSeconds: Math.max(0, Math.floor(Number(source.activeSeconds) || 0)),
    lastActiveAt: cleanIso(source.lastActiveAt),
    stageIndex: Math.max(0, Math.min(5, Math.floor(Number(source.stageIndex) || 0))),
    stepIndex: Math.max(0, Math.floor(Number(source.stepIndex) || 0)),
    snapshot,
    steps,
    promotion: source.promotion && typeof source.promotion === "object" ? {
      completedAt: cleanIso(source.promotion.completedAt),
      learnedAt: cleanIso(source.promotion.learnedAt),
      firstReviewDue: cleanDate(source.promotion.firstReviewDue),
      contentIds: uniqueStrings(source.promotion.contentIds, 300, 120)
    } : null
  };
}

function sanitizeSelfStudyState(value) {
  const source = value && typeof value === "object" ? value : {};
  const lessonMap = new Map();
  (Array.isArray(source.lessons) ? source.lessons : []).slice(0, MAX_LESSONS).forEach(raw => {
    try {
      const lesson = sanitizeSelfStudyLesson(raw, { skipVocabularyValidation: true });
      lessonMap.set(lesson.lessonId, lesson);
    } catch (_) {}
  });
  const progress = {};
  Object.entries(source.progress && typeof source.progress === "object" ? source.progress : {}).forEach(([lessonId, value]) => {
    const normalized = sanitizeProgress(value);
    if (normalized && normalized.lessonId === lessonId) progress[lessonId] = normalized;
  });
  const rawLessons = Array.from(lessonMap.values()).sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId));
  const schedule = buildSelfStudySchedule(source.schedule, rawLessons, progress, {
    synchronizedAt: source.schedule && source.schedule.synchronizedAt || source.updatedAt
  });
  const scheduleById = new Map(schedule.entries.map(entry => [entry.lessonId, entry]));
  const lessons = rawLessons.map(lesson => applyScheduleEntry(lesson, scheduleById.get(lesson.lessonId)));
  return {
    schema: 2,
    enabled: source.enabled === true,
    lessons,
    progress,
    schedule,
    updatedAt: cleanIso(source.updatedAt)
  };
}

function offlineAnswerDigest(salt, answer) {
  return crypto.createHash("sha256").update(`${salt}\0${answerKey(answer)}`, "utf8").digest("hex");
}

function offlineReferenceUnlock(answerSalt, answer, referenceAnswer) {
  if (!referenceAnswer) return null;
  const answerValue = answerKey(answer);
  const key = crypto.createHash("sha256").update(`${answerSalt}\0reference\0${answerValue}`, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(referenceAnswer, "utf8"), cipher.final()]);
  return {
    digest: offlineAnswerDigest(answerSalt, answer),
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function offlineStep(step, lessonSalt) {
  const answerSalt = crypto.createHash("sha256").update(`${lessonSalt}:${step.stepId}`, "utf8").digest("hex").slice(0, 32);
  return {
    stepId: step.stepId,
    type: step.type,
    category: step.category,
    title: step.title,
    instruction: step.instruction,
    content: step.content,
    prompt: step.prompt,
    passage: step.passage,
    english: step.direction === "zh-en" ? "" : step.english,
    chinese: step.direction === "en-zh" ? "" : step.chinese,
    phonetic: step.phonetic,
    pronunciation: step.pronunciation,
    choices: clone(step.choices),
    direction: step.direction,
    focus: step.focus,
    contentId: step.contentId,
    gradingMode: step.gradingMode,
    formalEvidence: false,
    required: step.required,
    correctionHints: clone(step.correctionHints),
    hints: clone(step.hints),
    referenceAnswerReveal: step.referenceAnswer ? Buffer.from(step.referenceAnswer, "utf8").toString("base64") : "",
    answerSalt,
    answerDigests: step.acceptedAnswers.map(answer => offlineAnswerDigest(answerSalt, answer)),
    referenceUnlocks: step.acceptedAnswers.map(answer => offlineReferenceUnlock(answerSalt, answer, step.referenceAnswer)).filter(Boolean)
  };
}

function offlineLesson(lesson, nonce, availability = "unknown") {
  const lessonSalt = crypto.createHash("sha256").update(`${nonce}:${lesson.lessonId}:${lesson.version}`, "utf8").digest("hex");
  return {
    lessonId: lesson.lessonId,
    studyDay: lesson.studyDay,
    formalDate: lesson.formalDate,
    title: lesson.title,
    version: lesson.version,
    enabledFrom: lesson.enabledFrom,
    expiresAt: lesson.expiresAt,
    publishedAt: lesson.publishedAt,
    availability: ["available", "waiting", "expired", "unknown"].includes(availability) ? availability : "unknown",
    stages: lesson.stages.map(stage => ({
      stageId: stage.stageId,
      type: stage.type,
      title: stage.title,
      steps: stage.steps.map(step => offlineStep(step, lessonSalt))
    })),
    plannedContent: clone(lesson.plannedContent),
    nextPreview: lesson.nextPreview
  };
}

function offlineSelfStudyPackage(value, options = {}) {
  const state = sanitizeSelfStudyState(value);
  const limit = Math.max(1, Math.min(MAX_LESSONS, Number(options.limit) || 14));
  const nonce = cleanInline(options.nonce, 160) || crypto.randomBytes(18).toString("hex");
  const activeIds = new Set(Object.values(state.progress).filter(progress => ["in-progress", "paused", "ready"].includes(progress.status)).map(progress => progress.lessonId));
  const completedIds = new Set(Object.values(state.progress).filter(progress => ["completed", "cancelled", "expired"].includes(progress.status)).map(progress => progress.lessonId));
  const selected = state.lessons.filter(lesson => activeIds.has(lesson.lessonId) || !completedIds.has(lesson.lessonId)).slice(0, limit);
  Object.values(state.progress).forEach(progress => {
    if (activeIds.has(progress.lessonId) && !selected.some(lesson => lesson.lessonId === progress.lessonId)) selected.unshift(progress.snapshot);
  });
  const preparedAt = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const scheduleById = new Map(state.schedule.entries.map(entry => [entry.lessonId, entry]));
  const lessons = selected.slice(0, limit).map(lesson => {
    const schedule = scheduleById.get(lesson.lessonId);
    const availability = !schedule || schedule.status !== "known"
      ? "unknown"
      : lessonExpired(lesson, preparedAt)
        ? "expired"
        : lessonEnabled(lesson, preparedAt) ? "available" : "waiting";
    return offlineLesson(lesson, nonce, availability);
  });
  const lessonMap = new Map(lessons.map(lesson => [lesson.lessonId, lesson]));
  const progress = {};
  Object.values(state.progress).filter(item => activeIds.has(item.lessonId) && lessonMap.has(item.lessonId)).forEach(item => {
    progress[item.lessonId] = {
      ...clone(item),
      snapshot: clone(lessonMap.get(item.lessonId)),
      steps: Object.fromEntries(Object.entries(item.steps).map(([stepId, step]) => [stepId, {
        ...clone(step),
        attempts: (Array.isArray(step.attempts) ? step.attempts : []).map(attempt => {
          const { referenceAnswer, ...safeAttempt } = clone(attempt);
          return { ...safeAttempt, formalEvidence: false };
        })
      }]))
    };
  });
  return {
    schema: 2,
    enabled: state.enabled,
    lessons,
    progress,
    schedule: clone(state.schedule),
    clock: { timeZone: SELF_STUDY_TIME_ZONE, serverNow: preparedAt.toISOString() },
    updatedAt: state.updatedAt,
    answerDigest: "sha256-answer-key-v1"
  };
}

function mergeSelfStudyLessons(value, packageValue, options = {}) {
  const state = sanitizeSelfStudyState(value);
  const source = packageValue && typeof packageValue === "object" ? packageValue : {};
  const incoming = (Array.isArray(source.lessons) ? source.lessons : [])
    .map(lesson => sanitizeSelfStudyLesson(lesson, { skipVocabularyValidation: true }))
    .map(lesson => {
      const progress = state.progress[lesson.lessonId];
      return progress && ["completed", "cancelled", "expired"].includes(progress.status)
        ? preserveSelfStudyHistorySchedule(lesson, progress)
        : source.scheduleRevision || source.schedule && source.schedule.revision
          ? lesson
          : applyScheduleEntry(lesson, legacyScheduleEntry(lesson, progress));
    })
    .sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId));
  if (!incoming.length) fail("self-study package requires at least one lesson");
  const incomingIds = new Set();
  incoming.forEach(lesson => {
    if (incomingIds.has(lesson.lessonId)) fail(`duplicate lessonId: ${lesson.lessonId}`);
    incomingIds.add(lesson.lessonId);
  });
  const incomingById = new Map(incoming.map(lesson => [lesson.lessonId, lesson]));
  const rollingWords = new Set((Array.isArray(options.learnedWords) ? options.learnedWords : []).map(word => String(word).toLocaleLowerCase()).filter(Boolean));
  const validationCatalog = [...state.lessons.filter(lesson => !incomingById.has(lesson.lessonId)), ...incoming].sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId));
  validationCatalog.forEach(lesson => {
    if (incomingById.has(lesson.lessonId)) validateLessonVocabulary(lesson, Array.from(rollingWords));
    lesson.plannedContent.words.flatMap(item => englishTokens(item.english)).forEach(word => rollingWords.add(word));
  });
  const map = new Map(state.lessons.map(lesson => [lesson.lessonId, lesson]));
  incoming.forEach(lesson => map.set(lesson.lessonId, lesson));
  const removeIds = uniqueStrings(source.removeLessonIds, MAX_LESSONS, 120);
  removeIds.forEach(lessonId => {
    const progress = state.progress[lessonId];
    if (!progress || !["in-progress", "paused", "ready"].includes(progress.status)) map.delete(lessonId);
  });
  state.lessons = Array.from(map.values()).sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId)).slice(0, MAX_LESSONS);
  state.updatedAt = cleanIso(source.updatedAt) || new Date().toISOString();
  const scheduleOverrides = new Map(incoming.map(lesson => [lesson.lessonId, scheduleEntryFromLesson(lesson, "teaching-sync")]));
  state.schedule = buildSelfStudySchedule(state.schedule, state.lessons, state.progress, {
    overrides: scheduleOverrides,
    revision: source.scheduleRevision || source.schedule && source.schedule.revision || state.schedule.revision,
    synchronizedAt: state.updatedAt
  });
  const scheduleById = new Map(state.schedule.entries.map(entry => [entry.lessonId, entry]));
  state.lessons = state.lessons.map(lesson => applyScheduleEntry(lesson, scheduleById.get(lesson.lessonId)));
  return {
    state,
    result: {
      lessons: state.lessons.length,
      received: incoming.length,
      activeSnapshotsRetained: Object.values(state.progress).filter(item => ["in-progress", "paused", "ready"].includes(item.status)).length,
      updatedAt: state.updatedAt
    }
  };
}

function lessonProgress(state, lessonId) {
  return state.progress[lessonId] || null;
}

function lessonExpired(lesson, now = new Date()) {
  return Boolean(lesson.expiresAt && Date.parse(lesson.expiresAt) <= now.getTime());
}

function lessonEnabled(lesson, now = new Date()) {
  return !lesson.enabledFrom || Date.parse(lesson.enabledFrom) <= now.getTime();
}

function lessonStatus(state, lesson, now = new Date()) {
  const progress = lessonProgress(state, lesson.lessonId);
  if (progress) return progress.status;
  if (lessonExpired(lesson, now)) return "expired";
  return "not-started";
}

function scheduledLessonForProgress(state, progress, snapshot) {
  if (!progress || !["in-progress", "paused", "ready"].includes(progress.status)) return snapshot;
  return state.lessons.find(lesson => lesson.lessonId === progress.lessonId) || snapshot;
}

function currentLessonCandidate(value, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const active = Object.values(state.progress).find(item => ["in-progress", "paused", "ready"].includes(item.status));
  if (active) return { state, lesson: active.snapshot, progress: active };
  for (const lesson of state.lessons) {
    const progress = state.progress[lesson.lessonId];
    if (progress && ["completed", "cancelled", "expired"].includes(progress.status)) continue;
    const schedule = state.schedule.entries.find(entry => entry.lessonId === lesson.lessonId);
    if (!schedule || schedule.status !== "known") return { state, lesson: null, progress: null, waitingLesson: lesson, waitingReason: "schedule-unknown" };
    if (lessonExpired(lesson, now)) return { state, lesson: null, progress: null, waitingLesson: lesson, waitingReason: "schedule-expired" };
    if (!lessonEnabled(lesson, now)) return { state, lesson: null, progress: null, waitingLesson: lesson, waitingReason: "not-enabled" };
    return { state, lesson, progress: null };
  }
  return { state, lesson: null, progress: null };
}

function selfStudyPreviewContent(value, now = new Date()) {
  const candidate = currentLessonCandidate(value, now);
  const lesson = candidate.progress ? candidate.progress.snapshot : (candidate.lesson || candidate.waitingLesson || null);
  if (!lesson) return null;
  const schedule = scheduledLessonForProgress(candidate.state, candidate.progress, lesson);
  const note = clone(lesson.plannedContent.note);
  if (schedule.plannedContent && schedule.plannedContent.note && schedule.plannedContent.note.date) {
    note.date = schedule.plannedContent.note.date;
  }
  const source = candidate.progress ? "active-self-study" : "planned-self-study";
  return {
    source,
    lessonId: lesson.lessonId,
    lessonVersion: lesson.version,
    studyDay: lesson.studyDay,
    formalDate: schedule.formalDate || lesson.formalDate,
    title: lesson.title,
    enabledFrom: schedule.enabledFrom || lesson.enabledFrom,
    expiresAt: schedule.expiresAt || lesson.expiresAt,
    currentDay: Math.max(1, Number(lesson.studyDay) - 1),
    nextDay: Number(lesson.studyDay),
    updatedAt: candidate.progress?.updatedAt || candidate.state.updatedAt || lesson.publishedAt || "",
    formalEvidence: false,
    scheduleStatus: candidate.waitingReason === "schedule-unknown" ? "unknown" : "authoritative",
    waitingReason: String(candidate.waitingReason || ""),
    words: clone(lesson.plannedContent.words).map(item => ({
      ...item,
      status: "planned",
      learned: "",
      preview: true,
      formalEvidence: false,
      sourceLessonId: lesson.lessonId,
      sourceLessonVersion: lesson.version
    })),
    sentences: clone(lesson.plannedContent.sentences).map(item => ({
      ...item,
      status: "planned",
      learned: "",
      preview: true,
      formalEvidence: false,
      sourceLessonId: lesson.lessonId,
      sourceLessonVersion: lesson.version
    })),
    note,
    nextPreview: lesson.nextPreview
  };
}

function initializeProgress(lesson, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    lessonId: lesson.lessonId,
    lessonVersion: lesson.version,
    status: "in-progress",
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: "",
    pausedAt: "",
    pauseReason: "",
    activeSeconds: 0,
    lastActiveAt: timestamp,
    stageIndex: 0,
    stepIndex: 0,
    snapshot: clone(lesson),
    steps: {},
    promotion: null
  };
}

function startSelfStudyLesson(value, now = new Date()) {
  const candidate = currentLessonCandidate(value, now);
  if (!candidate.lesson) {
    const message = candidate.waitingReason === "schedule-unknown"
      ? "self-study lesson date is unknown; sync with the server before starting"
      : candidate.waitingReason === "schedule-expired"
        ? "self-study lesson schedule expired; sync with the server before starting"
        : candidate.waitingLesson ? "next self-study lesson is not available yet" : "no self-study lesson is available";
    fail(message, 409);
  }
  if (candidate.progress) {
    if (candidate.progress.status === "paused") {
      candidate.progress.status = "in-progress";
      candidate.progress.pausedAt = "";
      candidate.progress.lastActiveAt = now.toISOString();
      candidate.progress.updatedAt = now.toISOString();
    }
    return candidate.state;
  }
  candidate.state.progress[candidate.lesson.lessonId] = initializeProgress(candidate.lesson, now);
  candidate.state.updatedAt = now.toISOString();
  return candidate.state;
}

function progressCurrent(progress) {
  if (!progress || !progress.snapshot) return null;
  const stage = progress.snapshot.stages[progress.stageIndex];
  if (!stage) return null;
  const step = stage.steps[progress.stepIndex];
  return step ? { lesson: progress.snapshot, stage, step, progress } : null;
}

function ensureStepProgress(progress, stepId) {
  if (!progress.steps[stepId]) progress.steps[stepId] = sanitizeStepProgress({});
  return progress.steps[stepId];
}

function touchProgress(progress, now = new Date()) {
  const timestamp = now.toISOString();
  if (progress.status === "in-progress" && progress.lastActiveAt) {
    const elapsed = Math.max(0, Math.min(60, Math.floor((now.getTime() - Date.parse(progress.lastActiveAt)) / 1000)));
    progress.activeSeconds += elapsed;
  }
  if (progress.status === "in-progress") progress.lastActiveAt = timestamp;
  progress.updatedAt = timestamp;
}

function saveSelfStudyDraft(value, input, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(input.lessonId, 120)];
  const current = progressCurrent(progress);
  if (!current || current.step.stepId !== cleanInline(input.stepId, 120)) fail("self-study step is not current", 409);
  const stepState = ensureStepProgress(progress, current.step.stepId);
  if (!["completed", "skipped"].includes(stepState.status)) stepState.draft = cleanText(input.draft, 2000);
  touchProgress(progress, now);
  state.updatedAt = now.toISOString();
  return state;
}

function pauseSelfStudy(value, input = {}, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(input.lessonId, 120)];
  if (!progress || !["in-progress", "paused"].includes(progress.status)) fail("self-study lesson is not in progress", 409);
  touchProgress(progress, now);
  progress.status = "paused";
  progress.pausedAt = now.toISOString();
  progress.pauseReason = cleanText(input.reason, 500);
  progress.lastActiveAt = "";
  state.updatedAt = now.toISOString();
  return state;
}

function resumeSelfStudy(value, input = {}, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(input.lessonId, 120)];
  if (!progress || !["paused", "in-progress"].includes(progress.status)) fail("self-study lesson cannot be resumed", 409);
  progress.status = "in-progress";
  progress.pausedAt = "";
  progress.pauseReason = "";
  progress.lastActiveAt = now.toISOString();
  progress.updatedAt = now.toISOString();
  state.updatedAt = now.toISOString();
  return state;
}

function requestSelfStudyHint(value, input = {}, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const lessonId = cleanInline(input.lessonId, 120);
  const stepId = cleanInline(input.stepId, 120);
  const hintId = cleanInline(input.hintId, 160);
  if (!hintId) fail("hintId is required");
  const progress = state.progress[lessonId];
  const current = progressCurrent(progress);
  if (!current || current.step.stepId !== stepId) fail("self-study step is not current", 409);
  if (progress.status === "paused") fail("resume the lesson before requesting a hint", 409);
  if (!isQuestionStep(current.step)) fail("current self-study step has no hints", 409);
  const stepState = ensureStepProgress(progress, stepId);
  const requestedLevel = Math.max(1, Math.min(3, Number(input.level) || stepState.hintLevel + 1));
  const receipt = stepState.hintReceipts.find(item => item.id === hintId);
  if (receipt) {
    if (receipt.level !== requestedLevel) fail("hintId was already used for another hint level", 409);
    return { state, duplicate: true, level: receipt.level };
  }
  if (requestedLevel > stepState.hintLevel + 1) fail("request hint levels in order", 409);
  if (requestedLevel === 3 && input.confirmReveal !== true) fail("full answer reveal requires explicit confirmation", 409);
  stepState.hintLevel = Math.max(stepState.hintLevel, requestedLevel);
  stepState.assistance = requestedLevel >= 3 ? "revealed" : "assisted";
  stepState.hintReceipts.push({ id: hintId, level: requestedLevel, requestedAt: now.toISOString() });
  stepState.hintReceipts = stepState.hintReceipts.slice(-MAX_HINT_RECEIPTS_PER_STEP);
  touchProgress(progress, now);
  state.updatedAt = now.toISOString();
  return { state, duplicate: false, level: requestedLevel };
}

function selfStudyAutomaticSummary(progress, now = new Date()) {
  if (!progress || !progress.snapshot) return null;
  const questionSteps = progress.snapshot.stages.flatMap(stage => stage.steps).filter(isQuestionStep);
  const rows = questionSteps.map(step => {
    const state = progress.steps[step.stepId] || sanitizeStepProgress({});
    const graded = state.attempts.filter(attempt => attempt.status === "graded");
    const first = graded[0] || null;
    const last = graded.at(-1) || null;
    return { step, state, first, last };
  });
  const completed = rows.filter(row => row.state.status === "completed");
  const assisted = completed.filter(row => row.state.assistance === "assisted" || row.last && row.last.assistance === "assisted");
  const revealed = completed.filter(row => row.state.assistance === "revealed" || row.last && row.last.assistance === "revealed");
  const independent = completed.filter(row => !row.state.assistance && row.last && row.last.correct === true && row.last.gradingStatus === "correct");
  const initiallyIncorrect = rows.filter(row => row.first && (row.first.correct !== true || row.first.gradingStatus !== "correct"));
  const corrected = initiallyIncorrect.filter(row => row.state.status === "completed");
  const pending = rows.filter(row => row.state.status === "pending");
  const unattempted = rows.filter(row => !row.first);
  const errorReasons = uniqueStrings(initiallyIncorrect.flatMap(row => [
    row.first && (row.first.detailedExplanation || row.first.explanation),
    ...(row.first && Array.isArray(row.first.problemWords) && row.first.problemWords.length ? [`相关词：${row.first.problemWords.join("、")}`] : [])
  ]), 8, 240);
  const weakPoints = uniqueStrings(initiallyIncorrect.map(row => row.step.focus || row.step.title || row.step.category).filter(Boolean), 8, 160);
  const words = progress.snapshot.plannedContent && Array.isArray(progress.snapshot.plannedContent.words)
    ? progress.snapshot.plannedContent.words.map(item => ({ id: item.id, english: item.english, chinese: item.chinese }))
    : [];
  const sentences = progress.snapshot.plannedContent && Array.isArray(progress.snapshot.plannedContent.sentences)
    ? progress.snapshot.plannedContent.sentences.map(item => ({ id: item.id, english: item.english, chinese: item.chinese }))
    : [];
  const nextReview = weakPoints.length
    ? `下次先复习：${weakPoints.join("、")}，并重新独立完成使用过提示或首答错误的题目。`
    : "下次按记忆曲线复习今天的新词，并在句子中再次独立回忆。";
  const text = [
    `今天学习了 ${words.length} 个新词、${sentences.length} 个新句型或句子。`,
    `实际完成 ${completed.length}/${questionSteps.length} 道题：独立完成 ${independent.length} 道，提示后完成 ${assisted.length} 道，看答案后完成 ${revealed.length} 道；首答错误 ${initiallyIncorrect.length} 道，已订正 ${corrected.length} 道。`,
    pending.length ? `${pending.length} 道仍等待判定，不计为错误。` : "没有等待判定的题目。",
    errorReasons.length ? `实际错因：${errorReasons.join("；")}。` : "本次没有已确认的错误，未练习内容没有被写成答错。",
    nextReview
  ].join("\n");
  return {
    schema: 1,
    source: "deterministic",
    generatedAt: now.toISOString(),
    lessonId: progress.lessonId,
    newWords: words,
    newSentences: sentences,
    completedQuestions: completed.length,
    totalQuestions: questionSteps.length,
    independentCorrect: independent.length,
    initiallyIncorrect: initiallyIncorrect.length,
    corrected: corrected.length,
    assistedCompleted: assisted.length,
    revealedCompleted: revealed.length,
    pending: pending.length,
    unattempted: unattempted.length,
    errorReasons,
    weakPoints,
    nextReview,
    text,
    formalEvidence: false
  };
}

function genericWrongExplanation(step, answer) {
  if (step.type === "choice") return "当前选择不正确，请重新读题并检查选项之间的区别。";
  if (step.direction === "zh-en" || step.type === "zh-en") {
    const difference = englishAnswerDifferences(step.referenceAnswer, answer);
    if (difference.missing.some(word => ["a", "an", "the"].includes(word))) return "英文答案漏了冠词，请检查名词前面的结构。";
    if (difference.missing.some(word => ["on", "in", "at", "to", "from", "under", "over"].includes(word))) return "英文答案的介词或位置词不完整，请检查位置关系。";
    if (difference.missing.some(word => ["am", "is", "are", "was", "were"].includes(word))) return "英文答案漏了或写错了 be 动词，请先检查主语。";
    if (difference.missing.some(word => ["i", "you", "he", "she", "it", "we", "they"].includes(word))) return "英文答案的主语不完整或不对应，请先检查谁在做这件事。";
    if (difference.missing.length) return "英文答案漏了关键词，请逐词对照中文信息检查。";
    if (difference.extra.length) return "英文答案多写了信息，请只表达题干中已有的内容。";
    return "英文拼写或词序不正确，请逐词检查后订正。";
  }
  if (step.direction === "en-zh" || step.type === "en-zh") return "中文答案有一处关键信息不完整，请检查主语、动作、对象、数量或位置。";
  return "当前答案与题意不一致，请重新检查题干中的关键信息。";
}

function localStepGrade(step, answer) {
  const accepted = step.acceptedAnswers;
  let result;
  if (step.direction === "zh-en" || step.type === "zh-en") {
    const correct = englishAnswerMatches(answer, accepted);
    result = {
      correct,
      score: correct ? 1 : 0,
      gradingStatus: correct ? "correct" : "incorrect",
      problemWords: correct ? [] : englishAnswerDifferences(step.referenceAnswer, answer).missing,
      wordResults: englishWordResults(step.referenceAnswer, answer)
    };
  } else if (step.direction === "en-zh" || step.type === "en-zh") {
    const quality = chineseAnswerQuality(answer, accepted, step.english || step.prompt);
    result = { ...quality, problemWords: [], wordResults: englishSourceWordResults(step.english || step.prompt, quality.correct) };
  } else {
    const keys = new Set(accepted.map(answerKey));
    const correct = keys.has(answerKey(answer));
    result = { correct, score: correct ? 1 : 0, gradingStatus: correct ? "correct" : "incorrect", problemWords: [], wordResults: [] };
  }
  const explanation = result.correct && result.gradingStatus === "correct"
    ? "回答正确，可以继续。"
    : (step.correctionHints[0] || genericWrongExplanation(step, answer));
  const detailedExplanation = result.correct
    ? buildTranslationExplanation({ direction: step.direction || "en-zh", referenceAnswer: step.referenceAnswer, answer, correct: true, gradingStatus: result.gradingStatus, explanation })
    : explanation;
  return { ...result, explanation, detailedExplanation, source: "local" };
}

function normalizeGrade(step, answer, value) {
  const source = value && typeof value === "object" ? value : {};
  const correct = source.correct === true;
  const score = Number.isFinite(Number(source.score)) ? Math.max(0, Math.min(1, Number(source.score))) : (correct ? 1 : 0);
  const gradingStatus = ["correct", "partial", "incorrect"].includes(source.gradingStatus) ? source.gradingStatus : (correct ? "correct" : "incorrect");
  const explanation = correct && gradingStatus === "correct"
    ? cleanText(source.explanation, 1000) || "回答正确，可以继续。"
    : (step.correctionHints[0] || genericWrongExplanation(step, answer));
  return {
    correct,
    score,
    gradingStatus,
    explanation,
    detailedExplanation: correct ? (cleanText(source.detailedExplanation, 2000) || explanation) : explanation,
    problemWords: uniqueStrings(source.problemWords, 20, 100),
    wordResults: (Array.isArray(source.wordResults) ? source.wordResults : []).slice(0, 50),
    source: cleanInline(source.source, 40) || (step.gradingMode === "ai" ? "ai" : "local"),
    model: cleanInline(source.model, 160),
    providerName: cleanInline(source.providerName, 160),
    reasoningEffort: cleanInline(source.reasoningEffort, 40)
  };
}

function advanceProgress(progress, now = new Date()) {
  const stage = progress.snapshot.stages[progress.stageIndex];
  if (progress.stepIndex + 1 < stage.steps.length) {
    progress.stepIndex += 1;
  } else if (progress.stageIndex + 1 < progress.snapshot.stages.length) {
    progress.stageIndex += 1;
    progress.stepIndex = 0;
  } else {
    progress.status = "ready";
    progress.lastActiveAt = "";
  }
  progress.updatedAt = now.toISOString();
}

function existingAttempt(stepState, attemptId, answer) {
  const found = stepState.attempts.find(item => item.attemptId === attemptId);
  if (!found) return null;
  if (found.answer !== answer) fail("attemptId was already used with a different answer", 409);
  return found;
}

async function submitSelfStudyStep(value, input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const state = sanitizeSelfStudyState(value);
  const lessonId = cleanInline(input && input.lessonId, 120);
  const stepId = cleanInline(input && input.stepId, 120);
  const attemptId = cleanInline(input && input.attemptId, 160);
  const progress = state.progress[lessonId];
  if (!progress) fail("self-study progress not found", 404);
  const snapshotStep = progress.snapshot.stages.flatMap(stage => stage.steps).find(step => step.stepId === stepId);
  const savedStepState = progress.steps[stepId];
  let retryPending = null;
  if (snapshotStep && savedStepState) {
    if (isQuestionStep(snapshotStep) && attemptId) {
      const replay = existingAttempt(savedStepState, attemptId, cleanText(input && input.answer, 2000));
      if (replay && replay.status === "pending" && snapshotStep.gradingMode === "ai" && input.retry === true) retryPending = replay;
      else if (replay) return { state, duplicate: true, completionReady: progress.status === "ready" || progress.status === "completed", attempt: replay };
    } else if (!isQuestionStep(snapshotStep) && attemptId && savedStepState.confirmationId === attemptId && savedStepState.status === "completed") {
      return { state, duplicate: true, completionReady: progress.status === "ready" || progress.status === "completed" };
    }
  }
  const current = progressCurrent(progress);
  if (!current || current.step.stepId !== stepId) fail("self-study step is not current", 409);
  if (progress.status === "paused") fail("resume the lesson before submitting", 409);
  if (progress.status !== "in-progress") fail("self-study lesson is not accepting answers", 409);
  const step = current.step;
  const stepState = ensureStepProgress(progress, stepId);
  touchProgress(progress, now);

  if (!isQuestionStep(step)) {
    if (!attemptId) fail("attemptId is required");
    let response = cleanText(input && (input.answer || input.response), 2000);
    if (step.type === "summary") {
      const summary = selfStudyAutomaticSummary(progress, now);
      stepState.automaticSummary = summary;
      response = cleanText(summary && summary.text, 2000);
    }
    if (step.type === "summary" && step.required && !response) fail("automatic summary is unavailable");
    if (stepState.status === "completed") return { state, duplicate: true, completionReady: progress.status === "ready" };
    stepState.draft = response;
    stepState.confirmationId = attemptId;
    stepState.status = "completed";
    stepState.completedAt = now.toISOString();
    advanceProgress(progress, now);
    state.updatedAt = now.toISOString();
    return { state, duplicate: false, completionReady: progress.status === "ready", automaticSummary: stepState.automaticSummary };
  }

  const answer = cleanText(input && input.answer, 2000);
  if (!answer) fail("answer is required");
  if (!attemptId) fail("attemptId is required");
  const duplicate = existingAttempt(stepState, attemptId, answer);
  if (duplicate && duplicate !== retryPending) return { state, duplicate: true, completionReady: progress.status === "ready", attempt: duplicate };
  if (stepState.status === "completed") fail("self-study step has already been completed", 409);
  if (stepState.status === "pending" && !retryPending) fail("this answer is still waiting for grading", 409);

  const correction = Boolean(stepState.firstAttemptId);
  const pending = retryPending || sanitizeAttempt({
    attemptId,
    answer,
    status: step.gradingMode === "ai" ? "pending" : "graded",
    gradingStatus: step.gradingMode === "ai" ? "pending" : "incorrect",
    submittedAt: now.toISOString(),
    correction,
    assistance: stepState.assistance,
    hintLevel: stepState.hintLevel,
    formalEvidence: step.formalEvidence,
    referenceAnswer: step.referenceAnswer,
    acceptedAnswerVersion: progress.lessonVersion
  });
  if (!retryPending) stepState.attempts.push(pending);
  stepState.draft = answer;
  if (step.gradingMode === "ai") {
    stepState.status = "pending";
    if (typeof options.onPending === "function") await options.onPending(state, { progress, step, attempt: pending });
  }

  let grade;
  try {
    grade = step.gradingMode === "ai" && typeof options.grade === "function"
      ? await options.grade({ lesson: current.lesson, stage: current.stage, step, answer, progress })
      : localStepGrade(step, answer);
  } catch (error) {
    state.updatedAt = now.toISOString();
    throw Object.assign(error, { selfStudyState: state, pendingAttempt: true });
  }
  const result = normalizeGrade(step, answer, grade);
  Object.assign(pending, result, {
    status: "graded",
    gradedAt: new Date().toISOString(),
    assistance: stepState.assistance,
    hintLevel: stepState.hintLevel
  });
  if (!stepState.firstAttemptId) stepState.firstAttemptId = attemptId;
  if (result.correct && result.gradingStatus === "correct") {
    stepState.status = "completed";
    stepState.completedAt = new Date().toISOString();
    stepState.draft = "";
  } else {
    stepState.status = "needs-correction";
  }
  state.updatedAt = new Date().toISOString();
  return { state, duplicate: false, completionReady: progress.status === "ready", attempt: pending };
}

function continueSelfStudyStep(value, input, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const lessonId = cleanInline(input && input.lessonId, 120);
  const stepId = cleanInline(input && input.stepId, 120);
  const continueId = cleanInline(input && input.continueId, 160);
  if (!continueId) fail("continueId is required");
  const progress = state.progress[lessonId];
  if (!progress) fail("self-study progress not found", 404);
  const stepState = progress.steps[stepId];
  if (stepState && stepState.continueId === continueId) return { state, duplicate: true, completionReady: progress.status === "ready" || progress.status === "completed" };
  const current = progressCurrent(progress);
  if (!current || current.step.stepId !== stepId) fail("self-study step is not current", 409);
  if (!isQuestionStep(current.step) || !stepState || stepState.status !== "completed") fail("current self-study question is not ready to continue", 409);
  stepState.continueId = continueId;
  touchProgress(progress, now);
  advanceProgress(progress, now);
  state.updatedAt = now.toISOString();
  return { state, duplicate: false, completionReady: progress.status === "ready" };
}

function testSummary(progress) {
  if (!progress || !progress.snapshot) return { total: 0, firstScore: 0, firstCorrect: 0, corrected: 0, pending: 0, unattempted: 0 };
  const stage = progress.snapshot.stages.find(item => item.type === "test");
  const questions = stage ? stage.steps.filter(isQuestionStep) : [];
  let firstScore = 0;
  let firstCorrect = 0;
  let corrected = 0;
  let pending = 0;
  let unattempted = 0;
  questions.forEach(step => {
    const state = progress.steps[step.stepId];
    const first = state && state.attempts.find(item => item.attemptId === state.firstAttemptId);
    if (!first) { unattempted += 1; return; }
    if (first.status === "pending") { pending += 1; return; }
    firstScore += Number(first.score) || 0;
    if (first.correct && first.gradingStatus === "correct") firstCorrect += 1;
    else if (state.attempts.some(item => item.correction && item.correct && item.gradingStatus === "correct")) corrected += 1;
  });
  return { total: questions.length, firstScore: Math.round(firstScore * 100) / 100, firstCorrect, corrected, pending, unattempted };
}

function markLessonCompleted(value, lessonId, promotion, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(lessonId, 120)];
  if (!progress) fail("self-study progress not found", 404);
  if (progress.status === "completed") return state;
  if (progress.status !== "ready") fail("all six stages must be completed first", 409);
  progress.status = "completed";
  progress.completedAt = now.toISOString();
  progress.updatedAt = progress.completedAt;
  progress.lastActiveAt = "";
  progress.promotion = {
    completedAt: progress.completedAt,
    learnedAt: cleanIso(promotion && promotion.learnedAt) || progress.completedAt,
    firstReviewDue: cleanDate(promotion && promotion.firstReviewDue),
    contentIds: uniqueStrings(promotion && promotion.contentIds, 300, 120)
  };
  state.updatedAt = progress.completedAt;
  return state;
}

function addTutorQuestion(value, input, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(input && input.lessonId, 120)];
  const current = progressCurrent(progress);
  if (!current || current.step.stepId !== cleanInline(input && input.stepId, 120)) fail("self-study step is not current", 409);
  const question = cleanText(input && input.question, 500);
  if (!question) fail("question is required");
  const id = cleanInline(input && input.questionId, 160) || `self-question-${crypto.randomUUID()}`;
  const stepState = ensureStepProgress(progress, current.step.stepId);
  const existing = stepState.questions.find(item => item.id === id);
  if (existing) {
    if (existing.question !== question) fail("questionId was already used with different text", 409);
    return { state, question: existing, duplicate: true, context: current };
  }
  const record = sanitizeTutorQuestion({ id, question, status: "pending", askedAt: now.toISOString() });
  stepState.questions.push(record);
  touchProgress(progress, now);
  state.updatedAt = now.toISOString();
  return { state, question: record, duplicate: false, context: current };
}

function resolveTutorQuestion(value, input, answerData, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const progress = state.progress[cleanInline(input && input.lessonId, 120)];
  const stepState = progress && progress.steps[cleanInline(input && input.stepId, 120)];
  const record = stepState && stepState.questions.find(item => item.id === cleanInline(input && input.questionId, 160));
  if (!record) fail("self-study question not found", 404);
  record.answer = cleanText(answerData && answerData.answer, 1200);
  record.status = record.answer ? "answered" : "failed";
  record.answeredAt = now.toISOString();
  record.providerName = cleanInline(answerData && answerData.providerName, 160);
  record.model = cleanInline(answerData && answerData.model, 160);
  record.reasoningEffort = cleanInline(answerData && answerData.reasoningEffort, 40);
  progress.updatedAt = now.toISOString();
  state.updatedAt = now.toISOString();
  return state;
}

function referenceLeaked(answer, step) {
  const value = answerKey(answer);
  return Boolean(value && step.acceptedAnswers.some(item => {
    const expected = answerKey(item);
    return expected && (value.includes(expected) || expected.includes(value));
  }));
}

function publicAttempt(attempt, revealReference) {
  if (!attempt) return null;
  return {
    attemptId: attempt.attemptId,
    answer: attempt.answer,
    status: attempt.status,
    correct: attempt.correct,
    score: attempt.score,
    gradingStatus: attempt.gradingStatus,
    explanation: attempt.explanation,
    detailedExplanation: attempt.detailedExplanation,
    submittedAt: attempt.submittedAt,
    gradedAt: attempt.gradedAt,
    correction: attempt.correction,
    assistance: attempt.assistance,
    hintLevel: attempt.hintLevel,
    formalEvidence: attempt.formalEvidence,
    ...(revealReference ? { referenceAnswer: attempt.referenceAnswer } : {})
  };
}

function publicCurrentStep(progress) {
  const current = progressCurrent(progress);
  if (!current) return null;
  const step = current.step;
  const state = ensureStepProgress(progress, step.stepId);
  const completed = state.status === "completed";
  const attempts = state.attempts.map(attempt => publicAttempt(attempt, completed));
  const revealedHints = (Array.isArray(step.hints) ? step.hints : []).slice(0, Math.min(2, state.hintLevel));
  const automaticSummary = step.type === "summary"
    ? (state.automaticSummary || selfStudyAutomaticSummary(progress, new Date(progress.updatedAt || Date.now())))
    : null;
  return {
    stepId: step.stepId,
    type: step.type,
    category: step.category,
    title: step.title,
    instruction: step.instruction,
    content: step.content,
    prompt: step.prompt,
    passage: step.passage,
    english: !completed && step.direction === "zh-en" ? "" : step.english,
    chinese: !completed && step.direction === "en-zh" ? "" : step.chinese,
    phonetic: step.phonetic,
    pronunciation: step.pronunciation,
    choices: clone(step.choices),
    direction: step.direction,
    focus: step.focus,
    formalEvidence: step.formalEvidence,
    required: step.required,
    status: state.status,
    draft: state.draft,
    attempts,
    questions: clone(state.questions),
    hintLevel: state.hintLevel,
    hintMaxLevel: isQuestionStep(step) ? 3 : 0,
    assistance: state.assistance,
    hints: clone(revealedHints),
    automaticSummary: clone(automaticSummary),
    ...((completed || state.hintLevel >= 3) ? { referenceAnswer: step.referenceAnswer } : {})
  };
}

function publicSelfStudyState(value, now = new Date()) {
  const candidate = currentLessonCandidate(value, now);
  const state = candidate.state;
  const progress = candidate.progress;
  const completedLessons = Object.values(state.progress).filter(item => item.status === "completed").length;
  const hasLessons = state.lessons.length > 0 || Object.keys(state.progress).length > 0;
  const currentSchedule = progress ? scheduledLessonForProgress(state, progress, progress.snapshot) : null;
  const current = progress ? {
    lessonId: progress.lessonId,
    lessonVersion: progress.lessonVersion,
    studyDay: progress.snapshot.studyDay,
    formalDate: currentSchedule.formalDate || progress.snapshot.formalDate,
    title: progress.snapshot.title,
    enabledFrom: currentSchedule.enabledFrom || progress.snapshot.enabledFrom,
    expiresAt: currentSchedule.expiresAt || progress.snapshot.expiresAt,
    status: progress.status,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    completedAt: progress.completedAt,
    pausedAt: progress.pausedAt,
    pauseReason: progress.pauseReason,
    activeSeconds: progress.activeSeconds,
    stageIndex: progress.stageIndex,
    stepIndex: progress.stepIndex,
    stage: progress.snapshot.stages[progress.stageIndex] ? {
      stageId: progress.snapshot.stages[progress.stageIndex].stageId,
      type: progress.snapshot.stages[progress.stageIndex].type,
      title: progress.snapshot.stages[progress.stageIndex].title,
      index: progress.stageIndex,
      total: progress.snapshot.stages.length
    } : null,
    stages: progress.snapshot.stages.map((stage, index) => ({
      stageId: stage.stageId,
      type: stage.type,
      title: stage.title,
      index,
      completedSteps: stage.steps.filter(step => ["completed", "skipped"].includes(progress.steps[step.stepId]?.status)).length,
      totalSteps: stage.steps.length,
      status: index < progress.stageIndex ? "completed" : index === progress.stageIndex ? progress.status : "locked"
    })),
    step: state.enabled ? publicCurrentStep(progress) : null,
    testSummary: testSummary(progress),
    nextPreview: progress.status === "completed" ? progress.snapshot.nextPreview : ""
  } : null;
  return {
    enabled: state.enabled,
    hasLessons,
    entryVisible: Boolean(state.enabled && (progress || candidate.lesson)),
    lessonCount: state.lessons.length,
    completedLessons,
    current,
    availableLesson: !progress && candidate.lesson ? {
      lessonId: candidate.lesson.lessonId,
      studyDay: candidate.lesson.studyDay,
      formalDate: candidate.lesson.formalDate,
      title: candidate.lesson.title,
      version: candidate.lesson.version,
      enabledFrom: candidate.lesson.enabledFrom,
      expiresAt: candidate.lesson.expiresAt
    } : null,
    waitingUntil: candidate.waitingLesson ? candidate.waitingLesson.enabledFrom : "",
    waitingReason: String(candidate.waitingReason || ""),
    schedule: {
      schema: state.schedule.schema,
      revision: state.schedule.revision,
      timeZone: state.schedule.timeZone,
      synchronizedAt: state.schedule.synchronizedAt,
      status: state.schedule.entries.some(entry => entry.status !== "known") ? "incomplete" : "authoritative"
    },
    serverNow: now.toISOString(),
    updatedAt: state.updatedAt
  };
}

function selfStudyHistory(value) {
  const state = sanitizeSelfStudyState(value);
  const histories = Object.values(state.progress).sort((left, right) => (left.snapshot.studyDay - right.snapshot.studyDay) || left.lessonId.localeCompare(right.lessonId)).map(progress => {
    const schedule = scheduledLessonForProgress(state, progress, progress.snapshot);
    const plannedContent = clone(progress.snapshot.plannedContent);
    if (schedule.plannedContent && schedule.plannedContent.note && schedule.plannedContent.note.date) {
      plannedContent.note = { ...(plannedContent.note || {}), date: schedule.plannedContent.note.date };
    }
    const stages = progress.snapshot.stages.map(stage => ({
      stageId: stage.stageId,
      type: stage.type,
      title: stage.title,
      completed: stage.steps.every(step => ["completed", "skipped"].includes(progress.steps[step.stepId]?.status)),
      steps: stage.steps.map(step => {
        const stepState = progress.steps[step.stepId] || sanitizeStepProgress({});
        return {
          stepId: step.stepId,
          type: step.type,
          category: step.category,
          prompt: step.prompt,
          passage: step.passage,
          english: step.english,
          chinese: step.chinese,
          direction: step.direction,
          contentId: step.contentId,
          formalEvidence: step.formalEvidence,
          status: stepState.status,
          draftPresent: Boolean(stepState.draft && !["completed", "skipped"].includes(stepState.status)),
          firstAttemptId: stepState.firstAttemptId,
          hintLevel: stepState.hintLevel,
          assistance: stepState.assistance,
          automaticSummary: clone(stepState.automaticSummary),
          firstAttempt: clone(stepState.attempts.find(item => item.attemptId === stepState.firstAttemptId) || null),
          attempts: clone(stepState.attempts),
          corrections: clone(stepState.attempts.filter(item => item.correction)),
          tutorHistory: clone(stepState.questions),
          completedAt: stepState.completedAt,
          skippedAt: stepState.skippedAt,
          referenceAnswer: step.referenceAnswer,
          acceptedAnswers: clone(step.acceptedAnswers)
        };
      })
    }));
    return {
      lessonId: progress.lessonId,
      lessonVersion: progress.lessonVersion,
      studyDay: progress.snapshot.studyDay,
      formalDate: schedule.formalDate || progress.snapshot.formalDate,
      title: progress.snapshot.title,
      enabledFrom: schedule.enabledFrom || progress.snapshot.enabledFrom,
      expiresAt: schedule.expiresAt || progress.snapshot.expiresAt,
      status: progress.status,
      startedAt: progress.startedAt,
      updatedAt: progress.updatedAt,
      completedAt: progress.completedAt,
      pausedAt: progress.pausedAt,
      pauseReason: progress.pauseReason,
      activeSeconds: progress.activeSeconds,
      currentStageIndex: progress.stageIndex,
      currentStepIndex: progress.stepIndex,
      promotion: clone(progress.promotion),
      testSummary: testSummary(progress),
      stages,
      plannedContent: {
        status: progress.status === "completed" ? "learned" : "planned",
        words: plannedContent.words,
        sentences: plannedContent.sentences,
        note: plannedContent.note
      }
    };
  });
  const formalAttempts = histories.flatMap(lesson => lesson.stages.flatMap(stage => stage.steps.flatMap(step => step.attempts))).filter(item => item.formalEvidence === true && item.status === "graded");
  const corrections = formalAttempts.filter(item => item.correction);
  const firstAttempts = histories.flatMap(lesson => lesson.stages.flatMap(stage => stage.steps.map(step => step.firstAttempt).filter(Boolean)));
  const current = Object.values(state.progress).find(item => ["in-progress", "paused", "ready"].includes(item.status)) || null;
  const allSteps = histories.flatMap(lesson => lesson.stages.flatMap(stage => stage.steps));
  const plannedLessons = state.lessons.filter(lesson => !state.progress[lesson.lessonId]).map(lesson => ({
    lessonId: lesson.lessonId,
    lessonVersion: lesson.version,
    studyDay: lesson.studyDay,
    formalDate: lesson.formalDate,
    title: lesson.title,
    status: lessonExpired(lesson) ? "expired" : "planned",
    enabledFrom: lesson.enabledFrom,
    expiresAt: lesson.expiresAt,
    stages: lesson.stages.map(stage => ({ stageId: stage.stageId, type: stage.type, title: stage.title, totalSteps: stage.steps.length, status: "unattempted" })),
    plannedContent: {
      status: "planned",
      words: clone(lesson.plannedContent.words),
      sentences: clone(lesson.plannedContent.sentences),
      note: clone(lesson.plannedContent.note)
    }
  }));
  const plannedSteps = plannedLessons.reduce((sum, lesson) => sum + lesson.stages.reduce((stageSum, stage) => stageSum + stage.totalSteps, 0), 0);
  return {
    summary: {
      completedLessons: histories.filter(item => item.status === "completed").length,
      currentLessonId: current ? current.lessonId : "",
      currentStageId: current ? current.snapshot.stages[current.stageIndex]?.stageId || "" : "",
      currentStepId: current ? current.snapshot.stages[current.stageIndex]?.steps[current.stepIndex]?.stepId || "" : "",
      formalAttempts: formalAttempts.length,
      firstCorrect: firstAttempts.filter(item => item.correct === true && item.gradingStatus === "correct").length,
      corrections: corrections.length,
      assistedCompletions: allSteps.filter(step => step.status === "completed" && step.assistance === "assisted").length,
      revealedCompletions: allSteps.filter(step => step.status === "completed" && step.assistance === "revealed").length,
      automaticSummaries: allSteps.filter(step => step.type === "summary" && step.automaticSummary).length,
      unattempted: allSteps.filter(step => step.status === "unattempted").length + plannedSteps,
      pending: allSteps.filter(step => step.status === "pending").length,
      lastStudiedAt: histories.map(item => item.updatedAt).filter(Boolean).sort().at(-1) || ""
    },
    schedule: clone(state.schedule),
    lessons: histories,
    plannedLessons
  };
}

module.exports = {
  QUESTION_STEP_TYPES,
  SELF_STUDY_SCHEDULE_ANCHOR_DATE,
  SELF_STUDY_SCHEDULE_ANCHOR_DAY,
  SELF_STUDY_SCHEDULE_REVISION,
  SELF_STUDY_TIME_ZONE,
  SELF_STUDY_STAGE_TYPES,
  SELF_STUDY_STEP_TYPES,
  TEST_BLUEPRINT,
  addTutorQuestion,
  continueSelfStudyStep,
  currentLessonCandidate,
  alignSelfStudyLessonSchedule,
  buildSelfStudySchedule,
  isQuestionStep,
  localStepGrade,
  markLessonCompleted,
  mergeSelfStudyLessons,
  offlineSelfStudyPackage,
  pauseSelfStudy,
  publicSelfStudyState,
  referenceLeaked,
  resolveTutorQuestion,
  resumeSelfStudy,
  requestSelfStudyHint,
  sanitizeSelfStudyLesson,
  sanitizeSelfStudyState,
  saveSelfStudyDraft,
  selfStudyPreviewContent,
  selfStudyHistory,
  selfStudyAutomaticSummary,
  selfStudyScheduledDate,
  startSelfStudyLesson,
  submitSelfStudyStep,
  testSummary
};
