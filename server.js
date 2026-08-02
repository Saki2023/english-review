const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { URL } = require("url");
const { loadUsers, normalizeUsername, publicUser, validPassword, validateCredentials } = require("./server/accounts");
const { chineseAnswerMatches, englishAnswerMatches } = require("./answer-utils");
const { createAiConnectionTester, createAiGrader, createAiModelFetcher, createAiQuestionGenerator, createAiTutor, createRateLimiter } = require("./server/ai-grader");
const { MAX_AI_HISTORY, MAX_TUTOR_HISTORY, MAX_TUTOR_MESSAGES, buildLearningProfile, createQuestionSet, sanitizeAiPractice, sanitizeTutorExchange, tutorThreadFromHistory } = require("./server/ai-practice");
const { AI_EFFORTS, createAiSettingsStore, getAvailableModels, resolveAiConnection, selectAiCandidates } = require("./server/ai-settings");
const { buildLearningSyncProfile } = require("./server/learning-sync");
const { validLearningSyncToken, validTeachingProfileWriteToken } = require("./server/learning-sync-token");
const { publicTeachingProfile, sanitizeTeachingProfile } = require("./server/teaching-profile");
const { abilityChanges, analyzeAbilities } = require("./server/ability-analysis");
const { repairLearningEvidence } = require("./server/evidence-repair");
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
const PORT = Number(process.env.PORT || 8080);
const API_TOKEN = String(process.env.API_TOKEN || "").trim();
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const APP_TIMEZONE = process.env.TZ || "Asia/Shanghai";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_AI_ANSWER_LENGTH = 500;
const MAX_AI_TUTOR_MESSAGE_LENGTH = 500;
const EXAM_GENERATION_TIMEOUT_MS = 120000;
const EXAM_GENERATION_API_VERSION = "2";

ensureDataDir();
const aiSettingsStore = createAiSettingsStore(DATA_DIR);
let aiSettings = aiSettingsStore.load();
let takeAiRequest = createRateLimiter(aiSettings ? aiSettings.rateLimitPerMinute : 20);
let content = loadContent();
let users = loadUsers(DATA_DIR);
let sessions = loadSessions();
let userStates = loadUserStates();
const activeExamGenerationJobs = new Map();
const legacyState = repairLearningEvidence(content, sanitizeState(readJson(LEGACY_STATE_FILE, {}))).state;
repairStoredUserStates();

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_) { return fallback; }
}

function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

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
  (Array.isArray(storedItems) ? storedItems : []).forEach(item => { if (item && item.id) map.set(item.id, item); });
  return Array.from(map.values());
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
    notes: Array.isArray(seed.notes) ? seed.notes : (Array.isArray(source.notes) ? source.notes : []),
    seedMistakes: Array.isArray(seed.seedMistakes) ? seed.seedMistakes : (Array.isArray(source.seedMistakes) ? source.seedMistakes : []),
    deletedIds
  };
}

function recalculateCurrentDay(target, seedDay = 0) {
  const itemDays = [...(target.words || []), ...(target.sentences || [])].map(item => Number(item.day) || 0);
  target.currentDay = Math.max(Number(seedDay) || 0, ...itemDays);
}

function loadContent() {
  const seed = readSeedContent();
  const merged = mergeContent(seed, readJson(CONTENT_FILE, null));
  recalculateCurrentDay(merged, seed.currentDay);
  writeJson(CONTENT_FILE, merged);
  return merged;
}

function refreshContent() {
  try {
    const seed = readSeedContent();
    const merged = mergeContent(seed, content);
    recalculateCurrentDay(merged, seed.currentDay);
    const changed = merged.currentDay !== content.currentDay || merged.words.length !== content.words.length || merged.sentences.length !== content.sentences.length || merged.notes.length !== (content.notes || []).length || merged.updatedAt !== content.updatedAt || merged.deletedIds.length !== (content.deletedIds || []).length;
    content = merged;
    if (changed) writeJson(CONTENT_FILE, content);
  } catch (_) {
    // Keep the last valid content if a seed file is temporarily unavailable.
  }
}

function sanitizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schema: 1,
    evidenceRepairVersion: Math.max(0, Number(source.evidenceRepairVersion) || 0),
    taskStates: source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {},
    history: source.history && typeof source.history === "object" ? source.history : {},
    attempts: Array.isArray(source.attempts) ? source.attempts.slice(-120) : [],
    sessions: source.sessions && typeof source.sessions === "object" ? source.sessions : {},
    mistakes: Array.isArray(source.mistakes) ? source.mistakes.slice(-80) : [],
    aiPractice: sanitizeAiPractice(source.aiPractice),
    aiExam: sanitizeAiExamState(source.aiExam),
    dictation: sanitizeDictationState(source.dictation),
    focusedPractice: sanitizeFocusedState(source.focusedPractice),
    teachingProfile: sanitizeTeachingProfile(source.teachingProfile)
  };
}

function publicReviewState(value) {
  const { aiExam, dictation, focusedPractice, teachingProfile, ...reviewState } = sanitizeState(value);
  return reviewState;
}

function defaultState() { return repairLearningEvidence(content, sanitizeState({})).state; }
function isEmptyState(value) { return !value || (!Object.keys(value.taskStates || {}).length && !Object.keys(value.history || {}).length && !value.attempts?.length && !value.mistakes?.length); }

function loadSessions() {
  const saved = readJson(SESSIONS_FILE, {});
  return { schema: 1, sessions: saved.sessions && typeof saved.sessions === "object" ? saved.sessions : {} };
}

function loadUserStates() {
  const saved = readJson(USER_STATES_FILE, {});
  return { schema: 1, users: saved.users && typeof saved.users === "object" ? saved.users : {} };
}

function persistSessions() { writeJson(SESSIONS_FILE, sessions); }
function persistUserStates() { writeJson(USER_STATES_FILE, userStates); }
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

