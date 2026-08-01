 (async () => {
  "use strict";

  const DATA = window.ENGLISH_REVIEW_DATA;
  const { buildMistakePracticeQueue, chineseAnswerMatches, englishAnswerMatches, normalizeChinese, normalizeEnglish, shouldSubmitOnEnter } = window.ENGLISH_REVIEW_ANSWER_UTILS;
  const STORAGE_KEY = "daily-english-review-v1";
  const DAILY_TARGET = 10;
  const INTERVALS = [1, 3, 7, 14, 30, 60];
  const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const AI_EFFORT_LABELS = { low: "轻度", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  const DEFAULT_AI_TIMEOUT_MS = 30000;
  const AI_CLIENT_TIMEOUT_MS = 125000;
  const API_ENABLED = location.protocol === "http:" || location.protocol === "https:";
  let remoteReady = !API_ENABLED;
  let remoteSaveTimer;
  const allItems = [...DATA.words.map(item => ({ ...item, type: "word" })), ...DATA.sentences.map(item => ({ ...item, type: "sentence" }))];
  const itemById = new Map(allItems.map(item => [item.id, item]));
  const taskById = new Map();
  allItems.forEach(item => (item.directions || ["en-zh"]).forEach(direction => taskById.set(`${item.id}:${direction}`, { item, direction, taskId: `${item.id}:${direction}` })));

  let activeView = "home";
  let reviewMode = "all";
  let libraryType = "word";
  let notesDay = Math.max(1, Number(DATA.currentDay) || 1, ...allItems.map(item => Number(item.day) || 0));
  let currentUser = API_ENABLED ? null : { id: "local", username: "本机模式", role: "local" };
  let appEventsBound = false;
  let authEventsBound = false;
  let model = loadModel();
  let toastTimer;
  let gradingInProgress = false;
  let aiRequestInProgress = false;
  let aiTutorRequestInProgress = false;
  let aiTutorDrag = null;
  let aiTutorTarget = null;
  let aiStatusMessage = "";
  let aiOptions = { configured: false, models: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: false };
  let aiConfigDraft = null;
  let activeAiProviderId = "";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  function localDate(date = new Date()) {
    const d = new Date(date);
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function parseDate(value) { return new Date(`${value}T12:00:00`); }

  function addDays(value, days) {
    const date = parseDate(value);
    date.setDate(date.getDate() + days);
    return localDate(date);
  }

  function displayDate(value = localDate()) {
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(parseDate(value));
  }

  function storageKey() { return currentUser && currentUser.id ? `${STORAGE_KEY}-${currentUser.id}` : STORAGE_KEY; }

  function normalizeClientTutor(value) {
    if (!value || typeof value !== "object") return null;
    const setId = String(value.setId || "").slice(0, 80);
    const questionId = String(value.questionId || "").slice(0, 80);
    if (!setId || !questionId) return null;
    const messages = (Array.isArray(value.messages) ? value.messages : []).map(item => {
      if (!item || !["user", "assistant"].includes(item.role)) return null;
      const content = String(item.content || "").trim().slice(0, item.role === "assistant" ? 1200 : 500);
      return content ? { role: item.role, content, createdAt: String(item.createdAt || "").slice(0, 40) } : null;
    }).filter(Boolean).slice(-12);
    return { setId, questionId, messages };
  }

  function normalizeClientAiPractice(value) {
    const source = value && typeof value === "object" ? value : {};
    const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
    const tutorSettings = source.tutorSettings && typeof source.tutorSettings === "object" ? source.tutorSettings : {};
    return {
      settings: {
        model: String(settings.model || ""),
        reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
        count: [5, 10].includes(Number(settings.count)) ? Number(settings.count) : 5
      },
      tutorSettings: {
        reasoningEffort: AI_EFFORTS.includes(tutorSettings.reasoningEffort) ? tutorSettings.reasoningEffort : "medium"
      },
      currentSet: source.currentSet && Array.isArray(source.currentSet.questions) ? source.currentSet : null,
      tutor: normalizeClientTutor(source.tutor),
      history: Array.isArray(source.history) ? source.history.slice(-1000) : [],
      updatedAt: String(source.updatedAt || "")
    };
  }

  function loadModel() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey()) || "null"); } catch (_) { saved = null; }
    const next = saved && typeof saved === "object" ? saved : {};
    next.taskStates = next.taskStates || {};
    next.history = next.history || {};
    next.attempts = Array.isArray(next.attempts) ? next.attempts : [];
    next.sessions = next.sessions || {};
    next.aiPractice = normalizeClientAiPractice(next.aiPractice);
    next.schema = 1;
    allItems.forEach(item => (item.directions || ["en-zh"]).forEach(direction => {
      const taskId = `${item.id}:${direction}`;
      if (!next.taskStates[taskId]) {
        next.taskStates[taskId] = { level: 0, nextDue: item.learned, lastResult: null, lastReviewed: null, reviewCount: 0 };
      }
    }));
    DATA.seedMistakes.forEach(mistake => {
      const state = next.taskStates[mistake.taskId];
      if (state && !state.reviewCount && state.lastResult === null) state.lastResult = false;
    });
    return next;
  }

  function saveModel() {
    try { localStorage.setItem(storageKey(), JSON.stringify(model)); } catch (_) { showToast("浏览器没有保存本机记录的权限"); }
    if (API_ENABLED && remoteReady) {
      clearTimeout(remoteSaveTimer);
      remoteSaveTimer = setTimeout(() => {
        fetch("/api/state", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(model) }).catch(() => {});
      }, 240);
    }
  }

  function mergeModels(local, remote) {
    const remoteTaskStates = remote && remote.taskStates ? remote.taskStates : {};
    const merged = {
      ...local,
      ...remote,
      taskStates: { ...local.taskStates },
      history: { ...local.history },
      sessions: { ...local.sessions },
      attempts: [...(local.attempts || [])],
      mistakes: [...(local.mistakes || [])],
      aiPractice: String(remote && remote.aiPractice && remote.aiPractice.updatedAt || "") >= String(local.aiPractice && local.aiPractice.updatedAt || "") ? normalizeClientAiPractice(remote.aiPractice) : normalizeClientAiPractice(local.aiPractice)
    };
    Object.entries(remoteTaskStates).forEach(([taskId, remoteState]) => {
      const localState = merged.taskStates[taskId];
      if (!localState || (remoteState.reviewCount || 0) >= (localState.reviewCount || 0) || String(remoteState.lastReviewed || "") > String(localState.lastReviewed || "")) merged.taskStates[taskId] = remoteState;
    });
    Object.entries(remote && remote.history ? remote.history : {}).forEach(([date, remoteHistory]) => {
      const localHistory = merged.history[date];
      if (!localHistory) merged.history[date] = remoteHistory;
      else merged.history[date] = { reviewed: Math.max(localHistory.reviewed || 0, remoteHistory.reviewed || 0), correct: Math.max(localHistory.correct || 0, remoteHistory.correct || 0) };
    });
    const attemptKeys = new Set(merged.attempts.map(item => `${item.date}|${item.taskId}|${item.answer}`));
    (remote && remote.attempts ? remote.attempts : []).forEach(item => { const key = `${item.date}|${item.taskId}|${item.answer}`; if (!attemptKeys.has(key)) { merged.attempts.push(item); attemptKeys.add(key); } });
    merged.attempts = merged.attempts.slice(-120);
    const mistakeKeys = new Set(merged.mistakes.map(item => item.id));
    (remote && remote.mistakes ? remote.mistakes : []).forEach(item => { if (!mistakeKeys.has(item.id)) { merged.mistakes.push(item); mistakeKeys.add(item.id); } });
    merged.mistakes = merged.mistakes.slice(-80);
    Object.entries(remote && remote.sessions ? remote.sessions : {}).forEach(([date, remoteSession]) => {
      const localSession = merged.sessions[date];
      if (!localSession || (remoteSession.doneTaskIds || []).length >= (localSession.doneTaskIds || []).length) merged.sessions[date] = remoteSession;
    });
    return merged;
  }

  async function syncRemoteState() {
    if (!API_ENABLED) return;
    try {
      const response = await fetch("/api/state", { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) return showAuthView();
      if (!response.ok) throw new Error("state request failed");
      const remote = await response.json();
      model = mergeModels(model, remote);
      remoteReady = true;
      saveModel();
      $("#dataStatus").textContent = `词库同步至第 ${DATA.currentDay} 天 · 云端已连接`;
      setView(activeView);
    } catch (_) {
      remoteReady = true;
      $("#dataStatus").textContent = `词库同步至第 ${DATA.currentDay} 天 · 离线缓存`;
    }
  }

  function showAuthView() {
    document.body.classList.add("auth-mode");
    $("#appBody").hidden = true;
    $("#authScreen").hidden = false;
    $("#accountArea").hidden = true;
    $("#resetButton").hidden = true;
    $("#openAiTutorButton").hidden = true;
    $("#aiTutorWindow").hidden = true;
    $("#authFeedback").hidden = true;
    refreshIcons();
  }

  function showAppView() {
    document.body.classList.remove("auth-mode");
    $("#authScreen").hidden = true;
    $("#appBody").hidden = false;
    $("#accountArea").hidden = false;
    $("#resetButton").hidden = false;
    $("#userBadge").textContent = currentUser ? currentUser.username : "本机模式";
    $("#logoutButton").hidden = !API_ENABLED;
    $("#openAiConfigButton").hidden = !currentUser || currentUser.role !== "admin";
    refreshIcons();
  }

  function setAuthFeedback(message) {
    const element = $("#authFeedback");
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle("is-error", Boolean(message));
  }

  async function fetchCurrentUser() {
    if (!API_ENABLED) return true;
    try {
      const response = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return false;
      const data = await response.json();
      if (!data.authenticated || !data.user) return false;
      currentUser = data.user;
      return true;
    } catch (_) { return false; }
  }

  async function submitAuth(event) {
    event.preventDefault();
    const username = $("#authUsername").value.trim();
    const password = $("#authPassword").value;
    const submit = $("#authSubmit");
    submit.disabled = true;
    setAuthFeedback("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setAuthFeedback(data.error || "操作失败，请稍后重试");
      currentUser = data.user;
      model = loadModel();
      remoteReady = false;
      showAppView();
      bindAppEvents();
      renderHome();
      loadAiOptions();
      syncRemoteState();
    } catch (_) { setAuthFeedback("无法连接服务器，请检查网络"); }
    finally { submit.disabled = false; }
  }

  async function logout() {
    if (API_ENABLED) { try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {} }
    currentUser = API_ENABLED ? null : { id: "local", username: "本机模式", role: "local" };
    remoteReady = !API_ENABLED;
    if (API_ENABLED) showAuthView();
  }

  function bindAuthEvents() {
    if (authEventsBound) return;
    authEventsBound = true;
    $("#authForm").addEventListener("submit", submitAuth);
    $("#logoutButton").addEventListener("click", logout);
  }

  function formatDirection(direction) { return direction === "en-zh" ? "英译中" : "中译英"; }

  function selectedAiSettings() {
    const practice = normalizeClientAiPractice(model.aiPractice);
    const modelName = aiOptions.models.includes(practice.settings.model) ? practice.settings.model : aiOptions.defaultModel;
    return { model: modelName, reasoningEffort: practice.settings.reasoningEffort, count: practice.settings.count };
  }

  function updateAiPreferences(patch) {
    const practice = normalizeClientAiPractice(model.aiPractice);
    practice.settings = { ...practice.settings, ...patch };
    practice.updatedAt = new Date().toISOString();
    model.aiPractice = practice;
    saveModel();
  }

  function updateAiTutorPreferences(patch) {
    const practice = normalizeClientAiPractice(model.aiPractice);
    practice.tutorSettings = { ...practice.tutorSettings, ...patch };
    practice.updatedAt = new Date().toISOString();
    model.aiPractice = practice;
    saveModel();
  }

  function populateAiModelSelect() {
    const select = $("#aiModelSelect");
    const settings = selectedAiSettings();
    select.replaceChildren(...aiOptions.models.map(modelName => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      return option;
    }));
    if (settings.model) select.value = settings.model;
    select.disabled = !aiOptions.configured || !aiOptions.models.length;
    $("#aiQuestionCount").value = String(settings.count);
    $$('[data-ai-effort]').forEach(button => {
      const active = button.dataset.aiEffort === settings.reasoningEffort;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = !aiOptions.configured;
    });
    $("#generateAiQuestions").disabled = !aiOptions.configured || aiRequestInProgress;
  }

  async function loadAiOptions() {
    aiStatusMessage = "";
    if (!API_ENABLED) {
      aiOptions = { configured: false, models: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: false };
      renderAiView();
      return;
    }
    try {
      const response = await fetch("/api/ai/options", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("AI options request failed");
      aiOptions = await response.json();
      const practice = normalizeClientAiPractice(model.aiPractice);
      if (!aiOptions.models.includes(practice.settings.model)) practice.settings.model = aiOptions.selectedModel || aiOptions.defaultModel || "";
      if (AI_EFFORTS.includes(aiOptions.selectedEffort) && !practice.updatedAt) practice.settings.reasoningEffort = aiOptions.selectedEffort;
      if ([5, 10].includes(Number(aiOptions.selectedCount)) && !practice.updatedAt) practice.settings.count = Number(aiOptions.selectedCount);
      model.aiPractice = practice;
    } catch (_) {
      aiOptions = { configured: false, models: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: Boolean(currentUser && currentUser.role === "admin") };
    }
    populateAiModelSelect();
    renderAiView();
  }

  function currentAiQuestion() {
    const set = model.aiPractice && model.aiPractice.currentSet;
    return set && Array.isArray(set.questions) ? set.questions[Number(set.index) || 0] : null;
  }

  function aiHistoryQuestionId(item) {
    const id = String(item && item.id || "");
    const setId = String(item && item.setId || "");
    const prefix = setId ? `${setId}:` : "";
    return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  function aiTutorTargetForHistory(item) {
    if (!item || !item.id) return null;
    return {
      kind: "history",
      historyId: String(item.id),
      setId: String(item.setId || `history-${item.id}`),
      questionId: aiHistoryQuestionId(item),
      prompt: String(item.prompt || "历史题目")
    };
  }

  function resolveAiTutorTarget(practice) {
    if (aiTutorTarget && aiTutorTarget.kind === "history") {
      const historyItem = practice.history.find(item => item.id === aiTutorTarget.historyId);
      if (historyItem) return aiTutorTargetForHistory(historyItem);
    }
    if (aiTutorTarget && aiTutorTarget.kind === "current") {
      const set = practice.currentSet;
      const question = set && set.id === aiTutorTarget.setId ? set.questions.find(item => item.id === aiTutorTarget.questionId) : null;
      if (question) return { ...aiTutorTarget, prompt: question.direction === "en-zh" ? question.english : question.chinese };
    }
    const set = practice.currentSet;
    const question = currentAiQuestion();
    if (set && question && !set.completed) {
      return { kind: "current", historyId: "", setId: set.id, questionId: question.id, prompt: question.direction === "en-zh" ? question.english : question.chinese };
    }
    return aiTutorTargetForHistory(practice.history[practice.history.length - 1]);
  }

  function tutorThreadForTarget(practice, target) {
    const tutor = normalizeClientTutor(practice.tutor);
    if (tutor && tutor.setId === target.setId && tutor.questionId === target.questionId) return tutor;
    return { setId: target.setId, questionId: target.questionId, messages: [] };
  }

  function renderAiTutorWindow() {
    const tutorWindow = $("#aiTutorWindow");
    const launchButton = $("#openAiTutorButton");
    const practice = normalizeClientAiPractice(model.aiPractice);
    const target = resolveAiTutorTarget(practice);
    const available = aiOptions.configured && target;
    if (!available) {
      tutorWindow.hidden = true;
      launchButton.hidden = true;
      return;
    }

    launchButton.hidden = !tutorWindow.hidden;
    if (tutorWindow.hidden) return;
    aiTutorTarget = target;
    $("#aiTutorTitle").textContent = target.kind === "history" ? "历史题问答" : "题目问答";
    $("#aiTutorContext").textContent = target.prompt;
    $("#aiTutorEffort").value = practice.tutorSettings.reasoningEffort;
    const thread = tutorThreadForTarget(practice, target);
    const messageList = $("#aiTutorMessages");
    if (!thread.messages.length) {
      const empty = document.createElement("div");
      empty.className = "ai-tutor-empty";
      empty.textContent = "暂无问答";
      messageList.replaceChildren(empty);
    } else {
      messageList.replaceChildren(...thread.messages.map(message => {
        const item = document.createElement("div");
        item.className = `ai-tutor-message ${message.role === "user" ? "is-user" : "is-assistant"}`;
        const role = document.createElement("span");
        role.className = "ai-tutor-message-role";
        role.textContent = message.role === "user" ? "你" : "AI";
        const content = document.createElement("span");
        content.textContent = message.content;
        item.append(role, content);
        return item;
      }));
      requestAnimationFrame(() => { messageList.scrollTop = messageList.scrollHeight; });
    }
    $("#clearAiTutorButton").disabled = aiTutorRequestInProgress || !thread.messages.length;
    $("#aiTutorEffort").disabled = aiTutorRequestInProgress;
    $("#aiTutorInput").disabled = aiTutorRequestInProgress;
    $("#sendAiTutorButton").disabled = aiTutorRequestInProgress;
  }

  function updateAiTutorWindowActions() {
    const tutorWindow = $("#aiTutorWindow");
    const minimized = tutorWindow.classList.contains("is-minimized");
    const maximized = tutorWindow.classList.contains("is-maximized");
    const minimize = $("#minimizeAiTutorButton");
    const maximize = $("#maximizeAiTutorButton");
    minimize.setAttribute("aria-label", minimized ? "还原问答窗口" : "最小化问答窗口");
    minimize.dataset.tooltip = minimized ? "还原" : "最小化";
    minimize.innerHTML = `<i data-lucide="${minimized ? "chevron-up" : "minus"}" aria-hidden="true"></i>`;
    maximize.setAttribute("aria-label", maximized ? "还原问答窗口" : "最大化问答窗口");
    maximize.dataset.tooltip = maximized ? "还原" : "最大化";
    maximize.innerHTML = `<i data-lucide="${maximized ? "minimize-2" : "maximize-2"}" aria-hidden="true"></i>`;
    refreshIcons();
  }

  function openAiTutorWindow(target = null) {
    const practice = normalizeClientAiPractice(model.aiPractice);
    if (target) aiTutorTarget = target;
    if (!resolveAiTutorTarget(practice)) return;
    const tutorWindow = $("#aiTutorWindow");
    tutorWindow.hidden = false;
    tutorWindow.classList.remove("is-minimized");
    updateAiTutorWindowActions();
    renderAiTutorWindow();
    requestAnimationFrame(() => $("#aiTutorInput").focus());
  }

  function closeAiTutorWindow() {
    $("#aiTutorWindow").hidden = true;
    renderAiTutorWindow();
  }

  function toggleAiTutorMinimize() {
    const tutorWindow = $("#aiTutorWindow");
    const restore = tutorWindow.classList.contains("is-minimized");
    tutorWindow.classList.remove("is-maximized");
    tutorWindow.classList.toggle("is-minimized", !restore);
    updateAiTutorWindowActions();
    if (restore) requestAnimationFrame(() => $("#aiTutorInput").focus());
  }

  function toggleAiTutorMaximize() {
    const tutorWindow = $("#aiTutorWindow");
    tutorWindow.classList.remove("is-minimized");
    tutorWindow.classList.toggle("is-maximized");
    updateAiTutorWindowActions();
  }

  function clearAiTutor() {
    if (aiTutorRequestInProgress) return;
    const practice = normalizeClientAiPractice(model.aiPractice);
    practice.tutor = null;
    practice.updatedAt = new Date().toISOString();
    model.aiPractice = practice;
    saveModel();
    renderAiTutorWindow();
  }

  async function submitAiTutorQuestion(event) {
    event.preventDefault();
    if (aiTutorRequestInProgress) return;
    const input = $("#aiTutorInput");
    const message = input.value.trim();
    const practice = normalizeClientAiPractice(model.aiPractice);
    const target = resolveAiTutorTarget(practice);
    if (!message || !target) return;

    const previousTutor = practice.tutor;
    const thread = tutorThreadForTarget(practice, target);
    const createdAt = new Date().toISOString();
    practice.tutor = {
      setId: target.setId,
      questionId: target.questionId,
      messages: [
        ...thread.messages,
        { role: "user", content: message, createdAt },
        { role: "assistant", content: "正在回答…", createdAt }
      ].slice(-12)
    };
    model.aiPractice = practice;
    aiTutorRequestInProgress = true;
    renderAiTutorWindow();
    try {
      const data = await responseJson(await fetch("/api/ai/questions/ask", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setId: target.setId,
          questionId: target.questionId,
          historyId: target.historyId,
          message,
          reasoningEffort: practice.tutorSettings.reasoningEffort
        })
      }));
      const next = normalizeClientAiPractice(model.aiPractice);
      next.tutor = normalizeClientTutor(data.tutor);
      next.tutorSettings = normalizeClientAiPractice({ tutorSettings: data.tutorSettings }).tutorSettings;
      next.updatedAt = new Date().toISOString();
      model.aiPractice = next;
      input.value = "";
      saveModel();
    } catch (error) {
      const reverted = normalizeClientAiPractice(model.aiPractice);
      reverted.tutor = previousTutor;
      model.aiPractice = reverted;
      showToast(error.message);
    } finally {
      aiTutorRequestInProgress = false;
      renderAiTutorWindow();
      requestAnimationFrame(() => input.focus());
    }
  }

  function startAiTutorDrag(event) {
    const tutorWindow = $("#aiTutorWindow");
    if (event.button !== 0 || event.target.closest("button") || matchMedia("(max-width: 760px)").matches || tutorWindow.classList.contains("is-minimized") || tutorWindow.classList.contains("is-maximized")) return;
    const rect = tutorWindow.getBoundingClientRect();
    aiTutorDrag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height };
    tutorWindow.style.width = `${rect.width}px`;
    tutorWindow.style.height = `${rect.height}px`;
    tutorWindow.style.right = "auto";
    tutorWindow.style.bottom = "auto";
    tutorWindow.style.left = `${rect.left}px`;
    tutorWindow.style.top = `${rect.top}px`;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveAiTutorWindow(event) {
    if (!aiTutorDrag || event.pointerId !== aiTutorDrag.pointerId) return;
    const maximumLeft = Math.max(8, window.innerWidth - aiTutorDrag.width - 8);
    const maximumTop = Math.max(8, window.innerHeight - aiTutorDrag.height - 8);
    $("#aiTutorWindow").style.left = `${Math.min(maximumLeft, Math.max(8, event.clientX - aiTutorDrag.offsetX))}px`;
    $("#aiTutorWindow").style.top = `${Math.min(maximumTop, Math.max(8, event.clientY - aiTutorDrag.offsetY))}px`;
  }

  function endAiTutorDrag(event) {
    if (!aiTutorDrag || event.pointerId !== aiTutorDrag.pointerId) return;
    aiTutorDrag = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (_) {}
  }

  function aiCorrectAnswer(question) { return question.direction === "zh-en" ? question.english : question.chinese; }

  function aiHistorySetId(item, index) {
    const explicit = String(item && item.setId || "").trim();
    if (explicit) return explicit;
    const id = String(item && item.id || "");
    return id.includes(":") ? id.slice(0, id.indexOf(":")) : `legacy-${item && item.date || "unknown"}-${index}`;
  }

  function formatAiHistoryTime(value, fallback = "") {
    const source = String(value || fallback || "");
    if (!source) return "时间未记录";
    if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return displayDate(source);
    const date = new Date(source);
    if (Number.isNaN(date.getTime())) return source;
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function groupAiHistory(practice) {
    const currentSet = practice.currentSet;
    const groups = new Map();
    practice.history.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const setId = aiHistorySetId(item, index);
      if (!groups.has(setId)) {
        groups.set(setId, {
          id: setId,
          createdAt: item.setCreatedAt || item.answeredAt || item.date || "",
          latestAt: item.answeredAt || item.setCreatedAt || item.date || "",
          providerName: item.providerName || "",
          model: item.model || "",
          reasoningEffort: item.reasoningEffort || "",
          expectedCount: Number(item.questionCount) || 0,
          latestOrder: index,
          questions: []
        });
      }
      const group = groups.get(setId);
      group.questions.push(item);
      if (String(item.answeredAt || "") > String(group.latestAt || "")) group.latestAt = item.answeredAt;
      group.latestOrder = Math.max(group.latestOrder, index);
      if (!group.providerName && item.providerName) group.providerName = item.providerName;
      if (!group.model && item.model) group.model = item.model;
      if (!group.reasoningEffort && item.reasoningEffort) group.reasoningEffort = item.reasoningEffort;
      group.expectedCount = Math.max(group.expectedCount, Number(item.questionCount) || 0);
    });
    return Array.from(groups.values()).map(group => {
      if (currentSet && currentSet.id === group.id) {
        group.createdAt ||= currentSet.createdAt;
        group.providerName ||= currentSet.providerName;
        group.model ||= currentSet.model;
        group.reasoningEffort ||= currentSet.reasoningEffort;
        group.expectedCount = Math.max(group.expectedCount, currentSet.questions.length);
      }
      group.questions.sort((left, right) => (Number(left.questionNumber) || 999) - (Number(right.questionNumber) || 999) || String(left.answeredAt || "").localeCompare(String(right.answeredAt || "")));
      if (!group.expectedCount) group.expectedCount = group.questions.length;
      return group;
    }).sort((left, right) => String(right.latestAt || right.createdAt || "").localeCompare(String(left.latestAt || left.createdAt || "")) || right.latestOrder - left.latestOrder);
  }

  function renderAiHistory() {
    const practice = normalizeClientAiPractice(model.aiPractice);
    const groups = groupAiHistory(practice);
    const questions = groups.flatMap(group => group.questions);
    const correct = questions.filter(item => item.correct === true).length;
    const accuracy = questions.length ? Math.round((correct / questions.length) * 100) : 0;
    $("#aiHistorySummary").textContent = questions.length ? `${groups.length} 组 · ${questions.length} 题 · 正确率 ${accuracy}%` : "暂无做题记录";
    const list = $("#aiHistoryList");
    if (!groups.length) {
      list.innerHTML = `<div class="ai-history-empty"><i data-lucide="history" aria-hidden="true"></i><span>暂无做题记录</span></div>`;
      refreshIcons();
      return;
    }
    list.innerHTML = groups.map(group => {
      const groupCorrect = group.questions.filter(item => item.correct === true).length;
      const complete = group.questions.length >= group.expectedCount;
      const modelLabel = [group.providerName, group.model, AI_EFFORT_LABELS[group.reasoningEffort]].filter(Boolean).join(" · ") || "历史题组";
      const questionRows = group.questions.map((item, index) => {
        const number = Number(item.questionNumber) || index + 1;
        return `<article class="ai-history-question">
          <div class="ai-history-question-meta"><span>第 ${number} 题 · ${formatDirection(item.direction)}</span><div class="ai-history-question-actions"><span class="ai-history-result ${item.correct === true ? "is-correct" : "is-wrong"}">${item.correct === true ? "正确" : "错误"}</span><button class="text-button ai-history-ask" type="button" data-ai-history-ask="${escapeHtml(item.id)}"><i data-lucide="message-circle-question" aria-hidden="true"></i>询问</button></div></div>
          <div class="ai-history-prompt">${escapeHtml(item.prompt || "（题目未记录）")}</div>
          <dl class="ai-history-answers">
            <div><dt>你的答案</dt><dd>${escapeHtml(item.userAnswer || "（未填写）")}</dd></div>
            <div><dt>正确答案</dt><dd>${escapeHtml(item.correctAnswer || "（未记录）")}</dd></div>
            ${item.explanation ? `<div><dt>讲解</dt><dd>${escapeHtml(item.explanation)}</dd></div>` : ""}
          </dl>
        </article>`;
      }).join("");
      return `<details class="ai-history-group">
        <summary>
          <div class="ai-history-group-main"><strong>${escapeHtml(formatAiHistoryTime(group.createdAt, group.latestAt))}</strong><span>${escapeHtml(modelLabel)}</span></div>
          <div class="ai-history-score"><strong>${groupCorrect} / ${group.questions.length}</strong><span>${complete ? "已完成" : `已做 ${group.questions.length} / ${group.expectedCount}`}</span></div>
          <i data-lucide="chevron-down" aria-hidden="true"></i>
        </summary>
        <div class="ai-history-questions">${questionRows}</div>
      </details>`;
    }).join("");
    refreshIcons();
  }

  function renderAiFeedback(question) {
    const feedback = $("#aiFeedback");
    if (typeof question.correct !== "boolean") {
      feedback.hidden = true;
      $("#aiFeedbackActions").hidden = true;
      return;
    }
    feedback.hidden = false;
    feedback.className = `feedback ${question.correct ? "is-correct" : "is-wrong"}`;
    feedback.innerHTML = `<span class="feedback-title">${question.correct ? "答对了" : "再看一次"}</span><span class="feedback-answer">正确答案：${escapeHtml(aiCorrectAnswer(question))}</span>${question.correct ? "" : `<span class="feedback-note">你的答案：${escapeHtml(question.userAnswer || "（未填写）")}</span>`}${question.explanation ? `<span class="feedback-note">${escapeHtml(question.explanation)}</span>` : ""}`;
    $("#aiFeedbackActions").hidden = false;
    requestAnimationFrame(() => $("#nextAiQuestion").focus({ preventScroll: true }));
  }

  function renderAiView() {
    if (!model.aiPractice) model.aiPractice = normalizeClientAiPractice(null);
    populateAiModelSelect();
    renderAiHistory();
    $("#openAiConfigButton").hidden = !currentUser || currentUser.role !== "admin";
    $("#aiStatus").textContent = aiStatusMessage || (aiOptions.configured ? "AI 已配置" : "AI 尚未配置");
    const empty = $("#aiEmptyState");
    const panel = $("#aiPracticePanel");
    const complete = $("#aiPracticeComplete");
    if (!aiOptions.configured) {
      empty.hidden = false; panel.hidden = true; complete.hidden = true;
      $("#aiEmptyTitle").textContent = currentUser && currentUser.role === "admin" ? "请先完成 AI 连接设置" : "AI 尚未配置";
      renderAiTutorWindow();
      return;
    }

    const set = model.aiPractice.currentSet;
    if (!set) {
      empty.hidden = false; panel.hidden = true; complete.hidden = true;
      $("#aiEmptyTitle").textContent = "准备生成题目";
      renderAiTutorWindow();
      return;
    }
    if (set.completed || Number(set.index) >= set.questions.length) {
      set.completed = true;
      empty.hidden = true; panel.hidden = true; complete.hidden = false;
      const correct = set.questions.filter(question => question.correct === true).length;
      $("#aiCompleteNote").textContent = `答对 ${correct} / ${set.questions.length} 题`;
      renderAiTutorWindow();
      return;
    }

    const question = currentAiQuestion();
    if (!question) {
      renderAiTutorWindow();
      return;
    }
    empty.hidden = true; panel.hidden = false; complete.hidden = true;
    $("#aiFocusBadge").textContent = question.focus || "巩固练习";
    $("#aiModelReadout").textContent = [set.providerName, set.model, AI_EFFORT_LABELS[set.reasoningEffort] || "中"].filter(Boolean).join(" · ");
    $("#aiQuestionProgress").textContent = `${Number(set.index) + 1} / ${set.questions.length}`;
    $("#aiDirectionLabel").textContent = formatDirection(question.direction);
    $("#aiPromptText").textContent = question.direction === "en-zh" ? question.english : question.chinese;
    $("#aiAnswerInput").value = question.userAnswer || "";
    $("#aiAnswerInput").placeholder = question.direction === "en-zh" ? "输入中文答案" : "输入英文答案";
    const answered = typeof question.correct === "boolean";
    $("#aiAnswerInput").disabled = answered || aiRequestInProgress;
    $("#submitAiAnswer").disabled = answered || aiRequestInProgress;
    renderAiFeedback(question);
    renderAiTutorWindow();
    if (!answered) requestAnimationFrame(() => $("#aiAnswerInput").focus());
    refreshIcons();
  }

  function setBusyButton(button, busy, label) {
    if (busy) {
      button.dataset.idleHtml = button.innerHTML;
      button.textContent = label;
      button.disabled = true;
    } else if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
      button.disabled = false;
      refreshIcons();
    }
  }

  async function responseJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败，请稍后重试");
    return data;
  }

  async function generateAiQuestions() {
    if (aiRequestInProgress || !aiOptions.configured) return;
    const button = $("#generateAiQuestions");
    const settings = {
      model: $("#aiModelSelect").value,
      reasoningEffort: $$('[data-ai-effort]').find(item => item.classList.contains("is-selected"))?.dataset.aiEffort || "medium",
      count: Number($("#aiQuestionCount").value) || 5
    };
    updateAiPreferences(settings);
    aiRequestInProgress = true;
    setBusyButton(button, true, "正在生成…");
    aiStatusMessage = "正在分析学习进度…";
    $("#aiStatus").textContent = aiStatusMessage;
    try {
      const response = await fetch("/api/ai/questions/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      const data = await responseJson(response);
      const practice = normalizeClientAiPractice(model.aiPractice);
      practice.settings = data.settings;
      practice.currentSet = data.set;
      practice.tutor = null;
      aiTutorTarget = null;
      practice.updatedAt = new Date().toISOString();
      model.aiPractice = practice;
      saveModel();
      aiStatusMessage = "题目已生成";
    } catch (error) {
      aiStatusMessage = error.message;
      showToast(error.message);
    } finally {
      aiRequestInProgress = false;
      setBusyButton(button, false, "");
      renderAiView();
    }
  }

  async function submitAiAnswer(event) {
    event.preventDefault();
    if (aiRequestInProgress) return;
    const set = model.aiPractice && model.aiPractice.currentSet;
    const question = currentAiQuestion();
    const answer = $("#aiAnswerInput").value.trim();
    if (!set || !question || !answer) return;
    aiRequestInProgress = true;
    setBusyButton($("#submitAiAnswer"), true, "AI 正在判断…");
    $("#aiAnswerInput").disabled = true;
    try {
      const response = await fetch("/api/ai/questions/grade", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setId: set.id, questionId: question.id, answer })
      });
      const data = await responseJson(response);
      model.aiPractice = normalizeClientAiPractice(data.practice);
      saveModel();
    } catch (error) {
      showToast(error.message);
      $("#aiAnswerInput").disabled = false;
    } finally {
      aiRequestInProgress = false;
      setBusyButton($("#submitAiAnswer"), false, "");
      renderAiView();
    }
  }

  function advanceAiQuestion() {
    const practice = normalizeClientAiPractice(model.aiPractice);
    const set = practice.currentSet;
    if (!set) return;
    const question = set.questions[Number(set.index) || 0];
    if (!question || typeof question.correct !== "boolean") return;
    set.index = (Number(set.index) || 0) + 1;
    set.completed = set.index >= set.questions.length;
    practice.tutor = null;
    aiTutorTarget = null;
    practice.updatedAt = new Date().toISOString();
    model.aiPractice = practice;
    saveModel();
    renderAiView();
  }

  function normalizeConfigModels(models) {
    return Array.from(new Set((Array.isArray(models) ? models : []).map(value => String(value || "").trim()).filter(value => value && value.length <= 120))).slice(0, 200);
  }

  function newAiProviderId() {
    const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `provider-${suffix}`.slice(0, 64);
  }

  function createAiProviderDraft(value = {}, index = 0) {
    return {
      id: String(value.id || newAiProviderId()),
      name: String(value.name || `供应商 ${index + 1}`),
      enabled: value.enabled !== false,
      baseUrl: String(value.baseUrl || ""),
      apiKey: "",
      hasApiKey: Boolean(value.hasApiKey),
      models: normalizeConfigModels(value.models),
      timeoutMs: Number(value.timeoutMs) || DEFAULT_AI_TIMEOUT_MS
    };
  }

  function createAiConfigDraft(config = {}) {
    const sourceProviders = Array.isArray(config.providers) && config.providers.length
      ? config.providers
      : config.baseUrl
        ? [{ id: "legacy-primary", name: "默认供应商", enabled: true, baseUrl: config.baseUrl, hasApiKey: config.hasApiKey, models: config.models, timeoutMs: config.timeoutMs }]
        : [{}];
    const providers = sourceProviders.map(createAiProviderDraft);
    const enabled = providers.filter(provider => provider.enabled);
    const requestedManualId = String(config.manualProviderId || "");
    const manualProviderId = (enabled.find(provider => provider.id === requestedManualId) || enabled[0] || providers[0]).id;
    return {
      mode: config.mode === "auto" ? "auto" : "manual",
      manualProviderId,
      providers,
      defaultModel: String(config.defaultModel || ""),
      rateLimitPerMinute: Number(config.rateLimitPerMinute) || 20
    };
  }

  function activeAiProvider() {
    return aiConfigDraft && aiConfigDraft.providers.find(provider => provider.id === activeAiProviderId) || null;
  }

  function configModelNames() {
    const provider = activeAiProvider();
    return provider ? [...provider.models] : [];
  }

  function renderConfigModelList() {
    const models = configModelNames();
    const list = $("#aiModelList");
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "model-list-empty";
      empty.textContent = "尚未获取模型";
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...models.map(modelName => {
        const item = document.createElement("div");
        item.className = "model-list-item";
        item.setAttribute("role", "listitem");
        const name = document.createElement("span");
        name.textContent = modelName;
        name.title = modelName;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "model-remove-button";
        remove.dataset.model = modelName;
        remove.setAttribute("aria-label", `移除模型 ${modelName}`);
        const icon = document.createElement("i");
        icon.dataset.lucide = "x";
        icon.setAttribute("aria-hidden", "true");
        remove.append(icon);
        item.append(name, remove);
        return item;
      }));
    }
    $("#aiModelCount").textContent = `${models.length} 个模型`;
    refreshIcons();
  }

  function setConfigModels(models, preferred = "") {
    const normalized = normalizeConfigModels(models);
    const provider = activeAiProvider();
    if (provider) provider.models = normalized;
    $("#aiModels").value = normalized.join("\n");
    renderConfigModelList();
    renderAiProviderList();
    syncAiRoutingControls(preferred);
  }

  function availableAiConfigModels() {
    if (!aiConfigDraft) return [];
    const providers = aiConfigDraft.mode === "auto"
      ? aiConfigDraft.providers.filter(provider => provider.enabled)
      : aiConfigDraft.providers.filter(provider => provider.enabled && provider.id === aiConfigDraft.manualProviderId);
    return normalizeConfigModels(providers.flatMap(provider => provider.models)).sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
  }

  function syncAiRoutingControls(preferred = "") {
    if (!aiConfigDraft) return;
    $$('[data-ai-routing-mode]').forEach(button => {
      const selected = button.dataset.aiRoutingMode === aiConfigDraft.mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-checked", String(selected));
    });
    const enabled = aiConfigDraft.providers.filter(provider => provider.enabled);
    if (!enabled.some(provider => provider.id === aiConfigDraft.manualProviderId)) {
      aiConfigDraft.manualProviderId = (enabled[0] || aiConfigDraft.providers[0] || {}).id || "";
    }
    const manualSelect = $("#aiManualProvider");
    const choices = enabled.length ? enabled : aiConfigDraft.providers;
    manualSelect.replaceChildren(...choices.map(provider => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = `${provider.name || "未命名供应商"}${provider.enabled ? "" : "（已停用）"}`;
      return option;
    }));
    manualSelect.value = aiConfigDraft.manualProviderId;
    manualSelect.disabled = !choices.length;
    $("#aiManualProviderField").hidden = aiConfigDraft.mode === "auto";

    const select = $("#aiDefaultModel");
    const current = preferred || select.value || aiConfigDraft.defaultModel;
    const models = availableAiConfigModels();
    select.replaceChildren(...models.map(modelName => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      return option;
    }));
    aiConfigDraft.defaultModel = models.includes(current) ? current : (models[0] || "");
    select.value = aiConfigDraft.defaultModel;
    select.disabled = !models.length;
  }

  function renderAiProviderList() {
    const list = $("#aiProviderList");
    if (!aiConfigDraft) return list.replaceChildren();
    list.replaceChildren(...aiConfigDraft.providers.map(provider => {
      const row = document.createElement("div");
      row.className = `ai-provider-row${provider.id === activeAiProviderId ? " is-selected" : ""}${provider.enabled ? "" : " is-disabled"}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = "ai-provider-select";
      select.dataset.aiProviderSelect = provider.id;
      select.setAttribute("aria-pressed", String(provider.id === activeAiProviderId));
      const name = document.createElement("span");
      name.className = "ai-provider-name";
      name.textContent = provider.name || "未命名供应商";
      const meta = document.createElement("span");
      meta.className = "ai-provider-meta";
      meta.textContent = `${provider.enabled ? "已启用" : "已停用"} · ${provider.models.length} 个模型`;
      select.append(name, meta);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ai-provider-delete";
      remove.dataset.aiProviderDelete = provider.id;
      remove.disabled = aiConfigDraft.providers.length <= 1;
      remove.setAttribute("aria-label", `删除 ${provider.name || "供应商"}`);
      const icon = document.createElement("i");
      icon.dataset.lucide = "trash-2";
      icon.setAttribute("aria-hidden", "true");
      remove.append(icon);
      row.append(select, remove);
      return row;
    }));
    refreshIcons();
  }

  function renderAiProviderEditor() {
    const provider = activeAiProvider();
    $("#aiProviderEditor").hidden = !provider;
    if (!provider) return;
    $("#aiProviderName").value = provider.name;
    $("#aiProviderEnabled").checked = provider.enabled;
    $("#aiBaseUrl").value = provider.baseUrl;
    $("#aiApiKey").value = provider.apiKey;
    $("#aiApiKey").required = !provider.hasApiKey && !provider.apiKey;
    $("#aiApiKey").placeholder = provider.hasApiKey ? "已保存，留空则不修改" : "输入 API Key";
    $("#aiTimeout").value = String(provider.timeoutMs || DEFAULT_AI_TIMEOUT_MS);
    $("#aiModels").value = provider.models.join("\n");
    $("#aiCustomModel").value = "";
    renderConfigModelList();
  }

  function renderAiConfiguration(preferredModel = "") {
    renderAiProviderList();
    renderAiProviderEditor();
    syncAiRoutingControls(preferredModel);
    $("#aiRateLimit").value = String(aiConfigDraft ? aiConfigDraft.rateLimitPerMinute : 20);
    refreshIcons();
  }

  function syncActiveAiProviderEditor() {
    const provider = activeAiProvider();
    if (!provider) return;
    provider.name = $("#aiProviderName").value.trim();
    provider.enabled = $("#aiProviderEnabled").checked;
    provider.baseUrl = $("#aiBaseUrl").value.trim();
    provider.apiKey = $("#aiApiKey").value.trim();
    provider.timeoutMs = Number($("#aiTimeout").value) || DEFAULT_AI_TIMEOUT_MS;
  }

  function updateActiveAiProvider(event) {
    syncActiveAiProviderEditor();
    const provider = activeAiProvider();
    if (!provider) return;
    $("#aiApiKey").required = !provider.hasApiKey && !provider.apiKey;
    if (["aiProviderName", "aiProviderEnabled"].includes(event.target.id)) {
      renderAiProviderList();
      syncAiRoutingControls();
    }
  }

  function selectAiProvider(providerId) {
    syncActiveAiProviderEditor();
    if (!aiConfigDraft || !aiConfigDraft.providers.some(provider => provider.id === providerId)) return;
    activeAiProviderId = providerId;
    renderAiConfiguration();
  }

  function addAiProvider() {
    syncActiveAiProviderEditor();
    if (!aiConfigDraft || aiConfigDraft.providers.length >= 20) return setAiConfigFeedback("最多可以保存 20 套供应商", true);
    const provider = createAiProviderDraft({ name: `供应商 ${aiConfigDraft.providers.length + 1}` }, aiConfigDraft.providers.length);
    aiConfigDraft.providers.push(provider);
    activeAiProviderId = provider.id;
    renderAiConfiguration();
    setAiConfigFeedback("已添加供应商，保存后生效");
    $("#aiProviderName").select();
  }

  function deleteAiProvider(providerId) {
    syncActiveAiProviderEditor();
    if (!aiConfigDraft || aiConfigDraft.providers.length <= 1) return;
    const removed = aiConfigDraft.providers.find(provider => provider.id === providerId);
    aiConfigDraft.providers = aiConfigDraft.providers.filter(provider => provider.id !== providerId);
    if (aiConfigDraft.manualProviderId === providerId) aiConfigDraft.manualProviderId = (aiConfigDraft.providers.find(provider => provider.enabled) || aiConfigDraft.providers[0]).id;
    if (activeAiProviderId === providerId) activeAiProviderId = aiConfigDraft.providers[0].id;
    renderAiConfiguration();
    setAiConfigFeedback(`${removed && removed.name || "供应商"}已移除，保存后生效`);
  }

  function setAiRoutingMode(mode) {
    if (!aiConfigDraft || !["manual", "auto"].includes(mode)) return;
    aiConfigDraft.mode = mode;
    syncAiRoutingControls();
  }

  function addCustomAiModel() {
    const input = $("#aiCustomModel");
    const modelName = input.value.trim();
    if (!modelName) return;
    if (modelName.length > 120) return setAiConfigFeedback("模型名称不能超过 120 个字符", true);
    setConfigModels([...configModelNames(), modelName], $("#aiDefaultModel").value || modelName);
    input.value = "";
    setAiConfigFeedback(`已添加模型：${modelName}`);
  }

  function removeConfigAiModel(modelName) {
    const currentDefault = $("#aiDefaultModel").value;
    setConfigModels(configModelNames().filter(value => value !== modelName), currentDefault);
  }

  async function fetchUpstreamAiModels() {
    const button = $("#fetchAiModelsButton");
    syncActiveAiProviderEditor();
    const provider = activeAiProvider();
    const baseUrl = $("#aiBaseUrl");
    const apiKey = $("#aiApiKey");
    if (!provider) return;
    if (!baseUrl.value.trim()) return baseUrl.reportValidity();
    if (apiKey.required && !apiKey.value.trim()) return apiKey.reportValidity();
    setBusyButton(button, true, "正在获取…");
    setAiConfigFeedback("正在读取上游模型…");
    try {
      const data = await responseJson(await fetch("/api/admin/ai-config/models", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.id,
          providerName: provider.name,
          baseUrl: baseUrl.value.trim(),
          apiKey: apiKey.value.trim(),
          timeoutMs: Number($("#aiTimeout").value) || DEFAULT_AI_TIMEOUT_MS
        })
      }));
      setConfigModels(data.models, $("#aiDefaultModel").value);
      setAiConfigFeedback(`已获取 ${data.count} 个上游模型，保存后生效`);
    } catch (error) {
      setAiConfigFeedback(error.message, true);
    } finally {
      setBusyButton(button, false, "");
    }
  }

  function setAiConfigFeedback(message, error = false) {
    const feedback = $("#aiConfigFeedback");
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.classList.toggle("is-error", error);
  }

  async function openAiConfiguration() {
    if (!currentUser || currentUser.role !== "admin") return;
    const dialog = $("#aiConfigDialog");
    dialog.showModal();
    setAiConfigFeedback("正在读取配置…");
    try {
      const config = await responseJson(await fetch("/api/admin/ai-config", { credentials: "same-origin", cache: "no-store" }));
      aiConfigDraft = createAiConfigDraft(config);
      activeAiProviderId = aiConfigDraft.providers.some(provider => provider.id === config.manualProviderId) ? config.manualProviderId : aiConfigDraft.providers[0].id;
      renderAiConfiguration(config.defaultModel);
      setAiConfigFeedback(config.configured ? "配置已保存" : "尚未配置");
    } catch (error) {
      setAiConfigFeedback(error.message, true);
    }
    refreshIcons();
  }

  function aiProviderValidationProblem(provider) {
    if (!provider.name) return { message: "请输入供应商名称", field: "#aiProviderName" };
    if (!provider.baseUrl) return { message: `${provider.name} 缺少 Base URL`, field: "#aiBaseUrl" };
    try {
      const url = new URL(provider.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch (_) { return { message: `${provider.name} 的 Base URL 无效`, field: "#aiBaseUrl" }; }
    if (!provider.apiKey && !provider.hasApiKey) return { message: `${provider.name} 缺少 API Key`, field: "#aiApiKey" };
    if (!provider.models.length) return { message: `${provider.name} 至少需要一个模型`, field: "#fetchAiModelsButton" };
    if (!Number.isInteger(provider.timeoutMs) || provider.timeoutMs < 1000 || provider.timeoutMs > 120000) return { message: `${provider.name} 的超时必须在 1000 到 120000 毫秒之间`, field: "#aiTimeout" };
    return null;
  }

  function showAiProviderValidation(provider, problem) {
    activeAiProviderId = provider.id;
    renderAiConfiguration();
    setAiConfigFeedback(problem.message, true);
    requestAnimationFrame(() => $(problem.field).focus());
  }

  async function saveAiConfiguration(closeAfterSave = false) {
    const form = $("#aiConfigForm");
    if (!aiConfigDraft) return null;
    syncActiveAiProviderEditor();
    aiConfigDraft.rateLimitPerMinute = Number($("#aiRateLimit").value);
    aiConfigDraft.defaultModel = $("#aiDefaultModel").value;
    for (const provider of aiConfigDraft.providers) {
      const problem = aiProviderValidationProblem(provider);
      if (problem) {
        showAiProviderValidation(provider, problem);
        return null;
      }
    }
    if (!form.reportValidity()) return null;
    const body = {
      schema: 2,
      mode: aiConfigDraft.mode,
      manualProviderId: aiConfigDraft.manualProviderId,
      providers: aiConfigDraft.providers.map(provider => ({
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        models: provider.models,
        timeoutMs: provider.timeoutMs
      })),
      defaultModel: aiConfigDraft.defaultModel,
      rateLimitPerMinute: aiConfigDraft.rateLimitPerMinute
    };
    const config = await responseJson(await fetch("/api/admin/ai-config", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));
    const previousActiveId = activeAiProviderId;
    aiConfigDraft = createAiConfigDraft(config);
    activeAiProviderId = aiConfigDraft.providers.some(provider => provider.id === previousActiveId) ? previousActiveId : aiConfigDraft.providers[0].id;
    renderAiConfiguration(config.defaultModel);
    setAiConfigFeedback("配置已保存");
    await loadAiOptions();
    if (closeAfterSave) $("#aiConfigDialog").close();
    return config;
  }

  async function submitAiConfiguration(event) {
    event.preventDefault();
    const button = event.submitter || $("#aiConfigForm button[type='submit']");
    setBusyButton(button, true, "正在保存…");
    try { await saveAiConfiguration(true); }
    catch (error) { setAiConfigFeedback(error.message, true); }
    finally { setBusyButton(button, false, ""); }
  }

  async function testAiConfiguration() {
    const button = $("#testAiConfigButton");
    const targetProviderId = activeAiProviderId;
    setBusyButton(button, true, "正在测试…");
    try {
      const config = await saveAiConfiguration(false);
      if (!config) return;
      const provider = config.providers.find(item => item.id === targetProviderId) || config.providers[0];
      const testModel = provider.models.includes(config.defaultModel) ? config.defaultModel : provider.models[0];
      const result = await responseJson(await fetch("/api/admin/ai-config/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, model: testModel, reasoningEffort: "medium" })
      }));
      setAiConfigFeedback(`连接成功：${result.providerName} · ${result.model}`);
    } catch (error) {
      setAiConfigFeedback(error.message, true);
    } finally {
      setBusyButton(button, false, "");
    }
  }

  function todayStats() {
    const history = model.history[localDate()] || { reviewed: 0, correct: 0 };
    return history;
  }

  function getSession() {
    const today = localDate();
    const existing = model.sessions[today];
    if (!existing || existing.mode !== reviewMode) {
      const next = { date: today, mode: reviewMode, taskIds: [], index: 0, doneTaskIds: [], currentTaskId: null, batchComplete: false };
      model.sessions[today] = next;
      saveModel();
      return next;
    }
    return existing;
  }

  function taskState(taskId) {
    if (!model.taskStates[taskId]) model.taskStates[taskId] = { level: 0, nextDue: localDate(), lastResult: null, lastReviewed: null, reviewCount: 0 };
    return model.taskStates[taskId];
  }

  function isDue(task) {
    const item = task.item;
    const today = localDate();
    return item.learned <= today && taskState(task.taskId).nextDue <= today;
  }

  function taskCandidates(mode = reviewMode, excluded = new Set()) {
    const tasks = Array.from(taskById.values()).filter(task => {
      if (!isDue(task) || excluded.has(task.taskId)) return false;
      if (mode === "word") return task.item.type === "word";
      if (mode === "sentence") return task.item.type === "sentence";
      return true;
    });
    tasks.sort((a, b) => {
      const stateA = taskState(a.taskId); const stateB = taskState(b.taskId);
      const mistakeA = stateA.lastResult === false ? 0 : 1; const mistakeB = stateB.lastResult === false ? 0 : 1;
      return mistakeA - mistakeB || stateA.nextDue.localeCompare(stateB.nextDue) || a.item.day - b.item.day || a.taskId.localeCompare(b.taskId);
    });
    return tasks;
  }

  function buildBatch(limit = DAILY_TARGET) {
    const session = getSession();
    const excluded = new Set(session.doneTaskIds || []);
    const candidates = taskCandidates(reviewMode, excluded);
    if (!candidates.length) return [];
    const selected = [];
    const pools = { word: candidates.filter(task => task.item.type === "word"), sentence: candidates.filter(task => task.item.type === "sentence") };
    let turn = reviewMode === "sentence" ? "sentence" : "word";
    while (selected.length < limit && (pools.word.length || pools.sentence.length)) {
      const preferred = pools[turn];
      const alternate = pools[turn === "word" ? "sentence" : "word"];
      const bucket = preferred.length ? preferred : alternate;
      if (!bucket.length) break;
      selected.push(bucket.shift());
      turn = turn === "word" ? "sentence" : "word";
    }
    return selected.map(task => task.taskId);
  }

  function currentTask() {
    const session = getSession();
    const taskId = session.taskIds[session.index];
    return taskId ? taskById.get(taskId) : null;
  }

  function ensureBatch() {
    const session = getSession();
    if (!session.taskIds.length && !session.batchComplete) {
      session.taskIds = buildBatch();
      session.index = 0;
      session.currentTaskId = session.taskIds[0] || null;
      if (!session.taskIds.length) session.batchComplete = true;
      saveModel();
    }
    return session;
  }

  function setView(view) {
    activeView = view;
    $$(".nav-item").forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    $$(".view").forEach(section => {
      const active = section.id === `view-${view}`;
      section.classList.toggle("is-visible", active);
      section.hidden = !active;
    });
    if (view === "home") renderHome();
    if (view === "ai") renderAiView();
    if (view === "library") renderLibrary();
    if (view === "notes") renderNotes();
    if (view === "mistakes") renderMistakes();
    if (view === "progress") renderProgress();
    renderAiTutorWindow();
    refreshIcons();
  }

  function setReviewMode(mode) {
    reviewMode = mode;
    const today = localDate();
    model.sessions[today] = { date: today, mode, taskIds: [], index: 0, doneTaskIds: [], currentTaskId: null, batchComplete: false };
    saveModel();
    $$("[data-mode]").forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    renderHome();
  }

  function renderHome() {
    const session = ensureBatch();
    const stats = todayStats();
    const due = taskCandidates(reviewMode, new Set()).length;
    const done = session.doneTaskIds.length;
    $("#todayLabel").textContent = displayDate();
    $("#dueCount").textContent = String(due);
    $("#reviewedCount").textContent = String(stats.reviewed);
    $("#accuracyCount").textContent = stats.reviewed ? `${Math.round((stats.correct / stats.reviewed) * 100)}%` : "—";
    $("#goalReadout").textContent = `${Math.min(done, DAILY_TARGET)} / ${DAILY_TARGET}`;
    $("#queueNote").textContent = due ? "先复习错题，再练新词和句子。" : "今天的到期题已完成，可以回到词句库自由练习。";
    const task = currentTask();
    const panel = $("#reviewPanel"); const complete = $("#reviewComplete");
    if (!task) {
      panel.hidden = true; complete.hidden = false;
      const remaining = taskCandidates(reviewMode, new Set(session.doneTaskIds)).length;
      $("#completeNote").textContent = remaining ? `这一轮完成，还有 ${remaining} 道到期题。` : "今天这一组已经完成。";
      $("#moreReviewButton").hidden = !remaining;
      return;
    }
    panel.hidden = false; complete.hidden = true;
    $("#promptType").textContent = task.item.type === "word" ? "单词" : "句子";
    $("#promptDay").textContent = `第 ${task.item.day} 天`;
    $("#questionCount").textContent = `${session.index + 1} / ${session.taskIds.length}`;
    $("#directionLabel").textContent = formatDirection(task.direction);
    const prompt = task.direction === "en-zh" ? task.item.english : task.item.chinese;
    $("#promptText").textContent = prompt;
    $("#phoneticLine").textContent = task.item.type === "word" && task.direction === "en-zh" ? task.item.phonetic : "";
    $("#exampleLine").textContent = "";
    $("#answerInput").value = "";
    $("#answerInput").placeholder = task.direction === "en-zh" ? "输入中文答案" : "输入英文答案";
    $("#answerInput").disabled = false;
    $("#submitAnswer").disabled = false;
    $("#feedback").hidden = true;
    $("#feedbackActions").hidden = true;
    requestAnimationFrame(() => $("#answerInput").focus());
  }

  function answerMatches(task, answer) {
    if (!answer.trim()) return false;
    if (task.direction === "zh-en") return englishAnswerMatches(answer, task.item.acceptedEnglish || [task.item.english]);
    return chineseAnswerMatches(answer, task.item.acceptedChinese || [task.item.chinese]);
  }

  function setGradingState(active) {
    gradingInProgress = active;
    const input = $("#answerInput");
    const button = $("#submitAnswer");
    if (active) {
      button.dataset.idleHtml = button.innerHTML;
      button.textContent = "AI \u6b63\u5728\u5224\u65ad...";
    } else if (button.dataset.idleHtml) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
      refreshIcons();
    }
    input.disabled = active;
    button.disabled = active;
  }

  async function requestAiGrade(task, answer) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_CLIENT_TIMEOUT_MS);
    const settings = selectedAiSettings();
    try {
      const response = await fetch("/api/ai/grade", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.taskId, answer, model: settings.model, reasoningEffort: settings.reasoningEffort }),
        signal: controller.signal
      });
      if (response.status === 401) showAuthView();
      if (!response.ok) throw new Error("AI grading request failed");
      const result = await response.json();
      if (typeof result.correct !== "boolean" || typeof result.explanation !== "string") throw new Error("AI grading response is invalid");
      return { correct: result.correct, explanation: result.explanation.trim(), source: result.source === "ai" ? "ai" : "local" };
    } finally {
      clearTimeout(timeout);
    }
  }

  function correctAnswer(task) {
    if (task.direction === "zh-en") return task.item.english;
    return task.item.chinese;
  }

  function updateSchedule(task, correct) {
    const state = taskState(task.taskId);
    state.lastReviewed = localDate();
    state.reviewCount = (state.reviewCount || 0) + 1;
    state.lastResult = correct;
    if (correct) {
      state.level = Math.min((state.level || 0) + 1, INTERVALS.length);
      state.nextDue = addDays(localDate(), INTERVALS[Math.max(0, state.level - 1)]);
    } else {
      state.level = 0;
      state.nextDue = addDays(localDate(), 1);
    }
  }

  async function submitAnswer(event) {
    event.preventDefault();
    if (gradingInProgress) return;
    const task = currentTask();
    if (!task) return;
    const answer = $("#answerInput").value.trim();
    let correct = answerMatches(task, answer);
    let grading = { source: "local", explanation: "" };
    if (!correct && answer && API_ENABLED && task.item.type === "sentence") {
      setGradingState(true);
      try {
        grading = await requestAiGrade(task, answer);
        correct = grading.correct;
      } catch (_) {
        grading = { source: "local-fallback", explanation: "AI \u5224\u9898\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u5df2\u6309\u672c\u5730\u7b54\u6848\u5224\u5b9a\u3002" };
      } finally {
        setGradingState(false);
      }
    }
    updateSchedule(task, correct);
    const today = localDate();
    model.history[today] = model.history[today] || { reviewed: 0, correct: 0 };
    model.history[today].reviewed += 1;
    if (correct) model.history[today].correct += 1;
    model.attempts.push({ taskId: task.taskId, date: today, answer, correct, expected: correctAnswer(task), gradingSource: grading.source, explanation: grading.explanation });
    if (!correct) model.mistakes = [...(model.mistakes || []), { id: `attempt-${Date.now()}`, taskId: task.taskId, day: task.item.day, prompt: task.direction === "en-zh" ? task.item.english : task.item.chinese, userAnswer: answer || "（未填写）", correctAnswer: correctAnswer(task), note: grading.explanation || "本次复习未答对。" }].slice(-80);
    const session = getSession();
    session.currentTaskId = task.taskId;
    session.doneTaskIds = Array.from(new Set([...(session.doneTaskIds || []), task.taskId]));
    saveModel();
    showFeedback(task, correct, answer, grading);
  }

  function showFeedback(task, correct, answer, grading = {}) {
    const feedback = $("#feedback");
    feedback.hidden = false;
    feedback.className = `feedback ${correct ? "is-correct" : "is-wrong"}`;
    feedback.innerHTML = `<span class="feedback-title">${correct ? "答对了" : "再看一次"}</span><span class="feedback-answer">正确答案：${escapeHtml(correctAnswer(task))}</span>${correct ? "" : `<span class="feedback-note">你的答案：${escapeHtml(answer || "（未填写）")}</span>`}`;
    if (grading.explanation) feedback.insertAdjacentHTML("beforeend", `<span class="feedback-note">${escapeHtml(grading.explanation)}</span>`);
    $("#answerInput").disabled = true;
    $("#submitAnswer").disabled = true;
    $("#feedbackActions").hidden = false;
    refreshIcons();
    requestAnimationFrame(() => $("#nextButton").focus({ preventScroll: true }));
  }

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char])); }

  function advance(retry = false) {
    const session = getSession();
    const task = currentTask();
    if (!task) return;
    if (retry) session.taskIds.push(task.taskId);
    session.index += 1;
    session.currentTaskId = session.taskIds[session.index] || null;
    if (session.index >= session.taskIds.length) session.batchComplete = true;
    saveModel();
    renderHome();
  }

  function practiceTask(taskId) {
    const task = taskById.get(taskId);
    if (!task) return;
    const today = localDate();
    reviewMode = task.item.type;
    model.sessions[today] = { date: today, mode: reviewMode, taskIds: [taskId], index: 0, doneTaskIds: [], currentTaskId: taskId, batchComplete: false };
    saveModel();
    $$("[data-mode]").forEach(button => { const active = button.dataset.mode === reviewMode; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    setView("home");
  }

  function practiceMistakeQueue(taskId) {
    const taskIds = buildMistakePracticeQueue(mistakeRows(), taskId, taskById.keys());
    if (!taskIds.length) return;
    const today = localDate();
    reviewMode = "all";
    model.sessions[today] = { date: today, mode: reviewMode, taskIds, index: 0, doneTaskIds: [], currentTaskId: taskIds[0], batchComplete: false };
    saveModel();
    $$("[data-mode]").forEach(button => { const active = button.dataset.mode === reviewMode; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    setView("home");
  }

  function renderLibrary() {
    const search = normalizeChinese($("#librarySearch").value || "");
    const day = $("#dayFilter").value;
    const items = allItems.filter(item => item.type === libraryType && (day === "all" || String(item.day) === day) && (!search || normalizeChinese(`${item.english}${item.chinese}`).includes(search) || normalizeEnglish(`${item.english}`).includes(normalizeEnglish(search))));
    $("#libraryHead").innerHTML = libraryType === "word" ? "<tr><th>单词</th><th>发音</th><th>中文</th><th>学习日</th><th></th></tr>" : "<tr><th>句子</th><th>中文</th><th>学习日</th><th></th></tr>";
    $("#libraryBody").innerHTML = items.map(item => libraryType === "word" ? `<tr><td><code>${escapeHtml(item.english)}</code></td><td class="phonetic-cell">${escapeHtml(item.phonetic)}</td><td>${escapeHtml(item.chinese)}</td><td class="day-cell">第 ${item.day} 天</td><td><button class="table-action" type="button" data-practice="${item.id}">练习</button></td></tr>` : `<tr><td><code>${escapeHtml(item.english)}</code></td><td>${escapeHtml(item.chinese)}</td><td class="day-cell">第 ${item.day} 天</td><td><button class="table-action" type="button" data-practice="${item.id}">练习</button></td></tr>`).join("");
    $("#libraryEmpty").hidden = items.length > 0;
    $$('[data-practice]').forEach(button => button.addEventListener("click", () => practiceTask(`${button.dataset.practice}:en-zh`)));
    $$("[data-library-type]").forEach(button => { const active = button.dataset.libraryType === libraryType; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    refreshIcons();
  }

  function renderNotes() {
    const noteDays = Array.from(new Set([
      ...allItems.map(item => Number(item.day) || 0),
      ...(Array.isArray(DATA.notes) ? DATA.notes.map(note => Number(note.day) || 0) : [])
    ].filter(Boolean))).sort((left, right) => left - right);
    if (!noteDays.includes(notesDay)) notesDay = noteDays[noteDays.length - 1] || 1;
    const note = (Array.isArray(DATA.notes) ? DATA.notes : []).find(item => Number(item.day) === notesDay) || {};
    const words = DATA.words.filter(item => Number(item.day) === notesDay);
    const sentences = DATA.sentences.filter(item => Number(item.day) === notesDay);
    const date = String(note.date || words[0]?.learned || sentences[0]?.learned || "");
    const select = $("#notesDaySelect");
    select.replaceChildren(...noteDays.map(day => {
      const entry = (Array.isArray(DATA.notes) ? DATA.notes : []).find(item => Number(item.day) === day) || {};
      const dayDate = String(entry.date || DATA.words.find(item => Number(item.day) === day)?.learned || DATA.sentences.find(item => Number(item.day) === day)?.learned || "");
      const option = document.createElement("option");
      option.value = String(day);
      option.textContent = dayDate ? `${displayDate(dayDate)} · 第 ${day} 天` : `第 ${day} 天`;
      return option;
    }));
    select.value = String(notesDay);
    $("#notesStatus").textContent = `已整理 ${noteDays.length} 天 · ${words.length} 个单词 · ${sentences.length} 个句子`;

    const goals = Array.isArray(note.goals) ? note.goals : [];
    const pronunciation = Array.isArray(note.pronunciation) ? note.pronunciation : words.map(item => `${item.english} ${item.phonetic}：${item.pronunciation}`).filter(Boolean);
    const patterns = Array.isArray(note.patterns) ? note.patterns : [];
    const mistakes = Array.isArray(note.mistakes) ? note.mistakes : [];
    const listHtml = values => `<ul class="notes-list">${values.map(value => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
    const body = [
      `<section class="notes-overview"><div class="notes-overview-meta"><span>${escapeHtml(date ? displayDate(date) : `第 ${notesDay} 天`)}</span>${note.score ? `<span class="count-badge">${escapeHtml(note.score)}</span>` : ""}</div><h2>${escapeHtml(date ? `${displayDate(date)}学习总结` : `第 ${notesDay} 天学习总结`)}</h2><p>${escapeHtml(note.summary || `当天学习了 ${words.length} 个单词和 ${sentences.length} 个句子。`)}</p></section>`,
      `<div class="notes-columns"><section class="notes-section"><h2>学习目标</h2>${goals.length ? listHtml(goals) : listHtml(["复习当天词句并完成双向翻译。"])}</section><section class="notes-section"><h2>发音提醒</h2>${pronunciation.length ? listHtml(pronunciation) : listHtml(["当天暂无单独发音记录。"])}</section></div>`,
      words.length ? `<section class="notes-section"><h2>当天单词</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>单词</th><th>发音</th><th>中文</th></tr></thead><tbody>${words.map(item => `<tr><td><code>${escapeHtml(item.english)}</code></td><td class="phonetic-cell">${escapeHtml(item.phonetic)}</td><td>${escapeHtml(item.chinese)}</td></tr>`).join("")}</tbody></table></div></section>` : "",
      sentences.length ? `<section class="notes-section"><h2>当天句子</h2>${sentences.map(item => `<div class="notes-example"><code>${escapeHtml(item.english)}</code><span>${escapeHtml(item.chinese)}</span></div>`).join("")}</section>` : "",
      patterns.length ? `<section class="notes-section"><h2>核心句型</h2>${patterns.map(pattern => `<div class="notes-pattern"><h3>${escapeHtml(pattern.title)}</h3><p>${escapeHtml(pattern.note)}</p>${(Array.isArray(pattern.examples) ? pattern.examples : []).map(example => `<div class="notes-example"><code>${escapeHtml(example.english)}</code><span>${escapeHtml(example.chinese)}</span></div>`).join("")}</div>`).join("")}</section>` : "",
      mistakes.length ? `<section class="notes-section"><h2>易错点</h2>${listHtml(mistakes)}</section>` : "",
      `<div class="notes-review"><strong>复习重点：</strong>${escapeHtml(note.review || "复习当天单词、句子和发音提示。")}</div>`
    ].join("");
    $("#notesBody").innerHTML = body;
    refreshIcons();
  }

  function mistakeRows() {
    const seeded = DATA.seedMistakes.map(item => ({ ...item, seeded: true }));
    const dynamic = (model.mistakes || []).map(item => ({ ...item, seeded: false }));
    return [...dynamic.reverse(), ...seeded];
  }

  function renderMistakes() {
    const rows = mistakeRows();
    $("#mistakeCount").textContent = `${rows.length} 条`;
    $("#mistakeBody").innerHTML = rows.map(row => `<tr><td>${escapeHtml(row.prompt)}</td><td>${escapeHtml(row.userAnswer)}</td><td>${escapeHtml(row.correctAnswer)}</td><td class="day-cell">第 ${row.day} 天</td><td><button class="table-action" type="button" data-mistake-task="${escapeHtml(row.taskId)}">再练</button></td></tr>`).join("");
    $("#mistakeEmpty").hidden = rows.length > 0;
    $$('[data-mistake-task]').forEach(button => button.addEventListener("click", () => practiceMistakeQueue(button.dataset.mistakeTask)));
  }

  function renderProgress() {
    const stats = todayStats();
    $("#libraryTotal").textContent = String(allItems.length);
    const mastered = allItems.filter(item => (item.directions || ["en-zh"]).every(direction => taskState(`${item.id}:${direction}`).level >= 2)).length;
    $("#masteredTotal").textContent = String(mastered);
    $("#streakTotal").textContent = `${calculateStreak()} 天`;
    $("#updatedAtLabel").textContent = DATA.updatedAt;
    const days = Array.from({ length: 7 }, (_, index) => addDays(localDate(), index - 6));
    const max = Math.max(1, ...days.map(day => (model.history[day] || { reviewed: 0 }).reviewed));
    $("#weeklyChart").innerHTML = days.map(day => { const count = (model.history[day] || { reviewed: 0 }).reviewed; const height = Math.max(3, Math.round((count / max) * 100)); return `<div class="bar-column"><span class="bar-value">${count || ""}</span><div class="bar-track"><div class="bar-fill" style="height:${height}%"></div></div><span class="bar-day">${day.slice(5).replace("-", "/")}</span></div>`; }).join("");
    const dayRows = Array.from(new Set(allItems.map(item => item.day))).sort((a, b) => a - b).map(day => { const words = DATA.words.filter(item => item.day === day).length; const sentences = DATA.sentences.filter(item => item.day === day).length; const total = words + sentences; return { day, words, sentences, total }; });
    const maxTotal = Math.max(1, ...dayRows.map(row => row.total));
    $("#dayBreakdownBody").innerHTML = dayRows.map(row => `<div class="day-row"><span class="day-row-label">第 ${row.day} 天</span><div class="day-row-bar"><div class="day-row-fill" style="width:${Math.round((row.total / maxTotal) * 100)}%"></div></div><span class="day-row-count">${row.words} 词 · ${row.sentences} 句</span></div>`).join("");
    refreshIcons();
  }

  function calculateStreak() {
    let count = 0; let cursor = localDate();
    while (model.history[cursor] && model.history[cursor].reviewed > 0) { count += 1; cursor = addDays(cursor, -1); }
    return count;
  }

  function showToast(message) {
    const toast = $("#toast"); toast.textContent = message; toast.classList.add("is-visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  function resetModel() {
    localStorage.removeItem(storageKey());
    model = loadModel();
    saveModel();
    renderHome(); renderAiView(); renderMistakes(); renderProgress();
    showToast("当前账号复习记录已重置");
  }

  function refreshIcons() { if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons({ attrs: { width: 16, height: 16, "stroke-width": 1.8 } }); }

  function populateDayFilter() {
    const select = $("#dayFilter");
    const selected = select.value || "all";
    const days = Array.from(new Set(allItems.map(item => item.day))).sort((a, b) => a - b);
    select.innerHTML = `<option value="all">全部天数</option>${days.map(day => `<option value="${day}">第 ${day} 天</option>`).join("")}`;
    select.value = days.includes(Number(selected)) ? selected : "all";
  }

  function bindAppEvents() {
    if (appEventsBound) return;
    appEventsBound = true;
    $$("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
    $$("[data-mode]").forEach(button => button.addEventListener("click", () => setReviewMode(button.dataset.mode)));
    $$("[data-library-type]").forEach(button => button.addEventListener("click", () => { libraryType = button.dataset.libraryType; renderLibrary(); }));
    $("#librarySearch").addEventListener("input", renderLibrary);
    $("#dayFilter").addEventListener("change", renderLibrary);
    $("#notesDaySelect").addEventListener("change", event => {
      notesDay = Number(event.target.value) || notesDay;
      renderNotes();
    });
    $("#aiModelSelect").addEventListener("change", event => {
      aiStatusMessage = "";
      updateAiPreferences({ model: event.target.value });
      renderAiView();
    });
    $$('[data-ai-effort]').forEach(button => button.addEventListener("click", () => {
      aiStatusMessage = "";
      updateAiPreferences({ reasoningEffort: button.dataset.aiEffort });
      renderAiView();
    }));
    $("#aiQuestionCount").addEventListener("change", event => {
      aiStatusMessage = "";
      updateAiPreferences({ count: Number(event.target.value) });
      renderAiView();
    });
    $("#generateAiQuestions").addEventListener("click", generateAiQuestions);
    $("#generateAnotherAiSet").addEventListener("click", generateAiQuestions);
    $("#aiAnswerForm").addEventListener("submit", submitAiAnswer);
    $("#openAiTutorButton").addEventListener("click", () => openAiTutorWindow());
    $("#closeAiTutorButton").addEventListener("click", closeAiTutorWindow);
    $("#minimizeAiTutorButton").addEventListener("click", toggleAiTutorMinimize);
    $("#maximizeAiTutorButton").addEventListener("click", toggleAiTutorMaximize);
    $("#clearAiTutorButton").addEventListener("click", clearAiTutor);
    $("#aiTutorEffort").addEventListener("change", event => {
      updateAiTutorPreferences({ reasoningEffort: event.target.value });
    });
    $("#aiTutorForm").addEventListener("submit", submitAiTutorQuestion);
    $("#aiTutorInput").addEventListener("keydown", event => {
      if (!shouldSubmitOnEnter(event)) return;
      event.preventDefault();
      $("#aiTutorForm").requestSubmit();
    });
    $("#aiHistoryList").addEventListener("click", event => {
      const button = event.target.closest("[data-ai-history-ask]");
      if (!button) return;
      const practice = normalizeClientAiPractice(model.aiPractice);
      const item = practice.history.find(entry => entry.id === button.dataset.aiHistoryAsk);
      const target = aiTutorTargetForHistory(item);
      if (target) openAiTutorWindow(target);
    });
    $("#aiTutorDragHandle").addEventListener("pointerdown", startAiTutorDrag);
    $("#aiTutorDragHandle").addEventListener("pointermove", moveAiTutorWindow);
    $("#aiTutorDragHandle").addEventListener("pointerup", endAiTutorDrag);
    $("#aiTutorDragHandle").addEventListener("pointercancel", endAiTutorDrag);
    $("#nextAiQuestion").addEventListener("click", advanceAiQuestion);
    $("#nextAiQuestion").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      advanceAiQuestion();
    });
    $("#openAiConfigButton").addEventListener("click", openAiConfiguration);
    $("#closeAiConfigButton").addEventListener("click", () => $("#aiConfigDialog").close());
    $("#aiConfigForm").addEventListener("submit", submitAiConfiguration);
    $$('[data-ai-routing-mode]').forEach(button => button.addEventListener("click", () => setAiRoutingMode(button.dataset.aiRoutingMode)));
    $("#aiManualProvider").addEventListener("change", event => {
      if (!aiConfigDraft) return;
      aiConfigDraft.manualProviderId = event.target.value;
      syncAiRoutingControls();
    });
    $("#aiDefaultModel").addEventListener("change", event => { if (aiConfigDraft) aiConfigDraft.defaultModel = event.target.value; });
    $("#aiRateLimit").addEventListener("input", event => { if (aiConfigDraft) aiConfigDraft.rateLimitPerMinute = Number(event.target.value); });
    $("#addAiProviderButton").addEventListener("click", addAiProvider);
    $("#aiProviderList").addEventListener("click", event => {
      const remove = event.target.closest("[data-ai-provider-delete]");
      if (remove) return deleteAiProvider(remove.dataset.aiProviderDelete);
      const select = event.target.closest("[data-ai-provider-select]");
      if (select) selectAiProvider(select.dataset.aiProviderSelect);
    });
    ["#aiProviderName", "#aiBaseUrl", "#aiApiKey", "#aiTimeout"].forEach(selector => $(selector).addEventListener("input", updateActiveAiProvider));
    $("#aiProviderEnabled").addEventListener("change", updateActiveAiProvider);
    $("#fetchAiModelsButton").addEventListener("click", fetchUpstreamAiModels);
    $("#addAiModelButton").addEventListener("click", addCustomAiModel);
    $("#aiCustomModel").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addCustomAiModel();
    });
    $("#aiModelList").addEventListener("click", event => {
      const button = event.target.closest("[data-model]");
      if (button) removeConfigAiModel(button.dataset.model);
    });
    $("#testAiConfigButton").addEventListener("click", testAiConfiguration);
    $("#answerForm").addEventListener("submit", submitAnswer);
    $("#nextButton").addEventListener("click", () => advance(false));
    $("#retryButton").addEventListener("click", () => advance(true));
    $("#moreReviewButton").addEventListener("click", () => { const session = getSession(); session.batchComplete = false; session.taskIds = buildBatch(); session.index = 0; session.currentTaskId = session.taskIds[0] || null; saveModel(); renderHome(); });
    $("#resetButton").addEventListener("click", () => $("#resetDialog").showModal());
    $("#openResetButton").addEventListener("click", () => $("#resetDialog").showModal());
    $("#confirmReset").addEventListener("click", event => { event.preventDefault(); $("#resetDialog").close(); resetModel(); });
  }

  function registerServiceWorker() {
    if (API_ENABLED && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=16").catch(() => {});
  }

  $("#dataStatus").textContent = API_ENABLED ? `词库同步至第 ${DATA.currentDay} 天 · 正在连接` : `词库同步至第 ${DATA.currentDay} 天`;
  populateDayFilter();
  bindAuthEvents();
  registerServiceWorker();
  if (API_ENABLED) {
    const authenticated = await fetchCurrentUser();
    if (!authenticated) { showAuthView(); refreshIcons(); return; }
    model = loadModel();
  }
  showAppView();
  bindAppEvents();
  renderHome();
  refreshIcons();
  await loadAiOptions();
  syncRemoteState();
})();
