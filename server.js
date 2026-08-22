const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { URL } = require("url");
const { loadUsers, normalizeUsername, publicUser, validPassword, validateCredentials } = require("./server/accounts");
const { NATURAL_DEEP_EXPLANATION, NATURAL_PERSON_MEASURE_EXPLANATION, OPTIONAL_MEASURE_OMISSION_EXPLANATION, buildTranslationExplanation, chineseAnswerMatches, chineseAnswerQuality, chineseNaturalDeepMatches, chineseNaturalPersonMeasureMatches, chineseOptionalMeasureOmissionMatches, englishAnswerMatches, englishSourceWordResults, englishWordResults, mistakeIsResolved, repairReviewEvidence } = require("./answer-utils");
const { createAiConnectionTester, createAiGrader, createAiModelFetcher, createAiPreviewSentenceGenerator, createAiQuestionGenerator, createAiReviewVariantGenerator, createAiTutor, createRateLimiter } = require("./server/ai-grader");
const { MAX_AI_HISTORY, MAX_TUTOR_HISTORY, MAX_TUTOR_MESSAGES, MAX_TUTOR_RESETS, buildLearningProfile, createDeterministicWordQuestions, createQuestionSet, offlineAiPractice, publicAiPractice, publicQuestionSet, sanitizeAiPractice, sanitizeQuestionSet, sanitizeTutorExchange, tutorThreadFromHistory } = require("./server/ai-practice");
const { createReviewBatch, publicFormalPractice, publicReviewBatch, sanitizeFormalPractice, sanitizeReviewBatch, sanitizeReviewResult } = require("./server/formal-practice");
const { AI_EFFORTS, createAiSettingsStore, getAvailableModels, resolveAiConnection, selectAiCandidates } = require("./server/ai-settings");
const { buildLearningSyncProfile } = require("./server/learning-sync");
const { validLearningSyncToken, validTeachingProfileWriteToken } = require("./server/learning-sync-token");
const { publicTeachingProfile, sanitizeTeachingProfile } = require("./server/teaching-profile");
const { abilityChanges, analyzeAbilities } = require("./server/ability-analysis");
const { expandRegisteredChineseAnswers, naturalizePlainDeepChinese, normalizeEnglish: normalizeVariantEnglish, prioritizeRegisteredChineseMeanings, registeredChineseMeaningConflicts, sanitizeGeneratedSentenceVariant, sentenceFamily, sentenceVariantById, validateGeneratedSentenceVariant } = require("./review-variants");
const { classifyRepeatedReviewBatch, mergeReviewSession, retireReviewSession, uniqueBatchIds } = require("./review-session");
const {
  REVIEW_VARIANT_POOL_BATCH,
  REVIEW_VARIANT_POOL_TARGET,
  assignReviewVariantPoolTasks,
  buildReviewVariantPoolTasks,
  ensureReviewVariantPool,
  publicReviewVariantPool,
  reviewVariantContentSignature,
  reviewVariantPoolSummary,
  reviewVariantSyncKey,
  sanitizeReviewVariantPool,
  storeReviewVariantPoolResults
} = require("./server/review-variant-pool");
const { expandPreviewAcceptedChinese, normalizePreviewSchoolSentence, sanitizePreviewPractice, sanitizePreviewPracticeHistory } = require("./server/preview-practice");
const { learningEvidenceRepairSignature, repairLearningEvidence } = require("./server/evidence-repair");
const { mergeStudyTime, normalizeStudyTime } = require("./study-time");
const {
  WORD_USAGE_MIGRATION_VERSION,
  activityEvents: buildWordUsageEvents,
  appendEvents: appendWordUsageEvents,
  migrateWordUsage,
  publicWordUsage,
  rankedWordIds: rankedWordUsageIds,
  sanitizeWordUsage,
  usageRows: wordUsageRows,
  validDate: validWordUsageDate
} = require("./server/word-memory");
const {
  addTutorQuestion,
  continueSelfStudyStep,
  localStepGrade,
  markLessonCompleted,
  mergeSelfStudyLessons,
  offlineSelfStudyPackage,
  pauseSelfStudy,
  publicSelfStudyState,
  referenceLeaked,
  requestSelfStudyHint,
  resolveTutorQuestion,
  resumeSelfStudy,
  sanitizeSelfStudyState,
  saveSelfStudyDraft,
  selfStudyPreviewContent,
  selfStudyHistory,
  startSelfStudyLesson,
  submitSelfStudyStep
} = require("./server/self-study");
const {
  completeDictation,
  createAiDictationAnalyzer,
  createDictationSession,
  dictationComplete,
  dictationSpeech,
  gradeDictation,
  publicDictationState,
  recordCompletedDictation,
  sanitizeDictationState,
  saveDictationAnswers,
  selectDictationWords
} = require("./server/dictation");
const {
  completeFocusedSession,
  createAiFocusedGenerator,
  createFocusedSession,
  examForFocusedGrading,
  focusedAnswersComplete,
  focusedListeningSpeech,
  normalizeFocusedType,
  publicFocusedState,
  recordCompletedFocused,
  sanitizeFocusedState,
  saveFocusedAnswers
} = require("./server/focused-practice");
const { createAiPaperRecognizer } = require("./server/paper-exam");
const {
  completeExam,
  createAiExamGenerator,
  createAiExamGrader,
  createExam,
  examAnswersComplete,
  listeningSpeech,
  normalizeTotalPoints,
  publicAiExamState,
  publicExam,
  recordCompletedExam,
  sanitizeAiExamState,
  sanitizeAnswers
} = require("./server/ai-exam");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "server", "data"));
const CONTENT_FILE = path.join(DATA_DIR, "content-store.json");
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const USER_STATES_FILE = path.join(DATA_DIR, "user-states.json");
const SELF_STUDY_TRANSACTION_FILE = path.join(DATA_DIR, "self-study-transaction.json");
const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = String(process.env.API_TOKEN || "").trim();
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const APP_TIMEZONE = process.env.TZ || "Asia/Shanghai";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_AI_ANSWER_LENGTH = 500;
const MAX_AI_TUTOR_MESSAGE_LENGTH = 500;
const MAX_SENTENCE_PRACTICE_EVENTS = 10000;
const EXAM_GENERATION_TIMEOUT_MS = 120000;
const EXAM_GENERATION_API_VERSION = "2";
const AI_SENTENCE_RETRY_MS = 5 * 60 * 1000;
const AI_SENTENCE_RETRY_SECONDS = 5 * 60;
const REVIEW_VARIANT_MAX_REPAIR_ROUNDS = 3;
const REVIEW_VARIANT_JOB_POLL_MS = 2000;
const REVIEW_VARIANT_JOB_CACHE_MS = 10 * 60 * 1000;
const REVIEW_VARIANT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEW_VARIANT_POOL_AUTOFILL = process.env.REVIEW_VARIANT_POOL_AUTOFILL !== "false";
const OFFLINE_PACK_SCHEMA_VERSION = 1;
const OFFLINE_PACK_DAYS = 14;
const OFFLINE_PACK_MAX_BYTES = 6 * 1024 * 1024;
const FORMAL_PRACTICE_LOCK_WARN_MS = Math.max(100, Number(process.env.FORMAL_PRACTICE_LOCK_WARN_MS) || 2000);

ensureDataDir();
recoverSelfStudyTransaction();
const aiSettingsStore = createAiSettingsStore(DATA_DIR);
let aiSettings = aiSettingsStore.load();
let takeAiRequest = createRateLimiter(aiSettings ? aiSettings.rateLimitPerMinute : 20);
let content = loadContent();
let users = loadUsers(DATA_DIR);
let sessions = loadSessions();
let userStates = loadUserStates();
const activeExamGenerationJobs = new Map();
const activeAiGenerationJobsByUserId = new Map();
const reviewVariantJobsById = new Map();
const reviewVariantJobIdsByKey = new Map();
const reviewVariantPoolJobsByUserId = new Map();
const reviewVariantPoolRetryTimersByUserId = new Map();
const selfStudyLocksByUserId = new Map();
const formalPracticeLocksByUserId = new Map();
const legacyState = markLearningEvidenceRepaired(repairLearningEvidence(content, sanitizeState(readJson(LEGACY_STATE_FILE, {}))).state);
repairStoredUserStates();

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_) { return fallback; }
}

function writeJson(filePath, value, { pretty = true } = {}) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function recoverSelfStudyTransaction() {
  const transaction = readJson(SELF_STUDY_TRANSACTION_FILE, null);
  if (!transaction || transaction.schema !== 1 || !transaction.content || !transaction.userStates) return;
  writeJson(CONTENT_FILE, transaction.content);
  writeJson(USER_STATES_FILE, transaction.userStates);
  fs.rmSync(SELF_STUDY_TRANSACTION_FILE, { force: true });
}

function persistSelfStudyTransaction(nextContent, nextUserStates) {
  writeJson(SELF_STUDY_TRANSACTION_FILE, { schema: 1, createdAt: new Date().toISOString(), content: nextContent, userStates: nextUserStates });
  writeJson(CONTENT_FILE, nextContent);
  writeJson(USER_STATES_FILE, nextUserStates, { pretty: false });
  fs.rmSync(SELF_STUDY_TRANSACTION_FILE, { force: true });
}

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

function today() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readSeedContent() {
  const source = fs.readFileSync(path.join(ROOT, "data.js"), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { timeout: 1000 });
  return sandbox.window.ENGLISH_REVIEW_DATA;
}

function mergeById(seedItems, storedItems) {
  const map = new Map((Array.isArray(seedItems) ? seedItems : []).map(item => [item.id, item]));
  (Array.isArray(storedItems) ? storedItems : []).forEach(item => {
    if (!item || !item.id) return;
    const existing = map.get(item.id);
    if (item.preview && existing && !existing.preview) return;
    map.set(item.id, item);
  });
  return Array.from(map.values());
}

function mergeNotes(seedNotes, storedNotes) {
  const map = new Map((Array.isArray(storedNotes) ? storedNotes : []).filter(item => item && Number(item.day) > 0).map(item => [Number(item.day), item]));
  (Array.isArray(seedNotes) ? seedNotes : []).forEach(item => { if (item && Number(item.day) > 0) map.set(Number(item.day), item); });
  return Array.from(map.values()).sort((left, right) => Number(left.day) - Number(right.day));
}

function mergeContent(seed, stored) {
  const source = stored && typeof stored === "object" ? stored : {};
  const deletedIds = Array.isArray(source.deletedIds) ? Array.from(new Set(source.deletedIds.map(String))) : [];
  const updatedAt = [seed.updatedAt, source.updatedAt].map(value => String(value || "")).filter(Boolean).sort().at(-1) || today();
  return {
    version: Math.max(Number(seed.version || 1), Number(source.version || 1)),
    updatedAt,
    currentDay: Math.max(Number(seed.currentDay || 0), Number(source.currentDay || 0)),
    words: mergeById(seed.words, source.words).filter(item => !deletedIds.includes(item.id)),
    sentences: mergeById(seed.sentences, source.sentences).filter(item => !deletedIds.includes(item.id)),
    notes: mergeNotes(seed.notes, source.notes),
    seedMistakes: Array.isArray(seed.seedMistakes) ? seed.seedMistakes : (Array.isArray(source.seedMistakes) ? source.seedMistakes : []),
    deletedIds
  };
}

function normalizeStoredContentSentences(target) {
  const context = target && typeof target === "object" ? target : { words: [], sentences: [] };
  context.sentences = (Array.isArray(context.sentences) ? context.sentences : []).map(item => {
    const english = String(item && item.english || "").trim();
    const sourceChinese = String(item && item.chinese || "").trim();
    if (!english || !sourceChinese) return item;
    const chinese = prioritizeRegisteredChineseMeanings(context, english, sourceChinese);
    const acceptedChinese = expandRegisteredChineseAnswers(context, english, [
      chinese,
      prioritizeRegisteredChineseMeanings(context, english, sourceChinese),
      ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])
        .map(answer => prioritizeRegisteredChineseMeanings(context, english, answer))
    ].filter(answer => answer && !registeredChineseMeaningConflicts(context, english, answer).length), 16);
    return { ...item, chinese, acceptedChinese };
  });
  return context;
}

function repairStoredQuestionWordMeanings(question) {
  if (!question || typeof question !== "object") return false;
  const english = String(question.english || "").trim();
  const sourceChinese = String(question.chinese || "").trim();
  if (!english || !sourceChinese) return false;
  const before = JSON.stringify({
    chinese: question.chinese,
    acceptedChinese: question.acceptedChinese,
    reviewVariant: question.reviewVariant
  });
  const chinese = prioritizeRegisteredChineseMeanings(content, english, sourceChinese);
  const acceptedChinese = expandRegisteredChineseAnswers(content, english, [
    chinese,
    ...(Array.isArray(question.acceptedChinese) ? question.acceptedChinese : [])
      .map(answer => prioritizeRegisteredChineseMeanings(content, english, answer))
  ].filter(answer => answer && !registeredChineseMeaningConflicts(content, english, answer).length), 16);
  question.chinese = chinese;
  question.acceptedChinese = acceptedChinese.length ? acceptedChinese : [chinese];
  if (question.reviewVariant && typeof question.reviewVariant === "object") {
    question.reviewVariant.chinese = chinese;
    question.reviewVariant.acceptedChinese = [...question.acceptedChinese];
  }
  return before !== JSON.stringify({
    chinese: question.chinese,
    acceptedChinese: question.acceptedChinese,
    reviewVariant: question.reviewVariant
  });
}

function repairStoredPracticeWordMeanings(state) {
  if (!state || typeof state !== "object") return false;
  let changed = false;
  const practice = state.formalPractice && state.formalPractice.review;
  const reviewBatches = [
    practice && practice.current,
    ...(practice && Array.isArray(practice.history) ? practice.history : [])
  ].filter(Boolean);
  reviewBatches.forEach(batch => {
    (Array.isArray(batch.questions) ? batch.questions : []).forEach(question => {
      if (repairStoredQuestionWordMeanings(question)) changed = true;
    });
  });
  const aiPractice = state.aiPractice && typeof state.aiPractice === "object" ? state.aiPractice : null;
  const aiSets = [
    aiPractice && aiPractice.currentSet,
    ...(aiPractice && Array.isArray(aiPractice.queuedSets) ? aiPractice.queuedSets : [])
  ].filter(Boolean);
  aiSets.forEach(set => {
    (Array.isArray(set.questions) ? set.questions : []).forEach(question => {
      if (repairStoredQuestionWordMeanings(question)) changed = true;
    });
  });
  return changed;
}

function recalculateCurrentDay(target, seedDay = 0) {
  const itemDays = [...(target.words || []), ...(target.sentences || []), ...(target.notes || [])].filter(item => !item.preview).map(item => Number(item.day) || 0);
  target.currentDay = Math.max(Number(seedDay) || 0, ...itemDays);
}

function loadContent() {
  const seed = readSeedContent();
  const merged = normalizeStoredContentSentences(mergeContent(seed, readJson(CONTENT_FILE, null)));
  recalculateCurrentDay(merged, seed.currentDay);
  writeJson(CONTENT_FILE, merged);
  return merged;
}

function refreshContent() {
  try {
    const seed = readSeedContent();
    const merged = normalizeStoredContentSentences(mergeContent(seed, content));
    recalculateCurrentDay(merged, seed.currentDay);
    const changed = merged.currentDay !== content.currentDay || merged.words.length !== content.words.length || JSON.stringify(merged.sentences) !== JSON.stringify(content.sentences) || merged.notes.length !== (content.notes || []).length || merged.updatedAt !== content.updatedAt || merged.deletedIds.length !== (content.deletedIds || []).length;
    content = merged;
    if (changed) writeJson(CONTENT_FILE, content);
  } catch (_) {
    // Keep the last valid content if a seed file is temporarily unavailable.
  }
}

function sanitizeSentencePracticeEvent(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id || "").trim().slice(0, 180);
  const variantId = String(value.variantId || "").trim().slice(0, 180);
  const date = validStudyDate(value.date);
  if (!id || !variantId || !date || typeof value.correct !== "boolean") return null;
  return {
    id,
    variantId,
    date,
    practicedAt: String(value.practicedAt || value.submittedAt || value.answeredAt || date).trim().slice(0, 40),
    correct: value.correct === true,
    source: value.source === "ai" ? "ai" : "review"
  };
}

function sanitizeSentencePracticeEvents(value) {
  const unique = new Map();
  (Array.isArray(value) ? value : []).map(sanitizeSentencePracticeEvent).filter(Boolean).forEach(event => unique.set(event.id, event));
  return Array.from(unique.values()).slice(-MAX_SENTENCE_PRACTICE_EVENTS);
}

function appendSentencePracticeEvents(state, values) {
  const unique = new Map(sanitizeSentencePracticeEvents(state.sentencePracticeEvents).map(event => [event.id, event]));
  (Array.isArray(values) ? values : []).map(sanitizeSentencePracticeEvent).filter(Boolean).forEach(event => unique.set(event.id, event));
  state.sentencePracticeEvents = Array.from(unique.values()).slice(-MAX_SENTENCE_PRACTICE_EVENTS);
}

function reviewSessionDoneTaskIds(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim().slice(0, 180))
    .filter(Boolean))).slice(0, 1000);
}

function mergeReviewSessionState(existingValue, incomingValue) {
  const existing = existingValue && typeof existingValue === "object" ? existingValue : {};
  const incoming = incomingValue && typeof incomingValue === "object" ? incomingValue : {};
  const merged = mergeReviewSession(existing, incoming);
  merged.doneTaskIds = reviewSessionDoneTaskIds(merged.doneTaskIds);
  merged.retiredBatchIds = uniqueBatchIds(merged.retiredBatchIds);
  merged.variants = merged.batchId ? {
    ...(existing.variants && typeof existing.variants === "object" ? existing.variants : {}),
    ...(incoming.variants && typeof incoming.variants === "object" ? incoming.variants : {})
  } : {};
  return merged;
}

function mergeReviewSessionStates(existingValue, incomingValue) {
  const existing = existingValue && typeof existingValue === "object" ? existingValue : {};
  const incoming = incomingValue && typeof incomingValue === "object" ? incomingValue : {};
  const dates = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
  return Object.fromEntries(Array.from(dates).map(date => [date, mergeReviewSessionState(existing[date], incoming[date])]));
}

function currentLearningEvidenceRepairSignature() {
  return learningEvidenceRepairSignature(content);
}

function markLearningEvidenceRepaired(state, signature = currentLearningEvidenceRepairSignature()) {
  state.repairSignature = signature;
  return state;
}

function migrateAccountState(value, signature = currentLearningEvidenceRepairSignature()) {
  const normalized = sanitizeState(value);
  const repaired = repairLearningEvidence(content, normalized);
  const repairedWordMeanings = repairStoredPracticeWordMeanings(repaired.state);
  const wordUsageMigration = migrateWordUsage(repaired.state.wordUsage, repaired.state, content, { date: today(), timeZone: APP_TIMEZONE });
  repaired.state.wordUsage = wordUsageMigration.state;
  markLearningEvidenceRepaired(repaired.state, signature);
  return { state: repaired.state, changed: repaired.changed || repairedWordMeanings || wordUsageMigration.changed || normalized.repairSignature !== signature };
}

function sanitizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schema: 1,
    evidenceRepairVersion: Math.max(0, Number(source.evidenceRepairVersion) || 0),
    repairSignature: String(source.repairSignature || "").trim().slice(0, 120),
    taskStates: source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {},
    history: source.history && typeof source.history === "object" ? source.history : {},
    attempts: Array.isArray(source.attempts) ? source.attempts.slice(-120) : [],
    sessions: source.sessions && typeof source.sessions === "object" ? source.sessions : {},
    mistakes: Array.isArray(source.mistakes) ? source.mistakes.slice(-80) : [],
    sentencePracticeEvents: sanitizeSentencePracticeEvents(source.sentencePracticeEvents),
    wordUsage: sanitizeWordUsage(source.wordUsage),
    studyTime: normalizeStudyTime(source.studyTime),
    previewPractice: sanitizePreviewPractice(source.previewPractice, content),
    previewPracticeHistory: sanitizePreviewPracticeHistory(source.previewPracticeHistory, content),
    aiPractice: sanitizeAiPractice(source.aiPractice),
    aiExam: sanitizeAiExamState(source.aiExam),
    dictation: sanitizeDictationState(source.dictation),
    focusedPractice: sanitizeFocusedState(source.focusedPractice),
    teachingProfile: sanitizeTeachingProfile(source.teachingProfile),
    reviewVariantPool: sanitizeReviewVariantPool(source.reviewVariantPool),
    selfStudy: sanitizeSelfStudyState(source.selfStudy),
    formalPractice: sanitizeFormalPractice(source.formalPractice)
  };
}

function publicReviewSessions(state) {
  let sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
  const currentReviewBatch = state.formalPractice && state.formalPractice.review && state.formalPractice.review.current;
  if (currentReviewBatch) {
    const completedTaskIds = authoritativeCompletedReviewTaskIds(state, currentReviewBatch);
    if (classifyRepeatedReviewBatch(currentReviewBatch, completedTaskIds)) {
      const studyDate = reviewBatchSessionDate(currentReviewBatch);
      sessions = {
        ...sessions,
        [studyDate]: {
        ...(sessions[studyDate] && typeof sessions[studyDate] === "object" ? sessions[studyDate] : { date: studyDate }),
        doneTaskIds: completedTaskIds
        }
      };
    }
  }
  return sessions;
}

function publicReviewState(value) {
  const state = value && typeof value === "object" ? value : defaultState();
  return {
    schema: 1,
    evidenceRepairVersion: Math.max(0, Number(state.evidenceRepairVersion) || 0),
    taskStates: state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {},
    history: state.history && typeof state.history === "object" ? state.history : {},
    attempts: Array.isArray(state.attempts) ? state.attempts : [],
    sessions: publicReviewSessions(state),
    mistakes: Array.isArray(state.mistakes) ? state.mistakes : [],
    wordUsage: publicWordUsage(state.wordUsage, content, { date: today(), timeZone: APP_TIMEZONE, capacity: 10 }),
    studyTime: state.studyTime,
    previewPractice: state.previewPractice,
    previewPracticeHistory: state.previewPracticeHistory,
    aiPractice: publicAiPractice(state.aiPractice),
    formalPractice: publicFormalPractice(state.formalPractice),
    reviewVariantPool: publicReviewVariantPool(state.reviewVariantPool)
  };
}

function publicFormalEvidenceState(value) {
  const state = value && typeof value === "object" ? value : defaultState();
  return {
    schema: 1,
    evidenceRepairVersion: Math.max(0, Number(state.evidenceRepairVersion) || 0),
    taskStates: state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {},
    history: state.history && typeof state.history === "object" ? state.history : {},
    attempts: Array.isArray(state.attempts) ? state.attempts : [],
    sessions: publicReviewSessions(state),
    mistakes: Array.isArray(state.mistakes) ? state.mistakes : [],
    wordUsage: publicWordUsage(state.wordUsage, content, { date: today(), timeZone: APP_TIMEZONE, capacity: 10 }),
    studyTime: state.studyTime,
    previewPractice: state.previewPractice,
    previewPracticeHistory: state.previewPracticeHistory
  };
}

function defaultState() {
  const state = markLearningEvidenceRepaired(repairLearningEvidence(content, sanitizeState({})).state);
  state.wordUsage = migrateWordUsage(state.wordUsage, state, content, { date: today(), timeZone: APP_TIMEZONE }).state;
  return state;
}
function isEmptyState(value) {
  const studyTime = normalizeStudyTime(value && value.studyTime);
  return !value || (!Object.keys(value.taskStates || {}).length
    && !Object.keys(value.history || {}).length
    && !value.attempts?.length
    && !value.sentencePracticeEvents?.length
    && !value.mistakes?.length
    && !Object.keys(studyTime.daily).length);
}

function loadSessions() {
  const saved = readJson(SESSIONS_FILE, {});
  return { schema: 1, sessions: saved.sessions && typeof saved.sessions === "object" ? saved.sessions : {} };
}

function loadUserStates() {
  const saved = readJson(USER_STATES_FILE, {});
  return { schema: 1, users: saved.users && typeof saved.users === "object" ? saved.users : {} };
}

function persistSessions() { writeJson(SESSIONS_FILE, sessions); }
function persistUserStates() { writeJson(USER_STATES_FILE, userStates, { pretty: false }); }
function persistContent() { writeJson(CONTENT_FILE, content); }
function refreshUsers() { users = loadUsers(DATA_DIR); }
function refreshAiSettings() {
  aiSettings = aiSettingsStore.load();
  takeAiRequest = createRateLimiter(aiSettings ? aiSettings.rateLimitPerMinute : 20);
}

function aiConfigured() { return Boolean(aiSettings && getAvailableModels(aiSettings).length); }

function advanceAiRotation(config, mode) {
  if (mode !== "auto") return;
  aiSettings = aiSettingsStore.advanceRotation(config.providerId) || aiSettings;
}

function recoverInterruptedFormalWork(state) {
  const now = new Date().toISOString();
  let changed = false;
  const formalPractice = sanitizeFormalPractice(state.formalPractice);
  if (formalPractice.review.current && formalPractice.review.current.phase === "grading") {
    formalPractice.review.current.phase = "review";
    formalPractice.review.current.lastError = "服务重启中断了上次批改，整组答案已保留，请重新点击确认并批改。";
    formalPractice.review.current.updatedAt = now;
    formalPractice.updatedAt = now;
    changed = true;
  }
  state.formalPractice = formalPractice;

  const aiPractice = sanitizeAiPractice(state.aiPractice);
  if (aiPractice.currentSet && aiPractice.currentSet.phase === "grading") {
    aiPractice.currentSet.phase = "review";
    aiPractice.currentSet.lastError = "服务重启中断了上次批改，整组答案已保留，请重新点击确认并批改。";
    aiPractice.currentSet.updatedAt = now;
    aiPractice.updatedAt = now;
    changed = true;
  }
  aiPractice.generationQueue.forEach(item => {
    if (item.status !== "pending") return;
    item.status = "failed";
    item.failedGroupNumber = Math.min(item.groupCount, item.generatedGroupCount + 1);
    item.error = `服务重启中断了第 ${item.failedGroupNumber} 组生成，请在原位置重试。`;
    item.updatedAt = now;
    aiPractice.updatedAt = now;
    changed = true;
  });
  state.aiPractice = aiPractice;
  return changed;
}

function repairStoredUserStates() {
  let changed = false;
  const signature = currentLearningEvidenceRepairSignature();
  Object.entries(userStates.users).forEach(([userId, value]) => {
    const migrated = migrateAccountState(value, signature);
    const normalized = migrated.state;
    const interrupted = recoverInterruptedFormalWork(normalized);
    const ensuredPool = ensureReviewVariantPool(normalized.reviewVariantPool, {
      date: today(),
      syncKey: reviewVariantSyncKey(content),
      contentSignature: reviewVariantContentSignature(content),
      content,
      targetCount: REVIEW_VARIANT_POOL_TARGET
    });
    normalized.reviewVariantPool = ensuredPool.pool;
    userStates.users[userId] = normalized;
    if (interrupted || migrated.changed || ensuredPool.changed || JSON.stringify(normalized) !== JSON.stringify(value)) changed = true;
  });
  if (changed) persistUserStates();
}

async function runAiRoute(route, operation) {
  let lastError;
  for (const config of route.candidates) {
    try {
      const value = await operation(config);
      advanceAiRotation(config, route.mode);
      return { value, config };
    } catch (error) {
      lastError = error;
      advanceAiRotation(config, route.mode);
      if (route.mode !== "auto") throw error;
      console.warn(`AI provider ${config.providerName} failed during automatic rotation: ${error && error.message ? error.message : "unknown error"}`);
    }
  }
  throw lastError || Object.assign(new Error("no AI provider is available"), { statusCode: 503 });
}

function createSession(userId) {
  purgeSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.sessions[hashToken(token)] = { userId, createdAt: new Date().toISOString(), expiresAt: Date.now() + SESSION_MAX_AGE * 1000 };
  persistSessions();
  return token;
}

function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

function purgeSessions() {
  const now = Date.now();
  let changed = false;
  Object.entries(sessions.sessions).forEach(([key, value]) => { if (!value || Number(value.expiresAt) <= now) { delete sessions.sessions[key]; changed = true; } });
  if (changed) persistSessions();
}

function parseCookies(header) {
  const result = {};
  String(header || "").split(";").forEach(part => { const index = part.indexOf("="); if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); });
  return result;
}

function requestToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return parseCookies(req.headers.cookie).sid || "";
}

function getRequestUser(req) {
  purgeSessions();
  const session = sessions.sessions[hashToken(requestToken(req))];
  if (!session) return null;
  const user = users.users.find(item => item.id === session.userId);
  return user || null;
}

function isApiToken(req) { return Boolean(API_TOKEN && req.headers.authorization === `Bearer ${API_TOKEN}`); }

function isLearningSyncToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") && validLearningSyncToken(authorization.slice(7), API_TOKEN);
}

function isTeachingProfileWriteToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.startsWith("Bearer ") && validTeachingProfileWriteToken(authorization.slice(7), API_TOKEN);
}

function canManageContent(req, user) { return Boolean(isApiToken(req) || (user && user.role === "admin")); }