function repairStoredUserStates() {
  let changed = false;
  Object.entries(userStates.users).forEach(([userId, value]) => {
    const repaired = repairLearningEvidence(content, sanitizeState(value));
    userStates.users[userId] = repaired.state;
    if (repaired.changed) changed = true;
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
  if (!userStates.users[user.id]) {
    const canMigrate = user.role === "admin" && users.users.length === 1 && !isEmptyState(legacyState);
    userStates.users[user.id] = canMigrate ? legacyState : defaultState();
    persistUserStates();
  } else {
    const repaired = repairLearningEvidence(content, sanitizeState(userStates.users[user.id]));
    userStates.users[user.id] = repaired.state;
    if (repaired.changed) persistUserStates();
  }
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
  const english = String(body.english || "").trim(); const chinese = String(body.chinese || "").trim();
  if (!english || !chinese) throw Object.assign(new Error("english and chinese are required"), { statusCode: 400 });
  const day = Number(body.day || content.currentDay || 1);
  if (!Number.isInteger(day) || day < 1) throw Object.assign(new Error("day must be a positive integer"), { statusCode: 400 });
  const base = { id: String(body.id || `api-d${day}-${kind}-${slug(english)}-${Date.now()}`).trim(), day, learned: String(body.learned || today()), english, chinese, directions: Array.isArray(body.directions) && body.directions.length ? body.directions : ["en-zh", "zh-en"] };
  if (kind === "word") return { ...base, phonetic: String(body.phonetic || "").trim(), acceptedChinese: Array.isArray(body.acceptedChinese) && body.acceptedChinese.length ? body.acceptedChinese : [chinese], pronunciation: String(body.pronunciation || "").trim(), example: String(body.example || "").trim(), exampleZh: String(body.exampleZh || "").trim() };
  return { ...base, acceptedChinese: Array.isArray(body.acceptedChinese) && body.acceptedChinese.length ? body.acceptedChinese : [chinese], acceptedEnglish: Array.isArray(body.acceptedEnglish) && body.acceptedEnglish.length ? body.acceptedEnglish : [english.toLowerCase().replace(/[.,!?;:]/g, "").trim()] };
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
  if (!canManageContent(req, user) && ["POST", "PATCH", "DELETE"].includes(req.method)) return sendError(res, user ? 403 : 401, user ? "admin role required" : "login required");
  if (req.method === "POST" && url.pathname === "/api/content") return readBody(req).then(body => { const item = addContentItem(body); persistContent(); sendJson(res, 201, item); }).catch(error => sendError(res, error.statusCode || 400, error.message));
  if (req.method === "POST" && url.pathname === "/api/content/batch") return readBody(req).then(body => {
    const incoming = Array.isArray(body.items) ? body.items : [...(Array.isArray(body.words) ? body.words.map(item => ({ ...item, kind: "word" })) : []), ...(Array.isArray(body.sentences) ? body.sentences.map(item => ({ ...item, kind: "sentence" })) : [])];
    if (!incoming.length) throw Object.assign(new Error("items, words, or sentences are required"), { statusCode: 400 });
    const normalized = incoming.map(normalizeContentItem); const existingIds = new Set([...content.words, ...content.sentences].map(item => item.id)); const incomingIds = new Set();
    normalized.forEach(item => { if (existingIds.has(item.id) || incomingIds.has(item.id)) throw Object.assign(new Error(`id already exists: ${item.id}`), { statusCode: 409 }); incomingIds.add(item.id); });
    const added = normalized.map(item => addContentItem({ ...item, kind: item.phonetic !== undefined ? "word" : "sentence" })); persistContent(); sendJson(res, 201, { added, currentDay: content.currentDay, updatedAt: content.updatedAt });
  }).catch(error => sendError(res, error.statusCode || 400, error.message));
  if (match && (req.method === "PATCH" || req.method === "DELETE")) {
    const found = findContentItem(decodeURIComponent(match[1])); if (!found) return sendError(res, 404, "content item not found");
    if (req.method === "DELETE") { found.collection.splice(found.index, 1); content.deletedIds = Array.from(new Set([...(content.deletedIds || []), found.item.id])); recalculateCurrentDay(content, readSeedContent().currentDay); content.updatedAt = today(); persistContent(); return sendJson(res, 200, { deleted: true, id: found.item.id }); }
    return readBody(req).then(body => { const merged = normalizeContentItem({ ...found.item, ...body, id: found.item.id, kind: found.item.phonetic !== undefined ? "word" : "sentence" }); found.collection[found.index] = merged; content.currentDay = Math.max(content.currentDay, merged.day); content.updatedAt = today(); persistContent(); sendJson(res, 200, merged); }).catch(error => sendError(res, error.statusCode || 400, error.message));
  }
  return sendError(res, 404, "content endpoint not found");
}

function handleState(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method === "GET") return sendJson(res, 200, publicReviewState(getUserState(user)));
  if (req.method === "PUT") return readBody(req).then(body => {
    const existing = getUserState(user);
    userStates.users[user.id] = repairLearningEvidence(content, sanitizeState({ ...body, aiExam: existing.aiExam, dictation: existing.dictation, focusedPractice: existing.focusedPractice, teachingProfile: existing.teachingProfile })).state;
    persistUserStates();
    sendJson(res, 200, publicReviewState(userStates.users[user.id]));
  }).catch(error => sendError(res, error.statusCode || 400, error.message));
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

function handleAbilities(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "GET") return sendError(res, 404, "ability endpoint not found");
  refreshContent();
  return sendJson(res, 200, analyzeAbilities(content, getUserState(user)));
}

function findSentenceTask(taskId) {
  const value = String(taskId || "");
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const direction = value.slice(separator + 1);
  if (!["en-zh", "zh-en"].includes(direction)) return null;
  const item = content.sentences.find(sentence => sentence.id === id);
  return item ? { item, direction, taskId: value } : null;
}

function localSentenceAnswerMatches(task, answer) {
  if (task.direction === "zh-en") return englishAnswerMatches(answer, task.item.acceptedEnglish || [task.item.english]);
  return chineseAnswerMatches(answer, task.item.acceptedChinese || [task.item.chinese]);
}

function aiSelectionForState(state, requested = {}) {
  const practice = sanitizeAiPractice(state.aiPractice);
  const availableModels = getAvailableModels(aiSettings);
  const storedModel = String(practice.settings.model || "").trim();
  const model = String(requested.model || (availableModels.includes(storedModel) ? storedModel : aiSettings && aiSettings.defaultModel) || "").trim();
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : practice.settings.reasoningEffort;
  const count = [5, 10].includes(Number(requested.count)) ? Number(requested.count) : practice.settings.count;
  const route = selectAiCandidates(aiSettings, { model, reasoningEffort });
  practice.settings = { model: route.model, reasoningEffort: route.reasoningEffort, count };
  practice.updatedAt = new Date().toISOString();
  state.aiPractice = practice;
  return { route, count, practice };
}

function publicAiOptions(user) {
  const current = aiSettingsStore.public();
  const practice = user ? sanitizeAiPractice(getUserState(user).aiPractice) : sanitizeAiPractice(null);
  const selectedModel = current.availableModels.includes(practice.settings.model) ? practice.settings.model : current.defaultModel;
  return {
    configured: current.configured,
    models: current.availableModels,
    defaultModel: current.defaultModel,
    efforts: current.efforts,
    selectedModel,
    selectedEffort: practice.settings.reasoningEffort,
    selectedCount: practice.settings.count,
    routingMode: current.mode,
    admin: Boolean(user && user.role === "admin")
  };
}

function publicAiGenerationFailure(error) {
  const providerStatus = Number(error && error.providerStatus) || null;
  const detail = String(error && error.message || "");
  let message = "AI 生成题目失败，请稍后重试或更换模型";
  let statusCode = 502;

  if ([401, 403].includes(providerStatus)) message = "AI 上游拒绝了请求，请检查 API Key 和模型权限";
  else if ([404, 405, 501].includes(providerStatus)) message = "AI 上游不支持该模型的生成接口，请更换模型";
  else if (providerStatus === 429) message = "AI 上游请求过多或额度不足，请稍后再试";
  else if ([400, 422].includes(providerStatus)) message = "AI 上游拒绝了当前模型或强度参数，请更换模型或降低强度";
  else if (providerStatus && providerStatus >= 500) message = "AI 上游服务暂时不可用，请稍后再试";
  else if (/timed out/i.test(detail)) {
    message = "AI 请求超时，请稍后重试或在 AI 设置中增加超时时间";
    statusCode = 504;
  } else if (/AI exam returned too few|missing numbered blanks|missing a cloze passage|missing a reading passage|point allocation is invalid/i.test(detail)) message = "AI 返回的试卷缺少必需题型或题量，系统未采用，请重新生成或更换模型";
  else if (/AI exam used unlearned English|AI exam returned no English/i.test(detail)) message = "AI 返回的试卷含有未学英语，系统未采用，请重新生成或更换模型";
  else if (/too few valid questions/i.test(detail)) message = "AI 返回的题目超出了已学词汇，请重试或更换模型";
  else if (/invalid (question|exam) JSON|did not return questions|unsupported response|Unexpected (end|token)/i.test(detail)) message = "AI 返回格式不符合出题要求，请重试或更换模型";
  else if (/response is too large/i.test(detail)) message = "AI 返回内容过长，请重试或更换模型";

  return { message, providerStatus, statusCode };
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
      return sendJson(res, 200, { ok: true, providerId: config.providerId, providerName: config.providerName, model: config.model, reasoningEffort: config.reasoningEffort });
    } catch (error) {
      console.warn(`AI connection test failed: ${error && error.message ? error.message : "unknown error"}`);
      return sendJson(res, 502, { error: "AI connection test failed", providerStatus: Number(error && error.providerStatus) || null });
    }
  }
  return sendError(res, 404, "AI admin endpoint not found");
}

