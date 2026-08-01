 (async () => {
  "use strict";

  const DATA = window.ENGLISH_REVIEW_DATA;
  const { buildMistakePracticeQueue, chineseAnswerMatches, englishAnswerMatches, normalizeChinese, normalizeEnglish } = window.ENGLISH_REVIEW_ANSWER_UTILS;
  const STORAGE_KEY = "daily-english-review-v1";
  const DAILY_TARGET = 10;
  const INTERVALS = [1, 3, 7, 14, 30, 60];
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
  let currentUser = API_ENABLED ? null : { id: "local", username: "本机模式", role: "local" };
  let appEventsBound = false;
  let authEventsBound = false;
  let model = loadModel();
  let toastTimer;
  let gradingInProgress = false;
  let aiRequestInProgress = false;
  let aiOptions = { configured: false, models: [], defaultModel: "", efforts: ["low", "medium", "high"], admin: false };

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

  function normalizeClientAiPractice(value) {
    const source = value && typeof value === "object" ? value : {};
    const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
    return {
      settings: {
        model: String(settings.model || ""),
        reasoningEffort: ["low", "medium", "high"].includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
        count: [5, 10].includes(Number(settings.count)) ? Number(settings.count) : 5
      },
      currentSet: source.currentSet && Array.isArray(source.currentSet.questions) ? source.currentSet : null,
      history: Array.isArray(source.history) ? source.history.slice(-120) : [],
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
    if (!API_ENABLED) {
      aiOptions = { configured: false, models: [], defaultModel: "", efforts: ["low", "medium", "high"], admin: false };
      renderAiView();
      return;
    }
    try {
      const response = await fetch("/api/ai/options", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("AI options request failed");
      aiOptions = await response.json();
      const practice = normalizeClientAiPractice(model.aiPractice);
      if (!aiOptions.models.includes(practice.settings.model)) practice.settings.model = aiOptions.selectedModel || aiOptions.defaultModel || "";
      if (["low", "medium", "high"].includes(aiOptions.selectedEffort) && !practice.updatedAt) practice.settings.reasoningEffort = aiOptions.selectedEffort;
      if ([5, 10].includes(Number(aiOptions.selectedCount)) && !practice.updatedAt) practice.settings.count = Number(aiOptions.selectedCount);
      model.aiPractice = practice;
    } catch (_) {
      aiOptions = { configured: false, models: [], defaultModel: "", efforts: ["low", "medium", "high"], admin: Boolean(currentUser && currentUser.role === "admin") };
    }
    populateAiModelSelect();
    renderAiView();
  }

  function currentAiQuestion() {
    const set = model.aiPractice && model.aiPractice.currentSet;
    return set && Array.isArray(set.questions) ? set.questions[Number(set.index) || 0] : null;
  }

  function aiCorrectAnswer(question) { return question.direction === "zh-en" ? question.english : question.chinese; }

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
    $("#openAiConfigButton").hidden = !currentUser || currentUser.role !== "admin";
    $("#aiStatus").textContent = aiOptions.configured ? "AI 已连接" : "AI 尚未配置";
    const empty = $("#aiEmptyState");
    const panel = $("#aiPracticePanel");
    const complete = $("#aiPracticeComplete");
    if (!aiOptions.configured) {
      empty.hidden = false; panel.hidden = true; complete.hidden = true;
      $("#aiEmptyTitle").textContent = currentUser && currentUser.role === "admin" ? "请先完成 AI 连接设置" : "AI 尚未配置";
      return;
    }

    const set = model.aiPractice.currentSet;
    if (!set) {
      empty.hidden = false; panel.hidden = true; complete.hidden = true;
      $("#aiEmptyTitle").textContent = "准备生成题目";
      return;
    }
    if (set.completed || Number(set.index) >= set.questions.length) {
      set.completed = true;
      empty.hidden = true; panel.hidden = true; complete.hidden = false;
      const correct = set.questions.filter(question => question.correct === true).length;
      $("#aiCompleteNote").textContent = `答对 ${correct} / ${set.questions.length} 题`;
      return;
    }

    const question = currentAiQuestion();
    if (!question) return;
    empty.hidden = true; panel.hidden = false; complete.hidden = true;
    $("#aiFocusBadge").textContent = question.focus || "巩固练习";
    $("#aiModelReadout").textContent = `${set.model} · ${{ low: "低", medium: "中", high: "高" }[set.reasoningEffort] || "中"}`;
    $("#aiQuestionProgress").textContent = `${Number(set.index) + 1} / ${set.questions.length}`;
    $("#aiDirectionLabel").textContent = formatDirection(question.direction);
    $("#aiPromptText").textContent = question.direction === "en-zh" ? question.english : question.chinese;
    $("#aiAnswerInput").value = question.userAnswer || "";
    $("#aiAnswerInput").placeholder = question.direction === "en-zh" ? "输入中文答案" : "输入英文答案";
    const answered = typeof question.correct === "boolean";
    $("#aiAnswerInput").disabled = answered || aiRequestInProgress;
    $("#submitAiAnswer").disabled = answered || aiRequestInProgress;
    renderAiFeedback(question);
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
    $("#aiStatus").textContent = "正在分析学习进度…";
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
      practice.updatedAt = new Date().toISOString();
      model.aiPractice = practice;
      saveModel();
      $("#aiStatus").textContent = "题目已生成";
    } catch (error) {
      $("#aiStatus").textContent = error.message;
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
    practice.updatedAt = new Date().toISOString();
    model.aiPractice = practice;
    saveModel();
    renderAiView();
  }

  function configModelNames() {
    return Array.from(new Set($("#aiModels").value.split(/[\n,]/).map(value => value.trim()).filter(value => value && value.length <= 120))).slice(0, 200);
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
    const normalized = Array.from(new Set((Array.isArray(models) ? models : []).map(value => String(value || "").trim()).filter(value => value && value.length <= 120))).slice(0, 200);
    $("#aiModels").value = normalized.join("\n");
    renderConfigModelList();
    syncDefaultModelOptions(preferred);
  }

  function syncDefaultModelOptions(preferred = "") {
    const select = $("#aiDefaultModel");
    const current = preferred || select.value;
    const models = configModelNames();
    select.replaceChildren(...models.map(modelName => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      return option;
    }));
    if (models.includes(current)) select.value = current;
    select.disabled = !models.length;
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
    const baseUrl = $("#aiBaseUrl");
    const apiKey = $("#aiApiKey");
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
          baseUrl: baseUrl.value.trim(),
          apiKey: apiKey.value.trim(),
          timeoutMs: Number($("#aiTimeout").value) || 10000
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
      $("#aiBaseUrl").value = config.baseUrl || "";
      $("#aiApiKey").value = "";
      $("#aiApiKey").required = !config.hasApiKey;
      $("#aiApiKey").placeholder = config.hasApiKey ? "已保存，留空则不修改" : "输入 API Key";
      setConfigModels(config.models || [], config.defaultModel);
      $("#aiCustomModel").value = "";
      $("#aiTimeout").value = String(config.timeoutMs || 10000);
      $("#aiRateLimit").value = String(config.rateLimitPerMinute || 20);
      setAiConfigFeedback(config.configured ? "配置已保存" : "尚未配置");
    } catch (error) {
      setAiConfigFeedback(error.message, true);
    }
    refreshIcons();
  }

  async function saveAiConfiguration(closeAfterSave = false) {
    const form = $("#aiConfigForm");
    const models = configModelNames();
    if (!models.length) {
      setAiConfigFeedback("请先获取上游模型，或手动添加至少一个模型", true);
      $("#fetchAiModelsButton").focus();
      return null;
    }
    syncDefaultModelOptions();
    if (!form.reportValidity()) return null;
    const body = {
      baseUrl: $("#aiBaseUrl").value.trim(),
      apiKey: $("#aiApiKey").value.trim(),
      models,
      defaultModel: $("#aiDefaultModel").value,
      timeoutMs: Number($("#aiTimeout").value),
      rateLimitPerMinute: Number($("#aiRateLimit").value)
    };
    const config = await responseJson(await fetch("/api/admin/ai-config", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));
    $("#aiApiKey").value = "";
    $("#aiApiKey").required = false;
    $("#aiApiKey").placeholder = "已保存，留空则不修改";
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
    setBusyButton(button, true, "正在测试…");
    try {
      const config = await saveAiConfiguration(false);
      if (!config) return;
      const result = await responseJson(await fetch("/api/admin/ai-config/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.defaultModel, reasoningEffort: "medium" })
      }));
      setAiConfigFeedback(`连接成功：${result.model}`);
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
    if (view === "mistakes") renderMistakes();
    if (view === "progress") renderProgress();
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
    const timeout = setTimeout(() => controller.abort(), 32000);
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
    $("#aiModelSelect").addEventListener("change", event => updateAiPreferences({ model: event.target.value }));
    $$('[data-ai-effort]').forEach(button => button.addEventListener("click", () => {
      updateAiPreferences({ reasoningEffort: button.dataset.aiEffort });
      renderAiView();
    }));
    $("#aiQuestionCount").addEventListener("change", event => updateAiPreferences({ count: Number(event.target.value) }));
    $("#generateAiQuestions").addEventListener("click", generateAiQuestions);
    $("#generateAnotherAiSet").addEventListener("click", generateAiQuestions);
    $("#aiAnswerForm").addEventListener("submit", submitAiAnswer);
    $("#nextAiQuestion").addEventListener("click", advanceAiQuestion);
    $("#nextAiQuestion").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      advanceAiQuestion();
    });
    $("#openAiConfigButton").addEventListener("click", openAiConfiguration);
    $("#closeAiConfigButton").addEventListener("click", () => $("#aiConfigDialog").close());
    $("#aiConfigForm").addEventListener("submit", submitAiConfiguration);
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
    if (API_ENABLED && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=11").catch(() => {});
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