function isSecureRequest(req) { return process.env.COOKIE_SECURE === "true" || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https"; }

function sessionCookie(req, token, maxAge = SESSION_MAX_AGE) {
  const parts = [`sid=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(req) { return sessionCookie(req, "", 0); }

function getUserState(user) {
  let changed = false;
  if (!userStates.users[user.id]) {
    const canMigrate = user.role === "admin" && users.users.length === 1 && !isEmptyState(legacyState);
    userStates.users[user.id] = canMigrate ? markLearningEvidenceRepaired(legacyState) : defaultState();
    changed = true;
  } else if (userStates.users[user.id].repairSignature !== currentLearningEvidenceRepairSignature()
    || sanitizeWordUsage(userStates.users[user.id].wordUsage).migrationVersion < WORD_USAGE_MIGRATION_VERSION) {
    const migrated = migrateAccountState(userStates.users[user.id]);
    userStates.users[user.id] = migrated.state;
    changed = true;
  }
  const ensured = ensureReviewVariantPool(userStates.users[user.id].reviewVariantPool, {
    date: today(),
    syncKey: reviewVariantSyncKey(content),
    contentSignature: reviewVariantContentSignature(content),
    content,
    targetCount: REVIEW_VARIANT_POOL_TARGET
  });
  userStates.users[user.id].reviewVariantPool = ensured.pool;
  if (ensured.changed) changed = true;
  if (changed) persistUserStates();
  return userStates.users[user.id];
}

function setCommonHeaders(res, contentType = "application/json; charset=utf-8") {
  res.setHeader("Content-Type", contentType);
  if (CORS_ORIGIN === "*") res.setHeader("Access-Control-Allow-Origin", "*");
  else { res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN); res.setHeader("Access-Control-Allow-Credentials", "true"); }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-English-Review-Exam-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, status, value, extraHeaders = {}) { setCommonHeaders(res); Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value)); res.writeHead(status); res.end(JSON.stringify(value)); }
function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function readBody(req, maximum = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > maximum) { reject(Object.assign(new Error("request body too large"), { statusCode: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (_) { reject(Object.assign(new Error("request body must be valid JSON"), { statusCode: 400 })); } });
    req.on("error", reject);
  });
}

function authResponse(req, res, user, token, status = 200) { sendJson(res, status, { user: publicUser(user), accessToken: token }, { "Set-Cookie": sessionCookie(req, token) }); }

function handleAuth(req, res, url) {
  refreshUsers();
  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    const user = getRequestUser(req);
    return sendJson(res, 200, { authenticated: Boolean(user), user: user ? publicUser(user) : null });
  }
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const user = getRequestUser(req);
    return user ? sendJson(res, 200, { user: publicUser(user) }) : sendError(res, 401, "login required");
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    return readBody(req).then(body => {
      const { username, password } = validateCredentials(body);
      const user = users.users.find(item => item.usernameKey === normalizeUsername(username));
      if (!user || !validPassword(password, user.passwordSalt, user.passwordHash)) throw Object.assign(new Error("用户名或密码不正确"), { statusCode: 401 });
      const token = createSession(user.id);
      return authResponse(req, res, user, token);
    }).catch(error => sendError(res, error.statusCode || 400, error.message));
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = requestToken(req); delete sessions.sessions[hashToken(token)]; persistSessions();
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(req) });
  }
  return sendError(res, 404, "auth endpoint not found");
}

function slug(value) { return String(value || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "item"; }

function normalizeContentItem(body) {
  const kind = body.kind === "sentence" || body.type === "sentence" ? "sentence" : "word";
  const english = String(body.english || "").trim(); const sourceChinese = String(body.chinese || "").trim();
  if (!english || !sourceChinese) throw Object.assign(new Error("english and chinese are required"), { statusCode: 400 });
  const chinese = kind === "sentence" ? naturalizePlainDeepChinese(english, sourceChinese) : sourceChinese;
  const day = Number(body.day || content.currentDay || 1);
  if (!Number.isInteger(day) || day < 1) throw Object.assign(new Error("day must be a positive integer"), { statusCode: 400 });
  const preview = kind === "word" && body.preview === true;
  const base = { id: String(body.id || `api-d${day}-${kind}-${slug(english)}-${Date.now()}`).trim(), day, learned: preview ? String(body.learned || "").trim() : String(body.learned || today()), preview, english, chinese, directions: Array.isArray(body.directions) && body.directions.length ? body.directions : ["en-zh", "zh-en"] };
  if (kind === "word") return { ...base, phonetic: String(body.phonetic || "").trim(), acceptedChinese: Array.isArray(body.acceptedChinese) && body.acceptedChinese.length ? body.acceptedChinese : [chinese], pronunciation: String(body.pronunciation || "").trim(), example: String(body.example || "").trim(), exampleZh: String(body.exampleZh || "").trim() };
  const acceptedChinese = expandRegisteredChineseAnswers(content, english, [chinese, sourceChinese, ...(Array.isArray(body.acceptedChinese) ? body.acceptedChinese : [])], 16);
  return { ...base, acceptedChinese, acceptedEnglish: Array.isArray(body.acceptedEnglish) && body.acceptedEnglish.length ? body.acceptedEnglish : [english.toLowerCase().replace(/[.,!?;:]/g, "").trim()] };
}

function boundedContentText(value, maximum = 500) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function boundedContentStrings(value, maximumItems = 20, maximumLength = 500) {
  return (Array.isArray(value) ? value : []).map(item => boundedContentText(item, maximumLength)).filter(Boolean).slice(0, maximumItems);
}

function normalizeContentNote(body) {
  const source = body && typeof body === "object" ? body : {};
  const day = Number(source.day);
  if (!Number.isInteger(day) || day < 1) throw Object.assign(new Error("note day must be a positive integer"), { statusCode: 400 });
  const patterns = (Array.isArray(source.patterns) ? source.patterns : []).slice(0, 12).map(pattern => ({
    title: boundedContentText(pattern && pattern.title, 120),
    note: boundedContentText(pattern && pattern.note, 500),
    examples: (Array.isArray(pattern && pattern.examples) ? pattern.examples : []).slice(0, 8).map(example => ({
      english: boundedContentText(example && example.english, 300),
      chinese: boundedContentText(example && example.chinese, 300)
    })).filter(example => example.english && example.chinese)
  })).filter(pattern => pattern.title || pattern.note || pattern.examples.length);
  return {
    day,
    date: boundedContentText(source.date || today(), 20),
    score: boundedContentText(source.score, 80),
    summary: boundedContentText(source.summary, 1000),
    goals: boundedContentStrings(source.goals),
    pronunciation: boundedContentStrings(source.pronunciation, 30, 1000),
    patterns,
    mistakes: boundedContentStrings(source.mistakes, 30, 1000),
    review: boundedContentText(source.review, 1200)
  };
}

function syncCourseContent(body) {
  const source = body && typeof body === "object" ? body : {};
  const replacePreviewWords = Object.hasOwn(source, "previewWords");
  const formalWords = Array.isArray(source.words) ? source.words.map(item => ({ ...item, kind: "word", preview: false })) : [];
  const formalIds = new Set(formalWords.map(item => String(item.id || "")).filter(Boolean));
  const projectedCurrentDay = Math.max(
    Number(content.currentDay) || 0,
    Number(readSeedContent().currentDay) || 0,
    ...formalWords.map(item => Number(item.day) || 0),
    ...(Array.isArray(source.sentences) ? source.sentences.map(item => Number(item && item.day) || 0) : []),
    ...(Array.isArray(source.notes) ? source.notes.map(item => Number(item && item.day) || 0) : [])
  );
  const learnedEnglish = new Set([
    ...content.words.filter(item => !item.preview).map(item => String(item.english || "").toLocaleLowerCase()),
    ...formalWords.map(item => String(item.english || "").toLocaleLowerCase())
  ].filter(Boolean));
  const seenPreviewEnglish = new Set();
  const previewWords = Array.isArray(source.previewWords) ? source.previewWords.filter(item => {
    const id = String(item && item.id || "");
    const english = String(item && item.english || "").toLocaleLowerCase();
    if (!id || !english || formalIds.has(id) || learnedEnglish.has(english) || seenPreviewEnglish.has(english)) return false;
    if (Number(item && item.day) !== projectedCurrentDay + 1) return false;
    seenPreviewEnglish.add(english);
    return true;
  }).map(item => ({ ...item, kind: "word", preview: true, learned: "" })) : [];
  const incoming = [
    ...previewWords,
    ...formalWords,
    ...(Array.isArray(source.sentences) ? source.sentences.map(item => ({ ...item, kind: "sentence", preview: false })) : [])
  ];
  const normalized = incoming.map(normalizeContentItem);
  const notes = (Array.isArray(source.notes) ? source.notes : []).map(normalizeContentNote);
  if (!normalized.length && !notes.length && !replacePreviewWords) throw Object.assign(new Error("words, sentences, notes, or previewWords are required"), { statusCode: 400 });

  const incomingIds = new Set();
  normalized.forEach(item => {
    if (incomingIds.has(item.id)) throw Object.assign(new Error(`duplicate incoming id: ${item.id}`), { statusCode: 409 });
    incomingIds.add(item.id);
  });

  const noteDays = new Set();
  notes.forEach(note => {
    if (noteDays.has(note.day)) throw Object.assign(new Error(`duplicate incoming note day: ${note.day}`), { statusCode: 409 });
    noteDays.add(note.day);
  });
  normalized.forEach(item => {
    const found = findContentItem(item.id);
    if (found && (found.item.phonetic !== undefined) !== (item.phonetic !== undefined)) {
      throw Object.assign(new Error(`content kind cannot change: ${item.id}`), { statusCode: 409 });
    }
  });

  if (replacePreviewWords) {
    const retainedPreviewIds = new Set([...previewWords.map(item => item.id), ...formalIds]);
    content.words = content.words.filter(item => !item.preview || retainedPreviewIds.has(item.id));
  }

  let added = 0;
  let updated = 0;
  normalized.forEach(item => {
    const found = findContentItem(item.id);
    if (item.preview && found && (!found.item.preview || Number(item.day) <= Number(content.currentDay || 0))) return;
    const target = item.phonetic !== undefined ? content.words : content.sentences;
    if (!found) {
      target.push(item);
      added += 1;
    } else {
      found.collection[found.index] = item;
      updated += 1;
    }
    content.deletedIds = (content.deletedIds || []).filter(id => id !== item.id);
  });

  let notesAdded = 0;
  let notesUpdated = 0;
  notes.forEach(note => {
    const index = content.notes.findIndex(item => Number(item.day) === note.day);
    if (index < 0) {
      content.notes.push(note);
      notesAdded += 1;
    } else {
      content.notes[index] = note;
      notesUpdated += 1;
    }
  });
  content.notes.sort((left, right) => Number(left.day) - Number(right.day));
  content.updatedAt = [content.updatedAt, boundedContentText(source.updatedAt, 40) || today()].map(String).filter(Boolean).sort().at(-1);
  recalculateCurrentDay(content, readSeedContent().currentDay);
  content.words = content.words.filter(item => !item.preview || Number(item.day) === Number(content.currentDay) + 1);
  persistContent();
  return { added, updated, previewWords: content.words.filter(item => item.preview).length, notesAdded, notesUpdated, currentDay: content.currentDay, words: content.words.length, sentences: content.sentences.length, notes: content.notes.length, updatedAt: content.updatedAt };
}

function addContentItem(body) {
  const item = normalizeContentItem(body); const collection = item.phonetic !== undefined ? content.words : content.sentences;
  if ([...content.words, ...content.sentences].some(existing => existing.id === item.id)) throw Object.assign(new Error("id already exists"), { statusCode: 409 });
  collection.push(item); content.deletedIds = (content.deletedIds || []).filter(id => id !== item.id); content.currentDay = Math.max(content.currentDay, item.day); content.updatedAt = today(); return item;
}

function findContentItem(id) { for (const collection of [content.words, content.sentences]) { const index = collection.findIndex(item => item.id === id); if (index >= 0) return { collection, index, item: collection[index] }; } return null; }

function handleContent(req, res, url, user) {
  refreshContent();
  const match = url.pathname.match(/^\/api\/content\/([^/]+)$/);
  if (req.method === "GET" && url.pathname === "/api/content") {
    const type = url.searchParams.get("type"); const day = url.searchParams.get("day"); const filter = list => list.filter(item => !day || String(item.day) === day);
    return sendJson(res, 200, { ...content, words: type === "sentence" ? [] : filter(content.words), sentences: type === "word" ? [] : filter(content.sentences) });
  }
  if (match && req.method === "GET") { const found = findContentItem(decodeURIComponent(match[1])); return found ? sendJson(res, 200, found.item) : sendError(res, 404, "content item not found"); }
  const teachingSync = req.method === "PUT" && url.pathname === "/api/content/batch" && isTeachingProfileWriteToken(req);
  if (!canManageContent(req, user) && !teachingSync && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return sendError(res, user ? 403 : 401, user ? "admin role required" : "login required");
  if (req.method === "POST" && url.pathname === "/api/content") return readBody(req).then(body => { const item = addContentItem(body); persistContent(); sendJson(res, 201, item); }).catch(error => sendError(res, error.statusCode || 400, error.message));
  if (req.method === "POST" && url.pathname === "/api/content/batch") return readBody(req).then(body => {
    const incoming = Array.isArray(body.items) ? body.items : [...(Array.isArray(body.words) ? body.words.map(item => ({ ...item, kind: "word" })) : []), ...(Array.isArray(body.sentences) ? body.sentences.map(item => ({ ...item, kind: "sentence" })) : [])];
    if (!incoming.length) throw Object.assign(new Error("items, words, or sentences are required"), { statusCode: 400 });
    const normalized = incoming.map(normalizeContentItem); const existingIds = new Set([...content.words, ...content.sentences].map(item => item.id)); const incomingIds = new Set();
    normalized.forEach(item => { if (existingIds.has(item.id) || incomingIds.has(item.id)) throw Object.assign(new Error(`id already exists: ${item.id}`), { statusCode: 409 }); incomingIds.add(item.id); });
    const added = normalized.map(item => addContentItem({ ...item, kind: item.phonetic !== undefined ? "word" : "sentence" })); persistContent(); sendJson(res, 201, { added, currentDay: content.currentDay, updatedAt: content.updatedAt });
  }).catch(error => sendError(res, error.statusCode || 400, error.message));
  if (req.method === "PUT" && url.pathname === "/api/content/batch") return readBody(req).then(body => {
    const previousSyncKey = reviewVariantSyncKey(content);
    const result = syncCourseContent(body);
    const currentSyncKey = reviewVariantSyncKey(content);
    const reviewSentencePool = prepareReviewVariantPoolsAfterCourseSync(previousSyncKey !== currentSyncKey);
    sendJson(res, 200, { ...result, reviewSentencePool });
  }).catch(error => sendError(res, error.statusCode || 400, error.message));
  if (match && (req.method === "PATCH" || req.method === "DELETE")) {
    const found = findContentItem(decodeURIComponent(match[1])); if (!found) return sendError(res, 404, "content item not found");
    if (req.method === "DELETE") { found.collection.splice(found.index, 1); content.deletedIds = Array.from(new Set([...(content.deletedIds || []), found.item.id])); recalculateCurrentDay(content, readSeedContent().currentDay); content.updatedAt = today(); persistContent(); return sendJson(res, 200, { deleted: true, id: found.item.id }); }
    return readBody(req).then(body => { const merged = normalizeContentItem({ ...found.item, ...body, id: found.item.id, kind: found.item.phonetic !== undefined ? "word" : "sentence" }); found.collection[found.index] = merged; content.currentDay = Math.max(content.currentDay, merged.day); content.updatedAt = today(); persistContent(); sendJson(res, 200, merged); }).catch(error => sendError(res, error.statusCode || 400, error.message));
  }
  return sendError(res, 404, "content endpoint not found");
}

function jsonValuesEqual(left, right) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeClientWritableState(existingValue, bodyValue) {
  const existing = existingValue && typeof existingValue === "object" ? existingValue : defaultState();
  const body = bodyValue && typeof bodyValue === "object" ? bodyValue : {};
  const next = { ...existing };
  let changed = false;
  let evidenceChanged = false;
  const replace = (key, value, evidence = false) => {
    if (jsonValuesEqual(existing[key], value)) return;
    next[key] = value;
    changed = true;
    if (evidence) evidenceChanged = true;
  };

  if (Object.hasOwn(body, "taskStates")) replace("taskStates", body.taskStates && typeof body.taskStates === "object" ? body.taskStates : {}, true);
  if (Object.hasOwn(body, "history")) replace("history", body.history && typeof body.history === "object" ? body.history : {}, true);
  if (Object.hasOwn(body, "attempts")) replace("attempts", Array.isArray(body.attempts) ? body.attempts.slice(-120) : [], true);
  if (Object.hasOwn(body, "sessions")) replace("sessions", mergeReviewSessionStates(existing.sessions, body.sessions));
  if (Object.hasOwn(body, "mistakes")) replace("mistakes", Array.isArray(body.mistakes) ? body.mistakes.slice(-80) : [], true);
  if (Object.hasOwn(body, "studyTime")) replace("studyTime", mergeStudyTime(body.studyTime, existing.studyTime));
  if (Object.hasOwn(body, "previewPractice")) replace("previewPractice", sanitizePreviewPractice(body.previewPractice, content));
  if (Object.hasOwn(body, "previewPracticeHistory")) replace("previewPracticeHistory", sanitizePreviewPracticeHistory(body.previewPracticeHistory, content));

  if (evidenceChanged) {
    const repaired = repairReviewEvidence(content, next);
    if (repaired.changed || repaired.state !== next) {
      Object.assign(next, repaired.state);
      changed = true;
    }
  }
  markLearningEvidenceRepaired(next);
  return { state: next, changed };
}

function handleStudyTimeState(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "PUT") return sendError(res, 404, "study time endpoint not found");
  return readBody(req).then(body => withFormalPracticeLock(user.id, async () => {
    const existing = getUserState(user);
    const studyTime = mergeStudyTime(body && body.studyTime, existing.studyTime);
    if (!jsonValuesEqual(studyTime, existing.studyTime)) {
      userStates.users[user.id] = { ...existing, studyTime };
      persistUserStates();
    }
    sendJson(res, 200, { ok: true, studyTime });
  }, "state:study-time")).catch(error => sendError(res, error.statusCode || 400, error.message));
}

function handleState(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method === "GET") return sendJson(res, 200, publicReviewState(getUserState(user)));
  if (req.method === "PUT") return readBody(req).then(body => withFormalPracticeLock(user.id, async () => {
    const existing = getUserState(user);
    const merged = mergeClientWritableState(existing, body);
    userStates.users[user.id] = merged.state;
    if (merged.changed) persistUserStates();
    sendJson(res, 200, publicReviewState(userStates.users[user.id]));
  })).catch(error => sendError(res, error.statusCode || 400, error.message));
  return sendError(res, 404, "state endpoint not found");
}

function handleLearningSync(req, res, url) {
  if (req.method !== "GET") return sendError(res, 404, "learning sync endpoint not found");
  if (!isLearningSyncToken(req)) return sendError(res, 401, "valid learning sync token required");
  const username = String(url.searchParams.get("username") || "").trim();
  if (!username) return sendError(res, 400, "username is required");
  refreshUsers();
  refreshContent();
  const target = users.users.find(item => item.usernameKey === normalizeUsername(username));
  if (!target) return sendError(res, 404, "user not found");
  return sendJson(res, 200, buildLearningSyncProfile(content, getUserState(target), target));
}

function handleTeachingProfileSync(req, res, url) {
  if (req.method !== "PUT") return sendError(res, 404, "teaching profile endpoint not found");
  if (!isTeachingProfileWriteToken(req)) return sendError(res, 401, "valid teaching profile write token required");
  const username = String(url.searchParams.get("username") || "").trim();
  if (!username) return sendError(res, 400, "username is required");
  refreshUsers();
  const target = users.users.find(item => item.usernameKey === normalizeUsername(username));
  if (!target) return sendError(res, 404, "user not found");
  return readBody(req).then(body => {
    const state = getUserState(target);
    state.teachingProfile = sanitizeTeachingProfile({ ...body, updatedAt: body.updatedAt || new Date().toISOString() });
    persistUserStates();
    sendJson(res, 200, { ok: true, teachingProfile: publicTeachingProfile(state.teachingProfile) });
  }).catch(error => sendError(res, error.statusCode || 400, error.message));
}

function withSelfStudyLock(userId, operation) {
  const previous = selfStudyLocksByUserId.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  selfStudyLocksByUserId.set(userId, current);
  return current.finally(() => {
    if (selfStudyLocksByUserId.get(userId) === current) selfStudyLocksByUserId.delete(userId);
  });
}

function withFormalPracticeLock(userId, operation, operationName = "formal-practice") {
  const queuedAt = Date.now();
  const safeOperationName = String(operationName || "formal-practice").replace(/[^a-z0-9:/_-]/gi, "").slice(0, 80) || "formal-practice";
  const previous = formalPracticeLocksByUserId.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const waitMs = Date.now() - queuedAt;
    if (waitMs >= FORMAL_PRACTICE_LOCK_WARN_MS) {
      console.warn(`[formal-practice-lock] ${JSON.stringify({ phase: "wait", operation: safeOperationName, elapsedMs: waitMs })}`);
    }
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= FORMAL_PRACTICE_LOCK_WARN_MS) {
        console.warn(`[formal-practice-lock] ${JSON.stringify({ phase: "operation", operation: safeOperationName, elapsedMs })}`);
      }
    }
  });
  formalPracticeLocksByUserId.set(userId, current);
  return current.finally(() => {
    if (formalPracticeLocksByUserId.get(userId) === current) formalPracticeLocksByUserId.delete(userId);
  });
}

function selfStudyLearnedWords() {
  return content.words
    .filter(item => !item.preview && item.learned && String(item.learned) <= today())
    .flatMap(item => previewEnglishTokens(item.english));
}

function handleSelfStudyLessonSync(req, res, url) {
  if (req.method !== "PUT") return sendError(res, 404, "self-study lesson sync endpoint not found");
  if (!isTeachingProfileWriteToken(req)) return sendError(res, 401, "valid teaching profile write token required");
  const username = String(url.searchParams.get("username") || "").trim();
  if (!username) return sendError(res, 400, "username is required");
  refreshUsers();
  refreshContent();
  const target = users.users.find(item => item.usernameKey === normalizeUsername(username));
  if (!target) return sendError(res, 404, "user not found");
  return readBody(req).then(body => withSelfStudyLock(target.id, async () => {
    const state = getUserState(target);
    const merged = mergeSelfStudyLessons(state.selfStudy, body, { learnedWords: selfStudyLearnedWords() });
    state.selfStudy = merged.state;
    userStates.users[target.id] = sanitizeState(state);
    persistUserStates();
    sendJson(res, 200, { ok: true, ...merged.result, enabled: state.selfStudy.enabled });
  })).catch(error => sendError(res, error.statusCode || 400, error.message));
}

function nextStudyDate(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? new Date(`${value}T12:00:00Z`) : new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function promoteSelfStudyContent(targetContent, targetState, progress, completedAt) {
  const lesson = progress.snapshot;
  const learnedAt = completedAt.toISOString();
  const learnedDate = lesson.formalDate || today();
  const firstReviewDue = nextStudyDate(learnedDate);
  const promotedIds = [];
  const idMap = new Map();

  lesson.plannedContent.words.forEach(planned => {
    const englishKey = String(planned.english || "").toLocaleLowerCase();
    const existingById = targetContent.words.find(item => item.id === planned.id);
    const existingFormal = targetContent.words.find(item => !item.preview && String(item.english || "").toLocaleLowerCase() === englishKey);
    const existing = existingById || existingFormal || null;
    const actualId = existing && !existing.preview ? existing.id : planned.id;
    targetContent.words = targetContent.words.filter(item => {
      if (!item.preview) return true;
      return item.id !== planned.id && String(item.english || "").toLocaleLowerCase() !== englishKey;
    });
    const formal = {
      ...planned,
      id: actualId,
      status: "learned",
      preview: false,
      learned: existing && !existing.preview && existing.learned ? existing.learned : learnedDate,
      learnedAt: existing && !existing.preview && existing.learnedAt ? existing.learnedAt : learnedAt,
      sourceLessonId: existing && !existing.preview && existing.sourceLessonId ? existing.sourceLessonId : lesson.lessonId,
      firstReviewDue: existing && !existing.preview && existing.firstReviewDue ? existing.firstReviewDue : firstReviewDue
    };
    const index = targetContent.words.findIndex(item => item.id === actualId);
    if (index >= 0) targetContent.words[index] = { ...targetContent.words[index], ...formal };
    else targetContent.words.push(formal);
    promotedIds.push(actualId);
    idMap.set(planned.id, actualId);
  });

  lesson.plannedContent.sentences.forEach(planned => {
    const englishKey = normalizeVariantEnglish(planned.english);
    const existingById = targetContent.sentences.find(item => item.id === planned.id);
    const existingFormal = targetContent.sentences.find(item => !item.preview && normalizeVariantEnglish(item.english) === englishKey);
    const existing = existingById || existingFormal || null;
    const actualId = existing ? existing.id : planned.id;
    const formal = {
      ...planned,
      id: actualId,
      status: "learned",
      preview: false,
      learned: existing && existing.learned ? existing.learned : learnedDate,
      learnedAt: existing && existing.learnedAt ? existing.learnedAt : learnedAt,
      sourceLessonId: existing && existing.sourceLessonId ? existing.sourceLessonId : lesson.lessonId,
      firstReviewDue: existing && existing.firstReviewDue ? existing.firstReviewDue : firstReviewDue
    };
    const index = targetContent.sentences.findIndex(item => item.id === actualId);
    if (index >= 0) targetContent.sentences[index] = { ...targetContent.sentences[index], ...formal };
    else targetContent.sentences.push(formal);
    promotedIds.push(actualId);
    idMap.set(planned.id, actualId);
  });
  normalizeStoredContentSentences(targetContent);

  const note = { ...lesson.plannedContent.note, day: lesson.studyDay, date: lesson.plannedContent.note.date || learnedDate, sourceLessonId: lesson.lessonId, learnedAt };
  const noteIndex = targetContent.notes.findIndex(item => Number(item.day) === Number(note.day));
  if (noteIndex >= 0) targetContent.notes[noteIndex] = { ...targetContent.notes[noteIndex], ...note };
  else targetContent.notes.push(note);
  targetContent.notes.sort((left, right) => Number(left.day) - Number(right.day));
  targetContent.deletedIds = (targetContent.deletedIds || []).filter(id => !promotedIds.includes(id));
  targetContent.updatedAt = learnedDate;
  recalculateCurrentDay(targetContent, readSeedContent().currentDay);

  [...lesson.plannedContent.words, ...lesson.plannedContent.sentences].forEach(planned => {
    const actualId = idMap.get(planned.id) || planned.id;
    const directions = Array.isArray(planned.directions) && planned.directions.length ? planned.directions : ["en-zh"];
    directions.forEach(direction => {
      const taskId = `${actualId}:${direction}`;
      const previous = targetState.taskStates[taskId] && typeof targetState.taskStates[taskId] === "object" ? targetState.taskStates[taskId] : {};
      targetState.taskStates[taskId] = {
        level: Number(previous.level) || 0,
        lastResult: typeof previous.lastResult === "boolean" ? previous.lastResult : null,
        reviewCount: Number(previous.reviewCount) || 0,
        lastReviewed: String(previous.lastReviewed || ""),
        nextDue: String(previous.nextDue || firstReviewDue)
      };
    });
  });
  return { learnedAt, firstReviewDue, contentIds: Array.from(new Set(promotedIds)) };
}

function completeSelfStudyLesson(user, accountState, selfStudyState, lessonId, completedAt = new Date()) {
  const nextContent = deepClone(content);
  const nextAccountState = sanitizeState({ ...accountState, selfStudy: selfStudyState });
  const progress = nextAccountState.selfStudy.progress[lessonId];
  if (!progress) throw Object.assign(new Error("self-study progress not found"), { statusCode: 404 });
  if (progress.status === "completed") return { accountState: nextAccountState, promotion: progress.promotion, duplicate: true };
  const promotion = promoteSelfStudyContent(nextContent, nextAccountState, progress, completedAt);
  nextAccountState.selfStudy = markLessonCompleted(nextAccountState.selfStudy, lessonId, promotion, completedAt);
  const repairedState = repairLearningEvidence(nextContent, sanitizeState(nextAccountState)).state;
  const nextUserStates = deepClone(userStates);
  nextUserStates.users[user.id] = repairedState;
  persistSelfStudyTransaction(nextContent, nextUserStates);
  content = nextContent;
  userStates = nextUserStates;
  return { accountState: repairedState, promotion, duplicate: false };
}

function selfStudyAiGrade(accountState, user, context) {
  const local = localStepGrade(context.step, context.answer);
  if (local.correct && local.gradingStatus === "correct") return Promise.resolve(local);
  if (!aiConfigured()) return Promise.reject(Object.assign(new Error("AI grading is not configured"), { statusCode: 503 }));
  const rate = takeAiRequest(user.id);
  if (!rate.allowed) return Promise.reject(Object.assign(new Error("AI grading rate limit reached"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds }));
  const selection = aiSelectionForState(accountState, {});
  const direction = context.step.direction || (context.step.type === "zh-en" ? "zh-en" : "en-zh");
  const sourceText = direction === "zh-en" ? (context.step.chinese || context.step.prompt) : (context.step.english || context.step.prompt || context.step.passage);
  return runAiRoute(selection.route, config => createAiGrader(config).grade({ answer: context.answer, acceptedAnswers: context.step.acceptedAnswers, direction, sourceText })).then(routed => ({
    ...completeTranslationGrade(direction, context.step.english || context.step.referenceAnswer, context.answer, routed.value, context.step.referenceAnswer),
    source: "ai",
    providerName: routed.config.providerName,
    model: selection.route.model,
    reasoningEffort: selection.route.reasoningEffort
  }));
}

function appendSelfStudyWordUsage(accountState, selfStudyState, body, submission) {
  const progress = selfStudyState && selfStudyState.progress && selfStudyState.progress[String(body && body.lessonId || "")];
  if (!progress || !progress.snapshot) return { added: [], reused: true };
  const step = progress.snapshot.stages.flatMap(stage => stage.steps).find(item => item.stepId === String(body && body.stepId || ""));
  const stepState = step && progress.steps && progress.steps[step.stepId];
  if (!step || !stepState || !["completed", "needs-correction"].includes(stepState.status)) return { added: [], reused: true };
  const attemptId = String(body && body.attemptId || "").trim();
  if (!attemptId) return { added: [], reused: true };
  const attempt = stepState.attempts && stepState.attempts.find(item => item.attemptId === attemptId);
  if (attempt && attempt.status !== "graded") return { added: [], reused: true };
  const plannedWords = progress.snapshot.plannedContent && Array.isArray(progress.snapshot.plannedContent.words) ? progress.snapshot.plannedContent.words : [];
  const plannedSentences = progress.snapshot.plannedContent && Array.isArray(progress.snapshot.plannedContent.sentences) ? progress.snapshot.plannedContent.sentences : [];
  const usageContent = { ...content, words: [...content.words, ...plannedWords], sentences: [...content.sentences, ...plannedSentences] };
  const globalWord = content.words.find(item => item.id === step.contentId && item.preview !== true && item.learned && String(item.learned) <= today());
  const directRecall = Boolean(globalWord && step.contentId && step.type !== "reading-question");
  const assistance = attempt && attempt.assistance || stepState.assistance || "";
  const result = attempt
    ? (directRecall ? wordUsageResult(attempt, assistance) : assistance === "revealed" ? "revealed" : assistance === "assisted" ? "assisted" : attempt.correct === true ? "completed" : "wrong")
    : "completed";
  const events = buildWordUsageEvents({
    eventId: `self-study:${attemptId}`,
    source: "self-study",
    taskId: `${progress.lessonId}:${step.stepId}`,
    wordIds: directRecall ? [globalWord.id] : (step.contentId && plannedWords.some(item => item.id === step.contentId) ? [step.contentId] : []),
    english: directRecall ? "" : [step.english, step.prompt, step.passage, step.content].filter(Boolean).join(" "),
    kind: directRecall ? "recall" : "exposure",
    result,
    formalEvidence: directRecall,
    date: studyDateForTimestamp(attempt && (attempt.gradedAt || attempt.submittedAt) || new Date().toISOString()),
    occurredAt: attempt && (attempt.gradedAt || attempt.submittedAt) || new Date().toISOString()
  }, usageContent, { timeZone: APP_TIMEZONE });
  const appended = appendWordUsageEvents(accountState.wordUsage, events, usageContent);
  accountState.wordUsage = appended.state;
  return appended;
}

function selfStudyTutorInput(accountState, context, message) {
  const stepState = context.progress.steps[context.step.stepId] || { attempts: [], questions: [], status: "unattempted" };
  const allowedWords = Array.from(new Set([
    ...selfStudyLearnedWords(),
    ...previewEnglishTokens(context.step.prompt),
    ...previewEnglishTokens(context.step.passage),
    ...previewEnglishTokens(context.step.english),
    ...previewEnglishTokens(message)
  ]));
  const currentWordMeanings = context.lesson.plannedContent.words.filter(word => allowedWords.includes(String(word.english || "").toLocaleLowerCase()));
  const wordMeanings = Object.fromEntries([
    ...content.words.filter(item => !item.preview).map(item => [String(item.english || "").toLocaleLowerCase(), Array.from(new Set([item.chinese, ...(item.acceptedChinese || [])])).filter(Boolean)]),
    ...currentWordMeanings.map(item => [String(item.english || "").toLocaleLowerCase(), Array.from(new Set([item.chinese, ...(item.acceptedChinese || [])])).filter(Boolean)])
  ]);
  const history = (stepState.questions || []).filter(item => item.status === "answered" && item.answer).slice(-6).flatMap(item => [
    { role: "user", content: item.question },
    { role: "assistant", content: item.answer }
  ]);
  return {
    exercise: {
      direction: context.step.direction,
      prompt: context.step.prompt || context.step.content,
      english: context.step.english || context.step.passage,
      chinese: context.step.chinese,
      correctAnswer: context.step.referenceAnswer,
      answered: stepState.status === "completed"
    },
    history,
    message,
    allowedWords,
    wordMeanings
  };
}

async function answerSelfStudyQuestion(accountState, user, context, message) {
  if (!aiConfigured()) throw Object.assign(new Error("AI is not configured"), { statusCode: 503 });
  const rate = takeAiRequest(user.id);
  if (!rate.allowed) throw Object.assign(new Error("AI rate limit reached"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds });
  const practice = sanitizeAiPractice(accountState.aiPractice);
  const availableModels = getAvailableModels(aiSettings);
  const route = selectAiCandidates(aiSettings, {
    providerId: practice.tutorSettings.providerId,
    model: availableModels.includes(practice.tutorSettings.model) ? practice.tutorSettings.model : aiSettings.defaultModel,
    reasoningEffort: practice.tutorSettings.reasoningEffort
  });
  const routed = await runAiRoute(route, config => createAiTutor(config).answer(selfStudyTutorInput(accountState, context, message)));
  const stepState = context.progress.steps[context.step.stepId] || {};
  const answer = stepState.status !== "completed" && referenceLeaked(routed.value, context.step)
    ? "我先不给出完整答案：请只检查当前题目的主语、关键词和位置关系，再自己试一次。你也可以只问其中一个词。"
    : routed.value;
  return { answer, providerName: routed.config.providerName, model: route.model, reasoningEffort: route.reasoningEffort };
}

async function handleSelfStudy(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method === "GET" && url.pathname === "/api/self-study") {
    return sendJson(res, 200, publicSelfStudyState(getUserState(user).selfStudy));
  }
  return withSelfStudyLock(user.id, async () => {
    let accountState = deepClone(getUserState(user));
    let selfStudy = sanitizeSelfStudyState(accountState.selfStudy);
    try {
      if (url.pathname === "/api/self-study/mode" && req.method === "POST") {
        const body = await readBody(req);
        if (body.enabled === true && !selfStudy.lessons.length && !Object.keys(selfStudy.progress).length) return sendError(res, 409, "no self-study lessons are available");
        selfStudy.enabled = body.enabled === true;
        selfStudy.updatedAt = new Date().toISOString();
      } else if (url.pathname === "/api/self-study/start" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        const body = await readBody(req);
        const requestedLessonId = String(body.lessonId || "").trim().slice(0, 120);
        if (requestedLessonId && selfStudy.progress[requestedLessonId]) {
          return sendJson(res, 200, { ...publicSelfStudyState(selfStudy), duplicate: true });
        }
        const started = startSelfStudyLesson(selfStudy);
        const active = Object.values(started.progress).find(progress => ["in-progress", "paused", "ready"].includes(progress.status));
        if (requestedLessonId && (!active || active.lessonId !== requestedLessonId)) return sendError(res, 409, "requested self-study lesson is not currently available");
        selfStudy = started;
      } else if (url.pathname === "/api/self-study/draft" && (req.method === "PUT" || req.method === "PATCH")) {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        selfStudy = saveSelfStudyDraft(selfStudy, await readBody(req));
      } else if (url.pathname === "/api/self-study/pause" && req.method === "POST") {
        selfStudy = pauseSelfStudy(selfStudy, await readBody(req));
      } else if (url.pathname === "/api/self-study/resume" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        selfStudy = resumeSelfStudy(selfStudy, await readBody(req));
      } else if (url.pathname === "/api/self-study/hint" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        const hinted = requestSelfStudyHint(selfStudy, await readBody(req));
        selfStudy = hinted.state;
        accountState.selfStudy = selfStudy;
        userStates.users[user.id] = sanitizeState(accountState);
        persistUserStates();
        return sendJson(res, 200, { ...publicSelfStudyState(selfStudy), duplicate: hinted.duplicate, hintLevel: hinted.level });
      } else if (url.pathname === "/api/self-study/submit" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        const body = await readBody(req);
        const submission = await submitSelfStudyStep(selfStudy, body, {
          async onPending(pendingState) {
            selfStudy = pendingState;
            accountState.selfStudy = selfStudy;
            userStates.users[user.id] = sanitizeState(accountState);
            persistUserStates();
          },
          grade: context => selfStudyAiGrade(accountState, user, context)
        });
        selfStudy = submission.state;
        accountState.selfStudy = selfStudy;
        appendSelfStudyWordUsage(accountState, selfStudy, body, submission);
        if (submission.completionReady) {
          const completion = completeSelfStudyLesson(user, accountState, selfStudy, body.lessonId);
          prepareReviewVariantPoolsAfterCourseSync(true);
          return sendJson(res, 200, { ...publicSelfStudyState(completion.accountState.selfStudy), duplicate: submission.duplicate, promoted: completion.promotion });
        }
        userStates.users[user.id] = sanitizeState(accountState);
        persistUserStates();
        return sendJson(res, 200, { ...publicSelfStudyState(selfStudy), duplicate: submission.duplicate });
      } else if (url.pathname === "/api/self-study/continue" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        const body = await readBody(req);
        const continued = continueSelfStudyStep(selfStudy, body);
        selfStudy = continued.state;
        accountState.selfStudy = selfStudy;
        if (continued.completionReady) {
          const completion = completeSelfStudyLesson(user, accountState, selfStudy, body.lessonId);
          prepareReviewVariantPoolsAfterCourseSync(true);
          return sendJson(res, 200, { ...publicSelfStudyState(completion.accountState.selfStudy), duplicate: continued.duplicate, promoted: completion.promotion });
        }
        userStates.users[user.id] = sanitizeState(accountState);
        persistUserStates();
        return sendJson(res, 200, { ...publicSelfStudyState(selfStudy), duplicate: continued.duplicate });
      } else if (url.pathname === "/api/self-study/question" && req.method === "POST") {
        if (!selfStudy.enabled) return sendError(res, 409, "self-study mode is disabled");
        const body = await readBody(req);
        const added = addTutorQuestion(selfStudy, body);
        selfStudy = added.state;
        accountState.selfStudy = selfStudy;
        userStates.users[user.id] = sanitizeState(accountState);
        persistUserStates();
        if (added.question.status === "answered") return sendJson(res, 200, publicSelfStudyState(selfStudy));
        const answerData = await answerSelfStudyQuestion(accountState, user, added.context, added.question.question);
        selfStudy = resolveTutorQuestion(selfStudy, { ...body, questionId: added.question.id }, answerData);
      } else {
        return sendError(res, 404, "self-study endpoint not found");
      }
      accountState.selfStudy = selfStudy;
      userStates.users[user.id] = sanitizeState(accountState);
      persistUserStates();
      return sendJson(res, 200, publicSelfStudyState(selfStudy));
    } catch (error) {
      if (error && error.selfStudyState) {
        selfStudy = error.selfStudyState;
        accountState.selfStudy = selfStudy;
        userStates.users[user.id] = sanitizeState(accountState);
        persistUserStates();
      }
      const statusCode = error && [400, 401, 404, 409, 413, 429].includes(error.statusCode) ? error.statusCode : 503;
      const message = statusCode === 503
        ? (error && error.pendingAttempt ? "AI 判题暂时不可用，答案已保存，请稍后重试" : "AI 问答暂时不可用，问题已保存，请稍后重试")
        : error.message;
      return sendJson(res, statusCode, { error: message, selfStudy: publicSelfStudyState(selfStudy), retryAfterSeconds: Number(error && error.retryAfterSeconds) || undefined });
    }
  });
}

function handlePreview(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "preview endpoint not found");
  refreshContent();
  const state = getUserState(user);
  const profile = publicTeachingProfile(state.teachingProfile);
  const previewData = accountPreviewData(user, state);
  const accountDocument = previewData.sourceLessonId ? selfStudyPreviewDocument(previewData) : null;
  const documents = new Map((profile.previews || []).map(document => [document.name, document]));
  if (profile.preview) documents.set(profile.preview.name, profile.preview);
  if (accountDocument) documents.set(accountDocument.name, accountDocument);
  const previews = Array.from(documents.values()).slice(-30);
  return sendJson(res, 200, {
    updatedAt: [profile.updatedAt, previewData.updatedAt].filter(Boolean).sort().at(-1) || "",
    preview: accountDocument || profile.preview,
    previews
  });
}

function selfStudyPreviewDocument(previewData) {
  const wordLines = previewData.words.map(item => `- ${item.english}：${item.chinese}${item.phonetic ? `（${item.phonetic}）` : ""}`);
  const sentenceLines = previewData.sentences.map(item => `- ${item.english}：${item.chinese}`);
  const note = previewData.note && typeof previewData.note === "object" ? previewData.note : {};
  const sections = [
    `第 ${previewData.nextDay} 天出门自学预习${previewData.formalDate ? `（${previewData.formalDate} 开始）` : ""}`,
    note.summary ? `\n学习重点\n${note.summary}` : "",
    wordLines.length ? `\n预习单词\n${wordLines.join("\n")}` : "",
    sentenceLines.length ? `\n预习句子\n${sentenceLines.join("\n")}` : "",
    previewData.nextPreview ? `\n下一步\n${previewData.nextPreview}` : ""
  ].filter(Boolean);
  return { name: `第 ${previewData.nextDay} 天出门自学预习`, content: sections.join("\n").trim() };
}

function accountPreviewData(user, stateValue = null) {
  const state = stateValue || getUserState(user);
  const selfStudy = selfStudyPreviewContent(state.selfStudy);
  const selectedNextDay = selfStudy ? selfStudy.nextDay : (Number(content.currentDay) || 1) + 1;
  const currentDay = selfStudy ? selfStudy.currentDay : Number(content.currentDay) || 1;
  const formallyLearnedIds = new Set([
    ...content.words.filter(item => item.preview !== true).map(item => String(item.id || "")),
    ...content.sentences.filter(item => item.preview !== true).map(item => String(item.id || ""))
  ]);
  const learnedEnglish = new Set(content.words.filter(item => item.preview !== true).map(item => String(item.english || "").toLocaleLowerCase()).filter(Boolean));
  const globalWords = content.words.filter(item => item.preview === true
    && Number(item.day) === selectedNextDay
    && !String(item.learned || "").trim()
    && !learnedEnglish.has(String(item.english || "").toLocaleLowerCase()));
  const plannedWords = selfStudy ? selfStudy.words.filter(item => !formallyLearnedIds.has(item.id) && !learnedEnglish.has(String(item.english || "").toLocaleLowerCase())) : [];
  const wordsByEnglish = new Map();
  [...globalWords, ...plannedWords].forEach(item => {
    const key = String(item.english || "").trim().toLocaleLowerCase();
    if (!key) return;
    const existing = wordsByEnglish.get(key);
    wordsByEnglish.set(key, {
      ...(existing || {}),
      ...item,
      day: selectedNextDay,
      status: "planned",
      learned: "",
      preview: true,
      formalEvidence: false,
      acceptedChinese: Array.from(new Set([...(existing?.acceptedChinese || []), ...(item.acceptedChinese || []), item.chinese].map(value => String(value || "").trim()).filter(Boolean))).slice(0, 20)
    });
  });
  const globalSentences = content.sentences.filter(item => item.preview === true && Number(item.day) === selectedNextDay && !String(item.learned || "").trim());
  const plannedSentences = selfStudy ? selfStudy.sentences.filter(item => !formallyLearnedIds.has(item.id)) : [];
  const sentencesById = new Map();
  [...globalSentences, ...plannedSentences].forEach(item => {
    const key = String(item.id || "").trim() || normalizePreviewEnglish(item.english);
    if (!key || sentencesById.has(key)) return;
    sentencesById.set(key, { ...item, day: selectedNextDay, status: "planned", learned: "", preview: true, formalEvidence: false });
  });
  return {
    currentDay,
    nextDay: selectedNextDay,
    formalDate: selfStudy?.formalDate || "",
    enabledFrom: selfStudy?.enabledFrom || "",
    expiresAt: selfStudy?.expiresAt || "",
    updatedAt: selfStudy?.updatedAt || content.updatedAt,
    sourceLessonId: selfStudy?.lessonId || "",
    sourceLessonVersion: selfStudy?.lessonVersion || "",
    title: selfStudy?.title || "",
    words: Array.from(wordsByEnglish.values()),
    sentences: Array.from(sentencesById.values()),
    note: selfStudy?.note || null,
    nextPreview: selfStudy?.nextPreview || ""
  };
}

function previewContentForAccount(previewData) {
  return {
    ...content,
    words: [...content.words, ...previewData.words],
    sentences: [...content.sentences, ...previewData.sentences]
  };
}

function offlinePreviewPracticeSentences(state, previewData) {
  const accountContent = previewContentForAccount(previewData);
  const learnedWords = buildLearningProfile(content, state, today()).allowedWords;
  const allowedWords = Array.from(new Set([...learnedWords, ...previewData.words.flatMap(item => previewEnglishTokens(item.english))]));
  const storedTasks = sanitizePreviewPractice(state.previewPractice, accountContent).tasks.filter(task => task.kind === "sentence");
  return previewData.words.map(target => {
    const stored = storedTasks.find(task => task.wordId === target.id && Array.isArray(task.requiredPreviewWordIds) && task.requiredPreviewWordIds.includes(target.id));
    if (stored) return { ...stored, formalEvidence: false, source: "saved-preview" };
    const targetTokens = previewEnglishTokens(target.english);
    const planned = previewData.sentences.find(sentence => targetTokens.every(token => previewEnglishTokens(sentence.english).includes(token)));
    return planned ? sanitizePreviewSentence(accountContent, target, { ...planned, source: "self-study", sourceContentId: planned.id }, allowedWords) : null;
  }).filter(Boolean);
}

const OFFLINE_AI_RECOVERY_VERSION = "v1";

function offlineAiRecoveryKey(user) {
  const secret = String(user && user.passwordHash || API_TOKEN || "");
  if (!user || !user.id || !secret) throw Object.assign(new Error("当前账号无法签发离线题组恢复凭据"), { statusCode: 409 });
  return crypto.createHash("sha256").update(`daily-english-review:offline-ai-recovery:${OFFLINE_AI_RECOVERY_VERSION}\0${user.id}\0${secret}`).digest();
}

function sealOfflineAiRecoveryReceipt(user, value) {
  const set = sanitizeQuestionSet(value);
  if (!set) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", offlineAiRecoveryKey(user), iv);
  cipher.setAAD(Buffer.from(`${user.id}:${OFFLINE_AI_RECOVERY_VERSION}`, "utf8"));
  const payload = Buffer.from(JSON.stringify({ version: 1, accountId: user.id, set }), "utf8");
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    setId: set.id,
    receipt: [OFFLINE_AI_RECOVERY_VERSION, iv.toString("base64url"), encrypted.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".")
  };
}

function openOfflineAiRecoveryReceipt(user, receipt, expectedSetId) {
  const parts = String(receipt || "").split(".");
  if (parts.length !== 4 || parts[0] !== OFFLINE_AI_RECOVERY_VERSION) throw Object.assign(new Error("离线题组恢复凭据无效，请重新准备离线包"), { statusCode: 422 });
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", offlineAiRecoveryKey(user), Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(`${user.id}:${OFFLINE_AI_RECOVERY_VERSION}`, "utf8"));
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8"));
    const set = sanitizeQuestionSet(payload && payload.set);
    if (Number(payload && payload.version) !== 1 || String(payload && payload.accountId || "") !== String(user.id) || !set || set.id !== expectedSetId) throw new Error("receipt mismatch");
    return set;
  } catch (_) {
    throw Object.assign(new Error("离线题组恢复凭据无效或不属于当前账号，请重新准备离线包"), { statusCode: 422 });
  }
}

function offlineAiRecoveryReceipts(user, value) {
  const practice = sanitizeAiPractice(value);
  return [practice.currentSet, ...practice.queuedSets].map(set => sealOfflineAiRecoveryReceipt(user, set)).filter(Boolean).slice(0, 21);
}

function buildOfflinePack(user) {
  refreshContent();
  const state = getUserState(user);
  const previewData = accountPreviewData(user, state);
  const generatedAt = new Date();
  const previewDocument = previewData.sourceLessonId ? selfStudyPreviewDocument(previewData) : null;
  const pack = {
    schemaVersion: OFFLINE_PACK_SCHEMA_VERSION,
    packId: `offline-${user.id}-${generatedAt.getTime()}`,
    account: { id: user.id, username: user.username },
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + OFFLINE_PACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    revision: [content.updatedAt, state.selfStudy && state.selfStudy.updatedAt, state.aiPractice && state.aiPractice.updatedAt].filter(Boolean).join(":"),
    limits: { courseDays: OFFLINE_PACK_DAYS, aiGroups: 20, maxBytes: OFFLINE_PACK_MAX_BYTES },
    content: { currentDay: content.currentDay, updatedAt: content.updatedAt },
    wordLibrary: content.words.filter(item => item.preview !== true && item.learned && String(item.learned) <= today()).map(item => ({
      id: item.id,
      day: item.day,
      english: item.english,
      chinese: item.chinese,
      acceptedChinese: Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [],
      phonetic: item.phonetic,
      pronunciation: item.pronunciation,
      directions: Array.isArray(item.directions) ? item.directions : ["en-zh", "zh-en"],
      learned: item.learned
    })),
    wordUsage: publicWordUsage(state.wordUsage, content, { date: today(), timeZone: APP_TIMEZONE, capacity: 10 }),
    selfStudy: offlineSelfStudyPackage(state.selfStudy, { limit: OFFLINE_PACK_DAYS, nonce: `${user.id}:${generatedAt.getTime()}:${crypto.randomBytes(12).toString("hex")}`, now: generatedAt }),
    selfStudyPublic: publicSelfStudyState(state.selfStudy),
    preview: {
      currentDay: previewData.currentDay,
      nextDay: previewData.nextDay,
      formalDate: previewData.formalDate,
      enabledFrom: previewData.enabledFrom,
      expiresAt: previewData.expiresAt,
      updatedAt: previewData.updatedAt,
      sourceLessonId: previewData.sourceLessonId,
      formalEvidence: false,
      document: previewDocument,
      words: previewData.words.map(item => ({ ...item, formalEvidence: false })),
      sentences: previewData.sentences.map(item => ({ ...item, formalEvidence: false })),
      practiceSentences: offlinePreviewPracticeSentences(state, previewData),
      practice: sanitizePreviewPractice(state.previewPractice, previewContentForAccount(previewData))
    },
    aiPractice: {
      ...offlineAiPractice(state.aiPractice),
      recoveryReceipts: offlineAiRecoveryReceipts(user, state.aiPractice)
    },
    outbox: { mode: "client-fifo", formalEvidencePending: true }
  };
  let bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  if (bytes > OFFLINE_PACK_MAX_BYTES) {
    pack.aiPractice.preparedSets = pack.aiPractice.preparedSets.slice(0, 5);
    pack.selfStudy.lessons = pack.selfStudy.lessons.slice(0, 7);
    bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  }
  if (bytes > OFFLINE_PACK_MAX_BYTES) throw Object.assign(new Error("离线包超过容量上限，请减少预装课程后重试"), { statusCode: 413 });
  pack.byteSize = bytes;
  return pack;
}

function handleOfflinePack(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "offline pack endpoint not found");
  try {
    return sendJson(res, 200, buildOfflinePack(user));
  } catch (error) {
    return sendError(res, error.statusCode || 500, error.message);
  }
}

function handlePreviewWords(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "preview words endpoint not found");
  refreshContent();
  const previewData = accountPreviewData(user);
  return sendJson(res, 200, {
    currentDay: previewData.currentDay,
    nextDay: previewData.nextDay,
    formalDate: previewData.formalDate,
    enabledFrom: previewData.enabledFrom,
    expiresAt: previewData.expiresAt,
    updatedAt: previewData.updatedAt,
    sourceLessonId: previewData.sourceLessonId,
    formalEvidence: false,
    words: previewData.words
  });
}

function previewEnglishTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

function normalizePreviewEnglish(value) {
  return String(value || "").toLocaleLowerCase().replace(/[.,!?;:]/g, "").replace(/\s+/g, " ").trim();
}

function previewSentenceId(wordId, english) {
  let hash = 2166136261;
  for (const character of normalizePreviewEnglish(english)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `preview-sentence-${String(wordId || "word").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80)}-${(hash >>> 0).toString(36)}`;
}

function sanitizePreviewSentence(contentValue, target, value, allowedWords) {
  const source = value && typeof value === "object" ? value : {};
  const school = normalizePreviewSchoolSentence({ english: source.english, chinese: source.chinese }, { rewriteChinese: true });
  const english = school.english;
  const chinese = naturalizePlainDeepChinese(english, school.chinese);
  if (!english || !chinese) return null;
  const tokens = previewEnglishTokens(english);
  const targetTokens = previewEnglishTokens(target.english);
  const allowed = new Set(allowedWords);
  if (!tokens.length || tokens.some(token => !allowed.has(token)) || !targetTokens.every(token => tokens.includes(token))) return null;
  const acceptedChinese = expandPreviewAcceptedChinese(contentValue, english, [school.chinese, String(source.chinese || "").trim(), ...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : [])], chinese, 16);
  return {
    id: previewSentenceId(target.id, english),
    kind: "sentence",
    wordId: target.id,
    requiredPreviewWordIds: [target.id],
    english,
    chinese,
    acceptedEnglish: school.acceptedEnglish,
    acceptedChinese,
    source: source.source === "self-study" ? "self-study" : "ai",
    sourceContentId: String(source.sourceContentId || source.id || "").trim().slice(0, 120),
    formalEvidence: false
  };
}

async function handlePreviewPracticeSentences(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "preview practice endpoint not found");
  const unavailable = (message = "AI 预习句子暂不可用，将每 5 分钟自动重试") => sendJson(res, 503, { error: message, retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
  try {
    refreshContent();
    const previewData = accountPreviewData(user);
    const { currentDay, nextDay, words: previewWords } = previewData;
    if (!previewWords.length) return sendJson(res, 200, { currentDay, nextDay, sentences: [], source: "none" });
    const body = await readBody(req);
    const requestedIds = Array.from(new Set((Array.isArray(body.wordIds) ? body.wordIds : []).map(value => String(value || "").trim()).filter(Boolean))).slice(0, 20);
    const targets = (requestedIds.length ? requestedIds.map(id => previewWords.find(item => item.id === id)).filter(Boolean) : previewWords).slice(0, 20);
    if (!targets.length) return sendError(res, 400, "preview word targets are required");
    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const profile = buildLearningProfile(content, state, today());
    const learnedWords = [...profile.allowedWords];
    const previewWordTokens = previewWords.map(item => ({ wordId: item.id, english: item.english }));
    const allowedWords = Array.from(new Set([...learnedWords, ...previewWords.flatMap(item => previewEnglishTokens(item.english))]));
    const accountContent = previewContentForAccount(previewData);
    const plannedByWord = new Map();
    targets.forEach(target => {
      const targetTokens = previewEnglishTokens(target.english);
      const planned = previewData.sentences.find(sentence => targetTokens.every(token => previewEnglishTokens(sentence.english).includes(token)));
      const sanitized = planned ? sanitizePreviewSentence(accountContent, target, { ...planned, source: "self-study", sourceContentId: planned.id }, allowedWords) : null;
      if (sanitized) plannedByWord.set(target.id, sanitized);
    });
    const missingTargets = targets.filter(target => !plannedByWord.has(target.id));
    let generated = null;
    let route = null;
    if (missingTargets.length) {
      if (!aiConfigured()) return unavailable("AI 尚未配置，预习句子将每 5 分钟自动重试");
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return unavailable("AI 请求受限，预习句子将每 5 分钟自动重试");
      const availableModels = getAvailableModels(aiSettings);
      const requestedModel = [body.model, practice.settings.model, aiSettings.defaultModel].map(value => String(value || "").trim()).find(value => availableModels.includes(value)) || aiSettings.defaultModel;
      const requestedEffort = AI_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : practice.settings.reasoningEffort;
      route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: requestedEffort });
      generated = await runAiRoute(route, config => createAiPreviewSentenceGenerator(config).generate({
        allowedWords,
        learnedWords,
        previewWords: previewWordTokens,
        targets: missingTargets.map(item => ({ wordId: item.id, english: item.english, chinese: item.chinese }))
      }));
    }
    const targetById = new Map(targets.map(item => [item.id, item]));
    const generatedSentences = (generated?.value || []).map(item => {
      const target = targetById.get(item.wordId);
      return target ? sanitizePreviewSentence(accountContent, target, item, allowedWords) : null;
    }).filter(Boolean);
    const generatedByWord = new Map(generatedSentences.map(item => [item.wordId, item]));
    const sentences = targets.map(target => plannedByWord.get(target.id) || generatedByWord.get(target.id)).filter(Boolean);
    if (sentences.length !== targets.length || new Set(sentences.map(item => item.wordId)).size !== targets.length) throw new Error("AI 返回的预习句子不完整或重复");
    const generatedAt = new Date().toISOString();
    const source = missingTargets.length ? (plannedByWord.size ? "mixed" : "ai") : "self-study";
    return sendJson(res, 200, {
      currentDay,
      nextDay,
      sentences: sentences.map(item => ({
        ...item,
        generatedAt,
        providerId: item.source === "ai" ? generated?.config.providerId || "" : "",
        providerName: item.source === "ai" ? generated?.config.providerName || "" : "",
        model: item.source === "ai" ? generated?.config.model || "" : "",
        reasoningEffort: item.source === "ai" ? route?.reasoningEffort || "" : "",
        formalEvidence: false
      })),
      source,
      provider: generated ? { id: generated.config.providerId, name: generated.config.providerName } : null,
      model: generated?.config.model || "",
      reasoningEffort: route?.reasoningEffort || "",
      formalEvidence: false
    });
  } catch (error) {
    console.warn(`AI preview sentence generation failed; retry will be scheduled: ${error && error.message ? error.message : "unknown error"}`);
    const failure = publicAiSentenceVariantFailure(error);
    return sendJson(res, failure.statusCode, {
      error: failure.message,
      retryAfterMs: AI_SENTENCE_RETRY_MS,
      reasonCode: failure.reasonCode,
      providerStatus: failure.providerStatus
    }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
  }
}

function previewWordsForPracticeGrade(user) {
  return accountPreviewData(user);
}

function previewPracticeGradeTask(rawTask, previewData) {
  const source = rawTask && typeof rawTask === "object" ? rawTask : {};
  const direction = source.direction === "zh-en" ? "zh-en" : source.direction === "en-zh" ? "en-zh" : "";
  const kind = source.kind === "word" ? "word" : source.kind === "sentence" ? "sentence" : "";
  const wordId = String(source.wordId || "").trim();
  const target = previewData.words.find(item => item.id === wordId);
  if (!direction || !kind || !wordId || !target) return null;
  if (kind === "word") {
    return {
      id: String(source.id || `preview-word-${wordId}-${direction}`).trim().slice(0, 160),
      kind,
      direction,
      wordId,
      english: target.english,
      chinese: target.chinese,
      acceptedEnglish: [target.english],
      acceptedChinese: Array.from(new Set([target.chinese, ...(Array.isArray(target.acceptedChinese) ? target.acceptedChinese : [])])).slice(0, 8)
    };
  }

  const school = normalizePreviewSchoolSentence({ english: source.english, chinese: source.chinese });
  const english = school.english;
  const chinese = naturalizePlainDeepChinese(english, school.chinese);
  const requiredIds = Array.from(new Set((Array.isArray(source.requiredPreviewWordIds) ? source.requiredPreviewWordIds : []).map(value => String(value || "").trim()).filter(Boolean)));
  if (!english || !chinese || !requiredIds.includes(wordId)) return null;
  const learnedWords = content.words
    .filter(item => !item.preview && item.learned && String(item.learned) <= today())
    .flatMap(item => previewEnglishTokens(item.english));
  const allowedWords = new Set([...learnedWords, ...previewData.words.flatMap(item => previewEnglishTokens(item.english))]);
  const tokens = previewEnglishTokens(english);
  const targetTokens = previewEnglishTokens(target.english);
  if (!tokens.length || tokens.some(token => !allowedWords.has(token)) || !targetTokens.every(token => tokens.includes(token))) return null;
  return {
    id: String(source.id || `preview-sentence-${wordId}`).trim().slice(0, 160),
    kind,
    direction,
    wordId,
    requiredPreviewWordIds: [wordId],
    english,
    chinese,
    acceptedEnglish: school.acceptedEnglish,
    acceptedChinese: expandPreviewAcceptedChinese(previewContentForAccount(previewData), english, [school.chinese, ...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : [])], chinese, 16),
    schoolMeaningAmbiguous: school.ambiguousSchool
  };
}

async function handlePreviewPracticeGrade(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "preview practice grade endpoint not found");
  const unavailable = (message = "AI 预习判题暂不可用，答案已保存，请稍后重试") => sendJson(res, 503, { error: message, retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
  try {
    refreshContent();
    const previewData = previewWordsForPracticeGrade(user);
    const body = await readBody(req);
    const task = previewPracticeGradeTask(body.task, previewData);
    if (!task) return sendError(res, 400, "预习题目已失效或不属于当前下一天预习内容");
    const answer = String(body.answer || "").trim();
    if (!answer) return sendError(res, 400, "answer is required");
    if (answer.length > MAX_AI_ANSWER_LENGTH) return sendError(res, 400, "answer is too long");
    const acceptedAnswers = task.direction === "zh-en" ? task.acceptedEnglish : task.acceptedChinese;
    const localGrade = localTranslationGrade(task.direction, task.english, answer, acceptedAnswers);
    if (localGrade) {
      const acceptedAmbiguousSchoolMeaning = task.direction === "zh-en"
        && task.schoolMeaningAmbiguous
        && !englishAnswerMatches(answer, [task.english])
        && englishAnswerMatches(answer, task.acceptedEnglish);
      const explanation = acceptedAmbiguousSchoolMeaning
        ? "中文“在学校”可能表示“在上学”，也可能表示“在一所学校里面”；两种合理英文均已接受。"
        : localGrade.explanation;
      const completedGrade = {
        ...localGrade,
        explanation,
        referenceAnswer: task.direction === "zh-en" ? task.english : task.chinese,
        detailedExplanation: acceptedAmbiguousSchoolMeaning
          ? "in school 表示“在上学/在校”；in a school 表示“在一所学校里面”。原中文题干没有区分这两个意思，因此本次预习答案判为正确，而且不会计入正式错题或能力分。"
          : localGrade.detailedExplanation || buildTranslationExplanation({
          direction: task.direction,
          referenceAnswer: task.direction === "zh-en" ? task.english : task.chinese,
          answer,
          correct: localGrade.correct,
          gradingStatus: localGrade.gradingStatus,
          explanation
        })
      };
      await recordPreviewPracticeWordUsage(user, task, body.eventId, completedGrade);
      return sendJson(res, 200, completedGrade);
    }
    if (!aiConfigured()) return unavailable("AI 尚未配置，答案已保存；配置完成后可重试判题");
    const rate = takeAiRequest(user.id);
    if (!rate.allowed) return sendJson(res, 429, { error: "AI 请求过于频繁，答案已保存，请稍后重试", retryAfterMs: rate.retryAfterSeconds * 1000 }, { "Retry-After": String(rate.retryAfterSeconds) });
    const state = getUserState(user);
    const selection = aiSelectionForState(state, body);
    persistUserStates();
    const sourceText = task.direction === "zh-en" ? task.chinese : task.english;
    const routed = await runAiRoute(selection.route, config => createAiGrader(config).grade({ answer, acceptedAnswers, direction: task.direction, sourceText }));
    const referenceAnswer = task.direction === "zh-en" ? task.english : task.chinese;
    const completedGrade = {
      ...completeTranslationGrade(task.direction, task.english, answer, routed.value, referenceAnswer),
      referenceAnswer,
      source: "ai"
    };
    await recordPreviewPracticeWordUsage(user, task, body.eventId, completedGrade);
    return sendJson(res, 200, completedGrade);
  } catch (error) {
    if (error && [400, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI preview practice grading failed; answer will remain saved: ${error && error.message ? error.message : "unknown error"}`);
    return unavailable("AI 预习判题暂不可用，答案已保存，请稍后重试");
  }
}