function aiQuestionMatches(question, answer) {
  if (question.direction === "zh-en") return englishAnswerMatches(answer, question.acceptedEnglish || [question.english]);
  return chineseAnswerMatches(answer, question.acceptedChinese || [question.chinese]);
}

function saveAiQuestionResult(state, setId, questionId, answer, result) {
  const practice = sanitizeAiPractice(state.aiPractice);
  const set = practice.currentSet;
  if (!set || set.id !== setId) throw Object.assign(new Error("AI question set not found"), { statusCode: 404 });
  const question = set.questions.find(item => item.id === questionId);
  if (!question) throw Object.assign(new Error("AI question not found"), { statusCode: 404 });
  const now = new Date().toISOString();
  question.userAnswer = answer;
  question.correct = result.correct;
  question.explanation = result.explanation;
  question.answeredAt = now;
  const prompt = question.direction === "en-zh" ? question.english : question.chinese;
  const correctAnswer = question.direction === "zh-en" ? question.english : question.chinese;
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
    direction: question.direction,
    prompt,
    userAnswer: answer,
    correctAnswer,
    correct: result.correct,
    focus: question.focus,
    explanation: result.explanation
  }].slice(-MAX_AI_HISTORY);
  practice.updatedAt = now;
  state.aiPractice = practice;
  persistUserStates();
  return question;
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
    const task = findSentenceTask(body.taskId);
    if (!task) return sendError(res, 404, "sentence task not found");
    if (localSentenceAnswerMatches(task, answer)) {
      return sendJson(res, 200, { correct: true, explanation: "\u672c\u5730\u89c4\u5219\u5df2\u63a5\u53d7\u8fd9\u4e2a\u7b54\u6848\u3002", source: "local" });
    }

    const rate = takeAiRequest(user.id);
    if (!rate.allowed) {
      return sendJson(res, 429, { error: "AI grading rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
    }

    const state = getUserState(user);
    const selection = aiSelectionForState(state, body);
    persistUserStates();
    const acceptedAnswers = task.direction === "zh-en" ? (task.item.acceptedEnglish || [task.item.english]) : (task.item.acceptedChinese || [task.item.chinese]);
    const sourceText = task.direction === "zh-en" ? task.item.chinese : task.item.english;
    const routed = await runAiRoute(selection.route, config => createAiGrader(config).grade({ answer, acceptedAnswers, direction: task.direction, sourceText }));
    return sendJson(res, 200, { ...routed.value, source: "ai" });
  } catch (error) {
    if (error && [400, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI grading failed: ${error && error.message ? error.message : "unknown error"}`);
    return sendError(res, 503, "AI grading is temporarily unavailable");
  }
}

async function handleAiGenerate(req, res, user) {
  if (!user) return sendError(res, 401, "login required");
  if (req.method !== "POST") return sendError(res, 404, "AI generation endpoint not found");
  if (!aiConfigured()) return sendError(res, 503, "AI is not configured");
  try {
    const body = await readBody(req);
    const state = getUserState(user);
    const selection = aiSelectionForState(state, body);
    const rate = takeAiRequest(user.id);
    if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
    refreshContent();
    const profile = buildLearningProfile(content, state, today());
    if (!profile.allowedWords.length) return sendError(res, 409, "no learned words are available");
    const routed = await runAiRoute(selection.route, config => createAiQuestionGenerator(config).generate(profile, selection.count));
    const set = createQuestionSet(routed.value, routed.config);
    selection.practice.currentSet = set;
    selection.practice.tutor = null;
    selection.practice.updatedAt = new Date().toISOString();
    state.aiPractice = selection.practice;
    persistUserStates();
    return sendJson(res, 201, { set, settings: selection.practice.settings });
  } catch (error) {
    if (error && [400, 404, 409, 413].includes(error.statusCode)) return sendError(res, error.statusCode, error.message);
    console.warn(`AI question generation failed: ${error && error.message ? error.message : "unknown error"}`);
    const failure = publicAiGenerationFailure(error);
    return sendJson(res, failure.statusCode, { error: failure.message, providerStatus: failure.providerStatus });
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
    const question = !historyItem && set && set.id === body.setId ? set.questions.find(item => item.id === body.questionId) : null;
    if (body.historyId && !historyItem) return sendError(res, 404, "AI history question not found");
    if (!historyItem && (!set || set.id !== body.setId)) return sendError(res, 404, "AI question set not found");
    if (!historyItem && !question) return sendError(res, 404, "AI question not found");

    const historyPrefix = historyItem && historyItem.setId ? `${historyItem.setId}:` : "";
    const historyQuestionId = historyItem && historyPrefix && historyItem.id.startsWith(historyPrefix) ? historyItem.id.slice(historyPrefix.length) : historyItem && historyItem.id;
    const threadSetId = historyItem ? (historyItem.setId || `history-${historyItem.id}`) : set.id;
    const threadQuestionId = historyItem ? historyQuestionId : question.id;
    const exercise = historyItem ? {
      direction: historyItem.direction,
      english: historyItem.direction === "zh-en" ? historyItem.correctAnswer : historyItem.prompt,
      chinese: historyItem.direction === "zh-en" ? historyItem.prompt : historyItem.correctAnswer,
      learnerAnswer: historyItem.userAnswer,
      answered: true,
      focus: historyItem.focus || "",
      explanation: historyItem.explanation || ""
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
    const contextModel = historyItem ? historyItem.model : set.model;
    const availableModels = getAvailableModels(aiSettings);
    const requestedModel = availableModels.includes(contextModel) ? contextModel : aiSettings.defaultModel;
    const tutorEffort = AI_EFFORTS.includes(body.reasoningEffort) ? body.reasoningEffort : practice.tutorSettings.reasoningEffort;
    const route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: tutorEffort });
    const thread = tutorThreadFromHistory(practice, threadSetId, threadQuestionId);
    const askedAt = new Date().toISOString();
    const routed = await runAiRoute(route, config => createAiTutor(config).answer({
      exercise,
      history: thread.messages,
      message
    }));
    const createdAt = new Date().toISOString();
    thread.messages = [
      ...thread.messages,
      { role: "user", content: message, createdAt },
      { role: "assistant", content: routed.value, createdAt }
    ].slice(-MAX_TUTOR_MESSAGES);
    const exchange = sanitizeTutorExchange({
      id: `tutor-${crypto.randomUUID()}`,
      setId: threadSetId,
      questionId: threadQuestionId,
      historyId: historyItem ? historyItem.id : "",
      source: historyItem ? "history" : "current",
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
    const question = set.questions.find(item => item.id === body.questionId);
    if (!question) return sendError(res, 404, "AI question not found");

    let result = { correct: aiQuestionMatches(question, answer), explanation: "本地规则判定。", source: "local" };
    if (!result.correct) {
      const rate = takeAiRequest(user.id);
      if (!rate.allowed) return sendJson(res, 429, { error: "AI rate limit reached" }, { "Retry-After": String(rate.retryAfterSeconds) });
      const availableModels = getAvailableModels(aiSettings);
      const requestedModel = availableModels.includes(set.model) ? set.model : aiSettings.defaultModel;
      const route = selectAiCandidates(aiSettings, { model: requestedModel, reasoningEffort: set.reasoningEffort });
      const acceptedAnswers = question.direction === "zh-en" ? question.acceptedEnglish : question.acceptedChinese;
      const sourceText = question.direction === "zh-en" ? question.chinese : question.english;
      const routed = await runAiRoute(route, config => createAiGrader(config).grade({ answer, acceptedAnswers, direction: question.direction, sourceText }));
      result = { ...routed.value, source: "ai" };
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
      const learnedWords = content.words.filter(item => !item.learned || String(item.learned) <= today());
      if (!learnedWords.length) return sendError(res, 409, "no learned words are available");
      const words = selectDictationWords(learnedWords, selection.dictation.weights, selection.count);
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

function mimeType(filePath) { return { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }[path.extname(filePath).toLowerCase()] || "application/octet-stream"; }

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname); if (relative === "/") relative = "/index.html";
  if (relative.includes("\0") || relative.includes("..") || relative.startsWith("/server/")) return sendError(res, 404, "not found");
  const filePath = path.resolve(ROOT, `.${relative}`); if (!filePath.startsWith(ROOT + path.sep)) return sendError(res, 404, "not found");
  fs.stat(filePath, (error, stats) => { if (error || !stats.isFile()) return sendError(res, 404, "not found"); setCommonHeaders(res, mimeType(filePath)); res.setHeader("Cache-Control", ["index.html", "styles.css", "data.js", "answer-utils.js", "app.js", "sw.js"].some(name => filePath.endsWith(name)) ? "no-cache" : "public, max-age=3600"); res.writeHead(200); fs.createReadStream(filePath).pipe(res); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`); const user = getRequestUser(req);
  if (req.method === "OPTIONS") { setCommonHeaders(res); res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith("/api/auth/")) return handleAuth(req, res, url);
  if (url.pathname.startsWith("/api/admin/ai-config")) return handleAiAdmin(req, res, url, user);
  if (url.pathname === "/api/health" && req.method === "GET") {
    refreshUsers();
    return sendJson(res, 200, { ok: true, service: "daily-english-review", currentDay: content.currentDay, words: content.words.length, sentences: content.sentences.length, users: users.users.length, authRequired: true, aiGrading: aiConfigured(), time: new Date().toISOString() });
  }
  if (url.pathname === "/api/ai/options" && req.method === "GET") return user ? sendJson(res, 200, publicAiOptions(user)) : sendError(res, 401, "login required");
  if (url.pathname === "/api/abilities") return handleAbilities(req, res, user);
  if (url.pathname === "/api/ai/grade") return handleAiGrade(req, res, user);
  if (url.pathname === "/api/ai/exams" || url.pathname.startsWith("/api/ai/exams/")) return handleAiExams(req, res, url, user);
  if (url.pathname === "/api/ai/dictation" || url.pathname.startsWith("/api/ai/dictation/")) return handleAiDictation(req, res, url, user);
  if (url.pathname === "/api/ai/focused" || url.pathname.startsWith("/api/ai/focused/")) return handleAiFocusedPractice(req, res, url, user);
  if (url.pathname === "/api/ai/questions/generate") return handleAiGenerate(req, res, user);
  if (url.pathname === "/api/ai/questions/ask") return handleAiTutorAsk(req, res, user);
  if (url.pathname === "/api/ai/questions/grade") return handleAiQuestionGrade(req, res, user);
  if (url.pathname === "/api/sync/profile") return handleLearningSync(req, res, url);
  if (url.pathname === "/api/sync/teaching-profile") return handleTeachingProfileSync(req, res, url);
  if (url.pathname === "/api/export" && req.method === "GET") return user ? sendJson(res, 200, { content, state: publicReviewState(getUserState(user)), user: publicUser(user) }) : sendError(res, 401, "login required");
  if (url.pathname === "/api/state") return handleState(req, res, user);
  if (url.pathname === "/api/content" || url.pathname.startsWith("/api/content/")) return handleContent(req, res, url, user);
  return serveStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`每日英语复习已启动：http://0.0.0.0:${PORT}`);
  console.log(`词库：${content.words.length} 个单词，${content.sentences.length} 个句子；账号：${users.users.length}`);
  if (API_TOKEN) console.log("API token content protection: enabled");
});
