"use strict";

const crypto = require("node:crypto");
const {
  buildTranslationExplanation,
  chineseAnswerQuality,
  englishAnswerDifferences,
  englishAnswerMatches,
  englishSourceWordResults,
  englishWordResults,
  normalizeChinese,
  normalizeEnglish
} = require("../answer-utils");

const SELF_STUDY_STAGE_TYPES = Object.freeze(["review", "phonics", "pattern", "reading", "test", "summary"]);
const SELF_STUDY_STEP_TYPES = new Set(["teach", "read-aloud", "choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction", "summary"]);
const QUESTION_STEP_TYPES = new Set(["choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction"]);
const TEST_BLUEPRINT = Object.freeze({ phonics: 2, "en-zh": 2, "zh-en": 2, reading: 4 });
const MAX_LESSONS = 60;
const MAX_ATTEMPTS_PER_STEP = 20;
const MAX_QUESTIONS_PER_STEP = 50;

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

function sanitizeStep(value, index, stageType) {
  const source = value && typeof value === "object" ? value : {};
  const type = cleanInline(source.type, 40).toLocaleLowerCase();
  if (!SELF_STUDY_STEP_TYPES.has(type)) fail(`unsupported self-study step type: ${type || "empty"}`);
  const direction = type === "zh-en" ? "zh-en" : type === "en-zh" ? "en-zh" : (["en-zh", "zh-en"].includes(source.direction) ? source.direction : "");
  const choices = (Array.isArray(source.choices) ? source.choices : []).slice(0, 12).map(sanitizeChoice).filter(item => item.text);
  const acceptedAnswers = acceptedAnswersForStep(source, direction);
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
  return {
    stepId: cleanId(source.stepId || `step-${index + 1}`, "stepId"),
    type,
    category,
    title: cleanInline(source.title, 160),
    instruction: cleanText(source.instruction, 1000),
    content: cleanText(source.content || source.teachingText, 5000),
    prompt: cleanText(source.prompt || source.question, 2000),
    passage: cleanText(source.passage || source.reading, 5000),
    english: cleanInline(source.english, 1000),
    chinese: cleanInline(source.chinese, 1000),
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
  const chinese = cleanInline(source.chinese, 1000);
  if (!english || !chinese) fail("planned sentence requires english and chinese");
  return {
    id: cleanId(source.id, "planned sentence id"),
    day: lessonDay,
    status: "planned",
    learned: "",
    preview: false,
    english,
    chinese,
    acceptedChinese: uniqueStrings([...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : []), chinese], 20, 1000),
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
  const lesson = {
    lessonId,
    studyDay,
    formalDate: cleanDate(source.formalDate || source.date),
    title: cleanInline(source.title, 200) || `第 ${studyDay} 天自学课程`,
    version: cleanInline(source.version, 80) || "1",
    enabledFrom: cleanIso(source.enabledFrom || source.availableFrom),
    expiresAt: cleanIso(source.expiresAt),
    publishedAt: cleanIso(source.publishedAt) || new Date().toISOString(),
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
    status: ["pending", "graded"].includes(source.status) ? source.status : "graded",
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
    completedAt: cleanIso(source.completedAt),
    skippedAt: cleanIso(source.skippedAt),
    questions: (Array.isArray(source.questions) ? source.questions : []).map(sanitizeTutorQuestion).filter(Boolean).slice(-MAX_QUESTIONS_PER_STEP)
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
  return {
    schema: 1,
    enabled: source.enabled === true,
    lessons: Array.from(lessonMap.values()).sort((left, right) => left.studyDay - right.studyDay || left.lessonId.localeCompare(right.lessonId)),
    progress,
    updatedAt: cleanIso(source.updatedAt)
  };
}

function mergeSelfStudyLessons(value, packageValue, options = {}) {
  const state = sanitizeSelfStudyState(value);
  const source = packageValue && typeof packageValue === "object" ? packageValue : {};
  const incoming = (Array.isArray(source.lessons) ? source.lessons : [])
    .map(lesson => sanitizeSelfStudyLesson(lesson, { skipVocabularyValidation: true }))
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

function currentLessonCandidate(value, now = new Date()) {
  const state = sanitizeSelfStudyState(value);
  const active = Object.values(state.progress).find(item => ["in-progress", "paused", "ready"].includes(item.status));
  if (active) return { state, lesson: active.snapshot, progress: active };
  for (const lesson of state.lessons) {
    const progress = state.progress[lesson.lessonId];
    if (progress && ["completed", "cancelled", "expired"].includes(progress.status)) continue;
    if (lessonExpired(lesson, now)) continue;
    if (!lessonEnabled(lesson, now)) return { state, lesson: null, progress: null, waitingLesson: lesson };
    return { state, lesson, progress: null };
  }
  return { state, lesson: null, progress: null };
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
  if (!candidate.lesson) fail(candidate.waitingLesson ? "next self-study lesson is not available yet" : "no self-study lesson is available", 409);
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
    const quality = chineseAnswerQuality(answer, accepted);
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
    const response = cleanText(input && (input.answer || input.response), 2000);
    if (step.type === "summary" && step.required && !response) fail("summary response is required");
    if (stepState.status === "completed") return { state, duplicate: true, completionReady: progress.status === "ready" };
    stepState.draft = response;
    stepState.confirmationId = attemptId;
    stepState.status = "completed";
    stepState.completedAt = now.toISOString();
    advanceProgress(progress, now);
    state.updatedAt = now.toISOString();
    return { state, duplicate: false, completionReady: progress.status === "ready" };
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
  Object.assign(pending, result, { status: "graded", gradedAt: new Date().toISOString() });
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
    ...(completed ? { referenceAnswer: step.referenceAnswer } : {})
  };
}

function publicSelfStudyState(value, now = new Date()) {
  const candidate = currentLessonCandidate(value, now);
  const state = candidate.state;
  const progress = candidate.progress;
  const completedLessons = Object.values(state.progress).filter(item => item.status === "completed").length;
  const hasLessons = state.lessons.length > 0 || Object.keys(state.progress).length > 0;
  const current = progress ? {
    lessonId: progress.lessonId,
    lessonVersion: progress.lessonVersion,
    studyDay: progress.snapshot.studyDay,
    title: progress.snapshot.title,
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
    availableLesson: !progress && candidate.lesson ? { lessonId: candidate.lesson.lessonId, studyDay: candidate.lesson.studyDay, title: candidate.lesson.title, version: candidate.lesson.version } : null,
    waitingUntil: candidate.waitingLesson ? candidate.waitingLesson.enabledFrom : "",
    updatedAt: state.updatedAt
  };
}

function selfStudyHistory(value) {
  const state = sanitizeSelfStudyState(value);
  const histories = Object.values(state.progress).sort((left, right) => (left.snapshot.studyDay - right.snapshot.studyDay) || left.lessonId.localeCompare(right.lessonId)).map(progress => {
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
      title: progress.snapshot.title,
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
        words: clone(progress.snapshot.plannedContent.words),
        sentences: clone(progress.snapshot.plannedContent.sentences),
        note: clone(progress.snapshot.plannedContent.note)
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
      unattempted: allSteps.filter(step => step.status === "unattempted").length + plannedSteps,
      pending: allSteps.filter(step => step.status === "pending").length,
      lastStudiedAt: histories.map(item => item.updatedAt).filter(Boolean).sort().at(-1) || ""
    },
    lessons: histories,
    plannedLessons
  };
}

module.exports = {
  QUESTION_STEP_TYPES,
  SELF_STUDY_STAGE_TYPES,
  SELF_STUDY_STEP_TYPES,
  TEST_BLUEPRINT,
  addTutorQuestion,
  continueSelfStudyStep,
  currentLessonCandidate,
  isQuestionStep,
  localStepGrade,
  markLessonCompleted,
  mergeSelfStudyLessons,
  pauseSelfStudy,
  publicSelfStudyState,
  referenceLeaked,
  resolveTutorQuestion,
  resumeSelfStudy,
  sanitizeSelfStudyLesson,
  sanitizeSelfStudyState,
  saveSelfStudyDraft,
  selfStudyHistory,
  startSelfStudyLesson,
  submitSelfStudyStep,
  testSummary
};