async function recordPreviewPracticeWordUsage(user, task, eventId, result) {
  const stableId = String(eventId || "").trim().slice(0, 180);
  if (!stableId) return { reused: true, added: 0 };
  return withFormalPracticeLock(user.id, async () => {
    const state = getUserState(user);
    const events = buildWordUsageEvents({
      eventId: stableId,
      source: "preview",
      taskId: task.id,
      wordIds: task.kind === "word" ? [task.wordId] : [],
      english: task.kind === "sentence" ? task.english : "",
      kind: "exposure",
      result: result && result.correct === true && result.gradingStatus === "correct" ? "completed" : "wrong",
      formalEvidence: false,
      date: today(),
      occurredAt: new Date().toISOString()
    }, previewContentForAccount(accountPreviewData(user, state)), { timeZone: APP_TIMEZONE });
    const appended = appendWordUsageEvents(state.wordUsage, events, content);
    state.wordUsage = appended.state;
    if (appended.added.length) {
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
    }
    return { reused: appended.reused, added: appended.added.length };
  }, "preview-word-usage");
}

function handleAbilities(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "ability endpoint not found");
  refreshContent();
  return sendJson(res, 200, analyzeAbilities(content, getUserState(user)));
}

function validStudyDate(value) {
  const date = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return "";
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() === Number(match[2]) - 1
    && parsed.getUTCDate() === Number(match[3]) ? date : "";
}

function handleReviewSentenceStats(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "sentence statistics endpoint not found");
  const state = getUserState(user);
  const pool = sanitizeReviewVariantPool(state.reviewVariantPool);
  const requestedFrom = String(url.searchParams.get("from") || "").trim();
  const requestedTo = String(url.searchParams.get("to") || "").trim();
  const from = validStudyDate(requestedFrom);
  const to = validStudyDate(requestedTo);
  if (requestedFrom && !from) return sendError(res, 400, "开始日期格式不正确");
  if (requestedTo && !to) return sendError(res, 400, "结束日期格式不正确");
  if (from && to && from > to) return sendError(res, 400, "开始日期不能晚于结束日期");
  const sort = ["index", "attempts", "correct", "wrong", "accuracy", "recent"].includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "index";
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const entries = new Map(pool.variants.map((variant, index) => [variant.id, {
    id: variant.id,
    index: index + 1,
    attempts: 0,
    correct: 0,
    wrong: 0,
    accuracy: null,
    lastPracticedAt: ""
  }]));
  const includeDate = date => (!from || date >= from) && (!to || date <= to);
  const add = (id, date, practicedAt, correct) => {
    const entry = entries.get(String(id || ""));
    if (!entry || !includeDate(String(date || ""))) return;
    entry.attempts += 1;
    if (correct) entry.correct += 1;
    else entry.wrong += 1;
    if (String(practicedAt || "") > entry.lastPracticedAt) entry.lastPracticedAt = String(practicedAt || "");
  };
  const events = new Map(sanitizeSentencePracticeEvents(state.sentencePracticeEvents).map(event => [event.id, event]));
  (Array.isArray(state.attempts) ? state.attempts : []).forEach(attempt => {
    if (attempt && attempt.formalEvidence === false) return;
    const event = sanitizeSentencePracticeEvent({
      id: attempt && attempt.id,
      variantId: attempt && attempt.variantId,
      date: attempt && attempt.date,
      practicedAt: attempt && (attempt.submittedAt || attempt.date),
      correct: attempt && attempt.correct === true && attempt.gradingStatus !== "partial" && Number(attempt.score) >= 1,
      source: "review"
    });
    if (event && !events.has(event.id)) events.set(event.id, event);
  });
  sanitizeAiPractice(state.aiPractice).history.forEach(item => {
    if (item.formalEvidence === false) return;
    const event = sanitizeSentencePracticeEvent({
      id: item.id,
      variantId: item.poolVariantId,
      date: item.date,
      practicedAt: item.answeredAt || item.date,
      correct: item.correct === true && item.gradingStatus !== "partial" && Number(item.score) >= 1,
      source: "ai"
    });
    if (event && !events.has(event.id)) events.set(event.id, event);
  });
  events.forEach(event => add(event.variantId, event.date, event.practicedAt, event.correct));
  const rows = Array.from(entries.values()).map(entry => ({
    ...entry,
    accuracy: entry.attempts ? Math.round(entry.correct / entry.attempts * 100) : null
  }));
  const numeric = entry => sort === "recent" ? 0 : (sort === "index" ? entry.index : (sort === "accuracy" ? (entry.accuracy === null ? -1 : entry.accuracy) : Number(entry[sort]) || 0));
  rows.sort((left, right) => {
    let compared = sort === "recent"
      ? left.lastPracticedAt.localeCompare(right.lastPracticedAt)
      : numeric(left) - numeric(right);
    if (order === "desc") compared *= -1;
    return compared || left.index - right.index;
  });
  return sendJson(res, 200, {
    syncKey: pool.syncKey,
    from,
    to,
    sort,
    order,
    generatedAt: new Date().toISOString(),
    stats: rows
  });
}

function handleWordUsage(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "word usage endpoint not found");
  refreshContent();
  const requestedFrom = String(url.searchParams.get("from") || "").trim();
  const requestedTo = String(url.searchParams.get("to") || "").trim();
  const from = validWordUsageDate(requestedFrom);
  const to = validWordUsageDate(requestedTo);
  if (requestedFrom && !from) return sendError(res, 400, "开始日期格式不正确");
  if (requestedTo && !to) return sendError(res, 400, "结束日期格式不正确");
  if (from && to && from > to) return sendError(res, 400, "开始日期不能晚于结束日期");
  const sort = ["index", "usage", "correct", "wrong", "accuracy", "recent", "due"].includes(url.searchParams.get("sort"))
    ? url.searchParams.get("sort")
    : "index";
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const state = getUserState(user);
  return sendJson(res, 200, wordUsageRows(state.wordUsage, content, {
    date: today(),
    from,
    to,
    sort,
    order,
    timeZone: APP_TIMEZONE,
    capacity: 10
  }));
}

function findSentenceTask(taskId, variantId = "", suppliedVariant = null) {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const direction = value.slice(separator + 1);
  if (!["en-zh", "zh-en"].includes(direction)) return null;
  const baseItem = content.sentences.find(sentence => sentence.id === id);
  if (!baseItem) return null;
  if (!variantId) return { item: baseItem, baseItem, direction, taskId: value, variant: null };
  const localVariant = sentenceVariantById(content, baseItem, variantId);
  const generatedVariant = !localVariant && suppliedVariant && String(suppliedVariant.id || "") === String(variantId)
    ? sanitizeGeneratedSentenceVariant(content, baseItem, suppliedVariant)
    : null;
  const variant = localVariant || generatedVariant;
  if (!variant) return null;
  return { item: { ...baseItem, ...variant }, baseItem, direction, taskId: value, variant };
}

function findStoredPoolSentenceTask(user, taskId, variantId = "") {
  if (!user) return null;
  const base = findSentenceTask(taskId);
  if (!base) return null;
  const state = getUserState(user);
  const pool = state.reviewVariantPool;
  const assignedId = String(pool && pool.assignments && pool.assignments[base.taskId] || "");
  const requestedId = String(variantId || "").trim();
  // A pool variant is accepted only when the server has assigned that exact
  // ID to this task. The browser cannot inject arbitrary sentence text.
  if (!assignedId || (requestedId && requestedId !== assignedId)) return null;
  const storedVariant = Array.isArray(pool.variants) ? pool.variants.find(item => item.id === assignedId) : null;
  if (!storedVariant) return null;
  const chinese = prioritizeRegisteredChineseMeanings(content, storedVariant.english, storedVariant.chinese);
  const acceptedChinese = expandRegisteredChineseAnswers(content, storedVariant.english, [
    chinese,
    ...storedVariant.acceptedChinese.map(answer => prioritizeRegisteredChineseMeanings(content, storedVariant.english, answer))
  ].filter(answer => answer && !registeredChineseMeaningConflicts(content, storedVariant.english, answer).length), 16);
  const variant = { ...storedVariant, chinese, acceptedChinese };
  return { ...base, item: { ...base.baseItem, ...variant }, variant };
}

