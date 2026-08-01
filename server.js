const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { URL } = require("url");
const { loadUsers, normalizeUsername, publicUser, validPassword, validateCredentials } = require("./server/accounts");

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

ensureDataDir();
let content = loadContent();
let users = loadUsers(DATA_DIR);
let sessions = loadSessions();
let userStates = loadUserStates();
const legacyState = sanitizeState(readJson(LEGACY_STATE_FILE, {}));

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
  return {
    version: Math.max(Number(seed.version || 1), Number(source.version || 1)),
    updatedAt: String(source.updatedAt || seed.updatedAt || today()),
    currentDay: Math.max(Number(seed.currentDay || 0), Number(source.currentDay || 0)),
    words: mergeById(seed.words, source.words).filter(item => !deletedIds.includes(item.id)),
    sentences: mergeById(seed.sentences, source.sentences).filter(item => !deletedIds.includes(item.id)),
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
    const changed = merged.currentDay !== content.currentDay || merged.words.length !== content.words.length || merged.sentences.length !== content.sentences.length || merged.updatedAt !== content.updatedAt || merged.deletedIds.length !== (content.deletedIds || []).length;
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
    taskStates: source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {},
    history: source.history && typeof source.history === "object" ? source.history : {},
    attempts: Array.isArray(source.attempts) ? source.attempts.slice(-120) : [],
    sessions: source.sessions && typeof source.sessions === "object" ? source.sessions : {},
    mistakes: Array.isArray(source.mistakes) ? source.mistakes.slice(-80) : []
  };
}

function defaultState() { return sanitizeState({}); }
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
  }
  return userStates.users[user.id];
}

function setCommonHeaders(res, contentType = "application/json; charset=utf-8") {
  res.setHeader("Content-Type", contentType);
  if (CORS_ORIGIN === "*") res.setHeader("Access-Control-Allow-Origin", "*");
  else { res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN); res.setHeader("Access-Control-Allow-Credentials", "true"); }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, status, value, extraHeaders = {}) { setCommonHeaders(res); Object.entries(extraHeaders).forEach(([key, value]) => res.setHeader(key, value)); res.writeHead(status); res.end(JSON.stringify(value)); }
function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(new Error("request body too large"), { statusCode: 413 })); req.destroy(); return; } chunks.push(chunk); });
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
  if (req.method === "GET") return sendJson(res, 200, getUserState(user));
  if (req.method === "PUT") return readBody(req).then(body => { userStates.users[user.id] = sanitizeState(body); persistUserStates(); sendJson(res, 200, userStates.users[user.id]); }).catch(error => sendError(res, error.statusCode || 400, error.message));
  return sendError(res, 404, "state endpoint not found");
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
  if (url.pathname === "/api/health" && req.method === "GET") {
    refreshUsers();
    return sendJson(res, 200, { ok: true, service: "daily-english-review", currentDay: content.currentDay, words: content.words.length, sentences: content.sentences.length, users: users.users.length, authRequired: true, time: new Date().toISOString() });
  }
  if (url.pathname === "/api/export" && req.method === "GET") return user ? sendJson(res, 200, { content, state: getUserState(user), user: publicUser(user) }) : sendError(res, 401, "login required");
  if (url.pathname === "/api/state") return handleState(req, res, user);
  if (url.pathname === "/api/content" || url.pathname.startsWith("/api/content/")) return handleContent(req, res, url, user);
  return serveStatic(req, res, url);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`每日英语复习已启动：http://0.0.0.0:${PORT}`);
  console.log(`词库：${content.words.length} 个单词，${content.sentences.length} 个句子；账号：${users.users.length}`);
  if (API_TOKEN) console.log("API token content protection: enabled");
});