function reviewTutorQuestionId(taskId, variantId = "") {
  const value = `${String(taskId || "")}\u0000${String(variantId || "base")}`;
  let first = 2166136261;
  let second = 2246822519;
  for (const character of value) {
    const code = character.codePointAt(0);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + 374761393), 3266489917);
  }
  return `review-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function findReviewTutorTask(user, taskId, variantId = "") {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const direction = value.slice(separator + 1);
  if (!["en-zh", "zh-en"].includes(direction)) return null;
  const baseItem = [...content.words, ...content.sentences].find(item => item.id === id);
  if (!baseItem || baseItem.preview === true || Number(baseItem.day) > Number(content.currentDay) || !baseItem.learned || String(baseItem.learned) > today()) return null;
  const directions = Array.isArray(baseItem.directions) && baseItem.directions.length ? baseItem.directions : ["en-zh"];
  if (!directions.includes(direction)) return null;
  const requestedVariantId = String(variantId || "").trim();
  if (!requestedVariantId) return { item: baseItem, baseItem, direction, taskId: value, variant: null };
  if (!content.sentences.some(item => item.id === id)) return null;
  return findStoredPoolSentenceTask(user, value, requestedVariantId);
}

function latestReviewAttempt(state, taskId, variantId = "") {
  const requestedVariantId = String(variantId || "");
  return [...(Array.isArray(state && state.attempts) ? state.attempts : [])].reverse().find(item => String(item && item.taskId || "") === String(taskId || "") && String(item && item.variantId || "") === requestedVariantId) || null;
}

function localSentenceAnswerMatches(task, answer) {
  if (task.direction === "zh-en") return englishAnswerMatches(answer, task.item.acceptedEnglish || [task.item.english]);
  return chineseAnswerMatches(answer, task.item.acceptedChinese || [task.item.chinese], task.item.english);
}

function recentReviewVariants(state) {
  return (Array.isArray(state.attempts) ? state.attempts : []).slice(-60).map(attempt => ({
    taskId: String(attempt && attempt.taskId || ""),
    id: String(attempt && attempt.variantId || ""),
    english: String(attempt && attempt.reviewVariant && attempt.reviewVariant.english || "")
  })).filter(item => item.taskId && (item.id || item.english));
}

const REVIEW_VARIANT_FAILURE_MESSAGES = Object.freeze({
  "invalid-json": "返回格式不是有效 JSON",
  "missing-task": "缺少这道题的结果",
  "invalid-object": "结果不是句子对象",
  "missing-english": "缺少英文句子",
  "missing-chinese": "缺少中文翻译",
  "unsupported-source-family": "原句句型暂不受支持",
  "wrong-family": "改变了原句句型",
  "no-english-words": "没有可识别的英文单词",
  "unlearned-word": "含有未学单词",
  "unlearned-word-sense": "使用了尚未学习的词义",
  "source-duplicate": "与原句完全相同",
  "fixed-sentence-duplicate": "与词句库固定句重复",
  "recent-variant-duplicate": "与近期变式重复",
  "batch-duplicate": "与本批已合格句子重复"
});

function reviewVariantFailure(task, reasonCode, details = {}) {
  return {
    taskId: task.taskId,
    reasonCode,
    message: REVIEW_VARIANT_FAILURE_MESSAGES[reasonCode] || "未通过句子校验",
    rejectedEnglish: String(details.english || "").slice(0, 180),
    unlearnedWords: Array.isArray(details.unlearnedWords) ? details.unlearnedWords.slice(0, 20) : []
  };
}

function validateReviewVariantCandidate(task, raw, context) {
  if (!raw) return { failure: reviewVariantFailure(task, "missing-task") };
  const validation = validateGeneratedSentenceVariant(content, task.baseItem, raw);
  if (!validation.valid) return { failure: reviewVariantFailure(task, validation.reasonCode, validation) };
  const normalized = validation.normalizedEnglish;
  const sourceEnglish = normalizeVariantEnglish(task.baseItem.english);
  if (normalized === sourceEnglish) return { failure: reviewVariantFailure(task, "source-duplicate", validation) };
  if (context.fixedEnglish.has(normalized)) return { failure: reviewVariantFailure(task, "fixed-sentence-duplicate", validation) };
  if (context.recentEnglish.has(normalized)) return { failure: reviewVariantFailure(task, "recent-variant-duplicate", validation) };
  if (context.selectedEnglish.has(normalized)) return { failure: reviewVariantFailure(task, "batch-duplicate", validation) };
  context.selectedEnglish.add(normalized);
  return { variant: validation.variant };
}

function logReviewVariantFailure(failure, round) {
  const words = failure.unlearnedWords.length ? ` unlearned=${failure.unlearnedWords.join(",")}` : "";
  const english = failure.rejectedEnglish ? ` english=${JSON.stringify(failure.rejectedEnglish)}` : "";
  console.warn(`AI review variant rejected: round=${round} taskId=${failure.taskId} reason=${failure.reasonCode}${words}${english}`);
}

function reviewVariantOutputError(error) {
  if (Number(error && error.providerStatus)) return false;
  return /invalid review variant JSON|did not return review variants|Unexpected (end|token)|JSON/i.test(String(error && error.message || ""));
}

function repairFeedback(failures) {
  return failures.map(item => ({
    taskId: item.taskId,
    reasonCode: item.reasonCode,
    problem: item.message,
    rejectedEnglish: item.rejectedEnglish,
    unlearnedWords: item.unlearnedWords
  }));
}

async function generateReviewVariantsWithRepairs(route, input) {
  const deadlineMs = Date.now() + REVIEW_VARIANT_UPSTREAM_TIMEOUT_MS;
  const accepted = new Map();
  const taskById = new Map(input.tasks.map(task => [task.taskId, task]));
  const fixedEnglish = new Set(input.fixedEnglish.map(normalizeVariantEnglish).filter(Boolean));
  const recentEnglish = new Set(input.recentEnglish.map(normalizeVariantEnglish).filter(Boolean));
  let pending = [...input.tasks];
  let validationFeedback = [];
  let failures = [];
  let lastConfig = route.candidates[0] || {};
  let repairRounds = 0;

  for (let round = 1; round <= REVIEW_VARIANT_MAX_REPAIR_ROUNDS && pending.length; round += 1) {
    repairRounds = round;
    if (deadlineMs - Date.now() <= 0) {
      throw Object.assign(new Error("AI review variant generation timed out"), { code: "REVIEW_VARIANT_TIMEOUT" });
    }
    let routed;
    try {
      routed = await runAiRoute(route, config => createAiReviewVariantGenerator(config).generate({
        allowedWords: input.allowedWords,
        grammarFamilies: input.grammarFamilies,
        targets: pending.map(task => ({ taskId: task.taskId, grammarFamily: sentenceFamily(task.baseItem), sourceEnglish: task.baseItem.english, sourceChinese: task.baseItem.chinese })),
        excludedEnglish: Array.from(new Set([...input.excludedEnglish, ...Array.from(accepted.values()).map(item => item.english)])),
        weakItems: input.weakItems,
        validationFeedback,
        timeoutMs: Math.max(1, deadlineMs - Date.now())
      }));
    } catch (error) {
      if (!reviewVariantOutputError(error)) throw error;
      failures = pending.map(task => reviewVariantFailure(task, "invalid-json"));
      failures.forEach(failure => logReviewVariantFailure(failure, round));
      validationFeedback = repairFeedback(failures);
      continue;
    }

    lastConfig = routed.config;
    const rawByTask = new Map(routed.value.map(item => [item.taskId, item]));
    const selectedEnglish = new Set(Array.from(accepted.values()).map(item => normalizeVariantEnglish(item.english)));
    const context = { fixedEnglish, recentEnglish, selectedEnglish };
    failures = [];

    pending.forEach(task => {
      const checked = validateReviewVariantCandidate(task, rawByTask.get(task.taskId), context);
      if (checked.failure) {
        failures.push(checked.failure);
        logReviewVariantFailure(checked.failure, round);
        return;
      }
      const generatedAt = new Date().toISOString();
      accepted.set(task.taskId, {
        ...checked.variant,
        taskId: task.taskId,
        source: "ai",
        providerId: routed.config.providerId,
        providerName: routed.config.providerName,
        model: routed.config.model,
        reasoningEffort: route.reasoningEffort,
        generatedAt
      });
    });

    pending = failures.map(failure => taskById.get(failure.taskId)).filter(Boolean);
    validationFeedback = repairFeedback(failures);
  }

  const variants = input.tasks.map(task => accepted.get(task.taskId)).filter(Boolean);
  const remainingFailures = failures.filter(failure => !accepted.has(failure.taskId));
  const message = remainingFailures.length
    ? `已有 ${variants.length} 条句子生成成功；${remainingFailures.length} 条连续 ${REVIEW_VARIANT_MAX_REPAIR_ROUNDS} 轮未通过校验，已停止自动重试。请点“立即重试”或更换模型。`
    : "";
  return {
    status: remainingFailures.length ? "needs-attention" : "completed",
    variants,
    failures: remainingFailures.map(({ rejectedEnglish, unlearnedWords, ...failure }) => ({ ...failure, unlearnedWords })),
    message,
    source: "ai",
    provider: { id: lastConfig.providerId || "", name: lastConfig.providerName || "" },
    model: lastConfig.model || route.model,
    reasoningEffort: route.reasoningEffort,
    repairRounds,
    maxRepairRounds: REVIEW_VARIANT_MAX_REPAIR_ROUNDS,
    autoRetry: false,
    retryAfterMs: 0
  };
}

function reviewVariantGrammarFamilies() {
  return {
    identity: "subject + am/is + a person or identity",
    description: "It is + an adjective, or It is a/an + adjective/noun",
    "sat-on": "subject + sat on + a surface or object",
    inside: "subject + is in + a place or container",
    on: "subject + is on + a surface or object"
  };
}

function buildReviewVariantGenerationInput(state, date, route, tasks, extraExcludedEnglish = [], syncKey = reviewVariantSyncKey(content)) {
  const profile = buildLearningProfile(content, state, date);
  const wordMeanings = Object.fromEntries(content.words
    .filter(item => !item.preview && item.learned && String(item.learned) <= String(date || today()))
    .map(item => [normalizeVariantEnglish(item.english), Array.from(new Set([item.chinese, ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])].filter(Boolean)))]));
  const recent = recentReviewVariants(state);
  const fixedEnglish = content.sentences.map(item => item.english);
  const recentEnglish = Array.from(new Set([
    ...recent.map(item => item.english).filter(Boolean),
    ...(Array.isArray(extraExcludedEnglish) ? extraExcludedEnglish : [])
  ]));
  return {
    date,
    syncKey,
    contentSignature: reviewVariantContentSignature(content),
    tasks,
    route,
    allowedWords: profile.allowedWords,
    wordMeanings,
    grammarFamilies: reviewVariantGrammarFamilies(),
    fixedEnglish,
    recentEnglish,
    excludedEnglish: Array.from(new Set([...fixedEnglish, ...recentEnglish])),
    weakItems: profile.weakItems.slice(0, 12)
  };
}

function reviewVariantPoolMatches(pool, identity) {
  return Boolean(pool && identity
    && pool.syncKey === identity.syncKey
    && pool.contentSignature === identity.contentSignature);
}

function persistReviewVariantJobResult(user, input, result) {
  const state = getUserState(user);
  const pool = state.reviewVariantPool;
  const identity = { syncKey: input.syncKey, contentSignature: input.contentSignature };
  if (!reviewVariantPoolMatches(pool, identity)) {
    return {
      ...result,
      status: "stale",
      variants: [],
      failures: [],
      message: "学习内容已完成新的同步，本次旧句子结果已舍弃。",
      stale: true,
      pool: reviewVariantPoolSummary(pool)
    };
  }
  const taskFamilies = Object.fromEntries(input.tasks.map(task => [task.taskId, sentenceFamily(task.baseItem)]));
  const stored = storeReviewVariantPoolResults(pool, result.variants, { taskFamilies });
  stored.pool.model = result.model || input.route.model;
  stored.pool.reasoningEffort = result.reasoningEffort || input.route.reasoningEffort;
  state.reviewVariantPool = stored.pool;
  persistUserStates();
  return { ...result, pool: reviewVariantPoolSummary(stored.pool) };
}

function clearReviewVariantPoolRetry(userId) {
  const timer = reviewVariantPoolRetryTimersByUserId.get(userId);
  if (timer) clearTimeout(timer);
  reviewVariantPoolRetryTimersByUserId.delete(userId);
}

function reviewVariantPoolRouteForUser(user) {
  if (!aiConfigured()) return null;
  const state = getUserState(user);
  const practice = sanitizeAiPractice(state.aiPractice);
  const availableModels = getAvailableModels(aiSettings);
  const models = Array.from(new Set([practice.settings.model, aiSettings.defaultModel, ...availableModels]
    .map(value => String(value || "").trim())
    .filter(value => availableModels.includes(value))));
  for (const model of models) {
    try {
      return selectAiCandidates(aiSettings, { model, reasoningEffort: practice.settings.reasoningEffort });
    } catch (_) {
      // Try the next enabled model when the manually selected provider does
      // not expose this account's previously saved model.
    }
  }
  return null;
}

function scheduleReviewVariantPoolRetry(user, date, syncKey, contentSignature) {
  clearReviewVariantPoolRetry(user.id);
  const timer = setTimeout(() => {
    reviewVariantPoolRetryTimersByUserId.delete(user.id);
    refreshContent();
    const state = getUserState(user);
    const pool = state.reviewVariantPool;
    if (!reviewVariantPoolMatches(pool, { syncKey, contentSignature }) || pool.status !== "failed") return;
    requestReviewVariantPoolAutofill(user, true);
  }, AI_SENTENCE_RETRY_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  reviewVariantPoolRetryTimersByUserId.set(user.id, timer);
}

function markReviewVariantPoolForRetry(user, message) {
  const state = getUserState(user);
  const pool = state.reviewVariantPool;
  if (pool.variants.length >= pool.targetCount || pool.status === "ready") return reviewVariantPoolSummary(pool);
  pool.status = "failed";
  pool.error = String(message || "AI 句子暂时不可用，将每 5 分钟自动重试").slice(0, 240);
  pool.nextRetryAt = new Date(Date.now() + AI_SENTENCE_RETRY_MS).toISOString();
  pool.updatedAt = new Date().toISOString();
  state.reviewVariantPool = pool;
  persistUserStates();
  scheduleReviewVariantPoolRetry(user, pool.date, pool.syncKey, pool.contentSignature);
  return reviewVariantPoolSummary(pool);
}

function requestReviewVariantPoolAutofill(user, force = false) {
  const state = getUserState(user);
  const pool = state.reviewVariantPool;
  const active = reviewVariantPoolJobsByUserId.get(user.id);
  if (!REVIEW_VARIANT_POOL_AUTOFILL) return { status: "disabled", started: false, pool: reviewVariantPoolSummary(pool) };
  if (active && reviewVariantPoolMatches(pool, active)) return { status: "pending", started: false, pool: reviewVariantPoolSummary(pool) };
  if (pool.variants.length >= pool.targetCount || pool.status === "ready") return { status: "ready", started: false, pool: reviewVariantPoolSummary(pool) };
  if (!force && pool.status === "needs-attention") return { status: "needs-attention", started: false, pool: reviewVariantPoolSummary(pool) };
  if (!force && pool.status === "failed" && Date.parse(pool.nextRetryAt || "") > Date.now()) return { status: "failed", started: false, pool: reviewVariantPoolSummary(pool) };

  const route = reviewVariantPoolRouteForUser(user);
  if (!route) {
    const summary = markReviewVariantPoolForRetry(user, "AI 尚未配置或当前供应商无法生成句子，将每 5 分钟自动重试。");
    return { status: "waiting-ai", started: false, pool: summary };
  }
  const rate = takeAiRequest(user.id);
  if (!rate.allowed) {
    const summary = markReviewVariantPoolForRetry(user, "AI 句子请求过多，将每 5 分钟自动重试。");
    return { status: "rate-limited", started: false, pool: summary };
  }
  const job = startReviewVariantPoolFill(user, route, force);
  const currentPool = getUserState(user).reviewVariantPool;
  return { status: job ? "pending" : currentPool.status, started: Boolean(job), pool: reviewVariantPoolSummary(currentPool) };
}

function prepareReviewVariantPoolsAfterCourseSync(cycleChanged) {
  refreshUsers();
  const results = [];
  users.users.forEach(user => {
    if (cycleChanged) {
      clearReviewVariantPoolRetry(user.id);
      reviewVariantPoolJobsByUserId.delete(user.id);
    }
    results.push(requestReviewVariantPoolAutofill(user));
  });
  return {
    targetCount: REVIEW_VARIANT_POOL_TARGET,
    cycleChanged: Boolean(cycleChanged),
    accounts: results.length,
    started: results.filter(item => item.started).length,
    ready: results.filter(item => item.status === "ready").length,
    waiting: results.filter(item => ["waiting-ai", "rate-limited", "failed"].includes(item.status)).length
  };
}

function resumeReviewVariantPoolsAfterStartup() {
  refreshUsers();
  users.users.forEach(user => {
    if (!userStates.users[user.id]) return;
    const pool = getUserState(user).reviewVariantPool;
    if (pool.status === "needs-attention" || pool.variants.length >= pool.targetCount) return;
    requestReviewVariantPoolAutofill(user, true);
  });
}

function startReviewVariantPoolFill(user, route, force = false) {
  if (!REVIEW_VARIANT_POOL_AUTOFILL) return null;
  const state = getUserState(user);
  const pool = state.reviewVariantPool;
  const existing = reviewVariantPoolJobsByUserId.get(user.id);
  if (existing && reviewVariantPoolMatches(pool, existing)) return existing;
  if (pool.variants.length >= pool.targetCount || pool.status === "ready") return null;
  if (!force && pool.status === "needs-attention") return null;
  if (!force && pool.status === "failed" && Date.parse(pool.nextRetryAt || "") > Date.now()) return null;
  if (existing) reviewVariantPoolJobsByUserId.delete(user.id);
  clearReviewVariantPoolRetry(user.id);
  pool.status = "pending";
  pool.model = route.model;
  pool.reasoningEffort = route.reasoningEffort;
  pool.error = "";
  pool.nextRetryAt = "";
  if (force) pool.blockedFamilies = [];
  pool.updatedAt = new Date().toISOString();
  persistUserStates();

  const job = {
    id: `review-pool-${crypto.randomUUID()}`,
    userId: user.id,
    date: pool.date,
    syncKey: pool.syncKey,
    contentSignature: pool.contentSignature,
    status: "pending",
    startedAtMs: Date.now(),
    promise: null
  };
  reviewVariantPoolJobsByUserId.set(user.id, job);
  job.promise = (async () => {
    let batches = 0;
    while (batches < 20) {
      refreshContent();
      const snapshotState = getUserState(user);
      const snapshotPool = snapshotState.reviewVariantPool;
      if (!reviewVariantPoolMatches(snapshotPool, job)) return;
      if (snapshotPool.variants.length >= snapshotPool.targetCount) {
        snapshotPool.status = "ready";
        snapshotPool.error = "";
        snapshotPool.nextRetryAt = "";
        snapshotState.reviewVariantPool = snapshotPool;
        persistUserStates();
        job.status = "completed";
        return;
      }
      const tasks = buildReviewVariantPoolTasks(content, snapshotPool, REVIEW_VARIANT_POOL_BATCH);
      if (!tasks.length) {
        snapshotPool.status = "needs-attention";
        snapshotPool.error = "当前已学句型不足，无法继续生成本轮句子池。";
        snapshotPool.updatedAt = new Date().toISOString();
        snapshotState.reviewVariantPool = snapshotPool;
        persistUserStates();
        job.status = "needs-attention";
        return;
      }
      const input = buildReviewVariantGenerationInput(snapshotState, job.date, route, tasks, snapshotPool.variants.map(item => item.english), job.syncKey);
      const result = await generateReviewVariantsWithRepairs(route, input);
      // State reads can occur while the upstream request is running. Re-read
      // the authoritative object before saving so polling cannot detach and
      // accidentally discard a completed batch.
      const currentState = getUserState(user);
      let currentPool = currentState.reviewVariantPool;
      if (!reviewVariantPoolMatches(currentPool, job)) return;
      const taskFamilies = Object.fromEntries(tasks.map(task => [task.taskId, task.family]));
      const stored = storeReviewVariantPoolResults(currentPool, result.variants, { requestedCount: tasks.length, taskFamilies });
      currentPool = stored.pool;
      // Only families that produced a variant accepted by the pool count as
      // available. Raw upstream responses may contain malformed, duplicate,
      // or wrong-family items that storeReviewVariantPoolResults rejects.
      const returnedByFamily = new Set(Object.keys(stored.addedByFamily || {}));
      const blockedFamilies = new Set(currentPool.blockedFamilies || []);
      tasks.forEach(task => { if (!returnedByFamily.has(task.family)) blockedFamilies.add(task.family); });
      currentPool.blockedFamilies = Array.from(blockedFamilies).slice(0, 20);
      currentPool.model = result.model || route.model;
      currentPool.reasoningEffort = result.reasoningEffort || route.reasoningEffort;
      currentPool.updatedAt = new Date().toISOString();
      if (!stored.added) {
        const canContinue = buildReviewVariantPoolTasks(content, currentPool, 1).length > 0;
        if (canContinue) {
          currentPool.status = "pending";
          currentPool.error = result.message || "某个句型的可用组合已耗尽，正在改用其他已学句型补齐。";
          currentState.reviewVariantPool = currentPool;
          persistUserStates();
          batches += 1;
          continue;
        }
        currentPool.status = "needs-attention";
        currentPool.error = result.message || "连续 3 轮没有生成新的合格句子，已停止自动重试。";
        currentState.reviewVariantPool = currentPool;
        persistUserStates();
        job.status = "needs-attention";
        return;
      }
      currentPool.status = currentPool.variants.length >= currentPool.targetCount ? "ready" : "pending";
      currentPool.error = "";
      currentPool.nextRetryAt = "";
      currentState.reviewVariantPool = currentPool;
      persistUserStates();
      batches += 1;
    }
    const currentState = getUserState(user);
    if (reviewVariantPoolMatches(currentState.reviewVariantPool, job) && currentState.reviewVariantPool.status !== "ready") {
      currentState.reviewVariantPool.status = "needs-attention";
      currentState.reviewVariantPool.error = "本轮句子池尚未补满，请点立即重试继续生成。";
      currentState.reviewVariantPool.updatedAt = new Date().toISOString();
      persistUserStates();
    }
    job.status = reviewVariantPoolMatches(currentState.reviewVariantPool, job) ? currentState.reviewVariantPool.status : "stale";
  })().catch(error => {
    console.warn(`AI review variant pool generation failed; retry will be scheduled: ${error && error.message ? error.message : "unknown error"}`);
    const currentState = getUserState(user);
    const currentPool = currentState.reviewVariantPool;
    if (!reviewVariantPoolMatches(currentPool, job)) return;
    const failure = publicAiSentenceVariantFailure(error);
    currentPool.status = "failed";
    currentPool.error = failure.message;
    currentPool.nextRetryAt = new Date(Date.now() + AI_SENTENCE_RETRY_MS).toISOString();
    currentPool.updatedAt = new Date().toISOString();
    currentState.reviewVariantPool = currentPool;
    persistUserStates();
    job.status = "failed";
    scheduleReviewVariantPoolRetry(user, job.date, job.syncKey, job.contentSignature);
  }).finally(() => {
    if (reviewVariantPoolJobsByUserId.get(user.id) === job) reviewVariantPoolJobsByUserId.delete(user.id);
  });
  return job;
}

function reviewVariantJobKey(userId, input) {
  return crypto.createHash("sha256").update(JSON.stringify({ userId, date: input.date, syncKey: input.syncKey, taskIds: input.tasks.map(task => task.taskId), model: input.route.model, reasoningEffort: input.route.reasoningEffort })).digest("hex");
}

function deleteReviewVariantJob(job) {
  if (!job) return;
  reviewVariantJobsById.delete(job.id);
  if (reviewVariantJobIdsByKey.get(job.key) === job.id) reviewVariantJobIdsByKey.delete(job.key);
}

function purgeReviewVariantJobs() {
  const current = Date.now();
  reviewVariantJobsById.forEach(job => {
    if (job.status === "pending" && current - Number(job.startedAtMs || current) >= REVIEW_VARIANT_UPSTREAM_TIMEOUT_MS) {
      failReviewVariantJob(job, Object.assign(new Error("AI review variant generation timed out"), { code: "REVIEW_VARIANT_TIMEOUT" }));
    }
    if (job.status !== "pending" && current - Number(job.finishedAtMs || job.startedAtMs) > REVIEW_VARIANT_JOB_CACHE_MS) deleteReviewVariantJob(job);
  });
}

function sendReviewVariantJob(res, job) {
  if (job.status === "pending") return sendJson(res, 202, { status: "pending", jobId: job.id, pollAfterMs: REVIEW_VARIANT_JOB_POLL_MS, message: "AI 正在后台生成并校验句子，单次最多等待 10 分钟；失败后每 5 分钟自动重试。" });
  if (job.status === "completed") return sendJson(res, 200, job.result, job.result.retryAfterMs ? { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) } : {});
  return sendJson(res, job.failure.statusCode, {
    error: job.failure.message,
    retryAfterMs: AI_SENTENCE_RETRY_MS,
    reasonCode: job.failure.reasonCode,
    providerStatus: job.failure.providerStatus
  }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
}

function sendPartialReviewVariantResponse(res, assigned, pendingTasks, { job = null, message = "", autoRetry = true, pool = null } = {}) {
  const variants = Array.isArray(assigned && assigned.variants) ? assigned.variants : [];
  const pendingTaskIds = (Array.isArray(pendingTasks) ? pendingTasks : []).map(task => String(task && task.taskId || "")).filter(Boolean);
  const first = variants[0] || {};
  return sendJson(res, job ? 202 : 200, {
    status: "partial",
    jobId: job ? job.id : "",
    pollAfterMs: job ? REVIEW_VARIANT_JOB_POLL_MS : 0,
    variants,
    pendingTaskIds,
    failures: [],
    message: String(message || `已先使用 ${variants.length} 条已生成句子，剩余 ${pendingTaskIds.length} 条继续准备。`).slice(0, 240),
    source: "ai",
    provider: { id: first.providerId || "", name: first.providerName || "" },
    model: first.model || (pool && pool.model) || "",
    reasoningEffort: first.reasoningEffort || (pool && pool.reasoningEffort) || "",
    repairRounds: 0,
    maxRepairRounds: REVIEW_VARIANT_MAX_REPAIR_ROUNDS,
    autoRetry: Boolean(autoRetry),
    retryAfterMs: autoRetry ? AI_SENTENCE_RETRY_MS : 0,
    cached: true,
    pool: pool || (assigned && assigned.pool ? reviewVariantPoolSummary(assigned.pool) : null)
  });
}

function failReviewVariantJob(job, error) {
  if (!job || job.status !== "pending") return;
  job.status = "failed";
  job.failure = publicAiSentenceVariantFailure(error);
  job.finishedAtMs = Date.now();
  if (reviewVariantJobIdsByKey.get(job.key) === job.id) reviewVariantJobIdsByKey.delete(job.key);
}

function startReviewVariantJob(user, key, route, input) {
  const job = {
    id: `review-variant-${crypto.randomUUID()}`,
    key,
    userId: user.id,
    status: "pending",
    startedAtMs: Date.now(),
    finishedAtMs: 0,
    result: null,
    failure: null,
    timeoutTimer: null
  };
  reviewVariantJobsById.set(job.id, job);
  reviewVariantJobIdsByKey.set(key, job.id);
  job.timeoutTimer = setTimeout(() => {
    if (job.status !== "pending") return;
    console.warn(`AI review variant job timed out after ${Math.round(REVIEW_VARIANT_UPSTREAM_TIMEOUT_MS / 60000)} minutes; retry will be scheduled`);
    failReviewVariantJob(job, Object.assign(new Error("AI review variant generation timed out"), { code: "REVIEW_VARIANT_TIMEOUT" }));
  }, REVIEW_VARIANT_UPSTREAM_TIMEOUT_MS);
  if (job.timeoutTimer && typeof job.timeoutTimer.unref === "function") job.timeoutTimer.unref();
  job.promise = generateReviewVariantsWithRepairs(route, input).then(result => {
    if (job.status !== "pending") return;
    job.status = "completed";
    job.result = persistReviewVariantJobResult(user, input, result);
    if (!job.result.stale) startReviewVariantPoolFill(user, route);
  }).catch(error => {
    if (job.status !== "pending") return;
    console.warn(`AI review variant generation failed; retry will be scheduled: ${error && error.message ? error.message : "unknown error"}`);
    failReviewVariantJob(job, error);
  }).finally(() => {
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    if (job.status === "pending") job.finishedAtMs = Date.now();
  });
  return job;
}

async function handleReviewSentenceVariantsLegacy(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  purgeReviewVariantJobs();
  const requestUrl = new URL(req.url, "http://localhost");
  if (req.method === "GET") {
    const job = reviewVariantJobsById.get(String(requestUrl.searchParams.get("jobId") || ""));
    if (!job || job.userId !== user.id) return sendError(res, 404, "review variant job not found");
    return sendReviewVariantJob(res, job);
  }
  if (req.method !== "POST") return sendError(res, 404, "review variant endpoint not found");
  try {
    refreshContent();
    const body = await readBody(req);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : today();
    const taskIds = Array.from(new Set((Array.isArray(body.taskIds) ? body.taskIds : []).map(value => String(value || "")).filter(Boolean))).slice(0, 10);
    if (!taskIds.length) return sendError(res, 400, "taskIds are required");
    const tasks = taskIds.map(taskId => findSentenceTask(taskId)).filter(Boolean);
    if (tasks.length !== taskIds.length) return sendError(res, 404, "sentence task not found");
    const unavailable = (message = "AI 变式暂时不可用，将每 5 分钟自动重试") => sendJson(res, 503, { error: message, retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
    if (!aiConfigured()) return unavailable("AI 尚未配置，句子变式将每 5 分钟自动重试");

    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const availableModels = getAvailableModels(aiSettings);
    const requestedModel = [body.model, practice.settings.model, aiSettings.defaultModel].map(value => String(value || "").trim()).find(value => availableModels.includes(value)) || aiSettings.defaultModel;
    const requestedEffort = AI_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : practice.settings.reasoningEffort;
    const route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: requestedEffort });
    const profile = buildLearningProfile(content, state, date);
    const recent = recentReviewVariants(state);
    const fixedEnglish = content.sentences.map(item => item.english);
    const recentEnglish = recent.map(item => item.english).filter(Boolean);
    const excludedEnglish = Array.from(new Set([...fixedEnglish, ...recentEnglish]));
    const grammarFamilies = {
      identity: "subject + am/is + a person or identity",
      description: "It is + an adjective, or It is a/an + adjective/noun",
      "sat-on": "subject + sat on + a surface or object",
      inside: "subject + is in + a place or container",
      on: "subject + is on + a surface or object"
    };
    const input = {
      date,
      syncKey: reviewVariantSyncKey(content),
      contentSignature: reviewVariantContentSignature(content),
      tasks,
      route,
      allowedWords: profile.allowedWords,
      grammarFamilies,
      fixedEnglish,
      recentEnglish,
      excludedEnglish,
      weakItems: profile.weakItems.slice(0, 12)
    };
    const key = reviewVariantJobKey(user.id, input);
    const existing = reviewVariantJobsById.get(reviewVariantJobIdsByKey.get(key));
    if (existing && (existing.status === "pending" || body.force !== true)) return sendReviewVariantJob(res, existing);
    if (existing) deleteReviewVariantJob(existing);

    const rate = takeAiRequest(user.id);
    if (!rate.allowed) return sendJson(res, 429, { error: "AI 变式请求受限，将每 5 分钟自动重试", retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
    return sendReviewVariantJob(res, startReviewVariantJob(user, key, route, input));
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }
}

async function handleReviewSentenceVariants(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  purgeReviewVariantJobs();
  const requestUrl = new URL(req.url, "http://localhost");
  if (req.method === "GET") {
    const job = reviewVariantJobsById.get(String(requestUrl.searchParams.get("jobId") || ""));
    if (!job || job.userId !== user.id) return sendError(res, 404, "review variant job not found");
    return sendReviewVariantJob(res, job);
  }
  if (req.method !== "POST") return sendError(res, 404, "review variant endpoint not found");
  try {
    refreshContent();
    const body = await readBody(req);
    const date = today();
    const state = getUserState(user);
    const pool = state.reviewVariantPool;
    const unavailable = (message = "AI 句子暂时不可用，将每 5 分钟自动重试") => sendJson(res, 503, { error: message, retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });

    if (body.prefetch === true && pool.variants.length >= pool.targetCount) {
      return sendJson(res, 200, { status: "ready", source: "ai", cached: true, pool: reviewVariantPoolSummary(pool) });
    }

    const taskIds = Array.from(new Set((Array.isArray(body.taskIds) ? body.taskIds : []).map(value => String(value || "")).filter(Boolean))).slice(0, 10);
    const tasks = taskIds.map(taskId => findSentenceTask(taskId)).filter(Boolean);
    if (body.prefetch !== true && !taskIds.length) return sendError(res, 400, "taskIds are required");
    if (tasks.length !== taskIds.length) return sendError(res, 404, "sentence task not found");

    let assigned = { pool, variants: [] };
    let pendingTasks = tasks;
    if (body.prefetch !== true) {
      // Use every compatible sentence already saved in this sync cycle first.
      // Manual retries must follow the same path: force only replaces a failed
      // AI job for tasks that the persisted pool still cannot satisfy.
      assigned = assignReviewVariantPoolTasks(pool, tasks, content);
      state.reviewVariantPool = assigned.pool;
      persistUserStates();
      const assignedTaskIds = new Set(assigned.variants.map(item => item.taskId));
      pendingTasks = tasks.filter(task => !assignedTaskIds.has(task.taskId));
      if (!pendingTasks.length) {
        const first = assigned.variants[0] || {};
        return sendJson(res, 200, {
          status: "completed",
          variants: assigned.variants,
          failures: [],
          message: "",
          source: "ai",
          provider: { id: first.providerId || "", name: first.providerName || "" },
          model: first.model || assigned.pool.model,
          reasoningEffort: first.reasoningEffort || assigned.pool.reasoningEffort,
          repairRounds: 0,
          maxRepairRounds: REVIEW_VARIANT_MAX_REPAIR_ROUNDS,
          autoRetry: false,
          retryAfterMs: 0,
          cached: true,
          pool: reviewVariantPoolSummary(assigned.pool)
        });
      }
    }

    if (!aiConfigured()) {
      if (assigned.variants.length) return sendPartialReviewVariantResponse(res, assigned, pendingTasks, { message: `已先使用 ${assigned.variants.length} 条已生成句子；剩余 ${pendingTasks.length} 条将在 AI 恢复后继续生成。`, pool: reviewVariantPoolSummary(assigned.pool) });
      return unavailable("AI 尚未配置，句子变式将每 5 分钟自动重试");
    }
    const practice = sanitizeAiPractice(state.aiPractice);
    const availableModels = getAvailableModels(aiSettings);
    const requestedModel = [body.model, practice.settings.model, aiSettings.defaultModel].map(value => String(value || "").trim()).find(value => availableModels.includes(value)) || aiSettings.defaultModel;
    const requestedEffort = AI_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : practice.settings.reasoningEffort;
    const route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: requestedEffort });

    if (body.prefetch === true) {
      const active = reviewVariantPoolJobsByUserId.get(user.id);
      if (active && reviewVariantPoolMatches(pool, active)) {
        return sendJson(res, 202, {
          status: "pending",
          prefetch: true,
          pollAfterMs: REVIEW_VARIANT_JOB_POLL_MS,
          message: "本轮学习同步的 50 条 AI 句子正在后台生成并逐批保存。",
          pool: reviewVariantPoolSummary(pool)
        });
      }
      if (pool.status === "needs-attention" && body.force !== true) {
        return sendJson(res, 200, {
          status: "needs-attention",
          prefetch: true,
          source: "ai",
          autoRetry: false,
          message: pool.error,
          pool: reviewVariantPoolSummary(pool)
        });
      }
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI 句子请求过多，将每 5 分钟自动重试", retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
      const started = startReviewVariantPoolFill(user, route, body.force === true);
      const currentPool = getUserState(user).reviewVariantPool;
      return sendJson(res, started ? 202 : 200, {
        status: started ? "pending" : currentPool.status,
        prefetch: true,
        source: "ai",
        pollAfterMs: REVIEW_VARIANT_JOB_POLL_MS,
        message: started ? "本轮学习同步的 50 条 AI 句子正在后台生成并逐批保存。" : currentPool.error,
        pool: reviewVariantPoolSummary(currentPool)
      });
    }

    const input = buildReviewVariantGenerationInput(state, date, route, pendingTasks, assigned.variants.map(item => item.english));
    const key = reviewVariantJobKey(user.id, input);
    const existing = reviewVariantJobsById.get(reviewVariantJobIdsByKey.get(key));
    if (existing && existing.status === "pending") {
      if (assigned.variants.length) return sendPartialReviewVariantResponse(res, assigned, pendingTasks, { job: existing, message: `已先使用 ${assigned.variants.length} 条已生成句子；剩余 ${pendingTasks.length} 条正在后台生成。`, pool: reviewVariantPoolSummary(assigned.pool) });
      return sendReviewVariantJob(res, existing);
    }
    if (existing && body.force !== true) {
      if (assigned.variants.length) return sendPartialReviewVariantResponse(res, assigned, pendingTasks, { message: `已先使用 ${assigned.variants.length} 条已生成句子；剩余 ${pendingTasks.length} 条等待重试。`, pool: reviewVariantPoolSummary(assigned.pool) });
      return sendReviewVariantJob(res, existing);
    }
    if (existing) deleteReviewVariantJob(existing);
    const rate = takeAiRequest(user.id);
    if (!rate.allowed) {
      if (assigned.variants.length) return sendPartialReviewVariantResponse(res, assigned, pendingTasks, { message: `已先使用 ${assigned.variants.length} 条已生成句子；剩余 ${pendingTasks.length} 条受限流影响，将在 5 分钟后重试。`, pool: reviewVariantPoolSummary(assigned.pool) });
      return sendJson(res, 429, { error: "AI 句子请求过多，将每 5 分钟自动重试", retryAfterMs: AI_SENTENCE_RETRY_MS }, { "Retry-After": String(AI_SENTENCE_RETRY_SECONDS) });
    }
    const job = startReviewVariantJob(user, key, route, input);
    if (assigned.variants.length) return sendPartialReviewVariantResponse(res, assigned, pendingTasks, { job, message: `已先使用 ${assigned.variants.length} 条已生成句子；剩余 ${pendingTasks.length} 条正在后台生成。`, pool: reviewVariantPoolSummary(assigned.pool) });
    return sendReviewVariantJob(res, job);
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }
}

function aiSelectionForState(state, requested = {}, options = {}) {
  const practice = sanitizeAiPractice(state.aiPractice);
  const availableModels = getAvailableModels(aiSettings);
  const storedModel = String(practice.settings.model || "").trim();
  const model = String(requested.model || (availableModels.includes(storedModel) ? storedModel : aiSettings && aiSettings.defaultModel) || "").trim();
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : practice.settings.reasoningEffort;
  const count = [5, 10].includes(Number(requested.count)) ? Number(requested.count) : practice.settings.count;
  const groupCount = [1, 2, 3, 5].includes(Number(requested.groupCount)) ? Number(requested.groupCount) : practice.settings.groupCount;
  const contentType = options.generation && ["word", "sentence"].includes(requested.contentType) ? requested.contentType : options.generation ? practice.settings.contentType : "sentence";
  const direction = options.generation && ["mixed", "en-zh", "zh-en"].includes(requested.direction) ? requested.direction : options.generation ? practice.settings.direction : "mixed";
  const route = contentType === "word"
    ? {
        mode: "local",
        model: model || "local-word-bank",
        reasoningEffort,
        candidates: [{ configured: true, providerId: "local-word-bank", providerName: "本地词库", model: model || "local-word-bank", reasoningEffort }]
      }
    : selectAiCandidates(aiSettings, { model, reasoningEffort });
  practice.settings = { model: route.model, reasoningEffort: route.reasoningEffort, count, groupCount, contentType, direction };
  practice.updatedAt = new Date().toISOString();
  state.aiPractice = practice;
  return { route, count, groupCount, contentType, direction, practice };
}

function publicAiOptions(user) {
  const current = aiSettingsStore.public();
  const practice = user ? sanitizeAiPractice(getUserState(user).aiPractice) : sanitizeAiPractice(null);
  const selectedModel = current.availableModels.includes(practice.settings.model) ? practice.settings.model : current.defaultModel;
  const providers = current.providers.map(provider => ({ id: provider.id, name: provider.name, enabled: provider.enabled, models: [...provider.models] }));
  const enabledTutorProviders = providers.filter(provider => provider.enabled && provider.models.length);
  const selectedTutorProvider = enabledTutorProviders.find(provider => provider.id === practice.tutorSettings.providerId)
    || enabledTutorProviders.find(provider => provider.id === current.manualProviderId)
    || enabledTutorProviders[0]
    || null;
  const selectedTutorModel = selectedTutorProvider
    ? selectedTutorProvider.models.includes(practice.tutorSettings.model)
      ? practice.tutorSettings.model
      : selectedTutorProvider.models.includes(current.defaultModel)
        ? current.defaultModel
        : selectedTutorProvider.models[0]
    : "";
  return {
    configured: current.configured,
    models: current.availableModels,
    providers,
    defaultModel: current.defaultModel,
    efforts: current.efforts,
    selectedModel,
    selectedTutorProviderId: selectedTutorProvider ? selectedTutorProvider.id : "",
    selectedTutorModel,
    selectedEffort: practice.settings.reasoningEffort,
    selectedTutorEffort: practice.tutorSettings.reasoningEffort,
    selectedCount: practice.settings.count,
    selectedGroupCount: practice.settings.groupCount,
    selectedContentType: practice.settings.contentType,
    selectedDirection: practice.settings.direction,
    routingMode: current.mode,
    admin: Boolean(user && user.role === "admin")
  };
}

function publicAiGenerationFailure(error) {
  const providerStatus = Number(error && error.providerStatus) || null;
  const localStatus = Number(error && error.statusCode) || null;
  const detail = String(error && error.message || "");
  let message = "AI 生成题目失败，请稍后重试或更换模型";
  let statusCode = 502;

  if (localStatus === 429) message = "AI 请求过于频繁，本组已暂停，请稍后原位重试";
  else if (localStatus === 409 && /no learned words/i.test(detail)) message = "目前没有可用于出题的已学单词";
  else if ([401, 403].includes(providerStatus)) message = "AI 上游拒绝了请求，请检查 API Key 和模型权限";
  else if ([404, 405, 501].includes(providerStatus)) message = "AI 上游不支持该模型的生成接口，请更换模型";
  else if (providerStatus === 429) message = "AI 上游请求过多或额度不足，请稍后再试";
  else if ([400, 422].includes(providerStatus)) message = "AI 上游拒绝了当前模型或强度参数，请更换模型或降低强度";
  else if (providerStatus && providerStatus >= 500) message = "AI 上游服务暂时不可用，请稍后再试";
  else if (/timed out/i.test(detail)) {
    message = "AI 请求超时，请稍后重试或在 AI 设置中增加超时时间";
    statusCode = 504;
  } else if (/too few question groups|too few valid questions|did not return questions/i.test(detail)) message = "AI 返回的题组或题量不完整，系统未采用，请重新生成或更换模型";
  else if (/AI exam returned too few|missing numbered blanks|missing a cloze passage|missing a reading passage|point allocation is invalid/i.test(detail)) message = "AI 返回的试卷缺少必需题型或题量，系统未采用，请重新生成或更换模型";
  else if (/AI exam used unlearned English|AI exam returned no English/i.test(detail)) message = "AI 返回的试卷含有未学英语，系统未采用，请重新生成或更换模型";
  else if (/invalid (question|exam) JSON|unsupported response|Unexpected (end|token)/i.test(detail)) message = "AI 返回格式不符合出题要求，请重试或更换模型";
  else if (/response is too large/i.test(detail)) message = "AI 返回内容过长，请重试或更换模型";

  return { message, providerStatus, statusCode };
}

function publicAiSentenceVariantFailure(error) {
  const providerStatus = Number(error && error.providerStatus) || null;
  const detail = String(error && error.message || "");
  let message = "AI 句子变式暂时不可用，将每 5 分钟自动重试";
  let statusCode = 503;
  let reasonCode = "unavailable";

  if (providerStatus === 429) {
    message = "AI 上游请求过多或额度不足，将每 5 分钟自动重试";
    reasonCode = "rate-limit";
    statusCode = 429;
  } else if ([401, 403].includes(providerStatus)) {
    message = "AI 上游拒绝了请求，请检查模型权限后重试";
    reasonCode = "provider-auth";
  } else if ([400, 422].includes(providerStatus)) {
    message = "AI 上游拒绝当前模型或强度参数，将每 5 分钟自动重试";
    reasonCode = "provider-parameters";
  } else if ([404, 405, 501].includes(providerStatus)) {
    message = "当前模型不支持所需的生成接口，将每 5 分钟自动重试";
    reasonCode = "unsupported-endpoint";
  } else if (providerStatus && providerStatus >= 500) {
    message = "AI 上游服务暂时不可用，将每 5 分钟自动重试";
    reasonCode = "provider-service";
  } else if (/timed out/i.test(detail)) {
    message = "AI 句子变式单次生成超过 10 分钟，已停止本次任务，将每 5 分钟自动重试";
    reasonCode = "timeout";
    statusCode = 504;
  } else if (/too large/i.test(detail)) {
    message = "AI 返回内容过长，将每 5 分钟自动重试";
    reasonCode = "response-too-large";
  } else if (/invalid|incomplete|repeated|unsupported|unlearned|超纲|重复|格式/i.test(detail)) {
    message = "AI 返回的句子连续 3 轮未通过校验，已停止自动重试；请立即重试或更换模型";
    reasonCode = "invalid-output";
  }

  return { message, statusCode, providerStatus, reasonCode };
}

function publicAiTutorFailure(error) {
  const providerStatus = Number(error && error.providerStatus) || null;
  const detail = String(error && error.message || "");
  let message = "AI 暂时无法回答，请稍后重试或更换模型";
  let statusCode = 502;

  if ([401, 403].includes(providerStatus)) message = "AI 上游拒绝了请求，请检查 API Key 和模型权限";
  else if ([404, 405, 501].includes(providerStatus)) message = "AI 上游不支持该模型的问答接口，请更换模型";
  else if (providerStatus === 429) message = "AI 上游请求过多或额度不足，请稍后再试";
  else if ([400, 422].includes(providerStatus)) message = "AI 上游拒绝了当前模型或强度参数，请更换模型或降低强度";
  else if (providerStatus && providerStatus >= 500) message = "AI 上游服务暂时不可用，请稍后再试";
  else if (/timed out/i.test(detail)) {
    message = "AI 回答超时，请稍后重试或在 AI 设置中增加超时时间";
    statusCode = 504;
  } else if (/empty tutor answer|unsupported response/i.test(detail)) message = "AI 返回的回答格式无效，请重试或更换模型";

  return { message, providerStatus, statusCode };
}

async function handleAiAdmin(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  if (user.role !== "admin") return sendError(res, 403, "admin role required");

  if (url.pathname === "/api/admin/ai-config" && req.method === "GET") return sendJson(res, 200, aiSettingsStore.public());
  if (url.pathname === "/api/admin/ai-config" && req.method === "PUT") {
    try {
      aiSettingsStore.save(await readBody(req));
      refreshAiSettings();
      return sendJson(res, 200, aiSettingsStore.public());
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }
  if (url.pathname === "/api/admin/ai-config/models" && req.method === "POST") {
    try {
      const config = resolveAiConnection(aiSettings, await readBody(req));
      const models = await createAiModelFetcher(config)();
      return sendJson(res, 200, { models, count: models.length });
    } catch (error) {
      if (error && error.statusCode === 400) return sendError(res, 400, error.message);
      console.warn(`AI model discovery failed: ${error && error.message ? error.message : "unknown error"}`);
      return sendJson(res, 502, { error: "获取上游模型失败", providerStatus: Number(error && error.providerStatus) || null });
    }
  }
  if (url.pathname === "/api/admin/ai-config/test" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const config = selectAiCandidates(aiSettings, body, { allowDisabledProvider: true }).candidates[0];
      await createAiConnectionTester(config)();
      return sendJson(res, 200, {
        ok: true,
        providerId: config.providerId,
        providerName: config.providerName,
        providerFamily: config.providerFamily,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        appliedReasoningEffort: config.upstreamReasoningEffort,
        timeoutMs: config.timeoutMs
      });
    } catch (error) {
      console.warn(`AI connection test failed: ${error && error.message ? error.message : "unknown error"}`);
      return sendJson(res, 502, { error: "AI connection test failed", providerStatus: Number(error && error.providerStatus) || null });
    }
  }
  return sendError(res, 404, "AI admin endpoint not found");
}

function aiQuestionMatches(question, answer) {
  if (question.direction === "zh-en") return englishAnswerMatches(answer, question.acceptedEnglish || [question.english]);
  return chineseAnswerMatches(answer, question.acceptedChinese || [question.chinese], question.english);
}

function localTranslationGrade(direction, english, answer, acceptedAnswers) {
  if (direction === "zh-en") {
    if (!englishAnswerMatches(answer, acceptedAnswers)) return null;
    const explanation = "本地规则已接受这个答案。";
    return { correct: true, score: 1, gradingStatus: "correct", explanation, detailedExplanation: buildTranslationExplanation({ direction, referenceAnswer: acceptedAnswers[0] || english, answer, correct: true, explanation }), problemWords: [], wordResults: englishWordResults(english, answer), source: "local" };
  }
  const quality = chineseAnswerQuality(answer, acceptedAnswers, english);
  if (!quality.correct) return null;
  const partial = quality.gradingStatus === "partial";
  const optionalMeasureOmission = chineseOptionalMeasureOmissionMatches(answer, acceptedAnswers);
  const naturalPersonMeasure = chineseNaturalPersonMeasureMatches(answer, acceptedAnswers, english);
  const naturalDeep = chineseNaturalDeepMatches(answer, acceptedAnswers, english);
  const explanation = partial
    ? "英语意思理解正确；中文量词不够自然，本题按部分正确记录。"
    : naturalDeep
      ? NATURAL_DEEP_EXPLANATION
      : naturalPersonMeasure
      ? NATURAL_PERSON_MEASURE_EXPLANATION
      : optionalMeasureOmission
      ? OPTIONAL_MEASURE_OMISSION_EXPLANATION
      : !chineseAnswerMatches(answer, [acceptedAnswers[0] || ""], english)
        ? "你的翻译使用了课程词库允许的同义表达，意思正确。"
        : "本地规则已接受这个答案。";
  return {
    ...quality,
    explanation,
    detailedExplanation: buildTranslationExplanation({ direction, referenceAnswer: acceptedAnswers[0] || "", answer, correct: true, gradingStatus: quality.gradingStatus, explanation }),
    problemWords: [],
    wordResults: englishSourceWordResults(english, true),
    source: "local"
  };
}

function completeTranslationGrade(direction, english, answer, result, referenceAnswer = "") {
  const score = Number.isFinite(Number(result.score)) ? Math.max(0, Math.min(1, Number(result.score))) : (result.correct ? 1 : 0);
  const gradingStatus = ["correct", "partial", "incorrect"].includes(result.gradingStatus) ? result.gradingStatus : (result.correct ? "correct" : "incorrect");
  const problemWords = Array.isArray(result.problemWords) ? result.problemWords : [];
  const wordResults = direction === "zh-en"
    ? englishWordResults(english, answer)
    : englishSourceWordResults(english, result.correct, problemWords);
  const expected = referenceAnswer || (direction === "zh-en" ? english : String(result.referenceAnswer || ""));
  return {
    ...result,
    score,
    gradingStatus,
    problemWords,
    wordResults,
    detailedExplanation: result.detailedExplanation || buildTranslationExplanation({ direction, referenceAnswer: expected, answer, correct: result.correct === true, gradingStatus, explanation: result.explanation, problemWords })
  };
}

function addStudyDays(date, days) {
  const parsed = new Date(`${String(date || today())}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function reviewQuestionSnapshot(user, taskId, variantId = "") {
  const task = findReviewTutorTask(user, taskId, variantId);
  if (!task) throw Object.assign(new Error("review question not found or is not eligible"), { statusCode: 404 });
  const item = task.item;
  const chinese = prioritizeRegisteredChineseMeanings(content, item.english, item.chinese);
  const acceptedChinese = expandRegisteredChineseAnswers(content, item.english, [
    chinese,
    ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : []).map(answer => prioritizeRegisteredChineseMeanings(content, item.english, answer))
  ].filter(answer => answer && !registeredChineseMeaningConflicts(content, item.english, answer).length), 16);
  const reviewVariant = task.variant ? { ...task.variant, chinese, acceptedChinese } : null;
  return {
    id: `reviewq-${crypto.randomUUID()}`,
    taskId: task.taskId,
    variantId: task.variant ? String(task.variant.id || "") : "",
    direction: task.direction,
    itemType: Object.hasOwn(item, "phonetic") ? "word" : "sentence",
    day: Number(item.day) || 0,
    phonetic: String(item.phonetic || ""),
    english: item.english,
    chinese,
    acceptedEnglish: item.acceptedEnglish || [item.english],
    acceptedChinese,
    reviewVariant,
    answer: ""
  };
}

function cloneFormalPractice(value) {
  return deepClone(value && typeof value === "object" ? value : sanitizeFormalPractice(null));
}

function cloneFormalMutationState(value) {
  const state = value && typeof value === "object" ? value : defaultState();
  return {
    ...state,
    taskStates: { ...(state.taskStates && typeof state.taskStates === "object" ? state.taskStates : {}) },
    history: { ...(state.history && typeof state.history === "object" ? state.history : {}) },
    attempts: Array.isArray(state.attempts) ? [...state.attempts] : [],
    sessions: { ...(state.sessions && typeof state.sessions === "object" ? state.sessions : {}) },
    mistakes: Array.isArray(state.mistakes) ? [...state.mistakes] : [],
    sentencePracticeEvents: Array.isArray(state.sentencePracticeEvents) ? [...state.sentencePracticeEvents] : [],
    wordUsage: sanitizeWordUsage(state.wordUsage),
    formalPractice: cloneFormalPractice(state.formalPractice)
  };
}

function wordUsageResult(result, assistance = "") {
  if (assistance === "revealed") return "revealed";
  if (assistance === "assisted") return "assisted";
  return result && result.correct === true && result.gradingStatus !== "partial" && Number(result.score) >= 1
    ? "independent-correct"
    : "wrong";
}

function appendQuestionWordUsage(state, { eventId, source, taskId, question, result, occurredAt, date, assistance = "", formalEvidence = true } = {}) {
  const directWord = Boolean(question && (question.itemType === "word" || question.contentType === "word"));
  const taskValue = String(taskId || question && question.taskId || "");
  const separator = taskValue.lastIndexOf(":");
  const taskWordId = separator > 0 ? taskValue.slice(0, separator) : taskValue;
  const events = buildWordUsageEvents({
    eventId,
    source,
    taskId: taskValue || question && question.id,
    wordIds: directWord ? [question && question.wordId || taskWordId] : [],
    english: directWord ? "" : question && question.english,
    kind: directWord ? "recall" : "exposure",
    result: directWord ? wordUsageResult(result, assistance) : (assistance === "revealed" ? "revealed" : assistance === "assisted" ? "assisted" : "completed"),
    formalEvidence,
    date,
    occurredAt
  }, content, { timeZone: APP_TIMEZONE });
  const appended = appendWordUsageEvents(state.wordUsage, events, content);
  state.wordUsage = appended.state;
  return appended;
}

function saveFormalPracticeState(user, state, practice) {
  state.formalPractice = practice;
  markLearningEvidenceRepaired(state);
  userStates.users[user.id] = state;
  persistUserStates();
  return userStates.users[user.id].formalPractice;
}

function reviewBatchResponse(state) {
  return {
    batch: publicReviewBatch(state.formalPractice && state.formalPractice.review && state.formalPractice.review.current),
    state: publicFormalEvidenceState(state)
  };
}

function reviewBatchSessionDate(batch) {
  return String(batch && batch.date || today()).slice(0, 20);
}

function reviewBatchSession(state, batch) {
  const studyDate = reviewBatchSessionDate(batch);
  const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
  return sessions[studyDate] && typeof sessions[studyDate] === "object" ? sessions[studyDate] : { date: studyDate };
}

function authoritativeCompletedReviewTaskIds(state, batch) {
  const studyDate = reviewBatchSessionDate(batch);
  const formalPractice = state.formalPractice && state.formalPractice.review ? state.formalPractice : sanitizeFormalPractice(null);
  const completedHistoryTaskIds = formalPractice.review.history
    .filter(item => item.phase === "completed" && reviewBatchSessionDate(item) === studyDate)
    .flatMap(item => item.questions.map(question => question.taskId));
  const attemptTaskIds = (Array.isArray(state.attempts) ? state.attempts : [])
    .filter(item => item && item.formalEvidence === true && item.batchId && String(item.date || "").slice(0, 20) === studyDate)
    .map(item => item.taskId);
  return reviewSessionDoneTaskIds([...completedHistoryTaskIds, ...attemptTaskIds]);
}

function indexedCompletedReviewTaskIds(state, batch) {
  return reviewSessionDoneTaskIds([
    ...reviewSessionDoneTaskIds(reviewBatchSession(state, batch).doneTaskIds),
    ...authoritativeCompletedReviewTaskIds(state, batch)
  ]);
}

function formalWordMeaningConflictGrade(question, answer) {
  if (!question || question.direction !== "en-zh") return null;
  const conflicts = registeredChineseMeaningConflicts(content, question.english, answer);
  if (!conflicts.length) return null;
  const words = Array.from(new Set(conflicts.map(item => item.token)));
  const expected = prioritizeRegisteredChineseMeanings(content, question.english, question.chinese);
  const explanation = `本题必须使用正式词库登记的词义；${conflicts.map(item => `${item.token} 应优先按“${item.preferred || "词库登记义项"}”理解，不能写成“${item.hint}”`).join("；")}。`;
  return completeTranslationGrade(question.direction, question.english, answer, {
    correct: false,
    score: 0,
    gradingStatus: "incorrect",
    explanation,
    problemWords: words,
    source: "word-bank"
  }, expected);
}

function formalWordMeaningsForEnglish(english, studyDate = today()) {
  const sourceTokens = new Set(String(english || "").toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || []);
  return Object.fromEntries(content.words.flatMap(item => {
    const token = normalizeVariantEnglish(item && item.english);
    if (!token || !sourceTokens.has(token) || item.preview === true || !item.learned || String(item.learned) > String(studyDate)) return [];
    const meanings = Array.from(new Set([
      ...String(item.chinese || "").split(/[；;、]/u),
      ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])
    ].map(value => String(value || "").trim()).filter(Boolean)));
    return meanings.length ? [[token, meanings]] : [];
  }));
}

function reviewBatchWasRetired(state, batchId) {
  const requestedId = String(batchId || "").trim();
  if (!requestedId) return false;
  return Object.values(state.sessions && typeof state.sessions === "object" ? state.sessions : {}).some(session => (
    uniqueBatchIds(session && session.retiredBatchIds).includes(requestedId)
  ));
}

function retireReviewBatchState(state, batch, updatedAt, completedTaskIds = null) {
  const studyDate = reviewBatchSessionDate(batch);
  state.sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
  const retainedTaskIds = completedTaskIds === null
    ? (Array.isArray(batch && batch.questions) ? batch.questions : []).map(question => question && question.taskId)
    : completedTaskIds;
  state.sessions[studyDate] = retireReviewSession(
    reviewBatchSession(state, batch),
    batch && batch.id,
    retainedTaskIds,
    updatedAt
  );
  return state.sessions[studyDate];
}

async function gradeFormalQuestion(question, answer, route = null) {
  const wordMeaningConflict = formalWordMeaningConflictGrade(question, answer);
  if (wordMeaningConflict) return wordMeaningConflict;
  const acceptedAnswers = question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese;
  const local = localTranslationGrade(question.direction, question.english, answer, acceptedAnswers);
  if (local) return local;
  if (question.itemType === "word") {
    const explanation = "答案与本题登记的词义或拼写不一致。";
    return completeTranslationGrade(question.direction, question.english, answer, {
      correct: false,
      score: 0,
      gradingStatus: "incorrect",
      explanation,
      problemWords: [question.english],
      source: "local"
    }, question.direction === "zh-en" ? question.english : question.chinese);
  }
  if (!route) throw Object.assign(new Error("AI grading is not configured"), { statusCode: 503 });
  const sourceText = question.direction === "zh-en" ? question.chinese : question.english;
  const routed = await runAiRoute(route, config => createAiGrader(config).grade({
    answer,
    acceptedAnswers,
    direction: question.direction,
    sourceText,
    wordMeanings: formalWordMeaningsForEnglish(question.english)
  }));
  return { ...completeTranslationGrade(question.direction, question.english, answer, routed.value, question.direction === "zh-en" ? question.english : question.chinese), source: "ai" };
}

async function gradeReviewBatchQuestions(user, batch) {
  const localResults = batch.questions.map(question => formalWordMeaningConflictGrade(question, question.answer) || localTranslationGrade(
    question.direction,
    question.english,
    question.answer,
    question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese
  ));
  const needsAi = batch.questions.some((question, index) => !localResults[index] && question.itemType === "sentence");
  let route = null;
  if (needsAi) {
    if (!aiConfigured()) throw Object.assign(new Error("AI 批改暂不可用，整组答案已保留，请稍后重试"), { statusCode: 503 });
    const rate = takeAiRequest(user.id);
    if (!rate.allowed) throw Object.assign(new Error("AI 请求过于频繁，整组答案已保留，请稍后重试"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds });
    route = selectAiCandidates(aiSettings, { model: batch.model, reasoningEffort: batch.reasoningEffort });
  }
  const results = [];
  for (let index = 0; index < batch.questions.length; index += 1) {
    results.push(localResults[index] || await gradeFormalQuestion(batch.questions[index], batch.questions[index].answer, route));
  }
  return results;
}

function updateFormalSchedule(state, question, result, studyDate) {
  const previous = state.taskStates[question.taskId] && typeof state.taskStates[question.taskId] === "object" ? state.taskStates[question.taskId] : {};
  const next = { ...previous };
  next.lastReviewed = studyDate;
  next.reviewCount = (Number(previous.reviewCount) || 0) + 1;
  next.lastResult = result.correct === true;
  next.lastScore = result.score;
  next.gradingStatus = result.gradingStatus;
  if (result.gradingStatus === "partial") {
    next.level = Math.max(1, Number(previous.level) || 0);
    next.nextDue = addStudyDays(studyDate, 1);
  } else if (result.correct) {
    const intervals = [1, 3, 7, 14, 30, 60];
    next.level = Math.min((Number(previous.level) || 0) + 1, intervals.length);
    next.nextDue = addStudyDays(studyDate, intervals[Math.max(0, next.level - 1)]);
  } else {
    next.level = 0;
    next.nextDue = addStudyDays(studyDate, 1);
  }
  state.taskStates[question.taskId] = next;
}

function applyCompletedReviewBatch(user, expectedBatch, results) {
  const latest = getUserState(user);
  const practice = latest.formalPractice;
  const current = practice.review.current;
  if (!current || current.id !== expectedBatch.id) throw Object.assign(new Error("review batch changed while grading"), { statusCode: 409 });
  if (current.phase === "completed") return latest;
  if (current.gradeRequestId !== expectedBatch.gradeRequestId) throw Object.assign(new Error("review grading request changed"), { statusCode: 409 });

  const next = cloneFormalMutationState(latest);
  const nextPractice = next.formalPractice;
  const batch = nextPractice.review.current;
  const studyDate = batch.date || today();
  const completedAt = new Date().toISOString();
  const newAttempts = [];
  const newMistakes = [];
  batch.questions.forEach((question, index) => {
    const result = results[index];
    question.result = result;
    updateFormalSchedule(next, question, result, studyDate);
    const attemptId = `${batch.id}:${question.id}`;
    const prompt = question.direction === "en-zh" ? question.english : question.chinese;
    const expected = question.direction === "zh-en" ? question.english : question.chinese;
    const attempt = {
      id: attemptId,
      batchId: batch.id,
      taskId: question.taskId,
      variantId: question.variantId,
      reviewVariant: question.reviewVariant,
      date: studyDate,
      submittedAt: completedAt,
      direction: question.direction,
      prompt,
      english: question.english,
      chinese: question.chinese,
      answer: question.answer,
      correct: result.correct,
      score: result.score,
      gradingStatus: result.gradingStatus,
      expected,
      gradingSource: result.source,
      explanation: result.explanation,
      detailedExplanation: result.detailedExplanation,
      problemWords: result.problemWords,
      wordResults: result.wordResults,
      formalEvidence: true
    };
    newAttempts.push(attempt);
    appendQuestionWordUsage(next, {
      eventId: attempt.id,
      source: "review",
      taskId: question.taskId,
      question,
      result,
      occurredAt: completedAt,
      date: studyDate,
      formalEvidence: true
    });
    if (result.gradingStatus !== "correct") newMistakes.push({
      id: `mistake-${attemptId}`,
      attemptId,
      batchId: batch.id,
      taskId: question.taskId,
      variantId: question.variantId,
      reviewVariant: question.reviewVariant,
      date: studyDate,
      direction: question.direction,
      day: question.day,
      prompt,
      userAnswer: question.answer,
      correctAnswer: expected,
      note: result.detailedExplanation || result.explanation || "本次复习未完全答对。"
    });
  });
  const existingAttemptIds = new Set(next.attempts.map(item => String(item && item.id || "")));
  next.attempts = [...next.attempts, ...newAttempts.filter(item => !existingAttemptIds.has(item.id))].slice(-120);
  appendSentencePracticeEvents(next, newAttempts.filter(item => item.variantId).map(item => ({
    id: item.id,
    variantId: item.variantId,
    date: item.date,
    practicedAt: item.submittedAt,
    correct: item.correct === true && item.gradingStatus !== "partial" && Number(item.score) >= 1,
    source: "review"
  })));
  const history = next.history[studyDate] && typeof next.history[studyDate] === "object" ? { ...next.history[studyDate] } : { reviewed: 0, correct: 0 };
  history.reviewed = (Number(history.reviewed) || 0) + newAttempts.length;
  history.correct = Math.round(((Number(history.correct) || 0) + results.reduce((sum, result) => sum + result.score, 0)) * 100) / 100;
  next.history[studyDate] = history;
  const newMistakeIds = new Set(newMistakes.map(item => item.id));
  next.mistakes = [...next.mistakes.filter(item => !newMistakeIds.has(item.id)), ...newMistakes]
    .filter(item => !mistakeIsResolved(next.attempts, item && item.taskId)).slice(-80);
  const completedTaskIds = batch.questions.map(question => question.taskId);
  const existingSession = next.sessions[studyDate] && typeof next.sessions[studyDate] === "object" ? next.sessions[studyDate] : {};
  const existingTaskIds = Array.isArray(existingSession.taskIds) ? existingSession.taskIds : [];
  const existingDoneTaskIds = Array.isArray(existingSession.doneTaskIds) ? existingSession.doneTaskIds : [];
  const sessionTaskIds = reviewSessionDoneTaskIds([...existingTaskIds, ...completedTaskIds]);
  next.sessions[studyDate] = {
    ...existingSession,
    date: studyDate,
    mode: ["all", "word", "sentence"].includes(existingSession.mode) ? existingSession.mode : (batch.mode || "all"),
    taskIds: sessionTaskIds,
    doneTaskIds: reviewSessionDoneTaskIds([...existingDoneTaskIds, ...completedTaskIds]),
    index: sessionTaskIds.length,
    currentTaskId: null,
    batchId: batch.id,
    batchComplete: true,
    allowRepeat: batch.allowRepeat === true,
    updatedAt: completedAt,
    variants: existingSession.variants && typeof existingSession.variants === "object" ? existingSession.variants : {}
  };
  batch.phase = "completed";
  batch.index = Math.max(0, batch.questions.length - 1);
  batch.completedAt = completedAt;
  batch.updatedAt = completedAt;
  batch.lastError = "";
  nextPractice.updatedAt = completedAt;
  next.formalPractice = nextPractice;
  markLearningEvidenceRepaired(next);
  userStates.users[user.id] = next;
  persistUserStates();
  return userStates.users[user.id];
}

function reviewBatchHasActivity(batch) {
  if (!batch) return false;
  if (batch.phase !== "answering") return true;
  return batch.questions.some(question => Boolean(
    String(question.answer || "").trim()
    || question.result
    || question.completedAt
    || (Array.isArray(question.attempts) && question.attempts.length)
  ));
}

function ensureImmediateAttemptRequestIds(batch) {
  let changed = false;
  if (!batch || !Array.isArray(batch.questions)) return changed;
  batch.questions.forEach(question => {
    if (question.completedAt || question.attemptRequestId) return;
    question.attemptRequestId = `reviewattempt-${crypto.randomUUID()}`;
    changed = true;
  });
  return changed;
}

function immediateQuestionCompleted(question) {
  const result = sanitizeReviewResult(question && question.result);
  return Boolean(question && question.completedAt && result && result.correct === true && result.gradingStatus === "correct" && Number(result.score) >= 1);
}

async function gradeImmediateReviewQuestion(user, batch, question, answer) {
  const local = formalWordMeaningConflictGrade(question, answer) || localTranslationGrade(
    question.direction,
    question.english,
    answer,
    question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese
  );
  if (local) return local;
  if (question.itemType !== "sentence") return gradeFormalQuestion(question, answer);
  if (!aiConfigured()) throw Object.assign(new Error("AI 批改暂不可用，本题尚未记分，请稍后重试"), { statusCode: 503 });
  const rate = takeAiRequest(user.id);
  if (!rate.allowed) throw Object.assign(new Error("AI 请求过于频繁，本题尚未记分，请稍后重试"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds });
  const route = selectAiCandidates(aiSettings, { model: batch.model, reasoningEffort: batch.reasoningEffort });
  return gradeFormalQuestion(question, answer, route);
}

function findImmediateAttempt(batch, attemptId) {
  for (const question of batch && Array.isArray(batch.questions) ? batch.questions : []) {
    const attempt = (Array.isArray(question.attempts) ? question.attempts : []).find(item => item.id === attemptId);
    if (attempt) return { question, attempt };
  }
  return null;
}

function applyImmediateReviewAttempt(user, expectedBatch, questionId, attemptId, answer, rawResult) {
  const latest = getUserState(user);
  const practice = latest.formalPractice;
  const current = practice.review.current;
  if (!current || current.id !== expectedBatch.id) throw Object.assign(new Error("review batch changed while grading"), { statusCode: 409 });
  const existing = findImmediateAttempt(current, attemptId);
  if (existing) {
    if (existing.question.id !== questionId || existing.attempt.answer !== answer) {
      throw Object.assign(new Error("同一提交标识不能改写为另一份答案"), { statusCode: 409 });
    }
    return { state: latest, reused: true };
  }
  if (current.gradingMode !== "immediate" || current.phase !== "answering") throw Object.assign(new Error("当前题组不是逐题批改作答阶段"), { statusCode: 409 });
  const currentQuestion = current.questions[current.index];
  if (!currentQuestion || currentQuestion.id !== questionId) throw Object.assign(new Error("review question changed"), { statusCode: 409 });
  if (currentQuestion.attemptRequestId !== attemptId) throw Object.assign(new Error("本题提交标识已更新，请使用恢复后的当前题目重试"), { statusCode: 409 });

  const result = sanitizeReviewResult(rawResult);
  if (!result) throw Object.assign(new Error("review grade is invalid"), { statusCode: 503 });
  const next = cloneFormalMutationState(latest);
  const nextPractice = next.formalPractice;
  const batch = nextPractice.review.current;
  const question = batch.questions[batch.index];
  const submittedAt = new Date().toISOString();
  const studyDate = batch.date || today();
  const prompt = question.direction === "en-zh" ? question.english : question.chinese;
  const expected = question.direction === "zh-en" ? question.english : question.chinese;
  const attempt = {
    id: attemptId,
    batchId: batch.id,
    taskId: question.taskId,
    variantId: question.variantId,
    reviewVariant: question.reviewVariant,
    date: studyDate,
    submittedAt,
    direction: question.direction,
    prompt,
    english: question.english,
    chinese: question.chinese,
    answer,
    correct: result.correct,
    score: result.score,
    gradingStatus: result.gradingStatus,
    expected,
    gradingSource: result.source,
    explanation: result.explanation,
    detailedExplanation: result.detailedExplanation,
    problemWords: result.problemWords,
    wordResults: result.wordResults,
    formalEvidence: true
  };

  updateFormalSchedule(next, question, result, studyDate);
  const existingAttemptIds = new Set(next.attempts.map(item => String(item && item.id || "")));
  if (!existingAttemptIds.has(attempt.id)) next.attempts = [...next.attempts, attempt].slice(-120);
  appendQuestionWordUsage(next, {
    eventId: attempt.id,
    source: "review",
    taskId: question.taskId,
    question,
    result,
    occurredAt: submittedAt,
    date: studyDate,
    formalEvidence: true
  });
  if (question.variantId) appendSentencePracticeEvents(next, [{
    id: attempt.id,
    variantId: question.variantId,
    date: studyDate,
    practicedAt: submittedAt,
    correct: result.correct === true && result.gradingStatus !== "partial" && Number(result.score) >= 1,
    source: "review"
  }]);
  const history = next.history[studyDate] && typeof next.history[studyDate] === "object" ? { ...next.history[studyDate] } : { reviewed: 0, correct: 0 };
  history.reviewed = (Number(history.reviewed) || 0) + 1;
  history.correct = Math.round(((Number(history.correct) || 0) + Number(result.score || 0)) * 100) / 100;
  next.history[studyDate] = history;

  const mistakeId = `mistake-${batch.id}:${question.id}`;
  if (result.gradingStatus !== "correct") {
    next.mistakes = [...next.mistakes.filter(item => item && item.id !== mistakeId), {
      id: mistakeId,
      attemptId,
      batchId: batch.id,
      taskId: question.taskId,
      variantId: question.variantId,
      reviewVariant: question.reviewVariant,
      date: studyDate,
      direction: question.direction,
      day: question.day,
      prompt,
      userAnswer: answer,
      correctAnswer: expected,
      note: result.detailedExplanation || result.explanation || "本次复习未完全答对。"
    }];
  }
  next.mistakes = next.mistakes.filter(item => !mistakeIsResolved(next.attempts, item && item.taskId)).slice(-80);

  question.answer = answer;
  question.draftUpdatedAt = submittedAt;
  question.result = result;
  question.attempts = [...question.attempts, { id: attemptId, answer, result, submittedAt }].slice(-20);
  if (result.correct === true && result.gradingStatus === "correct" && Number(result.score) >= 1) {
    question.completedAt = submittedAt;
    question.attemptRequestId = "";
  } else {
    question.completedAt = "";
    question.attemptRequestId = `reviewattempt-${crypto.randomUUID()}`;
  }
  batch.updatedAt = submittedAt;
  batch.lastError = "";
  nextPractice.updatedAt = submittedAt;
  next.formalPractice = nextPractice;
  markLearningEvidenceRepaired(next);
  userStates.users[user.id] = next;
  persistUserStates();
  return { state: userStates.users[user.id], reused: false };
}

function advanceImmediateReviewQuestion(user, expectedBatchId, questionId) {
  const latest = getUserState(user);
  const practice = latest.formalPractice;
  const current = practice.review.current;
  if (!current || current.id !== expectedBatchId) throw Object.assign(new Error("review batch not found"), { statusCode: 404 });
  if (current.gradingMode !== "immediate") throw Object.assign(new Error("当前题组不是逐题批改模式"), { statusCode: 409 });
  const requestedIndex = current.questions.findIndex(question => question.id === questionId);
  if (requestedIndex < 0) throw Object.assign(new Error("review question not found"), { statusCode: 404 });
  if (current.phase === "completed" || requestedIndex < current.index) return { state: latest, reused: true };
  if (current.phase !== "answering" || requestedIndex !== current.index) throw Object.assign(new Error("review question changed"), { statusCode: 409 });
  if (!immediateQuestionCompleted(current.questions[requestedIndex])) throw Object.assign(new Error("本题尚未完全答对，请先完成订正"), { statusCode: 409 });

  const next = cloneFormalMutationState(latest);
  const nextPractice = next.formalPractice;
  const batch = nextPractice.review.current;
  const question = batch.questions[requestedIndex];
  const now = new Date().toISOString();
  const studyDate = batch.date || today();
  const last = requestedIndex >= batch.questions.length - 1;
  const existingSession = next.sessions[studyDate] && typeof next.sessions[studyDate] === "object" ? next.sessions[studyDate] : {};
  const taskIds = batch.questions.map(item => item.taskId);
  const doneTaskIds = reviewSessionDoneTaskIds([...(Array.isArray(existingSession.doneTaskIds) ? existingSession.doneTaskIds : []), question.taskId]);

  if (last) {
    batch.phase = "completed";
    batch.completedAt = now;
    batch.index = Math.max(0, batch.questions.length - 1);
  } else {
    batch.index = requestedIndex + 1;
    ensureImmediateAttemptRequestIds(batch);
  }
  batch.updatedAt = now;
  batch.lastError = "";
  next.sessions[studyDate] = {
    ...existingSession,
    date: studyDate,
    mode: batch.mode,
    taskIds,
    doneTaskIds,
    index: last ? taskIds.length : batch.index,
    currentTaskId: last ? null : (taskIds[batch.index] || null),
    batchId: batch.id,
    batchComplete: last,
    allowRepeat: batch.allowRepeat === true,
    updatedAt: now,
    variants: existingSession.variants && typeof existingSession.variants === "object" ? existingSession.variants : {}
  };
  nextPractice.updatedAt = now;
  next.formalPractice = nextPractice;
  markLearningEvidenceRepaired(next);
  userStates.users[user.id] = next;
  persistUserStates();
  return { state: userStates.users[user.id], reused: false };
}

function handleReviewBatches(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  const suffix = url.pathname.slice("/api/review/batches".length) || "/";
  if (req.method === "GET" && suffix === "/") return sendJson(res, 200, reviewBatchResponse(getUserState(user)));
  return readBody(req).then(body => withFormalPracticeLock(user.id, async () => {
    const state = getUserState(user);
    const practice = cloneFormalPractice(state.formalPractice);
    const now = new Date().toISOString();
    if (suffix === "/mode" && req.method === "POST") {
      const gradingMode = ["group", "immediate"].includes(body.gradingMode) ? body.gradingMode : "";
      if (!gradingMode) return sendError(res, 400, "批改模式不正确");
      const current = practice.review.current;
      const locked = reviewBatchHasActivity(current);
      practice.review.gradingMode = gradingMode;
      if (current && !locked) {
        current.gradingMode = gradingMode;
        if (gradingMode === "immediate") ensureImmediateAttemptRequestIds(current);
        current.updatedAt = now;
      }
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      const saved = getUserState(user);
      return sendJson(res, 200, {
        gradingMode,
        appliesTo: current && !locked ? "current" : "next",
        batch: publicReviewBatch(saved.formalPractice.review.current),
        state: publicReviewState(saved)
      });
    }
    if (suffix === "/start" && req.method === "POST") {
      const requestedId = String(body.batchId || "").trim().slice(0, 180) || `reviewbatch-${crypto.randomUUID()}`;
      const current = practice.review.current;
      if (current && current.id === requestedId) return sendJson(res, 200, { batch: publicReviewBatch(current), reused: true });
      if (current && current.phase !== "completed") return sendJson(res, 409, { error: "已有未完成的今日复习题组", batch: publicReviewBatch(current) });
      const taskIds = Array.from(new Set((Array.isArray(body.taskIds) ? body.taskIds : []).map(item => String(item || "").trim()).filter(Boolean))).slice(0, 100);
      if (!taskIds.length) return sendError(res, 400, "review task IDs are required");
      const studyDate = String(body.date || today()).slice(0, 20);
      const allowRepeat = body.allowRepeat === true;
      const completed = new Set(indexedCompletedReviewTaskIds(state, { date: studyDate }));
      const alreadyCompleted = taskIds.filter(taskId => completed.has(taskId));
      if (!allowRepeat && alreadyCompleted.length) {
        return sendJson(res, 409, {
          code: "review_tasks_already_completed",
          error: "这组题包含今天已经完成的内容，已阻止重复建组",
          completedTaskIds: alreadyCompleted,
          state: publicFormalEvidenceState(state)
        });
      }
      refreshContent();
      const variantIds = body.variantIds && typeof body.variantIds === "object" ? body.variantIds : {};
      const questions = taskIds.map(taskId => reviewQuestionSnapshot(user, taskId, variantIds[taskId]));
      const batch = createReviewBatch(questions, {
        id: requestedId,
        date: studyDate,
        mode: body.mode,
        gradingMode: practice.review.gradingMode,
        allowRepeat,
        model: body.model,
        reasoningEffort: body.reasoningEffort
      });
      if (current && current.phase === "completed") practice.review.history = [...practice.review.history, current].slice(-40);
      practice.review.current = batch;
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      return sendJson(res, 201, { batch: publicReviewBatch(batch), reused: false });
    }
    const requestedBatchId = String(body.batchId || "").trim().slice(0, 180);
    if (suffix === "/archive" && req.method === "POST") {
      const current = practice.review.current;
      if (!current) {
        if (reviewBatchWasRetired(state, requestedBatchId)) return sendJson(res, 200, { batch: null, archivedBatchId: requestedBatchId, reused: true, state: publicFormalEvidenceState(state) });
        const archived = practice.review.history.find(item => item.id === requestedBatchId && item.phase === "completed");
        if (!archived) return sendError(res, 404, "review batch not found");
        retireReviewBatchState(state, archived, now);
        saveFormalPracticeState(user, state, practice);
        const saved = getUserState(user);
        return sendJson(res, 200, { batch: null, archivedBatchId: requestedBatchId, reused: true, state: publicFormalEvidenceState(saved) });
      }
      if (current.id !== requestedBatchId) return sendJson(res, 409, { error: "另一个复习题组正在进行", batch: publicReviewBatch(current) });
      if (current.phase !== "completed") return sendJson(res, 409, { error: "题组尚未完成", batch: publicReviewBatch(current) });
      practice.review.history = [...practice.review.history, current].filter((item, index, items) => items.findIndex(candidate => candidate.id === item.id) === index).slice(-40);
      practice.review.current = null;
      retireReviewBatchState(state, current, now);
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      const saved = getUserState(user);
      return sendJson(res, 200, { batch: null, archivedBatchId: requestedBatchId, reused: false, state: publicFormalEvidenceState(saved) });
    }
    if (suffix === "/resolve-repeat" && req.method === "POST") {
      const batch = practice.review.current;
      if (!batch || batch.id !== requestedBatchId) {
        if (reviewBatchWasRetired(state, requestedBatchId)) return sendJson(res, 200, { batch: publicReviewBatch(batch), retiredBatchId: requestedBatchId, reused: true, state: publicFormalEvidenceState(state) });
        return sendError(res, 404, "review batch not found");
      }
      const action = String(body.action || "");
      if (!["continue", "discard"].includes(action)) return sendError(res, 400, "repeat resolution action is required");
      const explicitDiscard = action === "discard" && body.confirmDiscard === true;
      const explicitChoice = action === "continue" || explicitDiscard;
      if (batch.gradingMode === "immediate" && !explicitChoice) return sendJson(res, 409, {
        code: "review_repeat_requires_explicit_choice",
        error: "逐题批改题组包含独立正式尝试，请明确选择继续当前草稿或放弃草稿并换新题",
        requiresConfirmation: true,
        batch: publicReviewBatch(batch),
        state: publicFormalEvidenceState(state)
      });
      const completedTaskIds = authoritativeCompletedReviewTaskIds(state, batch);
      const repeated = classifyRepeatedReviewBatch(batch, completedTaskIds);
      if (!repeated) return sendJson(res, 409, {
        code: "review_repeat_not_confirmed",
        error: "服务器没有找到这组题已经正式完成的完整证据，已保留题组且未作任何改动",
        batch: publicReviewBatch(batch),
        state: publicFormalEvidenceState(state)
      });
      if (action === "continue") {
        if (repeated.kind !== "draft") return sendJson(res, 409, { error: "空白重复组应直接换成新题", batch: publicReviewBatch(batch) });
        const previousBatchId = batch.id;
        const nextBatchId = `reviewbatch-${crypto.randomUUID()}`;
        const studyDate = reviewBatchSessionDate(batch);
        const session = reviewBatchSession(state, batch);
        const taskIds = batch.questions.map(question => question.taskId);
        batch.id = nextBatchId;
        batch.allowRepeat = true;
        batch.recoveredFromBatchId = previousBatchId;
        batch.updatedAt = now;
        practice.updatedAt = now;
        state.sessions = state.sessions && typeof state.sessions === "object" ? state.sessions : {};
        state.sessions[studyDate] = {
          ...session,
          date: studyDate,
          mode: batch.mode,
          taskIds,
          index: batch.index,
          doneTaskIds: reviewSessionDoneTaskIds([...reviewSessionDoneTaskIds(session.doneTaskIds), ...completedTaskIds]),
          currentTaskId: taskIds[batch.index] || null,
          batchId: nextBatchId,
          batchComplete: false,
          allowRepeat: true,
          retiredBatchIds: uniqueBatchIds([...(Array.isArray(session.retiredBatchIds) ? session.retiredBatchIds : []), previousBatchId]),
          updatedAt: now,
          variants: session.variants && typeof session.variants === "object" ? session.variants : {}
        };
        saveFormalPracticeState(user, state, practice);
        const saved = getUserState(user);
        return sendJson(res, 200, { batch: publicReviewBatch(saved.formalPractice.review.current), previousBatchId, reused: false, state: publicFormalEvidenceState(saved) });
      }
      if (action !== "discard") return sendError(res, 400, "repeat resolution action is required");
      if (repeated.kind === "draft" && body.confirmDiscard !== true) {
        return sendJson(res, 409, { error: "这组已有草稿，请明确选择继续或放弃", requiresConfirmation: true, batch: publicReviewBatch(batch) });
      }
      practice.review.current = null;
      practice.updatedAt = now;
      retireReviewBatchState(state, batch, now, completedTaskIds);
      saveFormalPracticeState(user, state, practice);
      const saved = getUserState(user);
      return sendJson(res, 200, { batch: null, retiredBatchId: requestedBatchId, reused: false, state: publicFormalEvidenceState(saved) });
    }
    const batch = practice.review.current;
    if (!batch || batch.id !== String(body.batchId || "")) return sendError(res, 404, "review batch not found");
    if (suffix === "/answer" && req.method === "POST") {
      if (batch.gradingMode !== "immediate") return sendJson(res, 409, { error: "当前题组使用整组批改", batch: publicReviewBatch(batch) });
      const questionId = String(body.questionId || "").trim().slice(0, 180);
      const attemptId = String(body.attemptRequestId || "").trim().slice(0, 180);
      const answer = String(body.answer || "").trim().slice(0, MAX_AI_ANSWER_LENGTH);
      if (!questionId || !attemptId) return sendError(res, 400, "本题提交标识不完整");
      const duplicate = findImmediateAttempt(batch, attemptId);
      if (duplicate) {
        if (duplicate.question.id !== questionId || duplicate.attempt.answer !== answer) return sendJson(res, 409, { error: "同一提交标识不能改写为另一份答案", batch: publicReviewBatch(batch) });
        return sendJson(res, 200, { batch: publicReviewBatch(batch), reused: true, state: publicFormalEvidenceState(state) });
      }
      if (!answer) return sendJson(res, 400, { error: "请先填写本题答案", batch: publicReviewBatch(batch) });
      if (batch.phase !== "answering" || !batch.questions[batch.index] || batch.questions[batch.index].id !== questionId) return sendJson(res, 409, { error: "当前题目已经变化，请按恢复后的题目继续", batch: publicReviewBatch(batch) });
      if (batch.questions[batch.index].attemptRequestId !== attemptId) return sendJson(res, 409, { error: "本题提交标识已更新，请按恢复后的题目继续", batch: publicReviewBatch(batch) });
      try {
        const result = await gradeImmediateReviewQuestion(user, batch, batch.questions[batch.index], answer);
        const applied = applyImmediateReviewAttempt(user, batch, questionId, attemptId, answer, result);
        return sendJson(res, 200, {
          batch: publicReviewBatch(applied.state.formalPractice.review.current),
          reused: applied.reused,
          state: publicFormalEvidenceState(applied.state)
        });
      } catch (error) {
        const latest = getUserState(user);
        const failedPractice = cloneFormalPractice(latest.formalPractice);
        const failedBatch = failedPractice.review.current;
        if (failedBatch && failedBatch.id === batch.id && failedBatch.phase === "answering") {
          failedBatch.lastError = String(error && error.message || "本题批改暂不可用，答案尚未记分，请稍后重试").slice(0, 300);
          failedBatch.updatedAt = new Date().toISOString();
          failedPractice.updatedAt = failedBatch.updatedAt;
          saveFormalPracticeState(user, latest, failedPractice);
        }
        const status = error && [400, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
        return sendJson(res, status, {
          error: String(error && error.message || "本题批改暂不可用，答案尚未记分，请稍后重试"),
          batch: publicReviewBatch(getUserState(user).formalPractice.review.current)
        }, error && error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
      }
    }
    if (suffix === "/advance" && req.method === "POST") {
      if (batch.gradingMode !== "immediate") return sendJson(res, 409, { error: "当前题组使用整组批改", batch: publicReviewBatch(batch) });
      const advanced = advanceImmediateReviewQuestion(user, batch.id, String(body.questionId || "").trim().slice(0, 180));
      return sendJson(res, 200, {
        batch: publicReviewBatch(advanced.state.formalPractice.review.current),
        reused: advanced.reused,
        state: publicFormalEvidenceState(advanced.state)
      });
    }
    if (suffix === "/draft" && req.method === "PUT") {
      if (batch.gradingMode !== "group") return sendJson(res, 409, { error: "逐题批改不保存整组草稿", batch: publicReviewBatch(batch) });
      if (batch.phase !== "answering") return sendJson(res, 409, { error: "当前题组不在作答阶段", batch: publicReviewBatch(batch) });
      const index = Math.min(Math.max(Number(body.index) || 0, 0), batch.questions.length - 1);
      const question = batch.questions[index];
      if (body.questionId && String(body.questionId) !== question.id) return sendError(res, 409, "review question changed");
      question.answer = String(body.answer || "").trim().slice(0, MAX_AI_ANSWER_LENGTH);
      question.draftUpdatedAt = now;
      batch.index = Object.hasOwn(body, "nextIndex")
        ? Math.min(Math.max(Number(body.nextIndex) || 0, 0), batch.questions.length - 1)
        : index;
      batch.updatedAt = now;
      batch.lastError = "";
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      return sendJson(res, 200, { batch: publicReviewBatch(batch) });
    }
    if (suffix === "/edit" && req.method === "POST") {
      if (batch.gradingMode !== "group") return sendJson(res, 409, { error: "逐题批改不能进入整组修改", batch: publicReviewBatch(batch) });
      if (batch.phase === "completed") return sendJson(res, 409, { error: "题组已经完成批改", batch: publicReviewBatch(batch) });
      batch.phase = "answering";
      batch.index = Math.min(Math.max(Number(body.index) || 0, 0), batch.questions.length - 1);
      batch.updatedAt = now;
      batch.lastError = "";
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      return sendJson(res, 200, { batch: publicReviewBatch(batch) });
    }
    if (suffix === "/review" && req.method === "POST") {
      if (batch.gradingMode !== "group") return sendJson(res, 409, { error: "逐题批改不进入整组核对", batch: publicReviewBatch(batch) });
      if (batch.phase === "completed") return sendJson(res, 200, { batch: publicReviewBatch(batch), reused: true });
      const missingIndex = batch.questions.findIndex(question => !question.answer.trim());
      if (missingIndex >= 0) {
        batch.phase = "answering";
        batch.index = missingIndex;
        batch.updatedAt = now;
        practice.updatedAt = now;
        saveFormalPracticeState(user, state, practice);
        return sendJson(res, 409, { error: `第 ${missingIndex + 1} 题还没有作答`, missingIndex, batch: publicReviewBatch(batch) });
      }
      batch.phase = "review";
      batch.reviewOpenedAt = batch.reviewOpenedAt || now;
      batch.gradeRequestId = batch.gradeRequestId || `reviewgrade-${crypto.randomUUID()}`;
      batch.updatedAt = now;
      batch.lastError = "";
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      return sendJson(res, 200, { batch: publicReviewBatch(batch) });
    }
    if (suffix === "/grade" && req.method === "POST") {
      if (batch.gradingMode !== "group") return sendJson(res, 409, { error: "逐题批改不能调用整组批改", batch: publicReviewBatch(batch) });
      if (batch.phase === "completed") return sendJson(res, 200, { batch: publicReviewBatch(batch), reused: true, state: publicFormalEvidenceState(state) });
      if (!["review", "grading"].includes(batch.phase)) return sendJson(res, 409, { error: "请先核对整组答案", batch: publicReviewBatch(batch) });
      const requestId = String(body.gradeRequestId || batch.gradeRequestId || "").trim();
      if (!requestId || (batch.gradeRequestId && batch.gradeRequestId !== requestId)) return sendJson(res, 409, { error: "批改请求标识不一致", batch: publicReviewBatch(batch) });
      batch.phase = "grading";
      batch.gradeRequestId = requestId;
      batch.gradingStartedAt = batch.gradingStartedAt || now;
      batch.updatedAt = now;
      batch.lastError = "";
      practice.updatedAt = now;
      saveFormalPracticeState(user, state, practice);
      try {
        const results = await gradeReviewBatchQuestions(user, batch);
        const saved = applyCompletedReviewBatch(user, batch, results);
        return sendJson(res, 200, { batch: publicReviewBatch(saved.formalPractice.review.current), reused: false, state: publicFormalEvidenceState(saved) });
      } catch (error) {
        const latest = getUserState(user);
        const failedPractice = cloneFormalPractice(latest.formalPractice);
        if (failedPractice.review.current && failedPractice.review.current.id === batch.id && failedPractice.review.current.phase !== "completed") {
          failedPractice.review.current.phase = "review";
          failedPractice.review.current.lastError = String(error && error.message || "AI 批改暂不可用，整组答案已保留，请稍后重试").slice(0, 300);
          failedPractice.review.current.updatedAt = new Date().toISOString();
          failedPractice.updatedAt = failedPractice.review.current.updatedAt;
          saveFormalPracticeState(user, latest, failedPractice);
        }
        const status = error && [400, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
        return sendJson(res, status, { error: String(error && error.message || "AI 批改暂不可用，整组答案已保留，请稍后重试"), batch: publicReviewBatch(failedPractice.review.current) }, error && error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
      }
    }
    return sendError(res, 404, "review batch endpoint not found");
  }, `review-batch:${suffix}`)).catch(error => sendError(res, error.statusCode || 400, error.message));
}

function saveAiQuestionResult(state, setId, questionId, answer, result) {
  const practice = sanitizeAiPractice(state.aiPractice);
  const set = practice.currentSet;
  if (!set || set.id !== setId) throw Object.assign(new Error("AI question set not found"), { statusCode: 404 });
  const question = set.questions.find(item => item.id === questionId);
  if (!question) throw Object.assign(new Error("AI question not found"), { statusCode: 404 });
  const now = new Date().toISOString();
  const correctAnswer = question.direction === "zh-en" ? question.english : question.chinese;
  const detailedExplanation = result.detailedExplanation || buildTranslationExplanation({
    direction: question.direction,
    referenceAnswer: correctAnswer,
    answer,
    correct: result.correct === true,
    gradingStatus: result.gradingStatus,
    explanation: result.explanation,
    problemWords: result.problemWords
  });
  question.userAnswer = answer;
  question.correct = result.correct;
  question.score = result.score;
  question.gradingStatus = result.gradingStatus;
  question.problemWords = result.problemWords;
  question.wordResults = result.wordResults;
  question.explanation = result.explanation;
  question.detailedExplanation = detailedExplanation;
  question.answeredAt = now;
  const prompt = question.direction === "en-zh" ? question.english : question.chinese;
  const historyId = `${set.id}:${question.id}`;
  const questionNumber = set.questions.findIndex(item => item.id === question.id) + 1;
  practice.history = [...practice.history.filter(item => item.id !== historyId), {
    id: historyId,
    setId: set.id,
    setCreatedAt: set.createdAt,
    answeredAt: now,
    date: today(),
    providerId: set.providerId,
    providerName: set.providerName,
    model: set.model,
    reasoningEffort: set.reasoningEffort,
    questionNumber,
    questionCount: set.questions.length,
    contentType: question.contentType,
    wordId: question.wordId,
    direction: question.direction,
    prompt,
    userAnswer: answer,
    correctAnswer,
    correct: result.correct,
    score: result.score,
    gradingStatus: result.gradingStatus,
    problemWords: result.problemWords,
    wordResults: result.wordResults,
    focus: question.focus,
    explanation: result.explanation,
    detailedExplanation
  }].slice(-MAX_AI_HISTORY);
  practice.updatedAt = now;
  state.aiPractice = practice;
  persistUserStates();
  return question;
}

async function gradeAiQuestionSet(user, set) {
  const localResults = set.questions.map(question => formalWordMeaningConflictGrade(question, question.userAnswer) || localTranslationGrade(
    question.direction,
    question.english,
    question.userAnswer,
    question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese
  ));
  const needsAi = localResults.some((result, index) => !result && set.questions[index].contentType !== "word");
  let route = null;
  if (needsAi) {
    if (!aiConfigured()) throw Object.assign(new Error("AI 批改暂不可用，整组答案已保留，请稍后重试"), { statusCode: 503 });
    const rate = takeAiRequest(user.id);
    if (!rate.allowed) throw Object.assign(new Error("AI 请求过于频繁，整组答案已保留，请稍后重试"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds });
    route = selectAiCandidates(aiSettings, { model: set.model, reasoningEffort: set.reasoningEffort });
  }
  const results = [];
  for (let index = 0; index < set.questions.length; index += 1) {
    const question = set.questions[index];
    results.push(localResults[index] || await gradeFormalQuestion({ ...question, itemType: question.contentType === "word" ? "word" : "sentence" }, question.userAnswer, route));
  }
  return results;
}

function applyCompletedAiQuestionSet(user, expectedSet, results) {
  const latest = getUserState(user);
  const practice = sanitizeAiPractice(latest.aiPractice);
  const set = practice.currentSet;
  if (!set || set.id !== expectedSet.id) throw Object.assign(new Error("AI question set changed while grading"), { statusCode: 409 });
  if (set.phase === "completed") return latest;
  if (set.gradeRequestId !== expectedSet.gradeRequestId) throw Object.assign(new Error("AI grading request changed"), { statusCode: 409 });
  const completedAt = new Date().toISOString();
  const nextHistory = [];
  set.questions.forEach((question, index) => {
    const result = results[index];
    const correctAnswer = question.direction === "zh-en" ? question.english : question.chinese;
    const prompt = question.direction === "en-zh" ? question.english : question.chinese;
    question.correct = result.correct;
    question.score = result.score;
    question.gradingStatus = result.gradingStatus;
    question.problemWords = result.problemWords;
    question.wordResults = result.wordResults;
    question.explanation = result.explanation;
    question.detailedExplanation = result.detailedExplanation || buildTranslationExplanation({
      direction: question.direction,
      referenceAnswer: correctAnswer,
      answer: question.userAnswer,
      correct: result.correct,
      gradingStatus: result.gradingStatus,
      explanation: result.explanation,
      problemWords: result.problemWords
    });
    question.answeredAt = completedAt;
    nextHistory.push({
      id: `${set.id}:${question.id}`,
      setId: set.id,
      setCreatedAt: set.createdAt,
      answeredAt: completedAt,
      date: today(),
      providerId: set.providerId,
      providerName: set.providerName,
      model: set.model,
      reasoningEffort: set.reasoningEffort,
      questionNumber: index + 1,
      questionCount: set.questions.length,
      poolVariantId: question.poolVariantId,
      contentType: question.contentType,
      wordId: question.wordId,
      direction: question.direction,
      prompt,
      userAnswer: question.userAnswer,
      correctAnswer,
      correct: result.correct,
      score: result.score,
      gradingStatus: result.gradingStatus,
      problemWords: result.problemWords,
      wordResults: result.wordResults,
      focus: question.focus,
      explanation: result.explanation,
      detailedExplanation: question.detailedExplanation,
      batchId: set.batchId,
      formalEvidence: true
    });
    appendQuestionWordUsage(latest, {
      eventId: `${set.id}:${question.id}`,
      source: "ai",
      taskId: question.wordId || question.id,
      question,
      result,
      occurredAt: completedAt,
      date: today(),
      formalEvidence: true
    });
  });
  const resultIds = new Set(nextHistory.map(item => item.id));
  practice.history = [...practice.history.filter(item => !resultIds.has(item.id)), ...nextHistory].slice(-MAX_AI_HISTORY);
  appendSentencePracticeEvents(latest, nextHistory.filter(item => item.poolVariantId).map(item => ({
    id: item.id,
    variantId: item.poolVariantId,
    date: item.date,
    practicedAt: item.answeredAt,
    correct: item.correct === true && item.gradingStatus !== "partial" && Number(item.score) >= 1,
    source: "ai"
  })));
  set.phase = "completed";
  set.completed = true;
  set.index = set.questions.length;
  set.completedAt = completedAt;
  set.updatedAt = completedAt;
  set.lastError = "";
  practice.updatedAt = completedAt;
  latest.aiPractice = practice;
  userStates.users[user.id] = sanitizeState(latest);
  persistUserStates();
  return userStates.users[user.id];
}

function compactRecoveryText(value) {
  return String(value || "").toLocaleLowerCase().normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, "");
}

function recoveryPromptMatches(direction, prompt, source) {
  if (direction === "en-zh") return normalizeVariantEnglish(prompt) === normalizeVariantEnglish(source.english);
  const accepted = Array.from(new Set([source.chinese, ...(Array.isArray(source.acceptedChinese) ? source.acceptedChinese : [])].filter(Boolean)));
  return accepted.some(answer => compactRecoveryText(answer) === compactRecoveryText(prompt));
}

function legacyOfflineAiQuestion(state, value, allowedWords) {
  const source = value && typeof value === "object" ? value : {};
  const id = String(source.id || "").trim().slice(0, 80);
  const direction = source.direction === "zh-en" ? "zh-en" : "en-zh";
  const prompt = String(source.prompt || "").trim().slice(0, 300);
  if (!id || !prompt) throw Object.assign(new Error("本机旧题组快照缺少稳定题目 ID 或题干，不能自动恢复"), { statusCode: 422 });
  let authoritative = null;
  if (source.contentType === "word" || source.wordId) {
    const item = content.words.find(word => word.id === String(source.wordId || "") && word.preview !== true && word.learned && String(word.learned) <= today());
    if (item && recoveryPromptMatches(direction, prompt, item)) {
      authoritative = {
        contentType: "word",
        wordId: item.id,
        direction,
        english: item.english,
        chinese: item.chinese,
        acceptedEnglish: [item.english],
        acceptedChinese: Array.from(new Set([item.chinese, ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])])).filter(Boolean).slice(0, 16)
      };
    }
  } else {
    const pool = sanitizeReviewVariantPool(state.reviewVariantPool);
    const poolId = String(source.poolVariantId || "").trim();
    const candidates = [
      ...content.sentences.filter(item => item.preview !== true && item.learned && String(item.learned) <= today()),
      ...pool.variants
    ].filter(item => item && item.english && item.chinese && (!poolId || String(item.id || "") === poolId));
    const matching = candidates.filter(item => recoveryPromptMatches(direction, prompt, item) && previewEnglishTokens(item.english).every(token => allowedWords.has(token)));
    const unique = new Map(matching.map(item => [`${normalizeVariantEnglish(item.english)}\0${compactRecoveryText(item.chinese)}`, item]));
    if (unique.size === 1) {
      const item = Array.from(unique.values())[0];
      authoritative = {
        contentType: "sentence",
        poolVariantId: poolId && String(item.id || "") === poolId ? poolId : "",
        direction,
        english: item.english,
        chinese: item.chinese,
        acceptedEnglish: Array.from(new Set([item.english, ...(Array.isArray(item.acceptedEnglish) ? item.acceptedEnglish : [])])).filter(Boolean).slice(0, 8),
        acceptedChinese: expandRegisteredChineseAnswers(content, item.english, [item.chinese, ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])], 16)
      };
    }
  }
  if (!authoritative) throw Object.assign(new Error("本机旧题组无法与当前已学词句安全核对，请保留草稿并重新准备离线包"), { statusCode: 422 });
  return {
    id,
    ...authoritative,
    userAnswer: String(source.userAnswer || "").trim().slice(0, MAX_AI_ANSWER_LENGTH),
    correct: null,
    score: null,
    gradingStatus: "",
    problemWords: [],
    wordResults: [],
    explanation: "",
    detailedExplanation: "",
    answeredAt: ""
  };
}

function legacyOfflineAiSet(state, value, expectedSetId) {
  const source = value && typeof value === "object" ? value : {};
  const questions = Array.isArray(source.questions) ? source.questions : [];
  if (String(source.id || "") !== expectedSetId || !questions.length || questions.length > 10) throw Object.assign(new Error("本机旧题组快照不完整，不能自动恢复"), { statusCode: 422 });
  const allowedWords = new Set(buildLearningProfile(content, state, today()).allowedWords);
  const recoveredQuestions = questions.map(question => legacyOfflineAiQuestion(state, question, allowedWords));
  if (new Set(recoveredQuestions.map(question => question.id)).size !== recoveredQuestions.length) throw Object.assign(new Error("本机旧题组题目 ID 重复，不能自动恢复"), { statusCode: 422 });
  return sanitizeQuestionSet({
    ...source,
    id: expectedSetId,
    questions: recoveredQuestions,
    completed: false,
    phase: ["answering", "review", "grading"].includes(source.phase) ? source.phase : "answering"
  });
}

function offlineAiRecoveryPhase(localPhase, operationPath) {
  const pathName = String(operationPath || "").trim();
  if (["/api/ai/questions/batch/draft", "/api/ai/questions/batch/edit", "/api/ai/questions/batch/review"].includes(pathName)) return "answering";
  if (pathName === "/api/ai/questions/batch/grade") return "review";
  throw Object.assign(new Error("离线题组恢复请求缺少可核验的 FIFO 操作阶段"), { statusCode: 422 });
}

function overlayOfflineAiSetProgress(authoritativeValue, localValue, expectedSetId, operationPath) {
  const authoritative = sanitizeQuestionSet(authoritativeValue);
  const local = localValue && typeof localValue === "object" ? localValue : {};
  if (!authoritative || authoritative.id !== expectedSetId || String(local.id || "") !== expectedSetId) throw Object.assign(new Error("离线题组恢复快照与稳定 ID 不一致"), { statusCode: 409 });
  const localQuestions = Array.isArray(local.questions) ? local.questions : [];
  if (localQuestions.length !== authoritative.questions.length) throw Object.assign(new Error("离线题组题目数量已变化，不能自动恢复"), { statusCode: 409 });
  const localById = new Map(localQuestions.map(question => [String(question && question.id || ""), question]));
  const questions = authoritative.questions.map(question => {
    const saved = localById.get(question.id);
    const prompt = saved && String(saved.prompt || "");
    if (!saved || !recoveryPromptMatches(question.direction, prompt, question)) throw Object.assign(new Error("离线题组题干与服务器签发快照不一致"), { statusCode: 409 });
    return {
      ...question,
      userAnswer: String(saved.userAnswer || "").trim().slice(0, MAX_AI_ANSWER_LENGTH),
      correct: null,
      score: null,
      gradingStatus: "",
      problemWords: [],
      wordResults: [],
      explanation: "",
      detailedExplanation: "",
      answeredAt: ""
    };
  });
  const phase = offlineAiRecoveryPhase(local.phase, operationPath);
  if (["review", "grading"].includes(phase) && questions.some(question => !question.userAnswer)) throw Object.assign(new Error("离线题组尚有空白答案，不能恢复到核对或批改阶段"), { statusCode: 409 });
  return sanitizeQuestionSet({
    ...authoritative,
    questions,
    index: Math.min(Math.max(Number(local.index) || 0, 0), Math.max(0, questions.length - 1)),
    phase,
    completed: false,
    gradeRequestId: String(local.gradeRequestId || "").trim().slice(0, 180),
    reviewOpenedAt: phase === "answering" ? "" : String(local.reviewOpenedAt || "").slice(0, 40),
    gradingStartedAt: phase === "grading" ? String(local.gradingStartedAt || "").slice(0, 40) : "",
    completedAt: "",
    lastError: "",
    updatedAt: new Date().toISOString()
  });
}

function aiSetHistoryCompleted(practice, setId, localSet) {
  const questionIds = new Set((Array.isArray(localSet && localSet.questions) ? localSet.questions : []).map(question => String(question && question.id || "")).filter(Boolean));
  if (!questionIds.size || questionIds.size !== localSet.questions.length) return false;
  const completedIds = new Set(practice.history.filter(item => item.setId === setId).map(item => String(item.id || "").slice(setId.length + 1)));
  return completedIds.size === questionIds.size && Array.from(questionIds).every(id => completedIds.has(id));
}

function recoverOfflineAiQuestionSet(user, state, practice, body) {
  const setId = String(body.setId || "").trim().slice(0, 80);
  const localSet = body.set && typeof body.set === "object" ? body.set : null;
  if (!setId || !localSet || String(localSet.id || "") !== setId) throw Object.assign(new Error("离线题组恢复请求不完整"), { statusCode: 400 });
  if (aiSetHistoryCompleted(practice, setId, localSet)) return { status: "completed", practice };
  if (practice.currentSet) {
    if (practice.currentSet.id === setId) return { status: "active", practice };
    throw Object.assign(new Error("服务器已有另一组未完成题目；原草稿仍保留，请先完成当前服务器题组或明确处理冲突"), { statusCode: 409 });
  }
  const authoritative = String(body.receipt || "").trim()
    ? openOfflineAiRecoveryReceipt(user, body.receipt, setId)
    : legacyOfflineAiSet(state, localSet, setId);
  const recovered = overlayOfflineAiSetProgress(authoritative, localSet, setId, body.operationPath);
  practice.currentSet = recovered;
  practice.queuedSets = practice.queuedSets.filter(set => set.id !== setId);
  practice.updatedAt = recovered.updatedAt;
  state.aiPractice = practice;
  userStates.users[user.id] = sanitizeState(state);
  persistUserStates();
  return { status: "recovered", practice: sanitizeAiPractice(userStates.users[user.id].aiPractice) };
}

function handleAiQuestionBatch(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  const suffix = url.pathname.slice("/api/ai/questions/batch".length) || "/";
  if (req.method === "GET" && suffix === "/") return sendJson(res, 200, { practice: publicAiPractice(getUserState(user).aiPractice) });
  return readBody(req).then(body => withFormalPracticeLock(user.id, async () => {
    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const set = practice.currentSet;
    if (suffix === "/recover" && req.method === "POST") {
      try {
        const recovered = recoverOfflineAiQuestionSet(user, state, practice, body);
        return sendJson(res, 200, { status: recovered.status, recovered: recovered.status === "recovered", reused: recovered.status !== "recovered", practice: publicAiPractice(recovered.practice) });
      } catch (error) {
        return sendError(res, error.statusCode || 409, error.message);
      }
    }
    if (!set || set.id !== String(body.setId || "")) return sendError(res, 404, "AI question set not found");
    const now = new Date().toISOString();
    if (suffix === "/draft" && req.method === "PUT") {
      if (set.phase !== "answering") return sendJson(res, 409, { error: "当前题组不在作答阶段", practice: publicAiPractice(practice) });
      const index = Math.min(Math.max(Number(body.index) || 0, 0), set.questions.length - 1);
      const question = set.questions[index];
      if (body.questionId && String(body.questionId) !== question.id) return sendError(res, 409, "AI question changed");
      question.userAnswer = String(body.answer || "").trim().slice(0, MAX_AI_ANSWER_LENGTH);
      question.answeredAt = "";
      set.index = Object.hasOwn(body, "nextIndex")
        ? Math.min(Math.max(Number(body.nextIndex) || 0, 0), set.questions.length - 1)
        : index;
      set.updatedAt = now;
      set.lastError = "";
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      return sendJson(res, 200, { practice: publicAiPractice(practice) });
    }
    if (suffix === "/edit" && req.method === "POST") {
      if (set.phase === "completed") return sendJson(res, 409, { error: "题组已经完成批改", practice: publicAiPractice(practice) });
      set.phase = "answering";
      set.index = Math.min(Math.max(Number(body.index) || 0, 0), set.questions.length - 1);
      set.updatedAt = now;
      set.lastError = "";
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      return sendJson(res, 200, { practice: publicAiPractice(practice) });
    }
    if (suffix === "/review" && req.method === "POST") {
      if (set.phase === "completed") return sendJson(res, 200, { practice: publicAiPractice(practice), reused: true });
      const requestedGradeRequestId = String(body.gradeRequestId || "").trim().slice(0, 180);
      if (requestedGradeRequestId && set.gradeRequestId && set.gradeRequestId !== requestedGradeRequestId) {
        return sendJson(res, 409, { error: "批改请求标识不一致", practice: publicAiPractice(practice) });
      }
      const missingIndex = set.questions.findIndex(question => !question.userAnswer.trim());
      if (missingIndex >= 0) {
        set.phase = "answering";
        set.index = missingIndex;
        set.updatedAt = now;
        practice.updatedAt = now;
        state.aiPractice = practice;
        userStates.users[user.id] = sanitizeState(state);
        persistUserStates();
        return sendJson(res, 409, { error: `第 ${missingIndex + 1} 题还没有作答`, missingIndex, practice: publicAiPractice(practice) });
      }
      set.phase = "review";
      set.reviewOpenedAt = set.reviewOpenedAt || now;
      set.gradeRequestId = set.gradeRequestId || requestedGradeRequestId || `aigrade-${crypto.randomUUID()}`;
      set.updatedAt = now;
      set.lastError = "";
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      return sendJson(res, 200, { practice: publicAiPractice(practice) });
    }
    if (suffix === "/grade" && req.method === "POST") {
      if (set.phase === "completed") return sendJson(res, 200, { practice: publicAiPractice(practice), reused: true, abilities: analyzeAbilities(content, state) });
      if (!["review", "grading"].includes(set.phase)) return sendJson(res, 409, { error: "请先核对整组答案", practice: publicAiPractice(practice) });
      const requestId = String(body.gradeRequestId || set.gradeRequestId || "").trim();
      if (!requestId || (set.gradeRequestId && set.gradeRequestId !== requestId)) return sendJson(res, 409, { error: "批改请求标识不一致", practice: publicAiPractice(practice) });
      set.phase = "grading";
      set.gradeRequestId = requestId;
      set.gradingStartedAt = set.gradingStartedAt || now;
      set.updatedAt = now;
      set.lastError = "";
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      try {
        const results = await gradeAiQuestionSet(user, set);
        const saved = applyCompletedAiQuestionSet(user, set, results);
        return sendJson(res, 200, { practice: publicAiPractice(saved.aiPractice), reused: false, abilities: analyzeAbilities(content, saved) });
      } catch (error) {
        const latest = getUserState(user);
        const failed = sanitizeAiPractice(latest.aiPractice);
        if (failed.currentSet && failed.currentSet.id === set.id && failed.currentSet.phase !== "completed") {
          failed.currentSet.phase = "review";
          failed.currentSet.lastError = String(error && error.message || "AI 批改暂不可用，整组答案已保留，请稍后重试").slice(0, 300);
          failed.currentSet.updatedAt = new Date().toISOString();
          failed.updatedAt = failed.currentSet.updatedAt;
          latest.aiPractice = failed;
          userStates.users[user.id] = sanitizeState(latest);
          persistUserStates();
        }
        const status = error && [400, 404, 409, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
        return sendJson(res, status, { error: String(error && error.message || "AI 批改暂不可用，整组答案已保留，请稍后重试"), practice: publicAiPractice(failed) }, error && error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
      }
    }
    return sendError(res, 404, "AI question batch endpoint not found");
  })).catch(error => sendError(res, error.statusCode || 400, error.message));
}

async function handleAiGrade(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI endpoint not found");
  if (!aiConfigured()) return sendError(res, 503, "AI grading is not configured");

  try {
    const body = await readBody(req);
    const answer = String(body.answer || "").trim();
    if (!answer) return sendError(res, 400, "answer is required");
    if (answer.length > MAX_AI_ANSWER_LENGTH) return sendError(res, 400, "answer is too long");
    const requestedVariantId = String(body.variantId || (body.reviewVariant && body.reviewVariant.id) || "").trim();
    const task = findStoredPoolSentenceTask(user, body.taskId, requestedVariantId)
      || findSentenceTask(body.taskId, requestedVariantId, body.reviewVariant);
    if (!task) return sendError(res, 404, "sentence task not found");
    const acceptedAnswers = task.direction === "zh-en" ? (task.item.acceptedEnglish || [task.item.english]) : (task.item.acceptedChinese || [task.item.chinese]);
    const localGrade = localTranslationGrade(task.direction, task.item.english, answer, acceptedAnswers);
    if (localGrade) return sendJson(res, 200, localGrade);

    const rate = takeAiRequest(user.id);
    if (!rate.allowed) {
      return sendJson(res, 429, { error: "AI grading rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
    }

    const state = getUserState(user);
    const selection = aiSelectionForState(state, body);
    persistUserStates();
    const sourceText = task.direction === "zh-en" ? task.item.chinese : task.item.english;
    const routed = await runAiRoute(selection.route, config => createAiGrader(config).grade({
      answer,
      acceptedAnswers,
      direction: task.direction,
      sourceText,
      wordMeanings: formalWordMeaningsForEnglish(task.item.english)
    }));
    return sendJson(res, 200, { ...completeTranslationGrade(task.direction, task.item.english, answer, routed.value, task.direction === "zh-en" ? task.item.english : (task.item.chinese || acceptedAnswers[0])), source: "ai" });
  } catch (error) {
    if (error && [400, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI grading failed: ${error && error.message ? error.message : "unknown error"}`);
    return sendError(res, 503, "AI grading is temporarily unavailable");
  }
}

function nextRunnableAiGenerationItem(practice) {
  for (const item of practice.generationQueue) {
    if (item.status === "failed") return null;
    if (item.status === "pending" && item.generatedGroupCount < item.groupCount) return item;
  }
  return null;
}

function normalizeGeneratedAiQuestionGroup(questions, currentPool) {
  return questions.map(question => {
    const sourceChinese = String(question && question.chinese || "").trim();
    const chinese = prioritizeRegisteredChineseMeanings(content, question && question.english, sourceChinese);
    const poolVariant = currentPool.variants.find(item => normalizeVariantEnglish(item.english) === normalizeVariantEnglish(question && question.english));
    return {
      ...question,
      poolVariantId: poolVariant ? poolVariant.id : "",
      chinese,
      acceptedChinese: expandRegisteredChineseAnswers(content, question && question.english, [
        chinese,
        ...(Array.isArray(question && question.acceptedChinese) ? question.acceptedChinese : [])
          .map(answer => prioritizeRegisteredChineseMeanings(content, question && question.english, answer))
      ].filter(answer => answer && !registeredChineseMeaningConflicts(content, question && question.english, answer).length), 16)
    };
  });
}

async function prepareNextAiGenerationGroup(user) {
  refreshContent();
  return withFormalPracticeLock(user.id, async () => {
    const state = getUserState(user);
    let practice = sanitizeAiPractice(state.aiPractice);
    let changed = false;
    for (const item of practice.generationQueue) {
      if (item.status === "failed") break;
      if (item.status === "pending" && item.generatedGroupCount >= item.groupCount) {
        item.status = item.setIds.length ? "ready" : "consumed";
        item.updatedAt = new Date().toISOString();
        practice.updatedAt = item.updatedAt;
        changed = true;
      }
    }
    state.aiPractice = practice;
    const runnable = nextRunnableAiGenerationItem(practice);
    if (!runnable) {
      if (changed) {
        userStates.users[user.id] = sanitizeState(state);
        persistUserStates();
      }
      return null;
    }
    const selection = aiSelectionForState(state, {
      model: runnable.model,
      reasoningEffort: runnable.reasoningEffort,
      count: runnable.count,
      groupCount: runnable.groupCount,
      contentType: runnable.contentType,
      direction: runnable.direction
    }, { generation: true });
    practice = selection.practice;
    const item = practice.generationQueue.find(candidate => candidate.requestId === runnable.requestId);
    if (!item || item.status !== "pending") return null;
    const groupIndex = item.generatedGroupCount;
    return {
      requestId: item.requestId,
      batchId: item.batchId,
      groupIndex,
      plannedSetId: item.plannedSetIds[groupIndex],
      createdAt: item.createdAt,
      currentPool: sanitizeReviewVariantPool(state.reviewVariantPool),
      profile: buildLearningProfile(content, state, today()),
      selection
    };
  });
}

async function storeGeneratedAiQuestionGroup(user, prepared, routed) {
  const normalizedQuestions = prepared.selection.contentType === "word"
    ? routed.value
    : normalizeGeneratedAiQuestionGroup(routed.value, prepared.currentPool);
  const set = createQuestionSet(normalizedQuestions, routed.config, {
    id: prepared.plannedSetId,
    batchId: prepared.batchId,
    generationRequestId: prepared.requestId,
    questionVersion: 1,
    contentType: prepared.selection.contentType,
    direction: prepared.selection.direction,
    requestedCount: prepared.selection.count,
    createdAt: prepared.createdAt,
    groupNumber: prepared.groupIndex + 1,
    groupCount: prepared.selection.groupCount
  });
  return withFormalPracticeLock(user.id, async () => {
    const latest = getUserState(user);
    const practice = sanitizeAiPractice(latest.aiPractice);
    const item = practice.generationQueue.find(candidate => candidate.requestId === prepared.requestId);
    if (!item) return false;
    if (item.generatedGroupCount > prepared.groupIndex) return true;
    if (item.status !== "pending" || item.generatedGroupCount !== prepared.groupIndex || item.plannedSetIds[prepared.groupIndex] !== prepared.plannedSetId) return false;
    const itemIndex = practice.generationQueue.findIndex(candidate => candidate.requestId === prepared.requestId);
    const earlierUnfinished = itemIndex > 0 && practice.generationQueue.slice(0, itemIndex).some(candidate => candidate.status !== "consumed");
    const becomesCurrent = !practice.currentSet && !earlierUnfinished;
    if (becomesCurrent) {
      practice.currentSet = set;
      practice.tutor = null;
    } else if (!practice.queuedSets.some(candidate => candidate.id === set.id)) {
      practice.queuedSets.push(set);
      if (!item.setIds.includes(set.id)) item.setIds.push(set.id);
    }
    item.generatedGroupCount = prepared.groupIndex + 1;
    item.failedGroupNumber = 0;
    item.status = item.generatedGroupCount >= item.groupCount
      ? (item.setIds.length ? "ready" : "consumed")
      : "pending";
    item.providerId = routed.config.providerId;
    item.providerName = routed.config.providerName;
    item.model = routed.config.model;
    item.reasoningEffort = prepared.selection.route.reasoningEffort;
    item.updatedAt = new Date().toISOString();
    item.error = "";
    practice.updatedAt = item.updatedAt;
    latest.aiPractice = practice;
    userStates.users[user.id] = sanitizeState(latest);
    persistUserStates();
    return true;
  });
}

async function failAiGenerationGroup(user, prepared, error) {
  return withFormalPracticeLock(user.id, async () => {
    const latest = getUserState(user);
    const practice = sanitizeAiPractice(latest.aiPractice);
    const item = practice.generationQueue.find(candidate => candidate.requestId === prepared.requestId);
    if (!item || item.status !== "pending" || item.generatedGroupCount !== prepared.groupIndex) return false;
    item.status = "failed";
    item.failedGroupNumber = prepared.groupIndex + 1;
    item.updatedAt = new Date().toISOString();
    item.error = publicAiGenerationFailure(error).message;
    practice.updatedAt = item.updatedAt;
    latest.aiPractice = practice;
    userStates.users[user.id] = sanitizeState(latest);
    persistUserStates();
    return true;
  });
}

async function runAiGenerationWorker(user) {
  while (true) {
    const prepared = await prepareNextAiGenerationGroup(user);
    if (!prepared) return;
    try {
      if (!prepared.profile.allowedWords.length) throw Object.assign(new Error("no learned words are available"), { statusCode: 409 });
      let routed;
      if (prepared.selection.contentType === "word") {
        const questions = createDeterministicWordQuestions(prepared.profile, prepared.selection.count, prepared.selection.direction, prepared.groupIndex + 1);
        if (questions.length < prepared.selection.count) throw Object.assign(new Error(`已学单词不足，当前只能生成 ${questions.length} 道不重复单词题`), { statusCode: 409 });
        routed = { value: questions, config: prepared.selection.route.candidates[0] };
      } else {
        const rate = takeAiRequest(user.id);
        if (!rate.allowed) throw Object.assign(new Error("AI rate limit reached"), { statusCode: 429, retryAfterSeconds: rate.retryAfterSeconds });
        routed = await runAiRoute(prepared.selection.route, config => createAiQuestionGenerator(config).generate(prepared.profile, prepared.selection.count, { direction: prepared.selection.direction }));
      }
      const stored = await storeGeneratedAiQuestionGroup(user, prepared, routed);
      if (!stored) return;
    } catch (error) {
      await failAiGenerationGroup(user, prepared, error);
      console.warn(`AI question group ${prepared.groupIndex + 1} generation failed: ${error && error.message ? error.message : "unknown error"}`);
      return;
    }
  }
}

function startAiGenerationWorker(user) {
  const existing = activeAiGenerationJobsByUserId.get(user.id);
  if (existing) return existing;
  const job = runAiGenerationWorker(user).catch(error => {
    console.warn(`AI question generation worker failed: ${error && error.message ? error.message : "unknown error"}`);
  });
  activeAiGenerationJobsByUserId.set(user.id, job);
  job.finally(() => {
    if (activeAiGenerationJobsByUserId.get(user.id) !== job) return;
    activeAiGenerationJobsByUserId.delete(user.id);
    const state = userStates.users[user.id];
    if (state && nextRunnableAiGenerationItem(sanitizeAiPractice(state.aiPractice))) {
      queueMicrotask(() => startAiGenerationWorker(user));
    }
  });
  return job;
}

function clearAiGenerationQueue(user) {
  return withFormalPracticeLock(user.id, async () => {
    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const currentSet = practice.currentSet;
    const currentSetId = String(currentSet && currentSet.id || "");
    const currentRequestId = String(currentSet && currentSet.generationRequestId || "");
    const cancelableGroupIds = new Set();
    const queuedSetIds = new Set(practice.queuedSets.map(set => String(set && set.id || "")).filter(Boolean));
    const now = new Date().toISOString();
    let cancelledRequests = 0;
    let changed = false;

    const addPlannedGroupIds = (item, isCurrentRequest) => {
      const plannedIds = Array.isArray(item.plannedSetIds) ? item.plannedSetIds : [];
      const expectedCount = Math.max(Number(item.groupCount) || 0, plannedIds.length, Array.isArray(item.setIds) ? item.setIds.length : 0);
      const currentIncluded = isCurrentRequest && plannedIds.includes(currentSetId);
      const before = cancelableGroupIds.size;
      for (let index = 0; index < expectedCount; index += 1) {
        const plannedId = String(plannedIds[index] || `${item.requestId}:group-${index + 1}`);
        if (isCurrentRequest && plannedId === currentSetId) continue;
        if (isCurrentRequest && !currentIncluded && index === 0) continue;
        cancelableGroupIds.add(plannedId);
      }
      return cancelableGroupIds.size - before;
    };

    practice.generationQueue.forEach(item => {
      if (!item || item.status === "consumed") return;
      cancelledRequests += 1;
      const isCurrentRequest = Boolean(currentSetId && (item.requestId === currentRequestId || item.plannedSetIds.includes(currentSetId)));
      const cancelledGroupCount = addPlannedGroupIds(item, isCurrentRequest);
      item.setIds = [];
      item.status = "consumed";
      item.failedGroupNumber = 0;
      item.error = "";
      item.cancelledAt = now;
      item.cancelledGroupCount = cancelledGroupCount;
      item.updatedAt = now;
      changed = true;
    });

    // Legacy states can contain prepared sets without a matching generation
    // receipt. They are never the active set, so they are safe to cancel too.
    queuedSetIds.forEach(setId => {
      if (setId !== currentSetId) cancelableGroupIds.add(setId);
    });
    const previousQueuedCount = practice.queuedSets.length;
    practice.queuedSets = practice.queuedSets.filter(set => String(set && set.id || "") === currentSetId);
    if (practice.queuedSets.length !== previousQueuedCount) changed = true;

    if (changed) {
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
    }
    const remaining = publicAiPractice(changed ? state.aiPractice : practice);
    return {
      practice: remaining,
      cancelledRequests,
      cancelledGroups: cancelableGroupIds.size,
      remainingGroups: remaining.generationQueue.reduce((sum, item) => sum + item.groups.length, 0),
      reused: !changed
    };
  }, "ai-generation-clear");
}

async function handleAiGenerate(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI generation endpoint not found");
  try {
    const body = await readBody(req);
    const requestId = String(body.requestId || "").trim().slice(0, 180) || `aigen-${crypto.randomUUID()}`;
    const existingPractice = sanitizeAiPractice(getUserState(user).aiPractice);
    const existingQueueItem = existingPractice.generationQueue.find(item => item.requestId === requestId);
    const requestedContentType = existingQueueItem
      ? existingQueueItem.contentType
      : (["word", "sentence"].includes(body.contentType) ? body.contentType : existingPractice.settings.contentType);
    if (requestedContentType !== "word" && !aiConfigured()) return sendJson(res, 503, { error: "AI 尚未配置，请先保存可用的供应商和模型", reasonCode: "not_configured" });
    const prepared = await withFormalPracticeLock(user.id, async () => {
      const state = getUserState(user);
      const storedPractice = sanitizeAiPractice(state.aiPractice);
      let queueItem = storedPractice.generationQueue.find(item => item.requestId === requestId);
      const reusedExisting = Boolean(queueItem);
      if (queueItem && ["ready", "consumed"].includes(queueItem.status)) {
        state.aiPractice = storedPractice;
        return { statusCode: 200, body: { practice: publicAiPractice(storedPractice), settings: storedPractice.settings, requestId, reused: true } };
      }
      if (queueItem && queueItem.status === "pending") {
        state.aiPractice = storedPractice;
        return { statusCode: 202, startWorker: true, body: { practice: publicAiPractice(storedPractice), settings: storedPractice.settings, requestId, reused: true, pending: true, staged: true } };
      }
      state.aiPractice = storedPractice;
      const selection = aiSelectionForState(state, queueItem ? {
        model: queueItem.model,
        reasoningEffort: queueItem.reasoningEffort,
        count: queueItem.count,
        groupCount: queueItem.groupCount,
        contentType: queueItem.contentType,
        direction: queueItem.direction
      } : body, { generation: true });
      const practice = selection.practice;
      queueItem = practice.generationQueue.find(item => item.requestId === requestId);
      const now = new Date().toISOString();
      if (!queueItem) {
        if (practice.generationQueue.filter(item => item.status !== "consumed").length >= 30) {
          const queuedGroups = publicAiPractice(practice).generationQueue.reduce((sum, item) => sum + item.groups.length, 0);
          throw Object.assign(new Error(`AI 题组队列已满（当前 ${queuedGroups} 组），请先完成或清空生成队列`), { statusCode: 409 });
        }
        queueItem = {
          id: `aiqueue-${crypto.randomUUID()}`,
          requestId,
          batchId: `aibatch-${crypto.randomUUID()}`,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          providerId: selection.route.candidates[0] && selection.route.candidates[0].providerId || "",
          providerName: selection.route.candidates[0] && selection.route.candidates[0].providerName || "",
          model: selection.route.model,
          reasoningEffort: selection.route.reasoningEffort,
          contentType: selection.contentType,
          direction: selection.direction,
          count: selection.count,
          groupCount: selection.groupCount,
          plannedSetIds: Array.from({ length: selection.groupCount }, () => `aiset-${crypto.randomUUID()}`),
          setIds: [],
          generatedGroupCount: 0,
          failedGroupNumber: 0,
          error: ""
        };
        practice.generationQueue.push(queueItem);
      } else {
        if (!Array.isArray(queueItem.plannedSetIds) || queueItem.plannedSetIds.length !== queueItem.groupCount) {
          queueItem.plannedSetIds = Array.from({ length: queueItem.groupCount }, (_, index) => queueItem.plannedSetIds && queueItem.plannedSetIds[index] || `aiset-${crypto.randomUUID()}`);
        }
        queueItem.status = "pending";
        queueItem.failedGroupNumber = 0;
        queueItem.updatedAt = now;
        queueItem.error = "";
      }
      practice.updatedAt = now;
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      return {
        statusCode: 202,
        startWorker: true,
        body: { practice: publicAiPractice(practice), settings: practice.settings, requestId, reused: reusedExisting, pending: true, staged: true }
      };
    });
    if (prepared.startWorker) startAiGenerationWorker(user);
    return sendJson(res, prepared.statusCode, prepared.body);
  } catch (error) {
    if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI question generation request failed: ${error && error.message ? error.message : "unknown error"}`);
    const failure = publicAiGenerationFailure(error);
    return sendJson(res, failure.statusCode, { error: failure.message, providerStatus: failure.providerStatus });
  }
}

async function handleAiGenerationQueueClear(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI queue endpoint not found");
  try {
    const result = await clearAiGenerationQueue(user);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message || "AI 题组队列清空失败");
  }
}

async function handleAiNextSet(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI question endpoint not found");
  try {
    const body = await readBody(req);
    const expectedSetId = String(body.setId || "").trim().slice(0, 80);
    const nextRequestId = String(body.nextRequestId || "").trim().slice(0, 180);
    return await withFormalPracticeLock(user.id, async () => {
      const state = getUserState(user);
      const practice = sanitizeAiPractice(state.aiPractice);
      const current = practice.currentSet;
      if (expectedSetId && current && current.id === expectedSetId) {
        return sendJson(res, 200, {
          set: publicQuestionSet(current),
          remainingGroups: publicAiPractice(practice).generationQueue.reduce((sum, item) => sum + item.groups.length, 0),
          practice: publicAiPractice(practice),
          nextRequestId,
          reused: true
        });
      }
      if (!current || current.phase !== "completed" || !current.questions.every(question => typeof question.correct === "boolean")) return sendError(res, 409, "current AI question set is not complete");
      const queueItem = practice.generationQueue.find(item => item.status !== "consumed");
      if (!queueItem) return sendError(res, 409, "no prepared AI question set is available");
      const nextSetId = queueItem.setIds[0];
      if (!nextSetId && queueItem.status === "pending") return sendJson(res, 409, { error: `第 ${queueItem.generatedGroupCount + 1} 组仍在生成，请稍后再试`, practice: publicAiPractice(practice) });
      if (!nextSetId && queueItem.status === "failed") return sendJson(res, 409, { error: queueItem.error || `第 ${queueItem.failedGroupNumber || queueItem.generatedGroupCount + 1} 组生成失败，请原位重试`, requestId: queueItem.requestId, practice: publicAiPractice(practice) });
      if (!nextSetId) return sendError(res, 409, "no prepared AI question set is available");
      if (expectedSetId && nextSetId !== expectedSetId) return sendJson(res, 409, { error: "待进入题组与队首快照不一致，请刷新后重试", expectedSetId: nextSetId, practice: publicAiPractice(practice) });
      const nextSet = practice.queuedSets.find(set => set.id === nextSetId);
      if (!nextSet) return sendJson(res, 409, { error: "队首题组快照暂不可用，请重试原生成请求", requestId: queueItem.requestId, practice: publicAiPractice(practice) });
      practice.currentSet = nextSet;
      practice.queuedSets = practice.queuedSets.filter(set => set.id !== nextSetId);
      queueItem.setIds = queueItem.setIds.slice(1);
      if (queueItem.generatedGroupCount >= queueItem.groupCount && queueItem.status !== "failed") {
        queueItem.status = queueItem.setIds.length ? "ready" : "consumed";
      }
      queueItem.updatedAt = new Date().toISOString();
      practice.tutor = null;
      practice.updatedAt = new Date().toISOString();
      state.aiPractice = practice;
      userStates.users[user.id] = sanitizeState(state);
      persistUserStates();
      return sendJson(res, 200, {
        set: publicQuestionSet(practice.currentSet),
        remainingGroups: publicAiPractice(practice).generationQueue.reduce((sum, item) => sum + item.groups.length, 0),
        practice: publicAiPractice(practice),
        nextRequestId,
        reused: false
      });
    });
  } catch (error) {
    return sendError(res, error.statusCode || 400, error.message);
  }
}

async function handleAiTutorAsk(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI tutor endpoint not found");
  if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
  try {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    if (!message) return sendError(res, 400, "question is required");
    if (message.length > MAX_AI_TUTOR_MESSAGE_LENGTH) return sendError(res, 400, "question is too long");

    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const historyItem = body.historyId ? practice.history.find(item => item.id === body.historyId) : null;
    const set = practice.currentSet;
    const reviewTask = !historyItem && body.taskId ? findReviewTutorTask(user, body.taskId, body.variantId) : null;
    const question = !historyItem && set && set.id === body.setId ? set.questions.find(item => item.id === body.questionId) : null;
    if (body.historyId && !historyItem) return sendError(res, 404, "AI history question not found");
    if (!historyItem && body.taskId && !reviewTask) return sendError(res, 404, "review question not found");
    if (!historyItem && !reviewTask && (!set || set.id !== body.setId)) return sendError(res, 404, "AI question set not found");
    if (!historyItem && !reviewTask && !question) return sendError(res, 404, "AI question not found");

    const historyPrefix = historyItem && historyItem.setId ? `${historyItem.setId}:` : "";
    const historyQuestionId = historyItem && historyPrefix && historyItem.id.startsWith(historyPrefix) ? historyItem.id.slice(historyPrefix.length) : historyItem && historyItem.id;
    const reviewVariantId = reviewTask && reviewTask.variant ? String(reviewTask.variant.id || "") : "";
    const threadSetId = historyItem ? (historyItem.setId || `history-${historyItem.id}`) : reviewTask ? "review" : set.id;
    const threadQuestionId = historyItem ? historyQuestionId : reviewTask ? reviewTutorQuestionId(reviewTask.taskId, reviewVariantId) : question.id;
    const reviewAttempt = reviewTask ? latestReviewAttempt(state, reviewTask.taskId, reviewVariantId) : null;
    const exercise = historyItem ? {
      direction: historyItem.direction,
      english: historyItem.direction === "zh-en" ? historyItem.correctAnswer : historyItem.prompt,
      chinese: historyItem.direction === "zh-en" ? historyItem.prompt : historyItem.correctAnswer,
      learnerAnswer: historyItem.userAnswer,
      answered: true,
      focus: historyItem.focus || "",
      explanation: historyItem.explanation || ""
    } : reviewTask ? {
      direction: reviewTask.direction,
      english: reviewTask.item.english,
      chinese: reviewTask.item.chinese,
      learnerAnswer: reviewAttempt ? String(reviewAttempt.answer || "") : "",
      answered: Boolean(reviewAttempt && typeof reviewAttempt.correct === "boolean"),
      focus: "",
      explanation: reviewAttempt ? String(reviewAttempt.explanation || "") : ""
    } : {
      direction: question.direction,
      english: question.english,
      chinese: question.chinese,
      learnerAnswer: question.userAnswer || "",
      answered: typeof question.correct === "boolean",
      focus: question.focus || "",
      explanation: question.explanation || ""
    };

    const rate = takeAiRequest(user.id);
    if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
    const contextModel = historyItem ? historyItem.model : reviewTask ? "" : set.model;
    const requestedProviderId = String(body.providerId || practice.tutorSettings.providerId || "").trim();
    const selectedProvider = requestedProviderId && Array.isArray(aiSettings && aiSettings.providers) ? aiSettings.providers.find(provider => provider.id === requestedProviderId) : null;
    const availableModels = selectedProvider ? selectedProvider.models : getAvailableModels(aiSettings);
    const requestedModel = [body.model, practice.tutorSettings.model, contextModel, aiSettings.defaultModel].map(value => String(value || "").trim()).find(value => availableModels.includes(value)) || availableModels[0] || aiSettings.defaultModel;
    const tutorEffort = AI_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : practice.tutorSettings.reasoningEffort;
    const route = selectAiCandidates(aiSettings, { providerId: requestedProviderId, model: requestedModel, reasoningEffort: tutorEffort });
    const thread = tutorThreadFromHistory(practice, threadSetId, threadQuestionId);
    thread.historyId = historyItem ? historyItem.id : "";
    thread.source = historyItem ? "history" : reviewTask ? "review" : "current";
    thread.taskId = reviewTask ? reviewTask.taskId : "";
    thread.variantId = reviewTask ? reviewVariantId : "";
    thread.direction = exercise.direction;
    thread.prompt = historyItem ? historyItem.prompt : (exercise.direction === "en-zh" ? exercise.english : exercise.chinese);
    const askedAt = new Date().toISOString();
    const tutorProfile = buildLearningProfile(content, state, today());
    const tutorWordMeanings = Object.fromEntries(content.words
      .filter(item => !item.preview && item.learned && String(item.learned) <= today())
      .map(item => [normalizeVariantEnglish(item.english), Array.from(new Set([item.chinese, ...(Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [])].filter(Boolean)))]));
    const routed = await runAiRoute(route, config => createAiTutor(config).answer({
      exercise,
      history: thread.messages,
      message,
      allowedWords: tutorProfile.allowedWords,
      wordMeanings: tutorWordMeanings
    }));
    const createdAt = new Date().toISOString();
    thread.messages = [
      ...thread.messages,
      { role: "user", content: message, createdAt },
      { role: "assistant", content: routed.value, createdAt }
    ].slice(-MAX_TUTOR_MESSAGES);
    thread.updatedAt = createdAt;
    const exchange = sanitizeTutorExchange({
      id: `tutor-${crypto.randomUUID()}`,
      setId: threadSetId,
      questionId: threadQuestionId,
      historyId: historyItem ? historyItem.id : "",
      source: historyItem ? "history" : reviewTask ? "review" : "current",
      taskId: reviewTask ? reviewTask.taskId : "",
      variantId: reviewTask ? reviewVariantId : "",
      direction: exercise.direction,
      prompt: historyItem ? historyItem.prompt : (exercise.direction === "en-zh" ? exercise.english : exercise.chinese),
      learnerAnswer: exercise.learnerAnswer,
      correctAnswer: exercise.answered ? (exercise.direction === "zh-en" ? exercise.english : exercise.chinese) : "",
      answered: exercise.answered,
      explanation: exercise.explanation,
      question: message,
      answer: routed.value,
      askedAt,
      answeredAt: createdAt,
      providerId: routed.config.providerId,
      providerName: routed.config.providerName,
      model: routed.config.model,
      reasoningEffort: route.reasoningEffort
    });
    practice.tutorHistory = [...practice.tutorHistory, exchange].filter(Boolean).slice(-MAX_TUTOR_HISTORY);
    practice.tutor = thread;
    practice.tutorSettings.providerId = routed.config.providerId;
    practice.tutorSettings.model = route.model;
    practice.tutorSettings.reasoningEffort = route.reasoningEffort;
    practice.updatedAt = createdAt;
    state.aiPractice = practice;
    persistUserStates();
    return sendJson(res, 200, { answer: routed.value, tutor: thread, exchange, tutorSettings: practice.tutorSettings, provider: { id: routed.config.providerId, name: routed.config.providerName } });
  } catch (error) {
    if (error && [400, 404, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI tutoring failed: ${error && error.message ? error.message : "unknown error"}`);
    const failure = publicAiTutorFailure(error);
    return sendJson(res, failure.statusCode, { error: failure.message, providerStatus: failure.providerStatus });
  }
}

async function handleAiTutorClear(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI tutor clear endpoint not found");
  try {
    const body = await readBody(req);
    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const historyItem = body.historyId ? practice.history.find(item => item.id === body.historyId) : null;
    const set = practice.currentSet;
    const reviewTask = !historyItem && body.taskId ? findReviewTutorTask(user, body.taskId, body.variantId) : null;
    const question = !historyItem && set && set.id === body.setId ? set.questions.find(item => item.id === body.questionId) : null;
    if (body.historyId && !historyItem) return sendError(res, 404, "AI history question not found");
    if (!historyItem && body.taskId && !reviewTask) return sendError(res, 404, "review question not found");
    if (!historyItem && !reviewTask && (!set || set.id !== body.setId)) return sendError(res, 404, "AI question set not found");
    if (!historyItem && !reviewTask && !question) return sendError(res, 404, "AI question not found");

    const historyPrefix = historyItem && historyItem.setId ? `${historyItem.setId}:` : "";
    const historyQuestionId = historyItem && historyPrefix && historyItem.id.startsWith(historyPrefix) ? historyItem.id.slice(historyPrefix.length) : historyItem && historyItem.id;
    const reviewVariantId = reviewTask && reviewTask.variant ? String(reviewTask.variant.id || "") : "";
    const threadSetId = historyItem ? (historyItem.setId || `history-${historyItem.id}`) : reviewTask ? "review" : set.id;
    const threadQuestionId = historyItem ? historyQuestionId : reviewTask ? reviewTutorQuestionId(reviewTask.taskId, reviewVariantId) : question.id;
    const source = historyItem ? "history" : reviewTask ? "review" : "current";
    const prompt = historyItem ? historyItem.prompt : reviewTask ? (reviewTask.direction === "en-zh" ? reviewTask.item.english : reviewTask.item.chinese) : (question.direction === "en-zh" ? question.english : question.chinese);
    const direction = historyItem ? historyItem.direction : reviewTask ? reviewTask.direction : question.direction;
    const resetAt = new Date().toISOString();
    const reset = { setId: threadSetId, questionId: threadQuestionId, historyId: historyItem ? historyItem.id : "", source, taskId: reviewTask ? reviewTask.taskId : "", variantId: reviewTask ? reviewVariantId : "", direction, prompt, resetAt };
    practice.tutorResets = [
      ...practice.tutorResets.filter(item => item.setId !== threadSetId || item.questionId !== threadQuestionId),
      reset
    ].slice(-MAX_TUTOR_RESETS);
    practice.tutor = { setId: threadSetId, questionId: threadQuestionId, historyId: reset.historyId, source, taskId: reviewTask ? reviewTask.taskId : "", variantId: reviewTask ? reviewVariantId : "", direction, prompt, updatedAt: resetAt, messages: [] };
    practice.updatedAt = resetAt;
    state.aiPractice = practice;
    persistUserStates();
    return sendJson(res, 200, { practice, tutor: practice.tutor, resetAt });
  } catch (error) {
    if (error && [400, 404, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI tutor clearing failed: ${error && error.message ? error.message : "unknown error"}`);
    return sendError(res, 500, "failed to clear AI tutor session");
  }
}

async function handleAiQuestionGrade(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI question endpoint not found");
  if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
  try {
    const body = await readBody(req);
    const answer = String(body.answer || "").trim();
    if (!answer) return sendError(res, 400, "answer is required");
    if (answer.length > MAX_AI_ANSWER_LENGTH) return sendError(res, 400, "answer is too long");
    const state = getUserState(user);
    const practice = sanitizeAiPractice(state.aiPractice);
    const set = practice.currentSet;
    if (!set || set.id !== body.setId) return sendError(res, 404, "AI question set not found");
    if (set.phase !== "completed") return sendJson(res, 409, { error: "当前版本改为整组统一批改，请刷新页面继续", practice: publicAiPractice(practice) });
    const question = set.questions.find(item => item.id === body.questionId);
    if (!question) return sendError(res, 404, "AI question not found");

    const acceptedAnswers = question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese;
    const wordMeaningConflict = formalWordMeaningConflictGrade(question, answer);
    let result = wordMeaningConflict || localTranslationGrade(question.direction, question.english, answer, acceptedAnswers);
    if (!result) result = { correct: false, score: 0, gradingStatus: "incorrect", explanation: "本地规则判定。", problemWords: [], wordResults: [], source: "local" };
    if (!result.correct && !wordMeaningConflict) {
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      const availableModels = getAvailableModels(aiSettings);
      const requestedModel = availableModels.includes(set.model) ? set.model : aiSettings.defaultModel;
      const route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: set.reasoningEffort });
      const sourceText = question.direction === "zh-en" ? question.chinese : question.english;
      const routed = await runAiRoute(route, config => createAiGrader(config).grade({
        answer,
        acceptedAnswers,
        direction: question.direction,
        sourceText,
        wordMeanings: formalWordMeaningsForEnglish(question.english)
      }));
      result = { ...completeTranslationGrade(question.direction, question.english, answer, routed.value, question.direction === "zh-en" ? question.english : question.chinese), source: "ai" };
    }
    const savedQuestion = saveAiQuestionResult(state, set.id, question.id, answer, result);
    return sendJson(res, 200, { ...result, question: savedQuestion, practice: state.aiPractice });
  } catch (error) {
    if (error && [400, 404, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI question grading failed: ${error && error.message ? error.message : "unknown error"}`);
    return sendError(res, 503, "AI question grading is temporarily unavailable");
  }
}

function aiExamSelectionForState(state, requested = {}) {
  const examState = sanitizeAiExamState(state.aiExam);
  const availableModels = getAvailableModels(aiSettings);
  const storedModel = String(examState.settings.model || "").trim();
  const model = String(requested.model || (availableModels.includes(storedModel) ? storedModel : aiSettings && aiSettings.defaultModel) || "").trim();
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : examState.settings.reasoningEffort;
  const includeEssay = Object.hasOwn(requested, "includeEssay") ? Boolean(requested.includeEssay) : examState.settings.includeEssay;
  const includeListening = Object.hasOwn(requested, "includeListening") ? Boolean(requested.includeListening) : examState.settings.includeListening;
  const totalPoints = normalizeTotalPoints(Object.hasOwn(requested, "totalPoints") ? requested.totalPoints : examState.settings.totalPoints);
  const route = selectAiCandidates(aiSettings, { model, reasoningEffort });
  examState.settings = { model: route.model, reasoningEffort: route.reasoningEffort, includeEssay, includeListening, totalPoints };
  examState.updatedAt = new Date().toISOString();
  state.aiExam = examState;
  return { route, examState, includeEssay, includeListening, totalPoints };
}

function appendCompletedExamWordUsage(state, exam) {
  if (!exam || exam.status !== "completed" || !exam.result) return;
  const grades = new Map((Array.isArray(exam.result.grades) ? exam.result.grades : []).map(grade => [grade.questionId, grade]));
  (Array.isArray(exam.questions) ? exam.questions : []).forEach(question => {
    const grade = grades.get(question.id) || {};
    const english = [question.sourceText, question.speechText, question.prompt].filter(Boolean).join(" ");
    appendQuestionWordUsage(state, {
      eventId: `exam:${exam.id}:${question.id}`,
      source: "exam",
      taskId: question.id,
      question: { english, contentType: "sentence" },
      result: {
        correct: grade.correct === true,
        gradingStatus: grade.correct === true ? "correct" : "incorrect",
        score: Number(grade.score) >= Number(question.points) ? 1 : 0
      },
      occurredAt: exam.submittedAt || exam.result.gradedAt,
      date: studyDateForTimestamp(exam.submittedAt || exam.result.gradedAt),
      formalEvidence: true
    });
  });
}

function studyDateForTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(safe);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function appendCompletedDictationWordUsage(state, session) {
  if (!session || session.status !== "completed") return;
  (Array.isArray(session.items) ? session.items : []).forEach(item => {
    appendQuestionWordUsage(state, {
      eventId: `dictation:${session.id}:${item.id}`,
      source: "dictation",
      taskId: item.id,
      question: { contentType: "word", wordId: item.wordId, english: item.english },
      result: { correct: item.correct === true, gradingStatus: item.correct === true ? "correct" : "incorrect", score: item.correct === true ? 1 : 0 },
      occurredAt: session.completedAt,
      date: studyDateForTimestamp(session.completedAt),
      formalEvidence: true
    });
  });
}

function appendCompletedFocusedWordUsage(state, session) {
  if (!session || session.status !== "completed" || !session.result) return;
  const grades = new Map((Array.isArray(session.result.grades) ? session.result.grades : []).map(grade => [grade.questionId, grade]));
  (Array.isArray(session.questions) ? session.questions : []).forEach(question => {
    const grade = grades.get(question.id) || {};
    appendQuestionWordUsage(state, {
      eventId: `focused:${session.id}:${question.id}`,
      source: "focused",
      taskId: question.id,
      question: { contentType: "sentence", english: [session.passage, question.sourceText, question.prompt].filter(Boolean).join(" ") },
      result: { correct: grade.correct === true, gradingStatus: grade.correct === true ? "correct" : "incorrect", score: grade.correct === true ? 1 : 0 },
      occurredAt: session.completedAt,
      date: studyDateForTimestamp(session.completedAt),
      formalEvidence: true
    });
  });
}

function reconcileAiExamGeneration(state) {
  const examState = sanitizeAiExamState(state.aiExam);
  const generation = examState.generation;
  if (generation && generation.status === "pending" && !activeExamGenerationJobs.has(generation.id)) {
    const finishedAt = new Date().toISOString();
    examState.generation = {
      ...generation,
      status: "failed",
      finishedAt,
      error: "服务器更新中断了试卷生成，请重新生成",
      providerStatus: null
    };
    examState.updatedAt = finishedAt;
    state.aiExam = examState;
    persistUserStates();
  }
  return examState;
}

function startAiExamGeneration(user, state, selection, profile) {
  const generationId = `examgen-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  selection.examState.generation = {
    id: generationId,
    status: "pending",
    startedAt,
    finishedAt: "",
    examId: "",
    error: "",
    providerStatus: null
  };
  selection.examState.updatedAt = startedAt;
  state.aiExam = selection.examState;
  persistUserStates();

  const examOptions = {
    includeEssay: selection.includeEssay,
    includeListening: selection.includeListening,
    totalPoints: selection.totalPoints
  };
  const job = (async () => {
    try {
      const routed = await runAiRoute(selection.route, config => createAiExamGenerator({
        ...config,
        timeoutMs: Math.max(Number(config.timeoutMs) || 0, EXAM_GENERATION_TIMEOUT_MS)
      }).generate(profile, examOptions));
      const currentState = getUserState(user);
      const examState = sanitizeAiExamState(currentState.aiExam);
      if (!examState.generation || examState.generation.id !== generationId) return;
      const exam = createExam(routed.value, routed.config);
      const finishedAt = new Date().toISOString();
      examState.currentExam = exam;
      examState.generation = {
        ...examState.generation,
        status: "completed",
        finishedAt,
        examId: exam.id,
        error: "",
        providerStatus: null
      };
      examState.updatedAt = finishedAt;
      currentState.aiExam = examState;
      persistUserStates();
    } catch (error) {
      console.warn(`AI exam generation failed: ${error && error.message ? error.message : "unknown error"}`);
      const currentState = getUserState(user);
      const examState = sanitizeAiExamState(currentState.aiExam);
      if (!examState.generation || examState.generation.id !== generationId) return;
      const failure = publicAiGenerationFailure(error);
      const finishedAt = new Date().toISOString();
      examState.generation = {
        ...examState.generation,
        status: "failed",
        finishedAt,
        error: failure.message,
        providerStatus: failure.providerStatus
      };
      examState.updatedAt = finishedAt;
      currentState.aiExam = examState;
      persistUserStates();
    }
  })().finally(() => activeExamGenerationJobs.delete(generationId));
  activeExamGenerationJobs.set(generationId, job);
  return generationId;
}

async function handleAiExams(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  const state = getUserState(user);

  if (url.pathname === "/api/ai/exams" && req.method === "GET") {
    return sendJson(res, 200, publicAiExamState(reconcileAiExamGeneration(state)));
  }

  if (url.pathname === "/api/ai/exams/generate" && req.method === "POST") {
    if (String(req.headers["x-english-review-exam-version"] || "") !== EXAM_GENERATION_API_VERSION) return sendError(res, 409, "网页已更新，请刷新页面后重新生成试卷");
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const existingExamState = reconcileAiExamGeneration(state);
      if (existingExamState.generation && existingExamState.generation.status === "pending") return sendError(res, 409, "试卷正在后台生成，请等待完成");
      const selection = aiExamSelectionForState(state, body);
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      refreshContent();
      const profile = buildLearningProfile(content, state, today());
      if (!profile.allowedWords.length) return sendError(res, 409, "no learned words are available");
      startAiExamGeneration(user, state, selection, profile);
      return sendJson(res, 202, publicAiExamState(state.aiExam));
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`AI exam generation failed: ${error && error.message ? error.message : "unknown error"}`);
      const failure = publicAiGenerationFailure(error);
      return sendJson(res, failure.statusCode, { error: failure.message, providerStatus: failure.providerStatus });
    }
  }

  if (url.pathname === "/api/ai/exams/current" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const examState = sanitizeAiExamState(state.aiExam);
      const exam = examState.currentExam;
      if (!exam || exam.id !== String(body.examId || "")) return sendError(res, 404, "exam not found");
      if (exam.status !== "draft") return sendError(res, 409, "exam has already been submitted");
      exam.answers = sanitizeAnswers(exam, body.answers);
      examState.currentExam = exam;
      examState.updatedAt = new Date().toISOString();
      state.aiExam = examState;
      persistUserStates();
      return sendJson(res, 200, publicAiExamState(examState));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/exams/listening" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const examState = sanitizeAiExamState(state.aiExam);
      const exam = examState.currentExam;
      if (!exam || exam.id !== String(body.examId || "")) return sendError(res, 404, "exam not found");
      const text = listeningSpeech(exam, body.questionId);
      if (!text) return sendError(res, 404, "listening question not found");
      return sendJson(res, 200, { text, lang: "en-US", rate: 0.75 });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/exams/photo-grade" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req, 18 * 1024 * 1024);
      const examState = sanitizeAiExamState(state.aiExam);
      const exam = examState.currentExam;
      if (!exam || exam.id !== String(body.examId || "")) return sendError(res, 404, "exam not found");
      if (exam.status !== "draft") return sendError(res, 409, "exam has already been submitted");
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      refreshContent();
      const before = analyzeAbilities(content, state);
      const availableModels = getAvailableModels(aiSettings);
      const model = availableModels.includes(exam.model) ? exam.model : aiSettings.defaultModel;
      const visionRoute = selectAiCandidates(aiSettings, { model, reasoningEffort: exam.reasoningEffort });
      const recognized = await runAiRoute(visionRoute, config => createAiPaperRecognizer(config).recognize(exam, body.images));
      exam.answers = sanitizeAnswers(exam, recognized.value.answers);
      const profile = buildLearningProfile(content, state, today());
      const gradingRoute = selectAiCandidates(aiSettings, { model, reasoningEffort: exam.reasoningEffort });
      const graded = await runAiRoute(gradingRoute, config => createAiExamGrader(config).grade({ exam, answers: exam.answers, allowedWords: profile.allowedWords }));
      const completed = completeExam(exam, graded.value, graded.config, profile.allowedWords);
      if (recognized.value.recognitionNote) completed.result.summary = `${recognized.value.recognitionNote} ${completed.result.summary}`.trim();
      state.aiExam = recordCompletedExam(examState, completed);
      appendCompletedExamWordUsage(state, completed);
      persistUserStates();
      const abilities = analyzeAbilities(content, state);
      return sendJson(res, 200, { ...publicAiExamState(state.aiExam), abilities, abilityChanges: abilityChanges(before, abilities), submissionMode: "photo" });
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`AI paper exam grading failed: ${error && error.message ? error.message : "unknown error"}`);
      const providerStatus = Number(error && error.providerStatus) || null;
      const message = [400, 422].includes(providerStatus) ? "当前模型可能不支持图片识别，请选择支持视觉的模型后重试" : "纸质答卷识别或判卷暂时不可用，原试卷草稿仍保留";
      return sendJson(res, providerStatus === 429 ? 429 : 502, { error: message, providerStatus });
    }
  }

  if (url.pathname === "/api/ai/exams/submit" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const examState = sanitizeAiExamState(state.aiExam);
      const exam = examState.currentExam;
      if (!exam || exam.id !== String(body.examId || "")) return sendError(res, 404, "exam not found");
      if (exam.status !== "draft") return sendError(res, 409, "exam has already been submitted");
      exam.answers = sanitizeAnswers(exam, { ...exam.answers, ...(body.answers && typeof body.answers === "object" ? body.answers : {}) });
      if (!examAnswersComplete(exam, exam.answers)) return sendError(res, 400, "请完成整张试卷后再交卷");
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      refreshContent();
      const before = analyzeAbilities(content, state);
      const profile = buildLearningProfile(content, state, today());
      const availableModels = getAvailableModels(aiSettings);
      const model = availableModels.includes(exam.model) ? exam.model : aiSettings.defaultModel;
      const route = selectAiCandidates(aiSettings, { model, reasoningEffort: exam.reasoningEffort });
      const routed = await runAiRoute(route, config => createAiExamGrader(config).grade({ exam, answers: exam.answers, allowedWords: profile.allowedWords }));
      const completed = completeExam(exam, routed.value, routed.config, profile.allowedWords);
      state.aiExam = recordCompletedExam(examState, completed);
      appendCompletedExamWordUsage(state, completed);
      persistUserStates();
      const abilities = analyzeAbilities(content, state);
      return sendJson(res, 200, { ...publicAiExamState(state.aiExam), abilities, abilityChanges: abilityChanges(before, abilities), submissionMode: "web" });
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`AI exam grading failed: ${error && error.message ? error.message : "unknown error"}`);
      const providerStatus = Number(error && error.providerStatus) || null;
      return sendJson(res, providerStatus === 429 ? 429 : 502, { error: "AI 判卷暂时不可用，试卷草稿已保留，请稍后重新交卷", providerStatus });
    }
  }

  return sendError(res, 404, "AI exam endpoint not found");
}

function dictationSelectionForState(state, requested = {}) {
  const dictation = sanitizeDictationState(state.dictation);
  const availableModels = getAvailableModels(aiSettings);
  const storedModel = String(dictation.settings.model || "").trim();
  const model = String(requested.model || (availableModels.includes(storedModel) ? storedModel : aiSettings && aiSettings.defaultModel) || "").trim();
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : dictation.settings.reasoningEffort;
  const count = [5, 10, 20].includes(Number(requested.count)) ? Number(requested.count) : dictation.settings.count;
  const route = selectAiCandidates(aiSettings, { model, reasoningEffort });
  dictation.settings = { model: route.model, reasoningEffort: route.reasoningEffort, count };
  dictation.updatedAt = new Date().toISOString();
  state.dictation = dictation;
  return { route, dictation, count };
}

async function handleAiDictation(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  const state = getUserState(user);

  if (url.pathname === "/api/ai/dictation" && req.method === "GET") {
    return sendJson(res, 200, publicDictationState(state.dictation));
  }

  if (url.pathname === "/api/ai/dictation/generate" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const selection = dictationSelectionForState(state, body);
      refreshContent();
      const learnedWords = content.words.filter(item => !item.preview && item.learned && String(item.learned) <= today());
      if (!learnedWords.length) return sendError(res, 409, "no learned words are available");
      const priorityWordIds = rankedWordUsageIds(state.wordUsage, content, { date: today(), timeZone: APP_TIMEZONE, limit: learnedWords.length });
      const words = selectDictationWords(learnedWords, selection.dictation.weights, selection.count, Math.random, priorityWordIds);
      selection.dictation.currentSession = createDictationSession(words, selection.route.candidates[0]);
      selection.dictation.updatedAt = new Date().toISOString();
      state.dictation = selection.dictation;
      persistUserStates();
      return sendJson(res, 201, publicDictationState(state.dictation));
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`Dictation generation failed: ${error && error.message ? error.message : "unknown error"}`);
      return sendError(res, 502, "听写生成失败，请检查 AI 模型设置");
    }
  }

  if (url.pathname === "/api/ai/dictation/current" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const dictation = sanitizeDictationState(state.dictation);
      const session = dictation.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "dictation session not found");
      if (session.status !== "draft") return sendError(res, 409, "dictation has already been submitted");
      dictation.currentSession = saveDictationAnswers(session, body.answers);
      dictation.updatedAt = new Date().toISOString();
      state.dictation = dictation;
      persistUserStates();
      return sendJson(res, 200, publicDictationState(dictation));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/dictation/speech" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const dictation = sanitizeDictationState(state.dictation);
      const session = dictation.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "dictation session not found");
      const text = dictationSpeech(session, body.itemId);
      if (!text) return sendError(res, 404, "dictation item not found");
      return sendJson(res, 200, { text, lang: "en-US", rate: 0.7 });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/dictation/submit" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const dictation = sanitizeDictationState(state.dictation);
      let session = dictation.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "dictation session not found");
      if (session.status !== "draft") return sendError(res, 409, "dictation has already been submitted");
      session = saveDictationAnswers(session, body.answers);
      if (!dictationComplete(session)) return sendError(res, 400, "请完成全部听写后再提交");
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      const before = analyzeAbilities(content, state);
      session = gradeDictation(session);
      const availableModels = getAvailableModels(aiSettings);
      const model = availableModels.includes(session.model) ? session.model : aiSettings.defaultModel;
      const route = selectAiCandidates(aiSettings, { model, reasoningEffort: session.reasoningEffort });
      const routed = await runAiRoute(route, config => createAiDictationAnalyzer(config).analyze(session));
      const completed = completeDictation(session, routed.value, routed.config);
      state.dictation = recordCompletedDictation(dictation, completed);
      appendCompletedDictationWordUsage(state, completed);
      persistUserStates();
      const abilities = analyzeAbilities(content, state);
      return sendJson(res, 200, { ...publicDictationState(state.dictation), abilities, abilityChanges: abilityChanges(before, abilities) });
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`AI dictation analysis failed: ${error && error.message ? error.message : "unknown error"}`);
      const providerStatus = Number(error && error.providerStatus) || null;
      return sendJson(res, providerStatus === 429 ? 429 : 502, { error: "AI 听写分析暂时不可用，草稿已保留，请稍后重新提交", providerStatus });
    }
  }

  return sendError(res, 404, "dictation endpoint not found");
}

function focusedSelectionForState(state, requested = {}) {
  const focused = sanitizeFocusedState(state.focusedPractice);
  const availableModels = getAvailableModels(aiSettings);
  const storedModel = String(focused.settings.model || "").trim();
  const model = String(requested.model || (availableModels.includes(storedModel) ? storedModel : aiSettings && aiSettings.defaultModel) || "").trim();
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : focused.settings.reasoningEffort;
  const focusedType = normalizeFocusedType(requested.focusedType || focused.settings.focusedType);
  const route = selectAiCandidates(aiSettings, { model, reasoningEffort });
  focused.settings = { model: route.model, reasoningEffort: route.reasoningEffort, focusedType };
  focused.updatedAt = new Date().toISOString();
  state.focusedPractice = focused;
  return { route, focused, focusedType };
}

async function handleAiFocusedPractice(req, res, url, user) {
  if (!user) return sendError(res, 401, "login required");
  const state = getUserState(user);

  if (url.pathname === "/api/ai/focused" && req.method === "GET") {
    return sendJson(res, 200, publicFocusedState(state.focusedPractice));
  }

  if (url.pathname === "/api/ai/focused/generate" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const selection = focusedSelectionForState(state, body);
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      refreshContent();
      const profile = buildLearningProfile(content, state, today());
      if (!profile.allowedWords.length) return sendError(res, 409, "no learned words are available");
      const routed = await runAiRoute(selection.route, config => createAiFocusedGenerator(config).generate(profile, selection.focusedType));
      selection.focused.currentSession = createFocusedSession(routed.value, routed.config, selection.focusedType);
      selection.focused.updatedAt = new Date().toISOString();
      state.focusedPractice = selection.focused;
      persistUserStates();
      return sendJson(res, 201, publicFocusedState(state.focusedPractice));
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`Focused practice generation failed: ${error && error.message ? error.message : "unknown error"}`);
      const failure = publicAiGenerationFailure(error);
      return sendJson(res, failure.statusCode, { error: failure.message, providerStatus: failure.providerStatus });
    }
  }

  if (url.pathname === "/api/ai/focused/current" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      const focused = sanitizeFocusedState(state.focusedPractice);
      let session = focused.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "focused practice not found");
      if (session.status !== "draft") return sendError(res, 409, "focused practice has already been submitted");
      session = saveFocusedAnswers(session, sanitizeAnswers(examForFocusedGrading(session), body.answers));
      focused.currentSession = session;
      focused.updatedAt = new Date().toISOString();
      state.focusedPractice = focused;
      persistUserStates();
      return sendJson(res, 200, publicFocusedState(focused));
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/focused/listening" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const focused = sanitizeFocusedState(state.focusedPractice);
      const session = focused.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "focused practice not found");
      const text = focusedListeningSpeech(session, body.questionId);
      if (!text) return sendError(res, 404, "focused listening question not found");
      return sendJson(res, 200, { text, lang: "en-US", rate: 0.72 });
    } catch (error) {
      return sendError(res, error.statusCode || 400, error.message);
    }
  }

  if (url.pathname === "/api/ai/focused/submit" && req.method === "POST") {
    if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
    try {
      const body = await readBody(req);
      const focused = sanitizeFocusedState(state.focusedPractice);
      let session = focused.currentSession;
      if (!session || session.id !== String(body.sessionId || "")) return sendError(res, 404, "focused practice not found");
      if (session.status !== "draft") return sendError(res, 409, "focused practice has already been submitted");
      const exam = examForFocusedGrading(session);
      session = saveFocusedAnswers(session, sanitizeAnswers(exam, body.answers));
      if (!focusedAnswersComplete(session)) return sendError(res, 400, "请完成全部专项题目后再提交");
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      refreshContent();
      const before = analyzeAbilities(content, state);
      const profile = buildLearningProfile(content, state, today());
      const availableModels = getAvailableModels(aiSettings);
      const model = availableModels.includes(session.model) ? session.model : aiSettings.defaultModel;
      const route = selectAiCandidates(aiSettings, { model, reasoningEffort: session.reasoningEffort });
      const routed = await runAiRoute(route, config => createAiExamGrader(config).grade({ exam, answers: session.answers, allowedWords: profile.allowedWords }));
      const completed = completeFocusedSession(session, routed.value, routed.config);
      state.focusedPractice = recordCompletedFocused(focused, completed);
      appendCompletedFocusedWordUsage(state, completed);
      persistUserStates();
      const abilities = analyzeAbilities(content, state);
      return sendJson(res, 200, { ...publicFocusedState(state.focusedPractice), abilities, abilityChanges: abilityChanges(before, abilities) });
    } catch (error) {
      if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
      console.warn(`Focused practice grading failed: ${error && error.message ? error.message : "unknown error"}`);
      const providerStatus = Number(error && error.providerStatus) || null;
      return sendJson(res, providerStatus === 429 ? 429 : 502, { error: "AI 专项分析暂时不可用，草稿已保留，请稍后重新提交", providerStatus });
    }
  }

  return sendError(res, 404, "focused practice endpoint not found");
}

function mimeType(filePath) { return { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".ogg": "audio/ogg", ".wav": "audio/wav" }[path.extname(filePath).toLowerCase()] || "application/octet-stream"; }

const STATIC_ASSET_VERSION = "78";
const STATIC_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STATIC_REVALIDATE_CACHE_CONTROL = "no-cache";

function staticCacheControl(filePath, url) {
  const name = path.basename(filePath);
  if (name === "index.html" || name === "sw.js") return STATIC_REVALIDATE_CACHE_CONTROL;
  if (url.searchParams.get("v") === STATIC_ASSET_VERSION) return STATIC_IMMUTABLE_CACHE_CONTROL;
  if (url.searchParams.has("v")) return STATIC_REVALIDATE_CACHE_CONTROL;
  return "public, max-age=3600";
}

function staticEntityTag(stats) {
  return `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

function staticRequestIsFresh(req, stats, entityTag) {
  const ifNoneMatch = String(req.headers["if-none-match"] || "").trim();
  if (ifNoneMatch) {
    const normalizedEntityTag = entityTag.replace(/^W\//, "");
    return ifNoneMatch === "*" || ifNoneMatch.split(",").some(value => value.trim().replace(/^W\//, "") === normalizedEntityTag);
  }
  const ifModifiedSince = Date.parse(String(req.headers["if-modified-since"] || ""));
  if (!Number.isFinite(ifModifiedSince)) return false;
  return Math.floor(stats.mtimeMs / 1000) * 1000 <= ifModifiedSince;
}

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname); if (relative === "/") relative = "/index.html";
  if (relative.includes("\0") || relative.includes("..") || relative.startsWith("/server/")) return sendError(res, 404, "not found");
  const filePath = path.resolve(ROOT, `.${relative}`); if (!filePath.startsWith(ROOT + path.sep)) return sendError(res, 404, "not found");
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return sendError(res, 404, "not found");
    setCommonHeaders(res, mimeType(filePath));
    const entityTag = staticEntityTag(stats);
    res.setHeader("Cache-Control", staticCacheControl(filePath, url));
    res.setHeader("ETag", entityTag);
    res.setHeader("Last-Modified", stats.mtime.toUTCString());
    if (staticRequestIsFresh(req, stats, entityTag)) { res.writeHead(304); return res.end(); }
    res.setHeader("Content-Length", stats.size);
    if (req.method === "HEAD") { res.writeHead(200); return res.end(); }
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`); const user = getRequestUser(req);
  if (req.method === "OPTIONS") { setCommonHeaders(res); res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith("/api/auth/")) return handleAuth(req, res, url);
  if (url.pathname.startsWith("/api/admin/ai-config")) return handleAiAdmin(req, res, url, user);
  if (url.pathname === "/api/health" && req.method === "GET") {
    refreshUsers();
    return sendJson(res, 200, { ok: true, service: "daily-english-review", currentDay: content.currentDay, words: content.words.length, previewWords: content.words.filter(item => item.preview).length, sentences: content.sentences.length, notes: content.notes.length, users: users.users.length, authRequired: true, aiGrading: aiConfigured(), time: new Date().toISOString() });
  }
  if (url.pathname === "/api/ai/options" && req.method === "GET") return user ? sendJson(res, 200, publicAiOptions(user)) : sendError(res, 401, "login required");
  if (url.pathname === "/api/preview/words") return handlePreviewWords(req, res, user);
  if (url.pathname === "/api/preview/practice/sentences") return handlePreviewPracticeSentences(req, res, user);
  if (url.pathname === "/api/preview/practice/grade") return handlePreviewPracticeGrade(req, res, user);
  if (url.pathname === "/api/preview") return handlePreview(req, res, user);
  if (url.pathname === "/api/offline/pack") return handleOfflinePack(req, res, user);
  if (url.pathname === "/api/abilities") return handleAbilities(req, res, user);
  if (url.pathname === "/api/word-usage") return handleWordUsage(req, res, url, user);
  if (url.pathname === "/api/review/sentence-stats") return handleReviewSentenceStats(req, res, url, user);
  if (url.pathname === "/api/review/sentence-variants") return handleReviewSentenceVariants(req, res, user);
  if (url.pathname === "/api/review/batches" || url.pathname.startsWith("/api/review/batches/")) return handleReviewBatches(req, res, url, user);
  if (url.pathname === "/api/ai/grade") return handleAiGrade(req, res, user);
  if (url.pathname === "/api/ai/exams" || url.pathname.startsWith("/api/ai/exams/")) return handleAiExams(req, res, url, user);
  if (url.pathname === "/api/ai/dictation" || url.pathname.startsWith("/api/ai/dictation/")) return handleAiDictation(req, res, url, user);
  if (url.pathname === "/api/ai/focused" || url.pathname.startsWith("/api/ai/focused/")) return handleAiFocusedPractice(req, res, url, user);
  if (url.pathname === "/api/ai/questions/queue/clear") return handleAiGenerationQueueClear(req, res, user);
  if (url.pathname === "/api/ai/questions/generate") return handleAiGenerate(req, res, user);
  if (url.pathname === "/api/ai/questions/next") return handleAiNextSet(req, res, user);
  if (url.pathname === "/api/ai/questions/batch" || url.pathname.startsWith("/api/ai/questions/batch/")) return handleAiQuestionBatch(req, res, url, user);
  if (url.pathname === "/api/ai/questions/tutor/clear") return handleAiTutorClear(req, res, user);
  if (url.pathname === "/api/ai/questions/ask") return handleAiTutorAsk(req, res, user);
  if (url.pathname === "/api/ai/questions/grade") return handleAiQuestionGrade(req, res, user);
  if (url.pathname === "/api/sync/profile") return handleLearningSync(req, res, url);
  if (url.pathname === "/api/sync/teaching-profile") return handleTeachingProfileSync(req, res, url);
  if (url.pathname === "/api/sync/self-study-lessons") return handleSelfStudyLessonSync(req, res, url);
  if (url.pathname === "/api/self-study" || url.pathname.startsWith("/api/self-study/")) return handleSelfStudy(req, res, url, user);
  if (url.pathname === "/api/export" && req.method === "GET") return user ? sendJson(res, 200, { content, state: publicReviewState(getUserState(user)), user: publicUser(user) }) : sendError(res, 401, "login required");
  if (url.pathname === "/api/state/study-time") return handleStudyTimeState(req, res, user);
  if (url.pathname === "/api/state") return handleState(req, res, user);
  if (url.pathname === "/api/content" || url.pathname.startsWith("/api/content/")) return handleContent(req, res, url, user);
  return serveStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`每日英语复习已启动：http://0.0.0.0:${PORT}`);
  console.log(`词库：${content.words.length} 个单词，${content.sentences.length} 个句子；账号：${users.users.length}`);
  if (API_TOKEN) console.log("API token content protection: enabled");
  resumeReviewVariantPoolsAfterStartup();
});
