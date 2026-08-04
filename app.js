 (async () => {
  "use strict";

  const DATA = window.ENGLISH_REVIEW_DATA;
  const PRONUNCIATION = window.ENGLISH_PRONUNCIATION_DATA || { concepts: [], phonemes: [] };
  const REVIEW_VARIANTS = window.ENGLISH_REVIEW_VARIANTS || { chooseSentenceVariant: () => null, sanitizeGeneratedSentenceVariant: () => null };
  const STUDY_TIME = window.ENGLISH_REVIEW_STUDY_TIME || {};
  const { MISTAKE_AUTO_RESOLVE_STREAK, buildMistakePracticeQueue, chineseAnswerMatches, chineseAnswerQuality, englishAnswerMatches, isReviewEligibleItem, mistakeCorrectStreak, mistakeIsResolved, normalizeChinese, normalizeEnglish, repairReviewEvidence, shouldSubmitOnEnter } = window.ENGLISH_REVIEW_ANSWER_UTILS;
  const FALLBACK_DAILY_STUDY_PLAN = [
    { id: "review", label: "旧知识复习", minutes: 10, view: "home", actionLabel: "开始复习" },
    { id: "phonics", label: "拼读与词汇", minutes: 15, view: "pronunciation", actionLabel: "打开发音课", allowBackground: true },
    { id: "pattern", label: "句子结构", minutes: 10, view: "notes", actionLabel: "打开学习笔记", allowBackground: true },
    { id: "reading", label: "阅读与翻译", minutes: 15, view: "ai", actionLabel: "开始阅读练习", allowBackground: true },
    { id: "correction", label: "测验与订正", minutes: 5, view: "mistakes", actionLabel: "打开错题本" },
    { id: "preview", label: "总结与预习", minutes: 5, view: "preview-words", actionLabel: "打开预习" }
  ];
  const {
    DAILY_STUDY_PLAN = FALLBACK_DAILY_STUDY_PLAN,
    STUDY_TIME_TARGET_SECONDS = 3600,
    formatStudyDuration = value => String(Math.max(0, Math.floor(Number(value) || 0))),
    mergeStudyTime = value => value || { daily: {}, updatedAt: "" },
    normalizeStudyTime = value => value || { daily: {}, updatedAt: "" },
    studyPlanProgress = value => {
      let boundary = 0;
      const seconds = Math.max(0, Math.min(STUDY_TIME_TARGET_SECONDS, Math.floor(Number(value) || 0)));
      const stages = DAILY_STUDY_PLAN.map((stage, index) => {
        const targetSeconds = stage.minutes * 60;
        const startSeconds = boundary;
        const endSeconds = startSeconds + targetSeconds;
        boundary = endSeconds;
        return { ...stage, index, targetSeconds, startSeconds, endSeconds, elapsedSeconds: Math.max(0, Math.min(targetSeconds, seconds - startSeconds)), complete: seconds >= endSeconds, current: seconds >= startSeconds && seconds < endSeconds };
      });
      return { seconds, complete: seconds >= STUDY_TIME_TARGET_SECONDS, stages, currentStage: stages.find(stage => stage.current) || null };
    },
    studySecondsForDate = (value, date) => Number(value?.daily?.[date]) || 0
  } = STUDY_TIME;
  const STORAGE_KEY = "daily-english-review-v1";
  const EXAM_GENERATION_API_VERSION = "2";
  const DAILY_TARGET = 10;
  const STUDY_TIME_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const STUDY_TIME_TICK_MS = 1000;
  const LIBRARY_PAGE_SIZES = [10, 20, 50, 100];
  const INTERVALS = [1, 3, 7, 14, 30, 60];
  const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const AI_EFFORT_LABELS = { low: "轻度", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  const MAX_CLIENT_TUTOR_HISTORY = 1000;
  const MAX_CLIENT_TUTOR_RESETS = 1000;
  const FOCUSED_TYPE_LABELS = { listening: "听力", choice: "选择", "fill-blank": "填空", "true-false": "判断", translation: "翻译", cloze: "完形填空", reading: "材料题", essay: "作文" };
  const DEFAULT_AI_TIMEOUT_MS = 30000;
  const AI_CLIENT_TIMEOUT_MS = 125000;
  const EXAM_GENERATION_POLL_MS = 2000;
  const REVIEW_VARIANT_RETRY_MS = 60 * 60 * 1000;
  const API_ENABLED = location.protocol === "http:" || location.protocol === "https:";
  let remoteReady = !API_ENABLED;
  let remoteSaveTimer;
  const allItems = [...DATA.words.map(item => ({ ...item, type: "word" })), ...DATA.sentences.map(item => ({ ...item, type: "sentence" }))];
  const learnedItems = allItems.filter(item => !item.preview);
  const itemById = new Map(allItems.map(item => [item.id, item]));
  const taskById = new Map();
  allItems.forEach(item => (item.directions || ["en-zh"]).forEach(direction => taskById.set(`${item.id}:${direction}`, { item, direction, taskId: `${item.id}:${direction}` })));

  let activeView = "home";
  let reviewMode = "all";
  let libraryType = "word";
  let libraryPage = 1;
  let pronunciationFilter = "learned";
  let notesDay = Math.max(1, Number(DATA.currentDay) || 1, ...learnedItems.map(item => Number(item.day) || 0));
  let currentUser = API_ENABLED ? null : { id: "local", username: "本机模式", role: "local" };
  let appEventsBound = false;
  let authEventsBound = false;
  let model = loadModel();
  let toastTimer;
  let gradingInProgress = false;
  let aiRequestInProgress = false;
  let aiTutorRequestInProgress = false;
  let reviewVariantPreparation = null;
  let reviewVariantRetryTimer = null;
  let reviewVariantRetryKey = "";
  let reviewVariantStatusMessage = "";
  let studyClockTimer = null;
  let studyClockRunning = false;
  let studyClockLastTickAt = 0;
  let studyClockLastActivityAt = 0;
  let studyClockRemainderMs = 0;
  let studyClockPauseReason = "";
  let studyClockPersistTimer = null;
  let aiTutorDrag = null;
  let aiTutorLaunchDrag = null;
  let aiTutorLaunchSuppressClickUntil = 0;
  let aiTutorTarget = null;
  let aiStatusMessage = "";
  let aiOptions = { configured: false, models: [], providers: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: false };
  let aiOptionsLoaded = false;
  let aiConfigDraft = null;
  let activeAiProviderId = "";
  let examState = normalizeClientAiExam(null);
  let examStatusMessage = "";
  let examRequestInProgress = false;
  let examGenerationMonitorId = "";
  let examGenerationMonitorPromise = null;
  let examDraftSaveTimer = null;
  let examSpeechQuestionId = "";
  const examListeningCache = new Map();
  let examPhotoFiles = [];
  let examAbilityChanges = [];
  let examQuestionHighlightTimer = null;
  let abilityReport = null;
  let abilityLoading = false;
  let abilityStatusMessage = "";
  let dictationState = normalizeClientDictation(null);
  let dictationLoaded = false;
  let dictationRequestInProgress = false;
  let dictationStatusMessage = "";
  let dictationDraftSaveTimer = null;
  let dictationAbilityChanges = [];
  const dictationSpeechCache = new Map();
  let focusedState = normalizeClientFocused(null);
  let focusedLoaded = false;
  let focusedRequestInProgress = false;
  let focusedStatusMessage = "";
  let focusedDraftSaveTimer = null;
  let focusedAbilityChanges = [];
  const focusedSpeechCache = new Map();
  let previewState = { loaded: false, loading: false, updatedAt: "", preview: null, previews: [], error: "" };
  let selectedPreviewName = "";
  let previewWordsState = { loaded: false, loading: false, currentDay: Number(DATA.currentDay) || 1, nextDay: (Number(DATA.currentDay) || 1) + 1, updatedAt: "", words: [], error: "" };
  let previewPracticeSentencePreparation = null;
  let previewPracticeRetryTimer = null;
  let previewPracticeRetryKey = "";
  let previewPracticeStatusMessage = "";

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
    return {
      setId,
      questionId,
      historyId: String(value.historyId || "").slice(0, 180),
      source: ["current", "history"].includes(value.source) ? value.source : "",
      prompt: String(value.prompt || "").trim().slice(0, 300),
      updatedAt: String(value.updatedAt || "").slice(0, 40),
      messages
    };
  }

  function normalizeClientTutorReset(value) {
    if (!value || typeof value !== "object") return null;
    const setId = String(value.setId || "").slice(0, 80);
    const questionId = String(value.questionId || "").slice(0, 80);
    const resetAt = String(value.resetAt || "").slice(0, 40);
    if (!setId || !questionId || !resetAt) return null;
    return {
      setId,
      questionId,
      historyId: String(value.historyId || "").slice(0, 180),
      source: ["current", "history"].includes(value.source) ? value.source : "",
      prompt: String(value.prompt || "").trim().slice(0, 300),
      resetAt
    };
  }

  function normalizeClientTutorExchange(value) {
    if (!value || typeof value !== "object") return null;
    const setId = String(value.setId || "").slice(0, 80);
    const questionId = String(value.questionId || "").slice(0, 80);
    const question = String(value.question || "").trim().slice(0, 500);
    const answer = String(value.answer || "").trim().slice(0, 1200);
    if (!setId || !questionId || !question || !answer) return null;
    return {
      id: String(value.id || `${setId}:${questionId}:${value.askedAt || ""}`).slice(0, 180),
      setId,
      questionId,
      historyId: String(value.historyId || "").slice(0, 180),
      source: value.source === "history" ? "history" : "current",
      direction: ["en-zh", "zh-en"].includes(value.direction) ? value.direction : "",
      prompt: String(value.prompt || "").slice(0, 300),
      learnerAnswer: String(value.learnerAnswer || "").slice(0, 500),
      correctAnswer: String(value.correctAnswer || "").slice(0, 300),
      answered: Boolean(value.answered),
      explanation: String(value.explanation || "").slice(0, 180),
      question,
      answer,
      askedAt: String(value.askedAt || "").slice(0, 40),
      answeredAt: String(value.answeredAt || value.askedAt || "").slice(0, 40),
      providerId: String(value.providerId || "").slice(0, 64),
      providerName: String(value.providerName || "").slice(0, 60),
      model: String(value.model || "").slice(0, 120),
      reasoningEffort: AI_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : ""
    };
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
        providerId: String(tutorSettings.providerId || ""),
        model: String(tutorSettings.model || ""),
        reasoningEffort: AI_EFFORTS.includes(tutorSettings.reasoningEffort) ? tutorSettings.reasoningEffort : "medium"
      },
      currentSet: source.currentSet && Array.isArray(source.currentSet.questions) ? source.currentSet : null,
      tutor: normalizeClientTutor(source.tutor),
      tutorHistory: (Array.isArray(source.tutorHistory) ? source.tutorHistory : []).map(normalizeClientTutorExchange).filter(Boolean).slice(-MAX_CLIENT_TUTOR_HISTORY),
      tutorResets: (Array.isArray(source.tutorResets) ? source.tutorResets : []).map(normalizeClientTutorReset).filter(Boolean).slice(-MAX_CLIENT_TUTOR_RESETS),
      history: Array.isArray(source.history) ? source.history.slice(-1000) : [],
      updatedAt: String(source.updatedAt || "")
    };
  }

  function normalizeClientReviewVariant(value) {
    if (!value || typeof value !== "object") return null;
    const id = String(value.id || "").trim().slice(0, 180);
    const english = String(value.english || "").trim().slice(0, 180);
    const chinese = String(value.chinese || "").trim().slice(0, 180);
    if (!id || !english || !chinese) return null;
    return {
      id,
      family: String(value.family || "").slice(0, 30),
      english,
      chinese,
      acceptedEnglish: Array.from(new Set((Array.isArray(value.acceptedEnglish) ? value.acceptedEnglish : [english]).map(item => String(item || "").trim()).filter(Boolean))).slice(0, 8),
      acceptedChinese: Array.from(new Set((Array.isArray(value.acceptedChinese) ? value.acceptedChinese : [chinese]).map(item => String(item || "").trim()).filter(Boolean))).slice(0, 8),
      source: value.source === "ai" ? "ai" : "local",
      providerId: String(value.providerId || "").slice(0, 64),
      providerName: String(value.providerName || "").slice(0, 60),
      model: String(value.model || "").slice(0, 120),
      reasoningEffort: AI_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : "",
      generatedAt: String(value.generatedAt || "").slice(0, 40)
    };
  }

  function normalizeClientReviewSession(value) {
    const source = value && typeof value === "object" ? value : {};
    const variants = {};
    Object.entries(source.variants && typeof source.variants === "object" ? source.variants : {}).forEach(([taskId, variant]) => {
      const normalized = normalizeClientReviewVariant(variant);
      // 旧版本可能保存了本地兜底句；升级后只接受 AI 固定结果，避免继续使用旧兜底。
      if (normalized && normalized.source === "ai") variants[String(taskId).slice(0, 180)] = normalized;
    });
    return {
      date: String(source.date || "").slice(0, 20),
      mode: ["all", "word", "sentence"].includes(source.mode) ? source.mode : "all",
      taskIds: Array.isArray(source.taskIds) ? source.taskIds.map(item => String(item || "").slice(0, 180)).filter(Boolean).slice(0, 100) : [],
      index: Math.max(0, Number(source.index) || 0),
      doneTaskIds: Array.isArray(source.doneTaskIds) ? source.doneTaskIds.map(item => String(item || "").slice(0, 180)).filter(Boolean).slice(0, 100) : [],
      currentTaskId: String(source.currentTaskId || "").slice(0, 180),
      batchComplete: Boolean(source.batchComplete),
      variants
    };
  }

  function normalizeClientAiExam(value) {
    const source = value && typeof value === "object" ? value : {};
    const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
    return {
      settings: {
        model: String(settings.model || ""),
        reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
        includeEssay: Boolean(settings.includeEssay),
        includeListening: Boolean(settings.includeListening),
        totalPoints: Number(settings.totalPoints) === 150 ? 150 : 100
      },
      currentExam: source.currentExam && Array.isArray(source.currentExam.questions) ? source.currentExam : null,
      generation: source.generation && ["pending", "completed", "failed"].includes(source.generation.status) ? {
        id: String(source.generation.id || ""),
        status: source.generation.status,
        startedAt: String(source.generation.startedAt || ""),
        finishedAt: String(source.generation.finishedAt || ""),
        examId: String(source.generation.examId || ""),
        error: String(source.generation.error || ""),
        providerStatus: Number(source.generation.providerStatus) || null
      } : null,
      history: Array.isArray(source.history) ? source.history.slice(-20) : [],
      weakPoints: Array.isArray(source.weakPoints) ? source.weakPoints.slice(-200) : [],
      updatedAt: String(source.updatedAt || "")
    };
  }

  function normalizeClientDictation(value) {
    const source = value && typeof value === "object" ? value : {};
    const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
    return {
      settings: {
        model: String(settings.model || ""),
        reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
        count: [5, 10, 20].includes(Number(settings.count)) ? Number(settings.count) : 5
      },
      currentSession: source.currentSession && Array.isArray(source.currentSession.items) ? source.currentSession : null,
      history: Array.isArray(source.history) ? source.history.slice(-50) : [],
      weightSummary: source.weightSummary && typeof source.weightSummary === "object" ? source.weightSummary : { trackedWords: 0, highPriorityWords: 0, maximumWeight: 1 },
      updatedAt: String(source.updatedAt || "")
    };
  }

  function normalizeClientFocused(value) {
    const source = value && typeof value === "object" ? value : {};
    const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
    return {
      settings: {
        model: String(settings.model || ""),
        reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
        focusedType: Object.hasOwn(FOCUSED_TYPE_LABELS, settings.focusedType) ? settings.focusedType : "choice"
      },
      currentSession: source.currentSession && Array.isArray(source.currentSession.questions) ? source.currentSession : null,
      history: Array.isArray(source.history) ? source.history.slice(-100) : [],
      skills: Array.isArray(source.skills) ? source.skills.slice(0, 8) : Object.entries(FOCUSED_TYPE_LABELS).map(([id, label]) => ({ id, label, score: 0, evidenceCount: 0, status: "unpracticed", updatedAt: "" })),
      updatedAt: String(source.updatedAt || "")
    };
  }

  function speechSynthesisAvailable() {
    return typeof window.SpeechSynthesisUtterance === "function" && Boolean(window.speechSynthesis);
  }

  function speechButtonHtml(text, label = "播放英文发音") {
    if (!text || !speechSynthesisAvailable()) return "";
    return `<button class="speak-button" type="button" data-speak-text="${escapeHtml(text)}" data-tooltip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i data-lucide="volume-2" aria-hidden="true"></i></button>`;
  }

  function speakEnglish(text, button = null, rate = 0.72) {
    const value = String(text || "").trim();
    if (!value || !speechSynthesisAvailable()) return false;
    window.speechSynthesis.cancel();
    $$(".speak-button.is-playing").forEach(item => item.classList.remove("is-playing"));
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = "en-US";
    utterance.rate = Math.max(0.5, Math.min(1, Number(rate) || 0.72));
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find(voice => /^en-US/i.test(voice.lang)) || voices.find(voice => /^en/i.test(voice.lang)) || null;
    if (button) button.classList.add("is-playing");
    const finish = () => button?.classList.remove("is-playing");
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
    return true;
  }

  function normalizeAbilityReport(value) {
    const source = value && typeof value === "object" ? value : {};
    const abilities = (Array.isArray(source.abilities) ? source.abilities : []).map(item => ({
      id: String(item.id || ""),
      label: String(item.label || ""),
      score: Math.max(0, Math.min(100, Number(item.score) || 0)),
      measuredAccuracy: Number.isFinite(Number(item.measuredAccuracy)) ? Number(item.measuredAccuracy) : null,
      evidenceCount: Math.max(0, Number(item.evidenceCount) || 0),
      status: ["unpracticed", "developing", "stable"].includes(item.status) ? item.status : "unpracticed",
      confidence: String(item.confidence || "none"),
      updatedAt: String(item.updatedAt || "")
    })).filter(item => item.id && item.label).slice(0, 7);
    return {
      comprehensiveScore: Math.max(0, Math.min(100, Number(source.comprehensiveScore) || 0)),
      practicedAbilities: Math.max(0, Number(source.practicedAbilities) || 0),
      unpracticedAbilities: Math.max(0, Number(source.unpracticedAbilities) || 0),
      totalEvidence: Math.max(0, Number(source.totalEvidence) || 0),
      status: String(source.status || "unpracticed"),
      updatedAt: String(source.updatedAt || ""),
      abilities
    };
  }

  function abilityStatusText(item) {
    if (item.status === "unpracticed") return "未测评";
    if (item.status === "stable") return `已稳定 · ${item.evidenceCount} 条证据`;
    return `形成中 · ${item.evidenceCount} 条证据`;
  }

  function drawAbilityRadar(report) {
    const canvas = $("#abilityRadar");
    const context = canvas && canvas.getContext("2d");
    if (!canvas || !context) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 620));
    const height = Math.round(width * 460 / 620);
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const abilities = report && report.abilities.length ? report.abilities : [
      { label: "词汇", score: 0, status: "unpracticed" }, { label: "拼写", score: 0, status: "unpracticed" },
      { label: "语法", score: 0, status: "unpracticed" }, { label: "阅读", score: 0, status: "unpracticed" },
      { label: "翻译", score: 0, status: "unpracticed" }, { label: "听力", score: 0, status: "unpracticed" },
      { label: "写作", score: 0, status: "unpracticed" }
    ];
    const centerX = width / 2;
    const centerY = height / 2 + 4;
    const radius = Math.min(width * 0.34, height * 0.36);
    const angleFor = index => -Math.PI / 2 + (Math.PI * 2 * index / abilities.length);
    const point = (index, scale) => ({
      x: centerX + Math.cos(angleFor(index)) * radius * scale,
      y: centerY + Math.sin(angleFor(index)) * radius * scale
    });

    context.lineWidth = 1;
    [0.2, 0.4, 0.6, 0.8, 1].forEach((scale, ringIndex) => {
      context.beginPath();
      abilities.forEach((_, index) => {
        const current = point(index, scale);
        if (!index) context.moveTo(current.x, current.y); else context.lineTo(current.x, current.y);
      });
      context.closePath();
      context.strokeStyle = ringIndex === 4 ? "#b9c8c1" : "#d9e2dd";
      context.stroke();
    });
    abilities.forEach((_, index) => {
      const outer = point(index, 1);
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.lineTo(outer.x, outer.y);
      context.strokeStyle = "#d9e2dd";
      context.stroke();
    });

    context.beginPath();
    abilities.forEach((item, index) => {
      const current = point(index, Math.max(0, Math.min(1, item.score / 100)));
      if (!index) context.moveTo(current.x, current.y); else context.lineTo(current.x, current.y);
    });
    context.closePath();
    context.fillStyle = "rgba(22, 124, 102, 0.20)";
    context.strokeStyle = "#167c66";
    context.lineWidth = 2;
    context.fill();
    context.stroke();
    abilities.forEach((item, index) => {
      const current = point(index, Math.max(0, Math.min(1, item.score / 100)));
      context.beginPath();
      context.arc(current.x, current.y, 3.5, 0, Math.PI * 2);
      context.fillStyle = "#167c66";
      context.fill();
    });

    context.font = '12px "Microsoft YaHei", sans-serif';
    context.fillStyle = "#202824";
    abilities.forEach((item, index) => {
      const labelPoint = point(index, 1.18);
      const text = `${item.label} ${item.status === "unpracticed" ? "未测评" : Math.round(item.score)}`;
      const measurement = context.measureText(text);
      const x = Math.max(2, Math.min(width - measurement.width - 2, labelPoint.x - measurement.width / 2));
      context.fillText(text, x, labelPoint.y + 4);
    });
  }

  function renderAbilityView() {
    const report = abilityReport;
    $("#abilityOverall").textContent = report && report.practicedAbilities ? String(report.comprehensiveScore) : "—";
    $("#abilityPracticed").textContent = `${report ? report.practicedAbilities : 0} / 7`;
    $("#abilityEvidence").textContent = String(report ? report.totalEvidence : 0);
    $("#abilitiesStatus").textContent = abilityLoading
      ? "正在汇总学习证据…"
      : abilityStatusMessage || (report && report.updatedAt ? `统计截至 ${formatAiHistoryTime(report.updatedAt)}` : "完成练习后，这里会形成可量化的能力档案。");
    const abilities = report ? report.abilities : [];
    $("#abilityDetailList").innerHTML = abilities.length ? abilities.map(item => `
      <div class="ability-detail ${item.status === "unpracticed" ? "is-unpracticed" : ""}">
        <div class="ability-detail-name"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(abilityStatusText(item))}</span></div>
        <div class="ability-meter" aria-hidden="true"><span style="width:${item.score}%"></span></div>
        <span class="ability-detail-score">${item.status === "unpracticed" ? "—" : Math.round(item.score)}</span>
      </div>`).join("") : '<p class="empty-message">正在读取能力数据…</p>';
    requestAnimationFrame(() => drawAbilityRadar(report));
  }

  async function loadAbilities(force = false) {
    if (!API_ENABLED) {
      abilityStatusMessage = "能力分析需要连接已部署的网站。";
      renderAbilityView();
      return;
    }
    if (abilityLoading || (abilityReport && !force)) return;
    abilityLoading = true;
    abilityStatusMessage = "";
    renderAbilityView();
    try {
      const response = await fetch("/api/abilities", { cache: "no-store", credentials: "same-origin" });
      abilityReport = normalizeAbilityReport(await responseJson(response));
    } catch (error) {
      abilityStatusMessage = error.message;
    } finally {
      abilityLoading = false;
      renderAbilityView();
    }
  }

  function invalidateAbilities() {
    abilityReport = null;
    if (activeView === "abilities") loadAbilities(true);
  }

  function selectedDictationSettings() {
    const settings = dictationState.settings || {};
    const fallbackModel = aiOptions.models.includes(settings.model) ? settings.model : aiOptions.defaultModel;
    return {
      model: fallbackModel || "",
      reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
      count: [5, 10, 20].includes(Number(settings.count)) ? Number(settings.count) : 5
    };
  }

  function updateDictationPreferences(patch) {
    dictationState.settings = { ...selectedDictationSettings(), ...patch };
    dictationStatusMessage = "";
    renderDictationView();
  }

  function populateDictationControls() {
    const settings = selectedDictationSettings();
    const select = $("#dictationModelSelect");
    select.innerHTML = aiOptions.models.length
      ? aiOptions.models.map(modelName => `<option value="${escapeHtml(modelName)}">${escapeHtml(modelName)}</option>`).join("")
      : '<option value="">尚未配置模型</option>';
    select.value = settings.model;
    $("#dictationCount").value = String(settings.count);
    $$('[data-dictation-effort]').forEach(button => {
      const active = button.dataset.dictationEffort === settings.reasoningEffort;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function dictationItemHtml(item, completed) {
    const position = Number(item.position) || 0;
    if (!completed) return `
      <div class="dictation-item" data-dictation-item="${escapeHtml(item.id)}">
        <span class="dictation-position">${position}</span>
        <button class="speak-button" type="button" data-dictation-listen="${escapeHtml(item.id)}" aria-label="播放第 ${position} 个单词"><i data-lucide="volume-2" aria-hidden="true"></i></button>
        <label><span class="sr-only">第 ${position} 个单词</span><input class="dictation-input" type="text" autocomplete="off" spellcheck="false" data-dictation-answer="${escapeHtml(item.id)}" value="${escapeHtml(item.answer || "")}" placeholder="听音后输入英文"></label>
        <span class="dictation-item-result">第 ${item.day || "—"} 天词库</span>
      </div>`;
    return `
      <div class="dictation-item" data-dictation-item="${escapeHtml(item.id)}">
        <span class="dictation-position">${position}</span>
        ${speechButtonHtml(item.english, `播放 ${item.english} 的发音`)}
        <div><strong>${escapeHtml(item.english)}</strong><div class="text-muted">${escapeHtml(item.phonetic || "")} · ${escapeHtml(item.chinese || "")}</div></div>
        <div class="dictation-item-result ${item.correct ? "is-correct" : ""}"><strong>${item.correct ? "正确" : "错误"}</strong>你的答案：${escapeHtml(item.answer || "（未填写）")}</div>
      </div>`;
  }

  function renderDictationResult(session) {
    const result = $("#dictationResult");
    const completed = session && session.status === "completed";
    result.hidden = !completed;
    if (!completed) return;
    $("#dictationResultScore").textContent = String(session.score || 0);
    $("#dictationResultPossible").textContent = `/ ${session.items.length}`;
    $("#dictationResultSummary").textContent = session.analysis && session.analysis.summary || "听写已完成。";
    const weakWords = session.analysis && Array.isArray(session.analysis.weakWords) ? session.analysis.weakWords : [];
    const recommendations = session.analysis && Array.isArray(session.analysis.recommendations) ? session.analysis.recommendations : [];
    const changes = dictationAbilityChanges.filter(item => item.delta !== 0);
    $("#dictationAnalysis").innerHTML = [
      ...weakWords.map(item => `<div class="dictation-analysis-item"><strong>${escapeHtml(item.detail)}</strong>${item.recommendation ? `<p>${escapeHtml(item.recommendation)}</p>` : ""}</div>`),
      ...recommendations.map(item => `<div class="dictation-analysis-item"><strong>练习建议</strong><p>${escapeHtml(item)}</p></div>`),
      changes.length ? `<div class="dictation-analysis-item"><strong>能力变化</strong><p>${changes.map(item => `${escapeHtml(item.label)} ${item.delta > 0 ? "+" : ""}${item.delta}`).join(" · ")}</p></div>` : ""
    ].join("") || '<div class="exam-no-weakness">本次没有发现需要额外记录的薄弱点。</div>';
  }

  function renderDictationHistory() {
    const history = [...dictationState.history].reverse();
    $("#dictationHistorySummary").textContent = history.length ? `已完成 ${history.length} 次` : "暂无听写记录";
    $("#dictationHistoryList").innerHTML = history.map(session => `
      <details class="ai-history-item">
        <summary><span>${escapeHtml(formatAiHistoryTime(session.completedAt || session.createdAt))}</span><strong>${session.score} / ${session.items.length}</strong></summary>
        <div class="dictation-history-body">
          <p>${escapeHtml(session.analysis && session.analysis.summary || "听写已完成。")}</p>
          <div class="dictation-history-words">${session.items.map(item => `<span class="dictation-history-word ${item.correct ? "" : "is-wrong"}">${escapeHtml(item.english)} · ${escapeHtml(item.answer)}</span>`).join("")}</div>
        </div>
      </details>`).join("");
  }

  function renderDictationView() {
    populateDictationControls();
    const supported = speechSynthesisAvailable();
    const available = supported && aiOptions.configured && !dictationRequestInProgress;
    $("#generateDictationButton").disabled = !available;
    $("#dictationSpeechSupport").textContent = supported ? "使用设备英文语音慢速播放；作答前不显示单词。" : "当前浏览器不支持语音合成，无法进行听写。";
    $("#dictationSpeechSupport").classList.toggle("is-error", !supported);
    $("#dictationStatus").textContent = dictationStatusMessage || (aiOptions.configured ? "错词会提高后续抽取权重。" : "请先由管理员配置 AI 模型。 ");
    const session = dictationState.currentSession;
    $("#dictationEmptyState").hidden = Boolean(session);
    $("#dictationForm").hidden = !session;
    if (session) {
      const completed = session.status === "completed";
      $("#dictationList").innerHTML = session.items.map(item => dictationItemHtml(item, completed)).join("");
      $("#dictationSubmitRow").hidden = completed;
      $("#submitDictationButton").disabled = dictationRequestInProgress;
      renderDictationResult(session);
    } else {
      $("#dictationResult").hidden = true;
    }
    renderDictationHistory();
    refreshIcons();
  }

  async function loadDictation(force = false) {
    if (!API_ENABLED || (dictationLoaded && !force)) { renderDictationView(); return; }
    try {
      dictationState = normalizeClientDictation(await responseJson(await fetch("/api/ai/dictation", { cache: "no-store", credentials: "same-origin" })));
      dictationLoaded = true;
      dictationStatusMessage = "";
    } catch (error) {
      dictationStatusMessage = error.message;
    }
    renderDictationView();
  }

  async function generateDictation() {
    if (dictationRequestInProgress || !speechSynthesisAvailable()) return;
    dictationRequestInProgress = true;
    dictationStatusMessage = "正在按错词权重抽取单词…";
    setBusyButton($("#generateDictationButton"), true, "正在生成…");
    renderDictationView();
    try {
      dictationState = normalizeClientDictation(await responseJson(await fetch("/api/ai/dictation/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedDictationSettings())
      })));
      dictationLoaded = true;
      dictationAbilityChanges = [];
      dictationSpeechCache.clear();
      dictationStatusMessage = "听写已生成，点击喇叭可重复播放。";
    } catch (error) {
      dictationStatusMessage = error.message;
      showToast(error.message);
    } finally {
      dictationRequestInProgress = false;
      setBusyButton($("#generateDictationButton"), false, "");
      renderDictationView();
    }
  }

  function dictationAnswers() {
    const session = dictationState.currentSession;
    return Object.fromEntries((session && session.items || []).map(item => [item.id, String(item.answer || "").trim()]));
  }

  function updateDictationAnswer(event) {
    const input = event.target.closest("[data-dictation-answer]");
    const session = dictationState.currentSession;
    if (!input || !session || session.status !== "draft") return;
    const item = session.items.find(entry => entry.id === input.dataset.dictationAnswer);
    if (!item) return;
    item.answer = input.value;
    clearTimeout(dictationDraftSaveTimer);
    dictationDraftSaveTimer = setTimeout(saveDictationDraft, 500);
    $("#dictationDraftStatus").textContent = "正在保存…";
  }

  async function saveDictationDraft() {
    const session = dictationState.currentSession;
    if (!session || session.status !== "draft") return;
    try {
      dictationState = normalizeClientDictation(await responseJson(await fetch("/api/ai/dictation/current", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, answers: dictationAnswers() })
      })));
      $("#dictationDraftStatus").textContent = "草稿已保存";
    } catch (_) {
      $("#dictationDraftStatus").textContent = "草稿暂未同步，稍后会重试";
    }
  }

  async function playDictationItem(button) {
    const session = dictationState.currentSession;
    const itemId = button.dataset.dictationListen;
    if (!session || !itemId || !speechSynthesisAvailable()) return;
    try {
      let speech = dictationSpeechCache.get(itemId);
      if (!speech) {
        const data = await responseJson(await fetch("/api/ai/dictation/speech", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, itemId })
        }));
        speech = data.text;
        dictationSpeechCache.set(itemId, speech);
      }
      speakEnglish(speech, button, 0.7);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function submitDictation(event) {
    event.preventDefault();
    if (dictationRequestInProgress) return;
    const session = dictationState.currentSession;
    if (!session || session.status !== "draft") return;
    const missing = session.items.find(item => !String(item.answer || "").trim());
    if (missing) {
      const input = $(`[data-dictation-answer="${CSS.escape(missing.id)}"]`);
      input?.focus();
      input?.scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("请完成全部听写后再提交");
      return;
    }
    clearTimeout(dictationDraftSaveTimer);
    dictationRequestInProgress = true;
    dictationStatusMessage = "AI 正在统一分析拼写和发音薄弱点…";
    setBusyButton($("#submitDictationButton"), true, "正在分析…");
    renderDictationView();
    try {
      const data = await responseJson(await fetch("/api/ai/dictation/submit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, answers: dictationAnswers() })
      }));
      dictationState = normalizeClientDictation(data);
      dictationAbilityChanges = Array.isArray(data.abilityChanges) ? data.abilityChanges : [];
      if (data.abilities) abilityReport = normalizeAbilityReport(data.abilities);
      dictationStatusMessage = "分析完成，错词权重和能力档案已更新。";
    } catch (error) {
      dictationStatusMessage = error.message;
      showToast(error.message);
    } finally {
      dictationRequestInProgress = false;
      setBusyButton($("#submitDictationButton"), false, "");
      renderDictationView();
    }
  }

  function selectedFocusedSettings() {
    const settings = focusedState.settings || {};
    return {
      model: aiOptions.models.includes(settings.model) ? settings.model : aiOptions.defaultModel || "",
      reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
      focusedType: Object.hasOwn(FOCUSED_TYPE_LABELS, settings.focusedType) ? settings.focusedType : "choice"
    };
  }

  function updateFocusedPreferences(patch) {
    focusedState.settings = { ...selectedFocusedSettings(), ...patch };
    focusedStatusMessage = "";
    renderFocusedView();
  }

  function populateFocusedControls() {
    const settings = selectedFocusedSettings();
    const select = $("#focusedModelSelect");
    select.innerHTML = aiOptions.models.length
      ? aiOptions.models.map(modelName => `<option value="${escapeHtml(modelName)}">${escapeHtml(modelName)}</option>`).join("")
      : '<option value="">尚未配置模型</option>';
    select.value = settings.model;
    $("#focusedTypeSelect").value = settings.focusedType;
    $$('[data-focused-effort]').forEach(button => {
      const active = button.dataset.focusedEffort === settings.reasoningEffort;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function focusedAnswerComplete(question, answer) {
    if (question.type === "true-false") return answer === true || answer === false || answer === "true" || answer === "false";
    return Boolean(String(answer || "").trim());
  }

  function focusedOptionHtml(question, option, disabled) {
    const selected = focusedState.currentSession && focusedState.currentSession.answers && focusedState.currentSession.answers[question.id];
    return `<label class="exam-option"><input type="radio" name="focused-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" data-focused-answer="${escapeHtml(question.id)}" ${selected === option.id ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="exam-option-key">${escapeHtml(option.id)}</span><span>${escapeHtml(option.text)}</span></label>`;
  }

  function focusedQuestionHtml(question, index, completed) {
    const session = focusedState.currentSession;
    const answer = session && session.answers ? session.answers[question.id] : "";
    let answerField = "";
    if (["single-choice", "cloze", "reading-comprehension", "listening"].includes(question.type)) {
      answerField = `<div class="exam-options-list">${question.options.map(option => focusedOptionHtml(question, option, completed)).join("")}</div>`;
    } else if (question.type === "true-false") {
      answerField = `<div class="exam-options-list exam-boolean-options">
        <label class="exam-option"><input type="radio" name="focused-${escapeHtml(question.id)}" value="true" data-focused-answer="${escapeHtml(question.id)}" ${answer === true ? "checked" : ""} ${completed ? "disabled" : ""}><span>正确</span></label>
        <label class="exam-option"><input type="radio" name="focused-${escapeHtml(question.id)}" value="false" data-focused-answer="${escapeHtml(question.id)}" ${answer === false ? "checked" : ""} ${completed ? "disabled" : ""}><span>错误</span></label>
      </div>`;
    } else if (["translation", "essay"].includes(question.type)) {
      answerField = `<textarea class="exam-textarea" rows="${question.type === "essay" ? 7 : 3}" data-focused-answer="${escapeHtml(question.id)}" maxlength="${question.type === "essay" ? 2000 : 600}" ${completed ? "disabled" : ""}>${escapeHtml(answer || "")}</textarea>${question.type === "essay" ? `<div class="exam-writing-meta"><span>${question.minWords || 0}-${question.maxWords || 0} 个英文单词</span>${question.requiredWords && question.requiredWords.length ? `<span>建议使用：${question.requiredWords.map(escapeHtml).join("、")}</span>` : ""}</div>` : ""}`;
    } else {
      answerField = `<input class="answer-input exam-short-answer" type="text" data-focused-answer="${escapeHtml(question.id)}" value="${escapeHtml(answer || "")}" autocomplete="off" spellcheck="false" ${completed ? "disabled" : ""}>`;
    }
    const listening = question.type === "listening" ? `<div class="exam-listening-player"><button class="secondary-button" type="button" data-focused-listen="${escapeHtml(question.id)}" ${speechSynthesisAvailable() ? "" : "disabled"}><i data-lucide="volume-2" aria-hidden="true"></i><span>播放听力</span></button></div>` : "";
    const grade = completed && question.result ? `<div class="exam-question-result ${question.result.correct ? "is-correct" : "is-review"}">
      <strong>得分 ${question.result.score} / ${question.points}</strong>
      ${question.result.explanation ? `<p>${escapeHtml(question.result.explanation)}</p>` : ""}
      ${question.result.correctAnswer ? `<p><span>参考答案：</span>${escapeHtml(question.result.correctAnswer)}</p>` : ""}
      ${question.transcript ? `<div class="exam-transcript"><span>听力原文</span><p><span class="inline-english">${escapeHtml(question.transcript)}${speechButtonHtml(question.transcript, "播放听力原文")}</span></p></div>` : ""}
    </div>` : "";
    return `<article class="exam-question" data-focused-question="${escapeHtml(question.id)}">
      <div class="exam-question-heading"><span>${index + 1}. ${escapeHtml(question.typeLabel)}</span><strong>${question.points} 分</strong></div>
      <p class="exam-question-prompt">${escapeHtml(question.prompt)}</p>
      ${question.sourceText ? `<div class="exam-source-text"><span class="inline-english">${escapeHtml(question.sourceText)}${/[A-Za-z]/.test(question.sourceText) ? speechButtonHtml(question.sourceText, "播放英文题目") : ""}</span></div>` : ""}
      ${listening}${answerField}${grade}
    </article>`;
  }

  function renderFocusedSkills() {
    $("#focusedSkillGrid").innerHTML = focusedState.skills.map(skill => {
      const score = Math.max(0, Math.min(5, Number(skill.score) || 0));
      return `<div class="focused-skill ${skill.status === "unpracticed" ? "is-unpracticed" : ""}">
        <div class="focused-skill-name"><strong>${escapeHtml(skill.label)}</strong><span>${skill.evidenceCount ? `${skill.evidenceCount} 次训练` : "未练习"}</span></div>
        <div class="focused-bars" aria-label="${escapeHtml(skill.label)} ${score} 分">${Array.from({ length: 5 }, (_, index) => `<span class="${index < score ? "is-filled" : ""}"></span>`).join("")}</div>
        <span class="focused-skill-score">${skill.evidenceCount ? `${score}/5` : "—"}</span>
      </div>`;
    }).join("");
  }

  function renderFocusedResult(session) {
    const completed = session && session.status === "completed";
    $("#focusedResult").hidden = !completed;
    if (!completed) return;
    $("#focusedResultScore").textContent = String(session.result && session.result.levelScore || 0);
    $("#focusedResultSummary").textContent = session.result && session.result.summary || "专项训练已完成。";
    const weakPoints = session.result && Array.isArray(session.result.weakPoints) ? session.result.weakPoints : [];
    const changes = focusedAbilityChanges.filter(item => item.delta !== 0);
    $("#focusedWeaknesses").innerHTML = [
      ...weakPoints.map(item => `<div class="exam-weakness"><div><strong>${escapeHtml(item.detail)}</strong><span class="severity-${escapeHtml(item.severity)}">${item.severity === "high" ? "重点" : item.severity === "low" ? "轻度" : "巩固"}</span></div>${item.recommendation ? `<p>${escapeHtml(item.recommendation)}</p>` : ""}</div>`),
      changes.length ? `<div class="exam-weakness"><div><strong>能力变化</strong></div><p>${changes.map(item => `${escapeHtml(item.label)} ${item.delta > 0 ? "+" : ""}${item.delta}`).join(" · ")}</p></div>` : ""
    ].join("") || '<div class="exam-no-weakness">本次专项表现稳定，没有新增薄弱点。</div>';
  }

  function renderFocusedHistory() {
    const history = [...focusedState.history].reverse();
    $("#focusedHistorySummary").textContent = history.length ? `已完成 ${history.length} 次` : "暂无专项记录";
    $("#focusedHistoryList").innerHTML = history.map(session => `<details class="ai-history-item">
      <summary><span>${escapeHtml(formatAiHistoryTime(session.completedAt || session.createdAt))} · ${escapeHtml(session.label)}</span><strong>${session.result && session.result.levelScore || 0} / 5</strong></summary>
      <div class="focused-history-body"><p>${escapeHtml(session.result && session.result.summary || "专项训练已完成。")}</p></div>
    </details>`).join("");
  }

  function renderFocusedView() {
    populateFocusedControls();
    renderFocusedSkills();
    const selectedType = selectedFocusedSettings().focusedType;
    const listeningUnsupported = selectedType === "listening" && !speechSynthesisAvailable();
    $("#generateFocusedButton").disabled = !aiOptions.configured || focusedRequestInProgress || listeningUnsupported;
    $("#focusedSupport").textContent = listeningUnsupported ? "当前浏览器不支持语音合成，无法生成听力专项。" : "每次训练满分 5 分，完成后统一分析并更新专项能力。";
    $("#focusedSupport").classList.toggle("is-error", listeningUnsupported);
    $("#focusedStatus").textContent = focusedStatusMessage || (aiOptions.configured ? "选择一个题型进行专项训练。" : "请先由管理员配置 AI 模型。 ");
    const session = focusedState.currentSession;
    $("#focusedEmptyState").hidden = Boolean(session);
    $("#focusedForm").hidden = !session;
    if (session) {
      const completed = session.status === "completed";
      $("#focusedSheetMeta").textContent = completed ? "COMPLETED" : "DRAFT";
      $("#focusedSheetTitle").textContent = session.title;
      $("#focusedInstructions").textContent = session.instructions || `${session.label}专项训练`;
      const hasPassage = Boolean(session.passage);
      $("#focusedPassage").hidden = !hasPassage;
      if (hasPassage) {
        $("#focusedPassageLabel").textContent = session.focusedType === "cloze" ? "完形填空材料" : "材料题材料";
        $("#focusedPassageText").innerHTML = `<span class="inline-english">${escapeHtml(session.passage)}${speechButtonHtml(session.passage, "播放专项材料")}</span>`;
      }
      $("#focusedQuestionList").innerHTML = session.questions.map((question, index) => focusedQuestionHtml(question, index, completed)).join("");
      $("#focusedSubmitRow").hidden = completed;
      renderFocusedResult(session);
    } else {
      $("#focusedResult").hidden = true;
    }
    renderFocusedHistory();
    refreshIcons();
  }

  async function loadFocused(force = false) {
    if (!API_ENABLED || (focusedLoaded && !force)) { renderFocusedView(); return; }
    try {
      focusedState = normalizeClientFocused(await responseJson(await fetch("/api/ai/focused", { cache: "no-store", credentials: "same-origin" })));
      focusedLoaded = true;
      focusedStatusMessage = "";
    } catch (error) {
      focusedStatusMessage = error.message;
    }
    renderFocusedView();
  }

  async function generateFocusedPractice() {
    if (focusedRequestInProgress) return;
    focusedRequestInProgress = true;
    focusedStatusMessage = "AI 正在根据学习进度生成专项题目…";
    setBusyButton($("#generateFocusedButton"), true, "正在生成…");
    renderFocusedView();
    try {
      focusedState = normalizeClientFocused(await responseJson(await fetch("/api/ai/focused/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedFocusedSettings())
      })));
      focusedLoaded = true;
      focusedAbilityChanges = [];
      focusedSpeechCache.clear();
      focusedStatusMessage = "专项题目已生成，完成全部题目后统一提交。";
    } catch (error) {
      focusedStatusMessage = error.message;
      showToast(error.message);
    } finally {
      focusedRequestInProgress = false;
      setBusyButton($("#generateFocusedButton"), false, "");
      renderFocusedView();
    }
  }

  function focusedAnswers() {
    const session = focusedState.currentSession;
    return session && session.answers && typeof session.answers === "object" ? { ...session.answers } : {};
  }

  function updateFocusedAnswer(event) {
    const input = event.target.closest("[data-focused-answer]");
    const session = focusedState.currentSession;
    if (!input || !session || session.status !== "draft") return;
    let value = input.value;
    const question = session.questions.find(item => item.id === input.dataset.focusedAnswer);
    if (question && question.type === "true-false") value = input.value === "true";
    session.answers[input.dataset.focusedAnswer] = value;
    input.closest("[data-focused-question]")?.classList.remove("is-unanswered");
    clearTimeout(focusedDraftSaveTimer);
    focusedDraftSaveTimer = setTimeout(saveFocusedDraft, 500);
    $("#focusedDraftStatus").textContent = "正在保存…";
  }

  async function saveFocusedDraft() {
    const session = focusedState.currentSession;
    if (!session || session.status !== "draft") return;
    try {
      focusedState = normalizeClientFocused(await responseJson(await fetch("/api/ai/focused/current", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, answers: focusedAnswers() })
      })));
      $("#focusedDraftStatus").textContent = "草稿已保存";
    } catch (_) {
      $("#focusedDraftStatus").textContent = "草稿暂未同步，稍后会重试";
    }
  }

  async function playFocusedListening(button) {
    const session = focusedState.currentSession;
    const questionId = button.dataset.focusedListen;
    if (!session || !questionId || !speechSynthesisAvailable()) return;
    try {
      let speech = focusedSpeechCache.get(questionId);
      if (!speech) {
        const data = await responseJson(await fetch("/api/ai/focused/listening", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, questionId })
        }));
        speech = data.text;
        focusedSpeechCache.set(questionId, speech);
      }
      speakEnglish(speech, button, 0.72);
    } catch (error) {
      showToast(error.message);
    }
  }

  async function submitFocusedPractice(event) {
    event.preventDefault();
    if (focusedRequestInProgress) return;
    const session = focusedState.currentSession;
    if (!session || session.status !== "draft") return;
    const missing = session.questions.find(question => !focusedAnswerComplete(question, session.answers[question.id]));
    if (missing) {
      const article = $(`[data-focused-question="${CSS.escape(missing.id)}"]`);
      article?.classList.add("is-unanswered");
      article?.scrollIntoView({ behavior: "smooth", block: "center" });
      article?.querySelector("input, textarea, button")?.focus({ preventScroll: true });
      showToast("请完成全部专项题目后再提交");
      return;
    }
    clearTimeout(focusedDraftSaveTimer);
    focusedRequestInProgress = true;
    focusedStatusMessage = "AI 正在统一判分并分析专项薄弱点…";
    setBusyButton($("#submitFocusedButton"), true, "正在分析…");
    renderFocusedView();
    try {
      const data = await responseJson(await fetch("/api/ai/focused/submit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, answers: focusedAnswers() })
      }));
      focusedState = normalizeClientFocused(data);
      focusedAbilityChanges = Array.isArray(data.abilityChanges) ? data.abilityChanges : [];
      if (data.abilities) abilityReport = normalizeAbilityReport(data.abilities);
      focusedStatusMessage = "专项分析完成，五分能力条和总能力档案已更新。";
    } catch (error) {
      focusedStatusMessage = error.message;
      showToast(error.message);
    } finally {
      focusedRequestInProgress = false;
      setBusyButton($("#submitFocusedButton"), false, "");
      renderFocusedView();
    }
  }

  function normalizeClientPreviewPractice(value) {
    const source = value && typeof value === "object" ? value : {};
    const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map(item => {
      if (!item || typeof item !== "object") return null;
      const id = String(item.id || "").trim().slice(0, 160);
      const kind = item.kind === "sentence" ? "sentence" : item.kind === "word" ? "word" : "";
      const direction = ["en-zh", "zh-en"].includes(item.direction) ? item.direction : "";
      const english = String(item.english || "").trim().slice(0, 180);
      const chinese = String(item.chinese || "").trim().slice(0, 180);
      if (!id || !kind || !direction || !english || !chinese) return null;
      return {
        id,
        kind,
        direction,
        wordId: String(item.wordId || "").trim().slice(0, 100),
        requiredPreviewWordIds: Array.from(new Set((Array.isArray(item.requiredPreviewWordIds) ? item.requiredPreviewWordIds : []).map(value => String(value || "").trim().slice(0, 100)).filter(Boolean))).slice(0, 8),
        english,
        chinese,
        acceptedEnglish: Array.from(new Set((Array.isArray(item.acceptedEnglish) ? item.acceptedEnglish : [english]).map(value => String(value || "").trim()).filter(Boolean))).slice(0, 8),
        acceptedChinese: Array.from(new Set((Array.isArray(item.acceptedChinese) ? item.acceptedChinese : [chinese]).map(value => String(value || "").trim()).filter(Boolean))).slice(0, 8)
      };
    }).filter(Boolean).slice(0, 80);
    const taskIds = new Set(tasks.map(item => item.id));
    const answers = Object.fromEntries(Object.entries(source.answers && typeof source.answers === "object" ? source.answers : {}).slice(-100).map(([key, value]) => [String(key).slice(0, 160), String(value || "").slice(0, 500)]).filter(([key]) => taskIds.has(key)));
    const results = Object.fromEntries(Object.entries(source.results && typeof source.results === "object" ? source.results : {}).slice(-100).map(([key, value]) => {
      const result = value && typeof value === "object" ? value : {};
      return [String(key).slice(0, 160), { correct: result.correct === true, score: Math.max(0, Math.min(1, Number(result.score) || 0)), gradingStatus: ["correct", "partial", "incorrect"].includes(result.gradingStatus) ? result.gradingStatus : (result.correct === true ? "correct" : "incorrect"), explanation: String(result.explanation || "").slice(0, 240), answeredAt: String(result.answeredAt || "").slice(0, 40) }];
    }).filter(([key]) => taskIds.has(key)));
    return {
      key: String(source.key || "").slice(0, 240),
      currentDay: Math.max(0, Number(source.currentDay) || 0),
      nextDay: Math.max(0, Number(source.nextDay) || 0),
      mode: ["mixed", "word", "sentence"].includes(source.mode) ? source.mode : "mixed",
      tasks,
      index: Math.max(0, Math.min(Number(source.index) || 0, tasks.length)),
      answers,
      results,
      completed: Boolean(source.completed),
      generatedAt: String(source.generatedAt || "").slice(0, 40),
      updatedAt: String(source.updatedAt || "").slice(0, 40)
    };
  }

  function loadModel() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storageKey()) || "null"); } catch (_) { saved = null; }
    const next = saved && typeof saved === "object" ? saved : {};
    next.taskStates = next.taskStates || {};
    next.history = next.history || {};
    next.studyTime = normalizeStudyTime(next.studyTime);
    next.attempts = Array.isArray(next.attempts) ? next.attempts : [];
    next.sessions = Object.fromEntries(Object.entries(next.sessions && typeof next.sessions === "object" ? next.sessions : {}).map(([date, session]) => [date, normalizeClientReviewSession(session)]));
    next.previewPractice = normalizeClientPreviewPractice(next.previewPractice);
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
    return repairReviewEvidence(DATA, next).state;
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
      studyTime: mergeStudyTime(local.studyTime, remote && remote.studyTime),
      sessions: { ...local.sessions },
      attempts: [...(local.attempts || [])],
      mistakes: [...(local.mistakes || [])],
      previewPractice: normalizeClientPreviewPractice(local.previewPractice),
      aiPractice: String(remote && remote.aiPractice && remote.aiPractice.updatedAt || "") >= String(local.aiPractice && local.aiPractice.updatedAt || "") ? normalizeClientAiPractice(remote.aiPractice) : normalizeClientAiPractice(local.aiPractice)
    };
    const remotePreviewPractice = normalizeClientPreviewPractice(remote && remote.previewPractice);
    if (remotePreviewPractice.updatedAt >= merged.previewPractice.updatedAt || (!merged.previewPractice.key && remotePreviewPractice.key)) merged.previewPractice = remotePreviewPractice;
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
      if (!localSession || (remoteSession.doneTaskIds || []).length >= (localSession.doneTaskIds || []).length) merged.sessions[date] = normalizeClientReviewSession(remoteSession);
    });
    Object.keys(merged.sessions).forEach(date => { merged.sessions[date] = normalizeClientReviewSession(merged.sessions[date]); });
    return repairReviewEvidence(DATA, merged).state;
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
      stopStudyClock("切换账号", false);
      currentUser = data.user;
      model = loadModel();
      previewState = { loaded: false, loading: false, updatedAt: "", preview: null, previews: [], error: "" };
      selectedPreviewName = "";
      previewWordsState = { loaded: false, loading: false, currentDay: Number(DATA.currentDay) || 1, nextDay: (Number(DATA.currentDay) || 1) + 1, updatedAt: "", words: [], error: "" };
      remoteReady = false;
      showAppView();
      bindAppEvents();
      renderHome();
      loadPreviewWords();
      loadAiOptions();
      loadAiExams();
      syncRemoteState();
    } catch (_) { setAuthFeedback("无法连接服务器，请检查网络"); }
    finally { submit.disabled = false; }
  }

  async function logout() {
    stopStudyClock("退出账号", false);
    if (API_ENABLED) { try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {} }
    currentUser = API_ENABLED ? null : { id: "local", username: "本机模式", role: "local" };
    previewState = { loaded: false, loading: false, updatedAt: "", preview: null, previews: [], error: "" };
    selectedPreviewName = "";
    previewWordsState = { loaded: false, loading: false, currentDay: Number(DATA.currentDay) || 1, nextDay: (Number(DATA.currentDay) || 1) + 1, updatedAt: "", words: [], error: "" };
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

  function availableAiTutorProviders() {
    return (Array.isArray(aiOptions.providers) ? aiOptions.providers : []).filter(provider => provider && provider.enabled && provider.id && Array.isArray(provider.models) && provider.models.length);
  }

  function selectedAiTutorProvider(practice = normalizeClientAiPractice(model.aiPractice)) {
    const providers = availableAiTutorProviders();
    return providers.find(provider => provider.id === practice.tutorSettings.providerId)
      || providers.find(provider => provider.id === aiOptions.selectedTutorProviderId)
      || providers[0]
      || null;
  }

  function selectedAiTutorModel(practice = normalizeClientAiPractice(model.aiPractice), provider = selectedAiTutorProvider(practice)) {
    if (!provider) return "";
    return provider.models.includes(practice.tutorSettings.model)
      ? practice.tutorSettings.model
      : provider.models.includes(aiOptions.selectedTutorModel)
        ? aiOptions.selectedTutorModel
        : provider.models[0] || "";
  }

  function populateAiTutorProviderSelect(practice = normalizeClientAiPractice(model.aiPractice)) {
    const select = $("#aiTutorProvider");
    const providers = availableAiTutorProviders();
    const selected = selectedAiTutorProvider(practice);
    select.replaceChildren(...providers.map(provider => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
    }));
    if (selected) select.value = selected.id;
    select.disabled = aiTutorRequestInProgress || !aiOptions.configured || !providers.length;
  }

  function populateAiTutorModelSelect(practice = normalizeClientAiPractice(model.aiPractice)) {
    const select = $("#aiTutorModel");
    const provider = selectedAiTutorProvider(practice);
    const models = provider ? provider.models : [];
    const selected = selectedAiTutorModel(practice, provider);
    select.replaceChildren(...models.map(modelName => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      return option;
    }));
    if (selected) select.value = selected;
    select.disabled = aiTutorRequestInProgress || !aiOptions.configured || !models.length;
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
      aiOptions = { configured: false, models: [], providers: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: false };
      aiOptionsLoaded = true;
      renderAiView();
      return;
    }
    try {
      const response = await fetch("/api/ai/options", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("AI options request failed");
      aiOptions = await response.json();
      aiOptions.providers = (Array.isArray(aiOptions.providers) ? aiOptions.providers : []).map(provider => ({
        id: String(provider && provider.id || ""),
        name: String(provider && provider.name || "AI 供应商"),
        enabled: Boolean(provider && provider.enabled),
        models: Array.from(new Set((Array.isArray(provider && provider.models) ? provider.models : []).map(value => String(value || "").trim()).filter(Boolean)))
      })).filter(provider => provider.id);
      const practice = normalizeClientAiPractice(model.aiPractice);
      if (!aiOptions.models.includes(practice.settings.model)) practice.settings.model = aiOptions.selectedModel || aiOptions.defaultModel || "";
      const tutorProvider = availableAiTutorProviders().find(provider => provider.id === practice.tutorSettings.providerId)
        || availableAiTutorProviders().find(provider => provider.id === aiOptions.selectedTutorProviderId)
        || availableAiTutorProviders()[0];
      practice.tutorSettings.providerId = tutorProvider ? tutorProvider.id : "";
      if (tutorProvider && !tutorProvider.models.includes(practice.tutorSettings.model)) {
        practice.tutorSettings.model = tutorProvider.models.includes(aiOptions.selectedTutorModel) ? aiOptions.selectedTutorModel : tutorProvider.models[0] || "";
      }
      if (AI_EFFORTS.includes(aiOptions.selectedEffort) && !practice.updatedAt) practice.settings.reasoningEffort = aiOptions.selectedEffort;
      if (AI_EFFORTS.includes(aiOptions.selectedTutorEffort) && !practice.updatedAt) practice.tutorSettings.reasoningEffort = aiOptions.selectedTutorEffort;
      if ([5, 10].includes(Number(aiOptions.selectedCount)) && !practice.updatedAt) practice.settings.count = Number(aiOptions.selectedCount);
      model.aiPractice = practice;
    } catch (_) {
      aiOptions = { configured: false, models: [], providers: [], defaultModel: "", efforts: [...AI_EFFORTS], admin: Boolean(currentUser && currentUser.role === "admin") };
    }
    aiOptionsLoaded = true;
    populateAiModelSelect();
    renderAiView();
    renderExamView();
    if (activeView === "home") renderHome();
    preparePreviewPracticeSentences();
  }

  async function loadAiExams() {
    examStatusMessage = "";
    let pendingGenerationId = "";
    if (!API_ENABLED) {
      examState = normalizeClientAiExam(null);
      renderExamView();
      return;
    }
    try {
      const response = await fetch("/api/ai/exams", { credentials: "same-origin", cache: "no-store" });
      examState = normalizeClientAiExam(await responseJson(response));
      preloadCurrentListening();
      if (examState.generation?.status === "pending") {
        pendingGenerationId = examState.generation.id;
        examStatusMessage = "AI 正在后台生成整张试卷，最高强度可能需要几分钟，可暂时离开本页";
      } else if (examState.generation?.status === "failed") examStatusMessage = examState.generation.error || "上次试卷生成失败，请重新生成";
    } catch (error) {
      examStatusMessage = error.message;
    }
    renderExamView();
    if (pendingGenerationId) void monitorExamGeneration(pendingGenerationId);
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

  function aiTutorTargetForSavedThread(practice) {
    const tutor = normalizeClientTutor(practice.tutor);
    if (!tutor) return null;
    if (tutor.historyId) {
      const exactHistory = practice.history.find(item => item.id === tutor.historyId);
      if (exactHistory) return aiTutorTargetForHistory(exactHistory);
    }
    const latestExchange = [...practice.tutorHistory].reverse().find(item => item.setId === tutor.setId && item.questionId === tutor.questionId && item.historyId);
    if (latestExchange) {
      const exchangeHistory = practice.history.find(item => item.id === latestExchange.historyId);
      if (exchangeHistory) return aiTutorTargetForHistory(exchangeHistory);
    }
    const matchingHistory = [...practice.history].reverse().find(item => item.setId === tutor.setId && aiHistoryQuestionId(item) === tutor.questionId);
    if (matchingHistory) return aiTutorTargetForHistory(matchingHistory);
    const set = practice.currentSet;
    const question = set && set.id === tutor.setId ? set.questions.find(item => item.id === tutor.questionId) : null;
    if (!question) return null;
    return { kind: "current", historyId: "", setId: set.id, questionId: question.id, prompt: question.direction === "en-zh" ? question.english : question.chinese };
  }

  function aiTutorResetForTarget(practice, target) {
    return practice.tutorResets.filter(item => item.setId === target.setId && item.questionId === target.questionId).sort((left, right) => right.resetAt.localeCompare(left.resetAt))[0] || null;
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
    const savedTarget = aiTutorTargetForSavedThread(practice);
    if (savedTarget) return savedTarget;
    const set = practice.currentSet;
    const question = currentAiQuestion();
    if (set && question && !set.completed) {
      return { kind: "current", historyId: "", setId: set.id, questionId: question.id, prompt: question.direction === "en-zh" ? question.english : question.chinese };
    }
    return aiTutorTargetForHistory(practice.history[practice.history.length - 1]);
  }

  function tutorThreadForTarget(practice, target) {
    const tutor = normalizeClientTutor(practice.tutor);
    if (aiTutorRequestInProgress && tutor && tutor.setId === target.setId && tutor.questionId === target.questionId) return tutor;
    const resetAt = aiTutorResetForTarget(practice, target)?.resetAt || "";
    const messages = practice.tutorHistory.filter(item => item.setId === target.setId && item.questionId === target.questionId && (!resetAt || item.askedAt > resetAt)).flatMap(item => [
      { role: "user", content: item.question, createdAt: item.askedAt },
      { role: "assistant", content: item.answer, createdAt: item.answeredAt }
    ]);
    if (messages.length) return { setId: target.setId, questionId: target.questionId, messages };
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
    if (!launchButton.hidden) requestAnimationFrame(restoreAiTutorLaunchPosition);
    if (tutorWindow.hidden) return;
    aiTutorTarget = target;
    $("#aiTutorTitle").textContent = target.kind === "history" ? "历史题问答" : "题目问答";
    $("#aiTutorContext").textContent = target.prompt;
    populateAiTutorProviderSelect(practice);
    populateAiTutorModelSelect(practice);
    $("#aiTutorEffort").value = practice.tutorSettings.reasoningEffort;
    const thread = tutorThreadForTarget(practice, target);
    const reset = aiTutorResetForTarget(practice, target);
    $("#aiTutorPersistenceStatus").textContent = reset && !thread.messages.length ? "新会话已建立 · 旧问答不会继续作为上下文" : "已按账号自动保存 · AI 最多使用本会话最近 6 轮";
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
    $("#aiTutorProvider").disabled = aiTutorRequestInProgress || !availableAiTutorProviders().length;
    $("#aiTutorModel").disabled = aiTutorRequestInProgress || !selectedAiTutorProvider(practice);
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

  async function clearAiTutor() {
    if (aiTutorRequestInProgress) return;
    const practice = normalizeClientAiPractice(model.aiPractice);
    const target = resolveAiTutorTarget(practice);
    if (!target) return;
    aiTutorRequestInProgress = true;
    renderAiTutorWindow();
    try {
      if (API_ENABLED) {
        const data = await responseJson(await fetch("/api/ai/questions/tutor/clear", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setId: target.setId, questionId: target.questionId, historyId: target.historyId })
        }));
        model.aiPractice = normalizeClientAiPractice(data.practice);
      } else {
        const resetAt = new Date().toISOString();
        practice.tutorResets = [
          ...practice.tutorResets.filter(item => item.setId !== target.setId || item.questionId !== target.questionId),
          { setId: target.setId, questionId: target.questionId, historyId: target.historyId, source: target.kind, prompt: target.prompt, resetAt }
        ].slice(-MAX_CLIENT_TUTOR_RESETS);
        practice.tutor = { setId: target.setId, questionId: target.questionId, historyId: target.historyId, source: target.kind, prompt: target.prompt, updatedAt: resetAt, messages: [] };
        practice.updatedAt = resetAt;
        model.aiPractice = practice;
      }
      aiTutorTarget = target;
      saveModel();
      showToast("当前会话已清除，旧问答仍保留为学习记录");
    } catch (error) {
      showToast(error.message || "清除会话失败，请稍后重试");
    } finally {
      aiTutorRequestInProgress = false;
      renderAiTutorWindow();
      requestAnimationFrame(() => $("#aiTutorInput").focus());
    }
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
          providerId: practice.tutorSettings.providerId,
          model: practice.tutorSettings.model,
          reasoningEffort: practice.tutorSettings.reasoningEffort
        })
      }));
      const next = normalizeClientAiPractice(model.aiPractice);
      next.tutor = normalizeClientTutor(data.tutor);
      const exchange = normalizeClientTutorExchange(data.exchange);
      if (exchange) next.tutorHistory = [...next.tutorHistory.filter(item => item.id !== exchange.id), exchange].slice(-MAX_CLIENT_TUTOR_HISTORY);
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

  function aiTutorLaunchPositionKey() { return `${storageKey()}-ai-tutor-launch-position-v2`; }

  function loadAiTutorLaunchPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(aiTutorLaunchPositionKey()) || "null");
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const left = Number(value.left);
      const top = Number(value.top);
      return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
    } catch (_) {
      return null;
    }
  }

  function placeAiTutorLaunchButton(position, persist = false) {
    const button = $("#openAiTutorButton");
    if (!position || button.hidden) return;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const maximumLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maximumTop = Math.max(8, window.innerHeight - rect.height - 8);
    const left = Math.min(maximumLeft, Math.max(8, Number(position.left) || 0));
    const top = Math.min(maximumTop, Math.max(8, Number(position.top) || 0));
    button.style.right = "auto";
    button.style.bottom = "auto";
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    if (persist) {
      try { localStorage.setItem(aiTutorLaunchPositionKey(), JSON.stringify({ left: Math.round(left), top: Math.round(top) })); } catch (_) {}
    }
  }

  function restoreAiTutorLaunchPosition() {
    if (aiTutorLaunchDrag) return;
    const button = $("#openAiTutorButton");
    if (button.hidden) return;
    const position = loadAiTutorLaunchPosition();
    if (!position) {
      ["left", "top", "right", "bottom"].forEach(property => button.style.removeProperty(property));
      return;
    }
    placeAiTutorLaunchButton(position, true);
  }

  function startAiTutorLaunchDrag(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    const button = $("#openAiTutorButton");
    const rect = button.getBoundingClientRect();
    aiTutorLaunchDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false
    };
    try { button.setPointerCapture(event.pointerId); } catch (_) {}
  }

  function moveAiTutorLaunchButton(event) {
    const drag = aiTutorLaunchDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      const button = $("#openAiTutorButton");
      button.classList.add("is-dragging");
      button.style.right = "auto";
      button.style.bottom = "auto";
      button.style.left = `${drag.startLeft}px`;
      button.style.top = `${drag.startTop}px`;
    }
    placeAiTutorLaunchButton({ left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY });
    event.preventDefault();
  }

  function endAiTutorLaunchDrag(event) {
    const drag = aiTutorLaunchDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const button = $("#openAiTutorButton");
    aiTutorLaunchDrag = null;
    button.classList.remove("is-dragging");
    if (drag.moved) {
      const rect = button.getBoundingClientRect();
      placeAiTutorLaunchButton({ left: rect.left, top: rect.top }, true);
      aiTutorLaunchSuppressClickUntil = Date.now() + 600;
      event.preventDefault();
    }
    try { button.releasePointerCapture(event.pointerId); } catch (_) {}
  }

  function constrainAiTutorLaunchPosition() {
    if (!aiTutorLaunchDrag) requestAnimationFrame(restoreAiTutorLaunchPosition);
  }

  function aiCorrectAnswer(question) { return question.direction === "zh-en" ? question.english : question.chinese; }

  function aiQuestionScore(question) {
    const score = Number(question && question.score);
    return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : (question && question.correct === true ? 1 : 0);
  }

  function formatQuestionScore(value) {
    const rounded = Math.round(Number(value || 0) * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

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
    const earned = questions.reduce((sum, item) => sum + aiQuestionScore(item), 0);
    const accuracy = questions.length ? Math.round((earned / questions.length) * 100) : 0;
    $("#aiHistorySummary").textContent = questions.length ? `${groups.length} 组 · ${questions.length} 题 · 正确率 ${accuracy}%` : "暂无做题记录";
    const list = $("#aiHistoryList");
    if (!groups.length) {
      list.innerHTML = `<div class="ai-history-empty"><i data-lucide="history" aria-hidden="true"></i><span>暂无做题记录</span></div>`;
      refreshIcons();
      return;
    }
    list.innerHTML = groups.map(group => {
      const groupScore = group.questions.reduce((sum, item) => sum + aiQuestionScore(item), 0);
      const complete = group.questions.length >= group.expectedCount;
      const modelLabel = [group.providerName, group.model, AI_EFFORT_LABELS[group.reasoningEffort]].filter(Boolean).join(" · ") || "历史题组";
      const questionRows = group.questions.map((item, index) => {
        const number = Number(item.questionNumber) || index + 1;
        return `<article class="ai-history-question">
          <div class="ai-history-question-meta"><span>第 ${number} 题 · ${formatDirection(item.direction)}</span><div class="ai-history-question-actions"><span class="ai-history-result ${item.gradingStatus === "partial" ? "is-partial" : item.correct === true ? "is-correct" : "is-wrong"}">${item.gradingStatus === "partial" ? "部分正确" : item.correct === true ? "正确" : "错误"}</span><button class="text-button ai-history-ask" type="button" data-ai-history-ask="${escapeHtml(item.id)}"><i data-lucide="message-circle-question" aria-hidden="true"></i>询问</button></div></div>
          <div class="ai-history-prompt"><span class="inline-english">${escapeHtml(item.prompt || "（题目未记录）")}${item.direction === "en-zh" ? speechButtonHtml(item.prompt, "播放题目发音") : ""}</span></div>
          <dl class="ai-history-answers">
            <div><dt>你的答案</dt><dd>${escapeHtml(item.userAnswer || "（未填写）")}</dd></div>
            <div><dt>正确答案</dt><dd><span class="inline-english">${escapeHtml(item.correctAnswer || "（未记录）")}${item.direction === "zh-en" ? speechButtonHtml(item.correctAnswer, "播放正确答案") : ""}</span></dd></div>
            ${item.explanation ? `<div><dt>讲解</dt><dd>${escapeHtml(item.explanation)}</dd></div>` : ""}
          </dl>
        </article>`;
      }).join("");
      return `<details class="ai-history-group">
        <summary>
          <div class="ai-history-group-main"><strong>${escapeHtml(formatAiHistoryTime(group.createdAt, group.latestAt))}</strong><span>${escapeHtml(modelLabel)}</span></div>
          <div class="ai-history-score"><strong>${formatQuestionScore(groupScore)} / ${group.questions.length}</strong><span>${complete ? "已完成" : `已做 ${group.questions.length} / ${group.expectedCount}`}</span></div>
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
    const partial = question.gradingStatus === "partial";
    feedback.className = `feedback ${partial ? "is-partial" : question.correct ? "is-correct" : "is-wrong"}`;
    feedback.innerHTML = `<span class="feedback-title">${partial ? "基本理解正确" : question.correct ? "答对了" : "再看一次"}</span><span class="feedback-answer"><span class="inline-english">正确答案：${escapeHtml(aiCorrectAnswer(question))}${question.direction === "zh-en" ? speechButtonHtml(aiCorrectAnswer(question), "播放正确答案") : ""}</span></span>${question.correct && !partial ? "" : `<span class="feedback-note">你的答案：${escapeHtml(question.userAnswer || "（未填写）")}</span>`}${partial ? `<span class="feedback-note">本题按 ${Math.round((Number(question.score) || 0.8) * 100)}% 记录，不会清空已有掌握等级。</span>` : ""}${question.explanation ? `<span class="feedback-note">${escapeHtml(question.explanation)}</span>` : ""}`;
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
      const earned = set.questions.reduce((sum, question) => sum + aiQuestionScore(question), 0);
      $("#aiCompleteNote").textContent = `得分 ${formatQuestionScore(earned)} / ${set.questions.length}`;
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
    $("#aiPromptSpeech").innerHTML = question.direction === "en-zh" ? speechButtonHtml(question.english, "播放题目发音") : "";
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
    const text = await response.text().catch(() => "");
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { data = {}; }
    }
    if (!response.ok) {
      let fallback = "请求失败，请稍后重试";
      if (response.status === 401) fallback = "登录状态已失效，请重新登录";
      else if (response.status === 429) fallback = "请求过于频繁，请稍后再试";
      else if ([504, 524].includes(response.status)) fallback = "请求经过网关时超时，请稍后重试";
      else if ([502, 503, 520, 521, 522, 523].includes(response.status)) fallback = "服务器或 AI 上游暂时不可用，请稍后重试";
      const error = new Error(data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : fallback);
      error.statusCode = response.status;
      throw error;
    }
    if (!text || !data || typeof data !== "object") throw new Error("服务器返回格式异常，请刷新后重试");
    return data;
  }

  function normalizeClientPreviewDocument(value) {
    if (!value || typeof value !== "object") return null;
    const name = String(value.name || "").trim().slice(0, 120);
    const content = String(value.content || "").trim().slice(0, 10000);
    return name && content ? { name, content } : null;
  }

  function normalizePreviewResponse(value) {
    const source = value && typeof value === "object" ? value : {};
    const documents = (Array.isArray(source.previews) ? source.previews : []).map(normalizeClientPreviewDocument).filter(Boolean);
    const latest = normalizeClientPreviewDocument(source.preview);
    const unique = new Map(documents.map(document => [document.name, document]));
    if (latest) unique.set(latest.name, latest);
    const previews = Array.from(unique.values()).slice(-30);
    return {
      loaded: true,
      loading: false,
      updatedAt: String(source.updatedAt || "").slice(0, 40),
      preview: latest || previews.at(-1) || null,
      previews,
      error: ""
    };
  }

  async function loadPreview() {
    if (previewState.loading) return;
    if (!API_ENABLED) {
      previewState = { loaded: true, loading: false, updatedAt: "", preview: null, previews: [], error: "每日预习需要登录网站后读取。" };
      renderPreview();
      return;
    }
    previewState = { ...previewState, loading: true, error: "" };
    renderPreview();
    try {
      const response = await fetch("/api/preview", { cache: "no-store", credentials: "same-origin" });
      previewState = normalizePreviewResponse(await responseJson(response));
      if (!selectedPreviewName || !previewState.previews.some(document => document.name === selectedPreviewName)) selectedPreviewName = previewState.preview?.name || "";
    } catch (error) {
      previewState = { ...previewState, loaded: true, loading: false, error: error.message || "获取预习失败，请稍后重试。" };
    }
    renderPreview();
  }

  function normalizeClientPreviewWord(value) {
    if (!value || typeof value !== "object") return null;
    const id = String(value.id || "").trim().slice(0, 100);
    const english = String(value.english || "").trim().slice(0, 100);
    const chinese = String(value.chinese || "").trim().slice(0, 180);
    const day = Math.max(0, Number(value.day) || 0);
    if (!id || !english || !chinese || !day || value.preview !== true || String(value.learned || "").trim()) return null;
    return {
      id,
      day,
      preview: true,
      learned: "",
      english,
      phonetic: String(value.phonetic || "").trim().slice(0, 100),
      chinese,
      acceptedChinese: Array.from(new Set((Array.isArray(value.acceptedChinese) ? value.acceptedChinese : [chinese]).map(item => String(item || "").trim()).filter(Boolean))).slice(0, 8),
      pronunciation: String(value.pronunciation || "").trim().slice(0, 300)
    };
  }

  function normalizePreviewWordsResponse(value) {
    const source = value && typeof value === "object" ? value : {};
    const currentDay = Math.max(1, Number(source.currentDay) || Number(DATA.currentDay) || 1);
    const nextDay = currentDay + 1;
    const words = (Array.isArray(source.words) ? source.words : []).map(normalizeClientPreviewWord).filter(item => item && item.day === nextDay);
    return {
      loaded: true,
      loading: false,
      currentDay,
      nextDay,
      updatedAt: String(source.updatedAt || "").slice(0, 40),
      words,
      error: ""
    };
  }

  async function loadPreviewWords() {
    if (previewWordsState.loading) return;
    if (!API_ENABLED) {
      previewWordsState = { ...previewWordsState, loaded: true, loading: false, words: [], error: "预习单词需要登录网站后读取。" };
      renderPreviewWords();
      renderStudyTimer();
      return;
    }
    previewWordsState = { ...previewWordsState, loading: true, error: "" };
    renderPreviewWords();
    try {
      const response = await fetch("/api/preview/words", { cache: "no-store", credentials: "same-origin" });
      previewWordsState = normalizePreviewWordsResponse(await responseJson(response));
    } catch (error) {
      previewWordsState = { ...previewWordsState, loaded: true, loading: false, error: error.message || "获取预习单词失败，请稍后重试。" };
    }
    ensurePreviewPracticeState();
    preparePreviewPracticeSentences();
    renderPreviewWords();
    renderPreviewPractice();
    renderStudyTimer();
  }

  function previewPracticeWords() {
    const expectedNextDay = Math.max(1, Number(previewWordsState.nextDay) || (Number(DATA.currentDay) || 1) + 1);
    const learnedEnglish = new Set(learnedItems.map(item => String(item.english || "").toLocaleLowerCase()).filter(Boolean));
    return (Array.isArray(previewWordsState.words) ? previewWordsState.words : []).filter(item => item && item.preview === true && !String(item.learned || "").trim() && Number(item.day) === expectedNextDay && !learnedEnglish.has(String(item.english || "").toLocaleLowerCase()));
  }

  function previewPracticeKey(words = previewPracticeWords()) {
    return `${previewWordsState.currentDay}|${previewWordsState.nextDay}|${words.map(item => item.id).sort().join(",")}`;
  }

  function previewWordPracticeTasks(words) {
    return words.flatMap(word => ["en-zh", "zh-en"].map(direction => ({
      id: `preview-word-${word.id}-${direction}`,
      kind: "word",
      direction,
      wordId: word.id,
      requiredPreviewWordIds: [word.id],
      english: word.english,
      chinese: word.chinese,
      acceptedEnglish: [word.english],
      acceptedChinese: word.acceptedChinese || [word.chinese]
    })));
  }

  function previewPracticeTasksForMode(state = normalizeClientPreviewPractice(model.previewPractice), mode = state.mode) {
    return (Array.isArray(state.tasks) ? state.tasks : []).filter(task => mode === "word" ? task.kind === "word" : mode === "sentence" ? task.kind === "sentence" : true);
  }

  function clearPreviewPracticeRetry(key = "") {
    if (key && previewPracticeRetryKey !== key) return;
    clearTimeout(previewPracticeRetryTimer);
    previewPracticeRetryTimer = null;
    previewPracticeRetryKey = "";
  }

  function schedulePreviewPracticeRetry(key) {
    if (!key || (previewPracticeRetryKey === key && previewPracticeRetryTimer)) return;
    clearPreviewPracticeRetry();
    previewPracticeRetryKey = key;
    previewPracticeRetryTimer = setTimeout(async () => {
      previewPracticeRetryTimer = null;
      if (previewPracticeRetryKey !== key) return;
      previewPracticeRetryKey = "";
      previewPracticeStatusMessage = "AI 正在重试预习句子…";
      renderPreviewPractice();
      await preparePreviewPracticeSentences(true);
    }, REVIEW_VARIANT_RETRY_MS);
  }

  function ensurePreviewPracticeState() {
    const words = previewPracticeWords();
    const key = previewPracticeKey(words);
    const current = normalizeClientPreviewPractice(model.previewPractice);
    if (current.key === key && current.currentDay === Number(previewWordsState.currentDay) && current.nextDay === Number(previewWordsState.nextDay)) {
      model.previewPractice = current;
      return current;
    }
    const next = {
      key,
      currentDay: Number(previewWordsState.currentDay) || Number(DATA.currentDay) || 1,
      nextDay: Number(previewWordsState.nextDay) || (Number(DATA.currentDay) || 1) + 1,
      mode: current.mode || "mixed",
      tasks: previewWordPracticeTasks(words),
      index: 0,
      answers: {},
      results: {},
      completed: false,
      generatedAt: "",
      updatedAt: new Date().toISOString()
    };
    model.previewPractice = next;
    clearPreviewPracticeRetry();
    previewPracticeStatusMessage = words.length ? "" : "";
    saveModel();
    return next;
  }

  async function preparePreviewPracticeSentences(force = false) {
    const words = previewPracticeWords();
    if (!words.length) return;
    const state = ensurePreviewPracticeState();
    const key = state.key;
    const covered = new Set(state.tasks.filter(task => task.kind === "sentence").flatMap(task => task.requiredPreviewWordIds || []));
    const missingWords = words.filter(word => !covered.has(word.id));
    if (!missingWords.length) {
      clearPreviewPracticeRetry(key);
      previewPracticeStatusMessage = "";
      return;
    }
    if (previewPracticeSentencePreparation && previewPracticeSentencePreparation.key === key) return previewPracticeSentencePreparation.promise;
    if (!API_ENABLED || !aiOptionsLoaded) return;
    if (!aiOptions.configured) {
      previewPracticeStatusMessage = "AI 尚未配置，预习句子将每小时自动重试。";
      schedulePreviewPracticeRetry(key);
      return;
    }
    if (!force && previewPracticeRetryKey === key && previewPracticeRetryTimer) return;
    clearPreviewPracticeRetry(key);
    previewPracticeStatusMessage = "AI 正在根据预习词准备句子…";
    const promise = (async () => {
      try {
        const data = await responseJson(await fetch("/api/preview/practice/sentences", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wordIds: missingWords.map(word => word.id) })
        }));
        if (data.source !== "ai") throw Object.assign(new Error("AI 未返回可固定的预习句子"), { statusCode: 503 });
        const returned = Array.isArray(data.sentences) ? data.sentences : [];
        const byWord = new Map(returned.map(item => [String(item.wordId || ""), item]));
        const nextSentences = missingWords.map(word => {
          const sentence = byWord.get(word.id);
          if (!sentence || !String(sentence.english || "").trim() || !String(sentence.chinese || "").trim()) throw Object.assign(new Error("AI 返回的预习句子不完整"), { statusCode: 503 });
          const required = Array.isArray(sentence.requiredPreviewWordIds) && sentence.requiredPreviewWordIds.length ? sentence.requiredPreviewWordIds : [word.id];
          if (!required.includes(word.id)) throw Object.assign(new Error("预习句子没有包含对应预习词"), { statusCode: 503 });
          return {
            id: `preview-sentence-${word.id}`,
            kind: "sentence",
            wordId: word.id,
            requiredPreviewWordIds: [word.id],
            direction: "en-zh",
            english: String(sentence.english).trim(),
            chinese: String(sentence.chinese).trim(),
            acceptedEnglish: [String(sentence.english).trim()],
            acceptedChinese: Array.from(new Set([String(sentence.chinese).trim(), ...(Array.isArray(sentence.acceptedChinese) ? sentence.acceptedChinese : [])].map(value => String(value || "").trim()).filter(Boolean))).slice(0, 8)
          };
        });
        const existingIds = new Set(state.tasks.map(task => task.id));
        nextSentences.forEach(sentence => {
          if (existingIds.has(sentence.id)) return;
          state.tasks.push(sentence, { ...sentence, id: `${sentence.id}-zh-en`, direction: "zh-en" });
        });
        state.generatedAt = new Date().toISOString();
        state.updatedAt = state.generatedAt;
        previewPracticeStatusMessage = "";
        clearPreviewPracticeRetry(key);
        saveModel();
      } catch (error) {
        previewPracticeStatusMessage = error && error.statusCode === 401 ? "登录状态已失效，请重新登录。" : "AI 暂不可用，预习句子将每小时自动重试。";
        if (!error || error.statusCode !== 401) schedulePreviewPracticeRetry(key);
        if (error && error.statusCode !== 401) showToast(previewPracticeStatusMessage);
      } finally {
        previewPracticeSentencePreparation = null;
        renderPreviewPractice();
      }
    })();
    previewPracticeSentencePreparation = { key, promise };
    return promise;
  }

  function currentPreviewPracticeTask() {
    const state = ensurePreviewPracticeState();
    const tasks = previewPracticeTasksForMode(state);
    return tasks[state.index] || null;
  }

  function previewPracticeGrade(task, answer) {
    if (task.direction === "en-zh") {
      const quality = chineseAnswerQuality(answer, task.acceptedChinese || [task.chinese]);
      return { correct: quality.gradingStatus !== "incorrect", score: quality.score, gradingStatus: quality.gradingStatus, explanation: quality.gradingStatus === "partial" ? "意思基本正确，中文表达还可以更自然。" : quality.gradingStatus === "correct" ? "中文意思对应正确。" : "请对照词义或句意再想一遍。" };
    }
    const correct = englishAnswerMatches(answer, task.acceptedEnglish || [task.english]);
    return { correct, score: correct ? 1 : 0, gradingStatus: correct ? "correct" : "incorrect", explanation: correct ? "英文拼写和句子结构正确。" : "请检查单词拼写、冠词和 be 动词。" };
  }

  function renderPreviewPractice() {
    const state = ensurePreviewPracticeState();
    const words = previewPracticeWords();
    const tasks = previewPracticeTasksForMode(state);
    const current = tasks[state.index] || null;
    $$('[data-preview-practice-mode]').forEach(button => {
      const selected = button.dataset.previewPracticeMode === state.mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("#previewPracticeStatus").textContent = previewPracticeStatusMessage || (words.length ? `第 ${state.nextDay} 天 · ${words.length} 个预习词${state.tasks.some(task => task.kind === "sentence") ? " · 句子已准备" : " · 句子正在准备"}` : "当前没有可练习的下一天预习词");
    $("#previewPracticeStartNote").textContent = "单词题只使用预习词；句子题必须包含预习词，也会组合已学词帮助记忆。这里的作答不会进入正式复习、错题本或能力分析。";
    $("#previewPracticeEmpty").hidden = Boolean(words.length);
    $("#previewPracticePanel").hidden = !current || state.completed;
    $("#previewPracticeComplete").hidden = !state.completed || !tasks.length;
    if (!words.length) {
      $("#previewPracticeEmpty").textContent = "目前没有可练习的下一天预习单词。学习窗口同步新预习后会自动出现。";
    } else if (!tasks.length) {
      $("#previewPracticeEmpty").textContent = state.mode === "sentence" ? "AI 句子还在准备中；恢复后会每小时自动重试。" : "正在准备预习练习…";
      $("#previewPracticeEmpty").hidden = false;
    }
    $("#previewPracticeProgress").textContent = tasks.length ? `${Math.min(state.index + (current ? 0 : 1), tasks.length)} / ${tasks.length}` : "0 / 0";
    if (state.completed) {
      const completed = tasks.filter(task => state.results[task.id]).length;
      const correct = tasks.filter(task => state.results[task.id] && state.results[task.id].correct).length;
      $("#previewPracticeCompleteNote").textContent = `本轮完成：${correct} / ${completed} 题答对。预习结果仅用于熟悉词句，不会改变正式掌握等级。`;
    }
    if (!current) { refreshIcons(); return; }
    const result = state.results[current.id];
    $("#previewPracticeType").textContent = current.kind === "word" ? "预习单词" : "预习句子";
    $("#previewPracticeDay").textContent = `第 ${state.nextDay} 天`;
    $("#previewPracticeCount").textContent = `${state.index + 1} / ${tasks.length}`;
    $("#previewPracticeDirection").textContent = current.direction === "en-zh" ? "英译中" : "中译英";
    $("#previewPracticePrompt").textContent = current.direction === "en-zh" ? current.english : current.chinese;
    $("#previewPracticeSpeech").innerHTML = current.direction === "en-zh" ? speechButtonHtml(current.english, "播放预习题目发音") : "";
    $("#previewPracticeInput").value = result ? (state.answers[current.id] || "") : "";
    $("#previewPracticeInput").placeholder = current.direction === "en-zh" ? "输入中文意思" : "输入英文翻译";
    $("#previewPracticeInput").disabled = Boolean(result);
    $("#previewPracticeSubmit").disabled = Boolean(result);
    $("#previewPracticeFeedback").hidden = !result;
    $("#previewPracticeNext").hidden = !result;
    if (result) {
      const expected = current.direction === "en-zh" ? current.chinese : current.english;
      $("#previewPracticeFeedback").className = `feedback ${result.gradingStatus === "partial" ? "is-partial" : result.correct ? "is-correct" : "is-wrong"}`;
      $("#previewPracticeFeedback").innerHTML = `<span class="feedback-title">${result.gradingStatus === "partial" ? "基本理解正确" : result.correct ? "答对了" : "再看一次"}</span><span class="feedback-answer">参考答案：${escapeHtml(expected)}</span><span class="feedback-note">${escapeHtml(result.explanation || "")}</span>`;
    } else {
      $("#previewPracticeFeedback").innerHTML = "";
    }
    requestAnimationFrame(() => { if (!result && activeView === "preview-practice") $("#previewPracticeInput")?.focus(); });
    refreshIcons();
  }

  function setPreviewPracticeMode(mode) {
    if (!["mixed", "word", "sentence"].includes(mode)) return;
    const state = ensurePreviewPracticeState();
    state.mode = mode;
    state.index = 0;
    state.completed = false;
    state.updatedAt = new Date().toISOString();
    saveModel();
    renderPreviewPractice();
  }

  function submitPreviewPractice(event) {
    event.preventDefault();
    const state = ensurePreviewPracticeState();
    const task = currentPreviewPracticeTask();
    if (!task || state.results[task.id]) return;
    const input = $("#previewPracticeInput");
    const answer = String(input.value || "").trim();
    if (!answer) { showToast("请先填写答案"); input.focus(); return; }
    const grading = previewPracticeGrade(task, answer);
    state.answers[task.id] = answer;
    state.results[task.id] = { ...grading, answeredAt: new Date().toISOString() };
    state.updatedAt = new Date().toISOString();
    saveModel();
    renderPreviewPractice();
  }

  function advancePreviewPractice() {
    const state = ensurePreviewPracticeState();
    const tasks = previewPracticeTasksForMode(state);
    const task = tasks[state.index];
    if (!task || !state.results[task.id]) return;
    state.index += 1;
    state.completed = state.index >= tasks.length;
    state.updatedAt = new Date().toISOString();
    saveModel();
    renderPreviewPractice();
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
      invalidateAbilities();
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

  function selectedExamSettings() {
    const settings = examState.settings || normalizeClientAiExam(null).settings;
    const modelName = aiOptions.models.includes(settings.model) ? settings.model : aiOptions.defaultModel;
    return {
      model: modelName || "",
      reasoningEffort: AI_EFFORTS.includes(settings.reasoningEffort) ? settings.reasoningEffort : "medium",
      includeEssay: Boolean(settings.includeEssay),
      includeListening: Boolean(settings.includeListening && speechSynthesisAvailable()),
      totalPoints: Number(settings.totalPoints) === 150 ? 150 : 100
    };
  }

  function updateExamPreferences(patch) {
    examState.settings = { ...selectedExamSettings(), ...patch };
    renderExamView();
  }

  function populateExamControls() {
    const settings = selectedExamSettings();
    const modelSelect = $("#examModelSelect");
    modelSelect.replaceChildren(...aiOptions.models.map(modelName => {
      const option = document.createElement("option");
      option.value = modelName;
      option.textContent = modelName;
      return option;
    }));
    if (settings.model) modelSelect.value = settings.model;
    modelSelect.disabled = !aiOptions.configured || examRequestInProgress;
    $$('[data-exam-effort]').forEach(button => {
      const active = button.dataset.examEffort === settings.reasoningEffort;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = !aiOptions.configured || examRequestInProgress;
    });
    $$('[data-exam-points]').forEach(button => {
      const active = Number(button.dataset.examPoints) === settings.totalPoints;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = !aiOptions.configured || examRequestInProgress;
    });
    $("#examIncludeEssay").checked = settings.includeEssay;
    $("#examIncludeEssay").disabled = !aiOptions.configured || examRequestInProgress;
    const listeningAvailable = speechSynthesisAvailable();
    $("#examIncludeListening").checked = settings.includeListening;
    $("#examIncludeListening").disabled = !aiOptions.configured || examRequestInProgress || !listeningAvailable;
    const support = $("#examListeningSupport");
    support.textContent = listeningAvailable ? "英文语音可用" : "当前浏览器不支持英文语音，无法生成含听力的试卷";
    support.classList.toggle("is-error", !listeningAvailable);
    $("#generateExamButton").disabled = !aiOptions.configured || examRequestInProgress;
  }

  function formatExamAnswer(question, answer) {
    if (question.type === "multiple-choice") {
      return (Array.isArray(answer) ? answer : []).map(id => {
        const option = question.options.find(item => item.id === id);
        return option ? `${option.id}. ${option.text}` : id;
      }).join("、");
    }
    if (["single-choice", "cloze", "reading-comprehension", "listening"].includes(question.type)) {
      const option = question.options.find(item => item.id === answer);
      return option ? `${option.id}. ${option.text}` : String(answer || "");
    }
    if (question.type === "true-false") return answer === true ? "正确" : answer === false ? "错误" : "";
    return String(answer || "");
  }

  function examAnswerComplete(question, answer) {
    if (question.type === "multiple-choice") return Array.isArray(answer) && answer.length > 0;
    if (question.type === "true-false") return typeof answer === "boolean";
    return Boolean(String(answer || "").trim());
  }

  function examOptionHtml(question, option, inputType, disabled) {
    const answer = examState.currentExam && examState.currentExam.answers ? examState.currentExam.answers[question.id] : "";
    const checked = inputType === "checkbox" ? Array.isArray(answer) && answer.includes(option.id) : answer === option.id;
    return `<label class="exam-option"><input type="${inputType}" name="exam-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" data-exam-answer="${escapeHtml(question.id)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><span class="exam-option-key">${escapeHtml(option.id)}</span><span>${escapeHtml(option.text)}</span></label>`;
  }

  function examQuestionHtml(question, index, completed) {
    const answer = examState.currentExam.answers && examState.currentExam.answers[question.id];
    const disabled = completed || examRequestInProgress;
    let answerField = "";
    if (["single-choice", "cloze", "reading-comprehension", "listening"].includes(question.type)) {
      answerField = `<div class="exam-options-list">${question.options.map(option => examOptionHtml(question, option, "radio", disabled)).join("")}</div>`;
    } else if (question.type === "multiple-choice") {
      answerField = `<div class="exam-options-list">${question.options.map(option => examOptionHtml(question, option, "checkbox", disabled)).join("")}</div>`;
    } else if (question.type === "true-false") {
      answerField = `<div class="exam-options-list exam-boolean-options">
        <label class="exam-option"><input type="radio" name="exam-${escapeHtml(question.id)}" value="true" data-exam-answer="${escapeHtml(question.id)}" ${answer === true ? "checked" : ""} ${disabled ? "disabled" : ""}><span>正确</span></label>
        <label class="exam-option"><input type="radio" name="exam-${escapeHtml(question.id)}" value="false" data-exam-answer="${escapeHtml(question.id)}" ${answer === false ? "checked" : ""} ${disabled ? "disabled" : ""}><span>错误</span></label>
      </div>`;
    } else if (question.type === "essay" || question.type === "translation") {
      const rows = question.type === "essay" ? 7 : 3;
      answerField = `<textarea class="exam-textarea" rows="${rows}" data-exam-answer="${escapeHtml(question.id)}" maxlength="${question.type === "essay" ? 2000 : 600}" ${disabled ? "disabled" : ""}>${escapeHtml(answer || "")}</textarea>${question.type === "essay" ? `<div class="exam-writing-meta"><span>${question.minWords || 0}-${question.maxWords || 0} 个英文单词</span>${question.requiredWords && question.requiredWords.length ? `<span>建议使用：${question.requiredWords.map(escapeHtml).join("、")}</span>` : ""}</div>` : ""}`;
    } else {
      answerField = `<input class="answer-input exam-short-answer" type="text" data-exam-answer="${escapeHtml(question.id)}" value="${escapeHtml(answer || "")}" autocomplete="off" spellcheck="false" ${disabled ? "disabled" : ""}>`;
    }
    const listening = question.type === "listening" ? `<div class="exam-listening-player"><button class="secondary-button" type="button" data-exam-listen="${escapeHtml(question.id)}" data-exam-id="${escapeHtml(examState.currentExam.id)}" ${speechSynthesisAvailable() ? "" : "disabled"}><i data-lucide="volume-2" aria-hidden="true"></i><span>播放听力</span></button></div>` : "";
    const grade = completed && question.result ? `<div class="exam-question-result ${question.result.correct ? "is-correct" : "is-review"}">
      <strong>得分 ${question.result.score} / ${question.points}</strong>
      ${question.result.explanation ? `<p>${escapeHtml(question.result.explanation)}</p>` : ""}
      ${question.result.correctAnswer ? `<p><span>参考答案：</span>${escapeHtml(question.result.correctAnswer)}</p>` : ""}
      ${question.type === "listening" && question.transcript ? `<div class="exam-transcript"><span>听力原文</span><p><span class="inline-english">${escapeHtml(question.transcript)}${speechButtonHtml(question.transcript, "播放听力原文")}</span></p></div>` : ""}
    </div>` : "";
    return `<article class="exam-question" data-exam-question="${escapeHtml(question.id)}" tabindex="-1">
      <div class="exam-question-heading"><span>${index + 1}. ${escapeHtml(question.typeLabel)}</span><strong>${question.points} 分</strong></div>
      <p class="exam-question-prompt">${escapeHtml(question.prompt)}</p>
      ${question.sourceText ? `<div class="exam-source-text"><span class="inline-english">${escapeHtml(question.sourceText)}${speechButtonHtml(question.sourceText, "播放英文材料")}</span></div>` : ""}
      ${listening}${answerField}${grade}
    </article>`;
  }

  function examQuestionUnits(question, completed) {
    const units = { listening: 5, "single-choice": 4, "multiple-choice": 5, "fill-blank": 4, "true-false": 4, cloze: 4, "reading-comprehension": 4, translation: 7, essay: 13 };
    return (units[question.type] || 4) + (completed ? 3 : 0);
  }

  function renderExamQuestions(exam) {
    let clozeShown = false;
    let readingShown = false;
    const blocks = exam.questions.map((question, index) => {
      let passage = "";
      let units = examQuestionUnits(question, exam.status === "completed");
      if (question.type === "cloze" && !clozeShown) {
        clozeShown = true;
        passage = `<section class="exam-reading-passage"><span>完形填空材料</span><p><span class="inline-english">${escapeHtml(exam.clozePassage)}${speechButtonHtml(exam.clozePassage, "播放完形填空材料")}</span></p></section>`;
        units += 7;
      } else if (question.type === "reading-comprehension" && !readingShown) {
        readingShown = true;
        passage = `<section class="exam-reading-passage"><span>材料题材料</span><p><span class="inline-english">${escapeHtml(exam.readingPassage)}${speechButtonHtml(exam.readingPassage, "播放材料题材料")}</span></p></section>`;
        units += 7;
      }
      return { units, html: `<div class="exam-page-block">${passage}${examQuestionHtml(question, index, exam.status === "completed")}</div>` };
    });
    const pages = [];
    let page = [];
    let used = 0;
    blocks.forEach(block => {
      if (page.length && used + block.units > 30) {
        pages.push(page);
        page = [];
        used = 0;
      }
      page.push(block.html);
      used += block.units;
    });
    if (page.length) pages.push(page);
    $("#examQuestionList").innerHTML = pages.map((items, index) => `<section class="exam-page" data-exam-page="${index + 1}">
      <header class="exam-page-running-header"><strong>${escapeHtml(exam.title)}</strong><span>姓名：____________　日期：____________</span></header>
      <div class="exam-page-content">${items.join("")}</div>
      <footer class="exam-page-footer">第 ${index + 1} / ${pages.length} 页 · 满分 ${exam.totalPoints} 分</footer>
    </section>`).join("");
  }

  function examWrongQuestionIds(exam) {
    return (exam.questions || []).filter(question => question.result && Number(question.result.score) < Number(question.points)).map(question => question.id);
  }

  function examWeaknessQuestionId(exam, weakness) {
    const knownIds = new Set((exam.questions || []).map(question => question.id));
    const wrongIds = new Set(examWrongQuestionIds(exam));
    const questionIds = Array.isArray(weakness && weakness.questionIds) ? weakness.questionIds.map(String) : [];
    return questionIds.find(id => wrongIds.has(id)) || questionIds.find(id => knownIds.has(id)) || "";
  }

  function examResultSummaryText(exam) {
    const result = exam && exam.result || {};
    const summary = typeof result.summary === "string" ? result.summary.trim() : "";
    if (summary && summary !== "[object Object]") return summary;
    const score = Number(result.score) || 0;
    const possible = Number(result.possible) || Number(exam && exam.totalPoints) || 100;
    const percentage = possible > 0 ? Math.round((score / possible) * 100) : 0;
    const details = (Array.isArray(result.weakPoints) ? result.weakPoints : []).map(item => String(item && item.detail || "").trim().replace(/[。！？!?；;]+$/g, "")).filter(Boolean).slice(0, 2);
    return `本次得分 ${score}/${possible}（${percentage}%）。${details.length ? `需要复习：${details.join("；")}。` : "本次没有记录明显薄弱点。"}`;
  }

  function examWeaknessHtml(exam, weakness) {
    const targetId = examWeaknessQuestionId(exam, weakness);
    const content = `<span class="exam-weakness-heading-row"><strong>${escapeHtml(weakness.detail)}</strong><span class="severity-${escapeHtml(weakness.severity)}">${weakness.severity === "high" ? "重点" : weakness.severity === "low" ? "轻微" : "一般"}</span></span>${weakness.recommendation ? `<span class="exam-weakness-copy">${escapeHtml(weakness.recommendation)}</span>` : ""}${weakness.relatedWords && weakness.relatedWords.length ? `<span class="exam-related-words">相关单词：${weakness.relatedWords.map(escapeHtml).join("、")}</span>` : ""}`;
    if (!targetId) return `<div class="exam-weakness">${content}</div>`;
    return `<button class="exam-weakness exam-weakness-link" type="button" data-exam-jump-question="${escapeHtml(targetId)}" aria-label="查看对应错题：${escapeHtml(weakness.detail)}">${content}<i data-lucide="locate-fixed" aria-hidden="true"></i></button>`;
  }

  function jumpToExamQuestion(questionId) {
    const target = $$('[data-exam-question]').find(item => item.dataset.examQuestion === String(questionId || ""));
    if (!target) {
      showToast("没有找到这条薄弱点对应的题目");
      return;
    }
    clearTimeout(examQuestionHighlightTimer);
    $$(".exam-question.is-weakness-target").forEach(item => item.classList.remove("is-weakness-target"));
    void target.offsetWidth;
    target.classList.add("is-weakness-target");
    target.focus({ preventScroll: true });
    const targetRect = target.getBoundingClientRect();
    const visibleHeight = Math.min(targetRect.height, Math.max(1, window.innerHeight - 160));
    const desiredTop = Math.max(80, (window.innerHeight - visibleHeight) / 2);
    const scrollTop = Math.max(0, window.scrollY + targetRect.top - desiredTop);
    window.scrollTo({ top: scrollTop, behavior: "smooth" });
    examQuestionHighlightTimer = setTimeout(() => target.classList.remove("is-weakness-target"), 2800);
  }

  function renderExamResult(exam) {
    const section = $("#examResult");
    const result = exam.result;
    section.hidden = !result;
    if (!result) return;
    $("#examResultScore").textContent = String(result.score || 0);
    $("#examResultPossible").textContent = `/ ${result.possible || exam.totalPoints}`;
    $("#examResultSummary").textContent = examResultSummaryText(exam);
    $("#examTypeScores").innerHTML = (result.typeScores || []).map(item => `<div><span>${escapeHtml(item.label)}</span><strong>${item.score} / ${item.possible}</strong></div>`).join("");
    const weaknesses = result.weakPoints || [];
    const changes = examAbilityChanges.filter(item => item.delta !== 0);
    const firstWrongQuestionId = examWrongQuestionIds(exam)[0] || "";
    const weaknessHeading = firstWrongQuestionId
      ? `<button class="exam-weakness-heading" type="button" data-exam-jump-question="${escapeHtml(firstWrongQuestionId)}"><span>需要加强</span><i data-lucide="locate-fixed" aria-hidden="true"></i></button>`
      : `<h3>需要加强</h3>`;
    $("#examWeaknesses").innerHTML = [
      weaknesses.length ? `${weaknessHeading}${weaknesses.map(item => examWeaknessHtml(exam, item)).join("")}` : `<div class="exam-no-weakness">本次没有记录明显薄弱点。</div>`,
      changes.length ? `<div class="exam-weakness"><span class="exam-weakness-heading-row"><strong>能力变化</strong></span><span class="exam-weakness-copy">${changes.map(item => `${escapeHtml(item.label)} ${item.delta > 0 ? "+" : ""}${item.delta}`).join(" · ")}</span></div>` : ""
    ].join("");
  }

  function renderExamHistory() {
    const history = examState.history || [];
    const percentages = history.map(exam => exam.result && exam.result.possible ? Math.round((exam.result.score / exam.result.possible) * 100) : null).filter(value => value !== null);
    $("#examHistorySummary").textContent = history.length ? `${history.length} 份 · 平均 ${Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)}%` : "暂无交卷记录";
    const list = $("#examHistoryList");
    if (!history.length) {
      list.innerHTML = `<div class="ai-history-empty"><i data-lucide="history" aria-hidden="true"></i><span>暂无交卷记录</span></div>`;
      return;
    }
    list.innerHTML = [...history].reverse().map(exam => {
      const result = exam.result || { score: 0, possible: exam.totalPoints, typeScores: [], weakPoints: [] };
      let clozeShown = false;
      let readingShown = false;
      const questionRows = exam.questions.map((question, index) => {
        let passage = "";
        if (question.type === "cloze" && !clozeShown) {
          clozeShown = true;
          passage = `<section class="exam-reading-passage"><span>完形填空材料</span><p>${escapeHtml(exam.clozePassage)}</p></section>`;
        } else if (question.type === "reading-comprehension" && !readingShown) {
          readingShown = true;
          passage = `<section class="exam-reading-passage"><span>材料题材料</span><p>${escapeHtml(exam.readingPassage)}</p></section>`;
        }
        return `${passage}<article class="exam-history-question">
          <div class="exam-history-question-heading"><strong>${index + 1}. ${escapeHtml(question.typeLabel)}</strong><span>${question.result ? question.result.score : 0} / ${question.points}</span></div>
          <p>${escapeHtml(question.prompt)}</p>
          ${question.type === "listening" && question.transcript ? `<div class="exam-transcript"><span>听力原文</span><p>${escapeHtml(question.transcript)}</p><button class="text-button" type="button" data-exam-listen="${escapeHtml(question.id)}" data-exam-id="${escapeHtml(exam.id)}"><i data-lucide="volume-2" aria-hidden="true"></i>重听</button></div>` : question.sourceText ? `<div class="exam-source-text">${escapeHtml(question.sourceText)}</div>` : ""}
          <dl class="ai-history-answers"><div><dt>你的答案</dt><dd>${escapeHtml(formatExamAnswer(question, exam.answers && exam.answers[question.id]) || "（未填写）")}</dd></div><div><dt>参考答案</dt><dd>${escapeHtml(question.result && question.result.correctAnswer || "（未记录）")}</dd></div>${question.result && question.result.explanation ? `<div><dt>讲解</dt><dd>${escapeHtml(question.result.explanation)}</dd></div>` : ""}</dl>
        </article>`;
      }).join("");
      const modelLabel = [exam.providerName, exam.model, AI_EFFORT_LABELS[exam.reasoningEffort]].filter(Boolean).join(" · ");
      return `<details class="ai-history-group exam-history-group"><summary><div class="ai-history-group-main"><strong>${escapeHtml(exam.title)}</strong><span>${escapeHtml(formatAiHistoryTime(exam.submittedAt, exam.createdAt))} · ${escapeHtml(modelLabel)}</span></div><div class="ai-history-score"><strong>${result.score} / ${result.possible}</strong><span>${exam.includeListening ? "含听力" : "无听力"} · ${exam.includeEssay ? "含作文" : "无作文"}</span></div><i data-lucide="chevron-down" aria-hidden="true"></i></summary><div class="exam-history-body"><p>${escapeHtml(examResultSummaryText(exam))}</p><div class="ai-history-questions">${questionRows}</div></div></details>`;
    }).join("");
  }

  function renderExamView() {
    populateExamControls();
    renderExamHistory();
    const exam = examState.currentExam;
    const empty = $("#examEmptyState");
    const paper = $("#examPaper");
    $("#examStatus").textContent = examStatusMessage || (aiOptions.configured ? "AI 已配置" : "AI 尚未配置");
    $("#printExamButton").disabled = !exam;
    $("#openExamPhotoButton").disabled = !exam || exam.status !== "draft" || examRequestInProgress;
    renderExamPhotoPanel();
    if (!exam) {
      empty.hidden = false;
      paper.hidden = true;
      $("#examEmptyTitle").textContent = examState.generation?.status === "pending"
        ? "AI 正在后台生成整张试卷"
        : examState.generation?.status === "failed"
          ? "上次试卷生成未完成"
          : aiOptions.configured
            ? "准备生成试卷"
            : currentUser && currentUser.role === "admin"
              ? "请先完成 AI 连接设置"
              : "AI 尚未配置";
      refreshIcons();
      return;
    }
    empty.hidden = true;
    paper.hidden = false;
    $("#examPaperMeta").textContent = [exam.status === "completed" ? "已交卷" : "答题中", formatAiHistoryTime(exam.createdAt), exam.providerName, exam.model, AI_EFFORT_LABELS[exam.reasoningEffort]].filter(Boolean).join(" · ");
    $("#examPaperTitle").textContent = exam.title;
    $("#examInstructions").textContent = exam.instructions;
    $("#examTotalReadout").textContent = `满分 ${exam.totalPoints}`;
    renderExamQuestions(exam);
    $("#examSubmitRow").hidden = exam.status === "completed";
    $("#submitExamButton").disabled = examRequestInProgress;
    if (exam.status === "draft" && !examRequestInProgress) $("#examDraftStatus").textContent ||= "草稿会自动保存";
    renderExamResult(exam);
    refreshIcons();
  }

  function renderExamPhotoPanel() {
    const panel = $("#examPhotoPanel");
    panel.hidden = !examPhotoFiles.length;
    $("#examPhotoSummary").textContent = examPhotoFiles.length ? `已选择 ${examPhotoFiles.length} 张：${examPhotoFiles.map(file => file.name).join("、")}` : "尚未选择图片";
    $("#gradeExamPhotoButton").disabled = !examPhotoFiles.length || examRequestInProgress;
  }

  async function imageElementForFile(file) {
    if (typeof createImageBitmap === "function") return createImageBitmap(file, { imageOrientation: "from-image" });
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function compressExamPhoto(file) {
    const image = await imageElementForFile(file);
    const sourceWidth = image.width || image.naturalWidth;
    const sourceHeight = image.height || image.naturalHeight;
    const scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (typeof image.close === "function") image.close();
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  function selectExamPhotos(event) {
    const files = Array.from(event.target.files || []).filter(file => ["image/jpeg", "image/png", "image/webp"].includes(file.type));
    if (files.length > 6) {
      showToast("最多选择 6 张答卷照片");
      event.target.value = "";
      examPhotoFiles = [];
    } else examPhotoFiles = files;
    renderExamPhotoPanel();
  }

  function clearExamPhotos() {
    examPhotoFiles = [];
    $("#examPhotoInput").value = "";
    renderExamPhotoPanel();
  }

  async function gradeExamPhotos() {
    const exam = examState.currentExam;
    if (!exam || exam.status !== "draft" || !examPhotoFiles.length || examRequestInProgress) return;
    examRequestInProgress = true;
    examStatusMessage = "正在压缩图片，随后由视觉模型识别并统一判卷…";
    setBusyButton($("#gradeExamPhotoButton"), true, "正在识别…");
    renderExamView();
    try {
      const images = [];
      for (let index = 0; index < examPhotoFiles.length; index += 1) {
        examStatusMessage = `正在处理第 ${index + 1} / ${examPhotoFiles.length} 张答卷照片…`;
        $("#examStatus").textContent = examStatusMessage;
        images.push(await compressExamPhoto(examPhotoFiles[index]));
      }
      examStatusMessage = "视觉模型正在识别手写答案并统一判卷…";
      $("#examStatus").textContent = examStatusMessage;
      const data = await responseJson(await fetch("/api/ai/exams/photo-grade", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId: exam.id, images })
      }));
      examState = normalizeClientAiExam(data);
      examAbilityChanges = Array.isArray(data.abilityChanges) ? data.abilityChanges : [];
      if (data.abilities) abilityReport = normalizeAbilityReport(data.abilities);
      clearExamPhotos();
      examStatusMessage = "纸质答卷判卷完成；照片未保存，识别答案和成绩已写入学习档案。";
    } catch (error) {
      examStatusMessage = error.message;
      showToast(error.message);
    } finally {
      examRequestInProgress = false;
      setBusyButton($("#gradeExamPhotoButton"), false, "");
      renderExamView();
    }
  }

  async function requestListeningText(exam, question) {
    const key = `${exam.id}:${question.id}`;
    if (question.transcript) return question.transcript;
    if (examListeningCache.has(key)) return examListeningCache.get(key);
    const data = await responseJson(await fetch("/api/ai/exams/listening", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examId: exam.id, questionId: question.id })
    }));
    examListeningCache.set(key, data.text);
    return data.text;
  }

  function preloadCurrentListening() {
    const exam = examState.currentExam;
    if (!exam || !speechSynthesisAvailable()) return;
    exam.questions.filter(question => question.type === "listening" && !question.transcript).forEach(question => requestListeningText(exam, question).catch(() => {}));
  }

  async function playExamListening(examId, questionId) {
    if (!speechSynthesisAvailable()) return showToast("当前浏览器不支持英文语音");
    const exam = examState.currentExam && examState.currentExam.id === examId ? examState.currentExam : examState.history.find(item => item.id === examId);
    const question = exam && exam.questions.find(item => item.id === questionId && item.type === "listening");
    if (!exam || !question) return;
    try {
      const text = await requestListeningText(exam, question);
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.75;
      utterance.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find(voice => /^en-US/i.test(voice.lang)) || voices.find(voice => /^en/i.test(voice.lang)) || null;
      examSpeechQuestionId = questionId;
      $$('[data-exam-listen]').forEach(button => button.classList.toggle("is-playing", button.dataset.examListen === questionId && button.dataset.examId === examId));
      utterance.onend = utterance.onerror = () => {
        examSpeechQuestionId = "";
        $$('[data-exam-listen]').forEach(button => button.classList.remove("is-playing"));
      };
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      showToast(error.message);
    }
  }

  function updateExamAnswer(event) {
    const target = event.target.closest("[data-exam-answer]");
    const exam = examState.currentExam;
    if (!target || !exam || exam.status !== "draft") return;
    const question = exam.questions.find(item => item.id === target.dataset.examAnswer);
    if (!question) return;
    exam.answers ||= {};
    if (question.type === "multiple-choice") {
      exam.answers[question.id] = $$('[data-exam-answer]').filter(input => input.dataset.examAnswer === question.id && input.checked).map(input => input.value).sort();
    } else if (question.type === "true-false") {
      exam.answers[question.id] = target.value === "true";
    } else exam.answers[question.id] = target.value;
    $("#examDraftStatus").textContent = "草稿待保存";
    clearTimeout(examDraftSaveTimer);
    examDraftSaveTimer = setTimeout(saveExamDraft, 600);
  }

  async function saveExamDraft() {
    clearTimeout(examDraftSaveTimer);
    const exam = examState.currentExam;
    if (!exam || exam.status !== "draft" || examRequestInProgress) return;
    const status = $("#examDraftStatus");
    status.textContent = "正在保存草稿…";
    try {
      await responseJson(await fetch("/api/ai/exams/current", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId: exam.id, answers: exam.answers })
      }));
      status.textContent = `草稿已保存 · ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    } catch (_) {
      status.textContent = "草稿保存失败，将在下次输入后重试";
    }
  }

  function finishExamGenerationSuccess() {
    examListeningCache.clear();
    examAbilityChanges = [];
    clearExamPhotos();
    preloadCurrentListening();
    examStatusMessage = "试卷已生成，草稿会自动保存";
  }

  async function pollExamGeneration(generationId) {
    let transientFailures = 0;
    while (examGenerationMonitorId === generationId) {
      await new Promise(resolve => setTimeout(resolve, EXAM_GENERATION_POLL_MS));
      let nextState;
      try {
        nextState = normalizeClientAiExam(await responseJson(await fetch("/api/ai/exams", {
          credentials: "same-origin",
          cache: "no-store"
        })));
        transientFailures = 0;
      } catch (error) {
        transientFailures += 1;
        if (transientFailures < 5) {
          examStatusMessage = "网站连接短暂中断，正在继续查询后台生成结果…";
          $("#examStatus").textContent = examStatusMessage;
          continue;
        }
        throw error;
      }

      examState = nextState;
      const generation = examState.generation;
      if (!generation || generation.id !== generationId) throw new Error("试卷生成任务状态已变化，请重新生成");
      if (generation.status === "pending") {
        examStatusMessage = "AI 正在后台生成整张试卷，最高强度可能需要几分钟，可暂时离开本页";
        $("#examStatus").textContent = examStatusMessage;
        continue;
      }
      if (generation.status === "failed") throw new Error(generation.error || "AI 生成试卷失败，请重新生成或更换模型");
      if (!examState.currentExam || examState.currentExam.id !== generation.examId) throw new Error("试卷生成结果不完整，请重新生成");
      return;
    }
    throw new Error("试卷生成任务已停止，请重新查看试卷页面");
  }

  function monitorExamGeneration(generationId) {
    if (!generationId) return Promise.resolve();
    if (examGenerationMonitorId === generationId && examGenerationMonitorPromise) return examGenerationMonitorPromise;
    examGenerationMonitorId = generationId;
    const button = $("#generateExamButton");
    const wasBusy = examRequestInProgress;
    examRequestInProgress = true;
    examStatusMessage = "AI 正在后台生成整张试卷，最高强度可能需要几分钟，可暂时离开本页";
    if (!wasBusy) setBusyButton(button, true, "后台生成中…");
    else button.textContent = "后台生成中…";
    renderExamView();

    examGenerationMonitorPromise = pollExamGeneration(generationId)
      .then(() => finishExamGenerationSuccess())
      .catch(error => {
        examStatusMessage = error.message;
        showToast(error.message);
      })
      .finally(() => {
        if (examGenerationMonitorId !== generationId) return;
        examGenerationMonitorId = "";
        examGenerationMonitorPromise = null;
        examRequestInProgress = false;
        setBusyButton(button, false, "");
        renderExamView();
      });
    return examGenerationMonitorPromise;
  }

  async function generateExam() {
    if (examRequestInProgress || !aiOptions.configured) return;
    const current = examState.currentExam;
    if (current && current.status === "draft" && Object.values(current.answers || {}).some(value => Array.isArray(value) ? value.length : String(value ?? "").trim())) {
      if (!window.confirm("当前试卷尚未交卷，确认生成新试卷吗？")) return;
    }
    const settings = selectedExamSettings();
    examState.settings = settings;
    examRequestInProgress = true;
    examStatusMessage = "正在创建后台试卷生成任务…";
    setBusyButton($("#generateExamButton"), true, "正在创建…");
    renderExamView();
    let handedToMonitor = false;
    try {
      examState = normalizeClientAiExam(await responseJson(await fetch("/api/ai/exams/generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-English-Review-Exam-Version": EXAM_GENERATION_API_VERSION },
        body: JSON.stringify(settings)
      })));
      if (examState.generation?.status === "pending") {
        handedToMonitor = true;
        await monitorExamGeneration(examState.generation.id);
      } else finishExamGenerationSuccess();
    } catch (error) {
      examStatusMessage = error.message;
      showToast(error.message);
    } finally {
      if (!handedToMonitor) {
        examRequestInProgress = false;
        setBusyButton($("#generateExamButton"), false, "");
        renderExamView();
      }
    }
  }

  async function submitExam(event) {
    event.preventDefault();
    if (examRequestInProgress) return;
    const exam = examState.currentExam;
    if (!exam || exam.status !== "draft") return;
    const unanswered = exam.questions.find(question => !examAnswerComplete(question, exam.answers && exam.answers[question.id]));
    if (unanswered) {
      const article = $$('[data-exam-question]').find(item => item.dataset.examQuestion === unanswered.id);
      article?.classList.add("is-unanswered");
      article?.scrollIntoView({ behavior: "smooth", block: "center" });
      article?.querySelector("input, textarea, button")?.focus({ preventScroll: true });
      showToast("还有题目未完成，请填写后再交卷");
      return;
    }
    clearTimeout(examDraftSaveTimer);
    examRequestInProgress = true;
    examStatusMessage = "AI 正在统一判卷并分析薄弱点…";
    setBusyButton($("#submitExamButton"), true, "正在判卷…");
    renderExamView();
    try {
      const data = await responseJson(await fetch("/api/ai/exams/submit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId: exam.id, answers: exam.answers })
      }));
      examState = normalizeClientAiExam(data);
      examAbilityChanges = Array.isArray(data.abilityChanges) ? data.abilityChanges : [];
      if (data.abilities) abilityReport = normalizeAbilityReport(data.abilities);
      examStatusMessage = "判卷完成，薄弱点已写入学习档案";
      requestAnimationFrame(() => $("#examResult").scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      examStatusMessage = error.message;
      showToast(error.message);
    } finally {
      examRequestInProgress = false;
      setBusyButton($("#submitExamButton"), false, "");
      renderExamView();
    }
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
      const testEffort = selectedAiSettings().reasoningEffort;
      const result = await responseJson(await fetch("/api/admin/ai-config/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: provider.id, model: testModel, reasoningEffort: testEffort })
      }));
      const selectedLabel = AI_EFFORT_LABELS[result.reasoningEffort] || result.reasoningEffort;
      const appliedLabel = AI_EFFORT_LABELS[result.appliedReasoningEffort] || result.appliedReasoningEffort;
      const effortLabel = result.appliedReasoningEffort && result.appliedReasoningEffort !== result.reasoningEffort
        ? `${selectedLabel} → 上游${appliedLabel}`
        : selectedLabel;
      setAiConfigFeedback(`连接成功：${result.providerName} · ${result.model} · ${effortLabel}`);
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

  function studyTimeState() {
    model.studyTime = normalizeStudyTime(model.studyTime);
    return model.studyTime;
  }

  function todayStudySeconds() {
    return studySecondsForDate(studyTimeState(), localDate());
  }

  function studyTimeComplete() {
    return todayStudySeconds() >= STUDY_TIME_TARGET_SECONDS;
  }

  function currentStudyPlan() {
    return studyPlanProgress(todayStudySeconds());
  }

  function studyStageDescription(stage) {
    const previewWords = (Array.isArray(previewWordsState.words) ? previewWordsState.words : []).map(item => item.english).filter(Boolean).slice(0, 6);
    if (stage.id === "review") {
      const due = taskCandidates("all", new Set()).length;
      return due ? `完成今日到期题，优先复习错题；当前还有 ${due} 道可练。每题先自己回答，再看讲解。` : "到期题已完成；从词句库挑不熟的内容再练，英译中和中译英都要做。";
    }
    if (stage.id === "phonics") {
      const words = previewWords.length ? `，新词包括 ${previewWords.join("、")}` : "";
      return `在英语学习窗口学习下一课的发音重点和新词${words}；网页发音课用来听示范并跟读。`;
    }
    if (stage.id === "pattern") return "在英语学习窗口只学一个句子结构：先找“谁”，再找“做什么或是什么”，最后看地点等补充信息；用学习笔记回看例句。";
    if (stage.id === "reading") return "先读当天短文并说出大意，再做一组 5 题阅读或翻译练习；先独立作答，有疑问再打开“问 AI”。";
    if (stage.id === "correction") {
      const mistakes = mistakeRows().length;
      return mistakes ? `打开错题本，订正当前 ${mistakes} 个薄弱项；说明自己上次为什么错，再完成一次正确作答。` : "错题本目前已清空；回看今天最不确定的一题，并用自己的话说明正确理由。";
    }
    return "总结今天新学的音、词和句型，再查看下一课预习；只要求熟悉，不提前当作已学内容。";
  }

  function studyStageButtonLabel(stage, running) {
    if (stage.complete) return "回看";
    if (!stage.current) return "按顺序完成";
    if (running) return "正在学习";
    return stage.elapsedSeconds > 0 ? "继续本阶段" : stage.actionLabel;
  }

  function renderStudyPlanSteps(plan) {
    const list = $("#studyPlanSteps");
    if (!list) return;
    list.innerHTML = plan.stages.map(stage => {
      const statusClass = stage.complete ? "is-complete" : stage.current ? "is-current" : "is-locked";
      const icon = stage.complete ? '<i data-lucide="check" aria-hidden="true"></i>' : String(stage.index + 1);
      const timing = `${formatStudyDuration(stage.elapsedSeconds)} / ${formatStudyDuration(stage.targetSeconds)}`;
      return `
        <li class="study-plan-step ${statusClass}">
          <span class="study-plan-step-number">${icon}</span>
          <div class="study-plan-step-copy">
            <div class="study-plan-step-title"><strong>${escapeHtml(stage.label)}</strong><span>${stage.minutes} 分钟 · ${timing}</span></div>
            <p>${escapeHtml(studyStageDescription(stage))}</p>
          </div>
          <button class="secondary-button study-plan-step-action" type="button" data-study-stage="${escapeHtml(stage.id)}" ${stage.current || stage.complete ? "" : "disabled"}>${escapeHtml(studyStageButtonLabel(stage, studyClockRunning))}</button>
        </li>`;
    }).join("");
  }

  function renderStudyTimer() {
    const readout = $("#studyTimeReadout");
    const progress = $("#studyTimeProgress");
    const button = $("#studyTimerButton");
    const status = $("#studyTimeStatus");
    if (!readout || !progress || !button || !status) return;
    const plan = currentStudyPlan();
    const seconds = plan.seconds;
    const complete = plan.complete;
    const current = plan.currentStage;
    readout.textContent = `${formatStudyDuration(seconds)} / ${formatStudyDuration(STUDY_TIME_TARGET_SECONDS)}`;
    progress.style.width = `${Math.min(100, Math.round((seconds / STUDY_TIME_TARGET_SECONDS) * 100))}%`;
    progress.setAttribute("aria-valuenow", String(seconds));
    progress.setAttribute("aria-valuetext", `${formatStudyDuration(seconds)} / ${formatStudyDuration(STUDY_TIME_TARGET_SECONDS)}`);
    button.disabled = complete;
    button.textContent = complete ? "今日已完成" : studyClockRunning ? "暂停当前阶段" : `开始第 ${current.index + 1} 阶段`;
    button.setAttribute("aria-label", complete ? "今日学习计划已完成" : studyClockRunning ? `暂停${current.label}` : `开始${current.label}`);
    if (complete) status.textContent = "六个学习阶段和 60 分钟有效学习时间都已完成，今日达标。";
    else if (studyClockRunning) status.textContent = `正在进行第 ${current.index + 1} 阶段“${current.label}”：${studyStageDescription(current)}${current.allowBackground ? "这一阶段可以切换到英语学习窗口，回来后会继续显示进度。" : "请保持网页可见并有操作，离开页面会自动暂停。"}`;
    else if (studyClockPauseReason) status.textContent = `已暂停：${studyClockPauseReason}。下一步是第 ${current.index + 1} 阶段“${current.label}”。`;
    else status.textContent = `现在先做第 ${current.index + 1} 阶段“${current.label}”：${studyStageDescription(current)}`;
    renderStudyPlanSteps(plan);

    const dock = $("#studyPlanDock");
    const dockLabel = $("#studyPlanDockLabel");
    const dockTime = $("#studyPlanDockTime");
    const dockToggle = $("#studyPlanDockToggle");
    if (dock && dockLabel && dockTime && dockToggle) {
      dock.hidden = activeView === "home" || complete;
      if (current) {
        dockLabel.textContent = `第 ${current.index + 1} 阶段 · ${current.label}`;
        dockTime.textContent = `${formatStudyDuration(current.elapsedSeconds)} / ${formatStudyDuration(current.targetSeconds)}`;
        dockToggle.textContent = studyClockRunning ? "暂停" : current.elapsedSeconds > 0 ? "继续" : "开始";
        dockToggle.setAttribute("aria-label", studyClockRunning ? `暂停${current.label}` : `继续${current.label}`);
      }
    }
    refreshIcons();
  }

  function persistStudyTime(force = false) {
    const state = studyTimeState();
    state.updatedAt = new Date().toISOString();
    if (force) {
      clearTimeout(studyClockPersistTimer);
      studyClockPersistTimer = null;
      saveModel();
      return;
    }
    if (studyClockPersistTimer) return;
    studyClockPersistTimer = setTimeout(() => {
      studyClockPersistTimer = null;
      persistStudyTime(true);
    }, 10000);
  }

  function addStudySeconds(seconds) {
    const increment = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!increment) return;
    const state = studyTimeState();
    const date = localDate();
    const previous = studySecondsForDate(state, date);
    const previousPlan = studyPlanProgress(previous);
    const activeStage = previousPlan.currentStage;
    const stageBoundary = activeStage ? activeStage.endSeconds : STUDY_TIME_TARGET_SECONDS;
    const next = Math.min(stageBoundary, previous + increment);
    if (next === previous) return;
    state.daily[date] = next;
    persistStudyTime(false);
    renderStudyTimer();
    if (next >= stageBoundary) {
      const finalStage = next >= STUDY_TIME_TARGET_SECONDS;
      stopStudyClock(finalStage ? "今日六个阶段均已完成" : `“${activeStage.label}”已完成`, false);
      showToast(finalStage ? "今日 60 分钟学习计划完成" : `“${activeStage.label}”完成，请开始下一阶段`);
    }
  }

  function tickStudyClock(force = false) {
    if (!studyClockRunning) return;
    const now = Date.now();
    const current = currentStudyPlan().currentStage;
    const allowBackground = Boolean(current && current.allowBackground);
    if (!force && ((!allowBackground && document.hidden) || (!allowBackground && now - studyClockLastActivityAt > STUDY_TIME_IDLE_TIMEOUT_MS))) {
      studyClockLastTickAt = now;
      studyClockRemainderMs = 0;
      stopStudyClock(document.hidden ? "页面不可见" : "连续 5 分钟无操作", false);
      return;
    }
    const effectiveNow = force
      ? (allowBackground ? now : Math.min(now, studyClockLastActivityAt + STUDY_TIME_IDLE_TIMEOUT_MS))
      : now;
    const elapsed = force
      ? Math.max(0, effectiveNow - studyClockLastTickAt)
      : Math.max(0, allowBackground ? now - studyClockLastTickAt : Math.min(now - studyClockLastTickAt, STUDY_TIME_TICK_MS * 2));
    studyClockLastTickAt = now;
    studyClockRemainderMs += elapsed;
    const seconds = Math.floor(studyClockRemainderMs / 1000);
    studyClockRemainderMs %= 1000;
    addStudySeconds(seconds);
    renderStudyTimer();
  }

  function stopStudyClock(reason = "手动暂停", countElapsed = true) {
    if (studyClockRunning && countElapsed) tickStudyClock(true);
    studyClockRunning = false;
    clearInterval(studyClockTimer);
    studyClockTimer = null;
    studyClockRemainderMs = 0;
    studyClockPauseReason = reason;
    persistStudyTime(true);
    renderStudyTimer();
  }

  function startStudyClock() {
    if (studyTimeComplete() || document.hidden) return;
    studyClockRunning = true;
    studyClockPauseReason = "";
    studyClockLastTickAt = Date.now();
    studyClockLastActivityAt = studyClockLastTickAt;
    studyClockRemainderMs = 0;
    clearInterval(studyClockTimer);
    studyClockTimer = setInterval(() => tickStudyClock(false), STUDY_TIME_TICK_MS);
    renderStudyTimer();
  }

  function openStudyStage(stage, startCurrent = false) {
    if (!stage || (!stage.current && !stage.complete)) return;
    if (startCurrent && stage.current && !studyClockRunning) startStudyClock();
    setView(stage.view);
    showToast(`${stage.label}：${studyStageDescription(stage)}`);
  }

  function openCurrentStudyStage() {
    const stage = currentStudyPlan().currentStage;
    if (stage) openStudyStage(stage, true);
  }

  function markStudyActivity() {
    if (studyClockRunning) studyClockLastActivityAt = Date.now();
  }

  function handleStudyVisibility() {
    const current = currentStudyPlan().currentStage;
    if (document.hidden && studyClockRunning && !current?.allowBackground) stopStudyClock("页面不可见", false);
    else if (!document.hidden && studyClockRunning && current?.allowBackground) tickStudyClock(true);
    else renderStudyTimer();
  }

  function getSession() {
    const today = localDate();
    const existing = model.sessions[today];
    if (!existing || existing.mode !== reviewMode) {
      const next = { date: today, mode: reviewMode, taskIds: [], index: 0, doneTaskIds: [], currentTaskId: null, batchComplete: false, variants: {} };
      model.sessions[today] = next;
      saveModel();
      return next;
    }
    existing.variants = existing.variants && typeof existing.variants === "object" ? existing.variants : {};
    return existing;
  }

  function taskState(taskId) {
    if (!model.taskStates[taskId]) model.taskStates[taskId] = { level: 0, nextDue: localDate(), lastResult: null, lastReviewed: null, reviewCount: 0 };
    return model.taskStates[taskId];
  }

  function reviewTaskIsEligible(task, studyDate = localDate()) {
    return Boolean(task && isReviewEligibleItem(task.item, DATA.currentDay, studyDate));
  }

  function reviewTaskMatchesMode(task, mode) {
    if (!task) return false;
    if (mode === "word") return task.item.type === "word";
    if (mode === "sentence") return task.item.type === "sentence";
    return true;
  }

  function pruneReviewSession(session) {
    const before = JSON.stringify({ taskIds: session.taskIds, index: session.index, doneTaskIds: session.doneTaskIds, currentTaskId: session.currentTaskId, batchComplete: session.batchComplete, variants: session.variants });
    const originalTaskIds = Array.isArray(session.taskIds) ? session.taskIds : [];
    const originalIndex = Math.max(0, Math.min(Number(session.index) || 0, originalTaskIds.length));
    const studyDate = localDate();
    const eligible = taskId => {
      const task = taskById.get(taskId);
      return reviewTaskIsEligible(task, studyDate) && reviewTaskMatchesMode(task, session.mode);
    };
    const taskIds = originalTaskIds.filter(eligible);
    const doneTaskIds = (Array.isArray(session.doneTaskIds) ? session.doneTaskIds : []).filter(eligible);
    const validTaskIds = new Set(taskIds);
    const variants = Object.fromEntries(Object.entries(session.variants && typeof session.variants === "object" ? session.variants : {}).filter(([taskId]) => validTaskIds.has(taskId)));
    const removedTasks = taskIds.length !== originalTaskIds.length;
    const index = Math.min(originalTaskIds.slice(0, originalIndex).filter(eligible).length, taskIds.length);
    session.taskIds = taskIds;
    session.index = index;
    session.doneTaskIds = doneTaskIds;
    session.currentTaskId = taskIds[index] || null;
    session.batchComplete = taskIds.length ? index >= taskIds.length : (removedTasks ? false : Boolean(session.batchComplete));
    session.variants = variants;
    return before !== JSON.stringify({ taskIds: session.taskIds, index: session.index, doneTaskIds: session.doneTaskIds, currentTaskId: session.currentTaskId, batchComplete: session.batchComplete, variants: session.variants });
  }

  function isDue(task) {
    const today = localDate();
    return reviewTaskIsEligible(task, today) && taskState(task.taskId).nextDue <= today;
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

  function currentBaseTask() {
    const session = getSession();
    const taskId = session.taskIds[session.index];
    return taskId ? taskById.get(taskId) : null;
  }

  function reviewVariantForTask(task, session = getSession()) {
    if (!task || task.item.type !== "sentence") return task;
    const variant = normalizeClientReviewVariant(session.variants && session.variants[task.taskId]);
    if (!variant || variant.source !== "ai") return task;
    return { ...task, item: { ...task.item, ...variant }, reviewVariant: variant, baseItem: task.item };
  }

  function currentTask() {
    return reviewVariantForTask(currentBaseTask());
  }

  function sentenceTasksMissingVariants(session) {
    return session.taskIds.map(taskId => taskById.get(taskId)).filter(task => task && task.item.type === "sentence" && !session.variants[task.taskId]);
  }

  function reviewVariantBatchKey(session) {
    return `${session.date}|${session.mode}|${session.taskIds.join(",")}`;
  }

  function cancelReviewVariantRetry(key = "") {
    if (key && reviewVariantRetryKey !== key) return;
    clearTimeout(reviewVariantRetryTimer);
    reviewVariantRetryTimer = null;
    reviewVariantRetryKey = "";
  }

  function scheduleReviewVariantRetry(session, key) {
    if (!session || !key) return;
    if (reviewVariantRetryKey === key && reviewVariantRetryTimer) return;
    cancelReviewVariantRetry();
    reviewVariantRetryKey = key;
    reviewVariantRetryTimer = setTimeout(async () => {
      reviewVariantRetryTimer = null;
      if (reviewVariantRetryKey !== key) return;
      reviewVariantRetryKey = "";
      const current = getSession();
      if (reviewVariantBatchKey(current) !== key) {
        ensureBatch();
        return;
      }
      reviewVariantStatusMessage = "AI 正在重试句子变式…";
      if (activeView === "home") renderHome();
      await prepareReviewSentenceVariants(current, true);
    }, REVIEW_VARIANT_RETRY_MS);
  }

  async function prepareReviewSentenceVariants(session, force = false) {
    const missing = sentenceTasksMissingVariants(session);
    const key = reviewVariantBatchKey(session);
    if (!missing.length) {
      cancelReviewVariantRetry(key);
      reviewVariantStatusMessage = "";
      return;
    }
    if (reviewVariantPreparation && reviewVariantPreparation.key === key) return reviewVariantPreparation.promise;
    if (!API_ENABLED || !aiOptionsLoaded) {
      return;
    }
    if (!aiOptions.configured) {
      reviewVariantStatusMessage = "AI 尚未配置，句子变式将每小时自动重试。";
      scheduleReviewVariantRetry(session, key);
      return;
    }
    if (!force && reviewVariantRetryKey === key && reviewVariantRetryTimer) return;
    cancelReviewVariantRetry(key);
    reviewVariantStatusMessage = "AI 正在根据学习进度准备新句子…";
    const promise = (async () => {
      try {
        const data = await responseJson(await fetch("/api/review/sentence-variants", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: session.date, taskIds: missing.map(task => task.taskId) })
        }));
        if (data.source !== "ai") throw Object.assign(new Error("AI 未返回可固定的句子变式"), { statusCode: 503 });
        const returned = new Map((Array.isArray(data.variants) ? data.variants : []).map(item => [String(item.taskId || ""), normalizeClientReviewVariant(item)]));
        const nextVariants = new Map();
        missing.forEach(task => {
          const variant = returned.get(task.taskId);
          if (!variant || variant.source !== "ai") throw Object.assign(new Error("AI 返回的句子变式不完整"), { statusCode: 503 });
          nextVariants.set(task.taskId, variant);
        });
        nextVariants.forEach((variant, taskId) => { session.variants[taskId] = variant; });
        reviewVariantStatusMessage = "";
        cancelReviewVariantRetry(key);
        saveModel();
      } catch (error) {
        reviewVariantStatusMessage = error && error.statusCode === 401
          ? "登录状态已失效，请重新登录。"
          : "AI 暂不可用，将每小时自动重试。";
        if (!error || error.statusCode !== 401) scheduleReviewVariantRetry(session, key);
        if (error && error.statusCode !== 401) showToast(reviewVariantStatusMessage);
      } finally {
        reviewVariantPreparation = null;
        const current = currentBaseTask();
        if (activeView === "home" && current && current.item.type === "sentence") renderHome();
      }
    })();
    reviewVariantPreparation = { key, promise };
    return promise;
  }

  function ensureBatch() {
    const session = getSession();
    let changed = pruneReviewSession(session);
    if (!session.taskIds.length && !session.batchComplete) {
      session.taskIds = buildBatch();
      session.index = 0;
      session.currentTaskId = session.taskIds[0] || null;
      if (!session.taskIds.length) session.batchComplete = true;
      changed = true;
    }
    if (changed) saveModel();
    const sessionTasks = sentenceTasksMissingVariants(session);
    if (sessionTasks.length) prepareReviewSentenceVariants(session);
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
    if (view === "exam") renderExamView();
    if (view === "abilities") { renderAbilityView(); loadAbilities(); }
    if (view === "dictation") { renderDictationView(); loadDictation(); }
    if (view === "focused") { renderFocusedView(); loadFocused(); }
    if (view === "library") renderLibrary();
    if (view === "pronunciation") renderPronunciation();
    if (view === "notes") renderNotes();
    if (view === "preview") { renderPreview(); loadPreview(); }
    if (view === "preview-words") { renderPreviewWords(); loadPreviewWords(); }
    if (view === "preview-practice") { renderPreviewPractice(); loadPreviewWords(); }
    if (view === "mistakes") renderMistakes();
    if (view === "progress") renderProgress();
    renderStudyTimer();
    renderAiTutorWindow();
    refreshIcons();
  }

  function setReviewMode(mode) {
    reviewMode = mode;
    const today = localDate();
    model.sessions[today] = { date: today, mode, taskIds: [], index: 0, doneTaskIds: [], currentTaskId: null, batchComplete: false, variants: {} };
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
    renderStudyTimer();
    $("#queueNote").textContent = due ? "先复习错题，再练新词和句子。" : "今天的到期题已完成，可以回到词句库自由练习。";
    const baseTask = currentBaseTask();
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
    if (baseTask.item.type === "sentence" && !session.variants[baseTask.taskId]) {
      $("#promptType").textContent = "句子变式";
      $("#promptDay").textContent = `第 ${baseTask.item.day} 天 · 正在准备`;
      $("#questionCount").textContent = `${session.index + 1} / ${session.taskIds.length}`;
      $("#directionLabel").textContent = reviewVariantStatusMessage || "根据学习进度生成中";
      $("#promptText").textContent = reviewVariantStatusMessage.includes("重试") || reviewVariantStatusMessage.includes("不可用")
        ? "这道句子变式暂时待生成，AI 恢复后会自动重试。"
        : "AI 正在根据你已经学过的单词和句型准备新句子…";
      $("#promptSpeech").innerHTML = "";
      $("#phoneticLine").textContent = "不会加入未学单词；AI 暂不可用时每小时自动重试，不使用本地备用句。";
      $("#exampleLine").textContent = "";
      $("#answerInput").value = "";
      $("#answerInput").disabled = true;
      $("#submitAnswer").disabled = true;
      $("#feedback").hidden = true;
      $("#feedbackActions").hidden = true;
      return;
    }
    $("#promptType").textContent = task.item.type === "word" ? "单词" : "句子变式";
    $("#promptDay").textContent = `第 ${task.item.day} 天`;
    $("#questionCount").textContent = `${session.index + 1} / ${session.taskIds.length}`;
    $("#directionLabel").textContent = formatDirection(task.direction);
    const prompt = task.direction === "en-zh" ? task.item.english : task.item.chinese;
    $("#promptText").textContent = prompt;
    $("#promptSpeech").innerHTML = task.direction === "en-zh" ? speechButtonHtml(task.item.english, "播放题目发音") : "";
    $("#phoneticLine").textContent = task.item.type === "word" && task.direction === "en-zh" ? task.item.phonetic : "";
    $("#exampleLine").textContent = task.reviewVariant ? "已学句型变式 · AI 生成 · 原句仍保留在词句库" : "";
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
        body: JSON.stringify({ taskId: task.taskId, variantId: task.reviewVariant?.id || "", reviewVariant: task.reviewVariant || null, answer, model: settings.model, reasoningEffort: settings.reasoningEffort }),
        signal: controller.signal
      });
      if (response.status === 401) showAuthView();
      if (!response.ok) throw new Error("AI grading request failed");
      const result = await response.json();
      if (typeof result.correct !== "boolean" || typeof result.explanation !== "string") throw new Error("AI grading response is invalid");
      return {
        correct: result.correct,
        score: Number.isFinite(Number(result.score)) ? Math.max(0, Math.min(1, Number(result.score))) : (result.correct ? 1 : 0),
        gradingStatus: ["correct", "partial", "incorrect"].includes(result.gradingStatus) ? result.gradingStatus : (result.correct ? "correct" : "incorrect"),
        explanation: result.explanation.trim(),
        problemWords: Array.isArray(result.problemWords) ? result.problemWords : [],
        wordResults: Array.isArray(result.wordResults) ? result.wordResults : [],
        source: result.source === "ai" ? "ai" : "local"
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function correctAnswer(task) {
    if (task.direction === "zh-en") return task.item.english;
    return task.item.chinese;
  }

  function updateSchedule(task, correct, gradingStatus = correct ? "correct" : "incorrect", score = correct ? 1 : 0) {
    const state = taskState(task.taskId);
    state.lastReviewed = localDate();
    state.reviewCount = (state.reviewCount || 0) + 1;
    state.lastResult = correct;
    state.lastScore = score;
    state.gradingStatus = gradingStatus;
    if (gradingStatus === "partial") {
      state.level = Math.max(1, Number(state.level) || 0);
      state.nextDue = addDays(localDate(), 1);
    } else if (correct) {
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
    let grading = { source: "local", explanation: "", score: correct ? 1 : 0, gradingStatus: correct ? "correct" : "incorrect", problemWords: [], wordResults: [] };
    if (!correct && answer && task.direction === "en-zh") {
      const quality = chineseAnswerQuality(answer, task.item.acceptedChinese || [task.item.chinese]);
      if (quality.gradingStatus === "partial") {
        correct = true;
        grading = { ...grading, ...quality, explanation: "英语意思理解正确；中文量词不够自然，本题按部分正确记录。" };
      }
    }
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
    grading = {
      ...grading,
      score: Number.isFinite(Number(grading.score)) ? Math.max(0, Math.min(1, Number(grading.score))) : (correct ? 1 : 0),
      gradingStatus: ["correct", "partial", "incorrect"].includes(grading.gradingStatus) ? grading.gradingStatus : (correct ? "correct" : "incorrect"),
      problemWords: Array.isArray(grading.problemWords) ? grading.problemWords : [],
      wordResults: Array.isArray(grading.wordResults) ? grading.wordResults : []
    };
    updateSchedule(task, correct, grading.gradingStatus, grading.score);
    const today = localDate();
    model.history[today] = model.history[today] || { reviewed: 0, correct: 0 };
    model.history[today].reviewed += 1;
    model.history[today].correct = Math.round((model.history[today].correct + grading.score) * 100) / 100;
    const reviewVariant = task.reviewVariant ? { ...task.reviewVariant } : null;
    model.attempts.push({ taskId: task.taskId, variantId: reviewVariant?.id || "", reviewVariant, date: today, answer, correct, score: grading.score, gradingStatus: grading.gradingStatus, expected: correctAnswer(task), gradingSource: grading.source, explanation: grading.explanation, problemWords: grading.problemWords, wordResults: grading.wordResults });
    if (!correct) model.mistakes = [...(model.mistakes || []), { id: `attempt-${Date.now()}`, taskId: task.taskId, variantId: reviewVariant?.id || "", reviewVariant, day: task.item.day, prompt: task.direction === "en-zh" ? task.item.english : task.item.chinese, userAnswer: answer || "（未填写）", correctAnswer: correctAnswer(task), note: grading.explanation || "本次复习未答对。" }].slice(-80);
    else model.mistakes = (model.mistakes || []).filter(mistake => !mistakeIsResolved(model.attempts, mistake && mistake.taskId));
    const session = getSession();
    session.currentTaskId = task.taskId;
    session.doneTaskIds = Array.from(new Set([...(session.doneTaskIds || []), task.taskId]));
    saveModel();
    abilityReport = null;
    showFeedback(task, correct, answer, grading);
  }

  function showFeedback(task, correct, answer, grading = {}) {
    const feedback = $("#feedback");
    feedback.hidden = false;
    const partial = grading.gradingStatus === "partial";
    feedback.className = `feedback ${partial ? "is-partial" : correct ? "is-correct" : "is-wrong"}`;
    feedback.innerHTML = `<span class="feedback-title">${partial ? "基本理解正确" : correct ? "答对了" : "再看一次"}</span><span class="feedback-answer">正确答案：${escapeHtml(correctAnswer(task))}</span>${correct && !partial ? "" : `<span class="feedback-note">你的答案：${escapeHtml(answer || "（未填写）")}</span>`}${partial ? `<span class="feedback-note">本题按 ${Math.round((Number(grading.score) || 0.8) * 100)}% 记录，不会清空已有掌握等级。</span>` : ""}`;
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
    if (!reviewTaskIsEligible(task)) {
      showToast("预习单词不会进入今日复习，正式学完后才能练习");
      return;
    }
    const today = localDate();
    reviewMode = task.item.type;
    model.sessions[today] = { date: today, mode: reviewMode, taskIds: [taskId], index: 0, doneTaskIds: [], currentTaskId: taskId, batchComplete: false };
    saveModel();
    $$("[data-mode]").forEach(button => { const active = button.dataset.mode === reviewMode; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    setView("home");
  }

  function practiceMistakeQueue(taskId) {
    const taskIds = buildMistakePracticeQueue(mistakeRows(), taskId, taskById.keys()).filter(candidate => reviewTaskIsEligible(taskById.get(candidate)));
    if (!taskIds.length) {
      showToast("这组内容尚未正式学完，暂不加入今日复习");
      return;
    }
    const today = localDate();
    reviewMode = "all";
    model.sessions[today] = { date: today, mode: reviewMode, taskIds, index: 0, doneTaskIds: [], currentTaskId: taskIds[0], batchComplete: false };
    saveModel();
    $$("[data-mode]").forEach(button => { const active = button.dataset.mode === reviewMode; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    setView("home");
  }

  function renderLibrary() {
    const rawSearch = $("#librarySearch").value || "";
    const searchChinese = normalizeChinese(rawSearch);
    const searchEnglish = normalizeEnglish(rawSearch);
    const day = $("#dayFilter").value;
    const filteredItems = allItems.filter(item => item.type === libraryType
      && (day === "all" || String(item.day) === day)
      && (!rawSearch.trim()
        || normalizeChinese(item.chinese).includes(searchChinese)
        || normalizeEnglish(item.english).includes(searchEnglish)));
    const requestedPageSize = Number($("#libraryPageSize").value);
    const pageSize = LIBRARY_PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : LIBRARY_PAGE_SIZES[0];
    if (requestedPageSize !== pageSize) $("#libraryPageSize").value = String(pageSize);
    const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
    libraryPage = Math.min(totalPages, Math.max(1, libraryPage));
    const startIndex = (libraryPage - 1) * pageSize;
    const items = filteredItems.slice(startIndex, startIndex + pageSize);
    $("#libraryHead").innerHTML = libraryType === "word" ? "<tr><th class=\"sequence-cell\">序号</th><th>单词</th><th>发音</th><th>中文</th><th>学习日</th><th></th></tr>" : "<tr><th class=\"sequence-cell\">序号</th><th>句子</th><th>中文</th><th>学习日</th><th></th></tr>";
    $("#libraryBody").innerHTML = items.map((item, index) => {
      const action = item.preview ? '<span class="type-badge">预习</span>' : `<button class="table-action" type="button" data-practice="${item.id}">练习</button>`;
      const dayLabel = item.preview ? `第 ${item.day} 天预习` : `第 ${item.day} 天`;
      return libraryType === "word"
        ? `<tr><td class="sequence-cell">${startIndex + index + 1}</td><td><span class="inline-english"><code>${escapeHtml(item.english)}</code>${speechButtonHtml(item.english, `播放 ${item.english} 的发音`)}</span></td><td class="phonetic-cell">${escapeHtml(item.phonetic)}</td><td>${escapeHtml(item.chinese)}</td><td class="day-cell">${dayLabel}</td><td>${action}</td></tr>`
        : `<tr><td class="sequence-cell">${startIndex + index + 1}</td><td><span class="inline-english"><code>${escapeHtml(item.english)}</code>${speechButtonHtml(item.english, "播放句子发音")}</span></td><td>${escapeHtml(item.chinese)}</td><td class="day-cell">${dayLabel}</td><td>${action}</td></tr>`;
    }).join("");
    const hasItems = filteredItems.length > 0;
    const endIndex = startIndex + items.length;
    $("#libraryEmpty").hidden = hasItems;
    $("#libraryRange").textContent = hasItems ? `显示第 ${startIndex + 1}-${endIndex} 条，共 ${filteredItems.length} 条` : "共 0 条";
    $("#libraryPageStatus").textContent = hasItems ? `第 ${libraryPage} / ${totalPages} 页` : "第 0 / 0 页";
    $("#libraryPrevPage").disabled = !hasItems || libraryPage <= 1;
    $("#libraryNextPage").disabled = !hasItems || libraryPage >= totalPages;
    $$('[data-practice]').forEach(button => button.addEventListener("click", () => practiceTask(`${button.dataset.practice}:en-zh`)));
    $$("[data-library-type]").forEach(button => { const active = button.dataset.libraryType === libraryType; button.classList.toggle("is-selected", active); button.setAttribute("aria-pressed", String(active)); });
    refreshIcons();
  }

  function renderPronunciation() {
    const concepts = Array.isArray(PRONUNCIATION.concepts) ? PRONUNCIATION.concepts : [];
    const phonemes = Array.isArray(PRONUNCIATION.phonemes) ? PRONUNCIATION.phonemes : [];
    const items = phonemes.filter(item => {
      if (pronunciationFilter === "learned") return item.learned === true;
      if (["vowel", "consonant"].includes(pronunciationFilter)) return item.type === pronunciationFilter;
      return true;
    });
    const filterLabels = { learned: "已学", vowel: "元音", consonant: "辅音", all: "全部" };
    const vowelCount = phonemes.filter(item => item.type === "vowel").length;
    const consonantCount = phonemes.filter(item => item.type === "consonant").length;

    $("#pronunciationSummary").textContent = PRONUNCIATION.summary || "先学课程中已经单独讲过的音，其余内容随用随查。";
    $("#pronunciationAudioNotice").textContent = PRONUNCIATION.audioNotice || "喇叭播放英文示范词。";
    $("#pronunciationAccentNotice").textContent = PRONUNCIATION.accentNotice || "不同词典和口音的音标写法可能不同。";
    $("#pronunciationCount").textContent = `显示 ${items.length} 个${filterLabels[pronunciationFilter] || ""}发音 · 元音 ${vowelCount} · 辅音 ${consonantCount}`;

    $("#pronunciationConcepts").innerHTML = concepts.map((concept, index) => `
      <article class="pronunciation-concept">
        <span class="pronunciation-concept-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <h3>${escapeHtml(concept.title)}</h3>
          <p>${escapeHtml(concept.summary)}</p>
          <div class="pronunciation-concept-action"><strong>怎么做</strong><span>${escapeHtml(concept.action)}</span></div>
          <div class="pronunciation-concept-example"><strong>例子</strong><span>${escapeHtml(concept.example)}</span></div>
        </div>
      </article>
    `).join("");

    $("#pronunciationGrid").innerHTML = items.map(item => {
      const typeLabel = item.type === "vowel" ? "元音" : "辅音";
      return `
        <article class="pronunciation-card${item.learned ? " is-learned" : ""}">
          <header class="pronunciation-card-header">
            <div class="pronunciation-symbol-wrap">
              <span>${escapeHtml(typeLabel)} · ${escapeHtml(item.subtype)}</span>
              <strong class="pronunciation-symbol">${escapeHtml(item.symbol)}</strong>
            </div>
            <div class="pronunciation-card-actions">
              ${item.learned ? '<span class="pronunciation-learned-badge">本课已学</span>' : ""}
              ${speechButtonHtml(item.example, `慢速播放示范词 ${item.example}`)}
            </div>
          </header>
          <div class="pronunciation-example">
            <div><code>${escapeHtml(item.example)}</code><span>${escapeHtml(item.examplePhonetic)}</span></div>
            <span>${escapeHtml(item.exampleZh)}</span>
          </div>
          <dl class="pronunciation-steps">
            <div><dt>口型舌位</dt><dd>${escapeHtml(item.mouth)}</dd></div>
            <div><dt>发音动作</dt><dd>${escapeHtml(item.action)}</dd></div>
            <div><dt>中文辅助</dt><dd>${escapeHtml(item.chineseHint)}</dd></div>
            <div><dt>注意</dt><dd>${escapeHtml(item.pitfall)}</dd></div>
          </dl>
        </article>
      `;
    }).join("");
    $("#pronunciationEmpty").hidden = items.length > 0;
    $$('[data-pronunciation-filter]').forEach(button => {
      const active = button.dataset.pronunciationFilter === pronunciationFilter;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    refreshIcons();
  }

  function renderNotes() {
    const noteDays = Array.from(new Set([
      ...learnedItems.map(item => Number(item.day) || 0),
      ...(Array.isArray(DATA.notes) ? DATA.notes.map(note => Number(note.day) || 0) : [])
    ].filter(Boolean))).sort((left, right) => left - right);
    if (!noteDays.includes(notesDay)) notesDay = noteDays[noteDays.length - 1] || 1;
    const note = (Array.isArray(DATA.notes) ? DATA.notes : []).find(item => Number(item.day) === notesDay) || {};
    const words = DATA.words.filter(item => !item.preview && Number(item.day) === notesDay);
    const sentences = DATA.sentences.filter(item => !item.preview && Number(item.day) === notesDay);
    const date = String(note.date || words[0]?.learned || sentences[0]?.learned || "");
    const select = $("#notesDaySelect");
    select.replaceChildren(...noteDays.map(day => {
      const entry = (Array.isArray(DATA.notes) ? DATA.notes : []).find(item => Number(item.day) === day) || {};
      const dayDate = String(entry.date || DATA.words.find(item => !item.preview && Number(item.day) === day)?.learned || DATA.sentences.find(item => !item.preview && Number(item.day) === day)?.learned || "");
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
      words.length ? `<section class="notes-section"><h2>当天单词</h2><div class="table-wrap"><table class="data-table"><thead><tr><th>单词</th><th>发音</th><th>中文</th></tr></thead><tbody>${words.map(item => `<tr><td><span class="inline-english"><code>${escapeHtml(item.english)}</code>${speechButtonHtml(item.english, `播放 ${item.english} 的发音`)}</span></td><td class="phonetic-cell">${escapeHtml(item.phonetic)}</td><td>${escapeHtml(item.chinese)}</td></tr>`).join("")}</tbody></table></div></section>` : "",
      sentences.length ? `<section class="notes-section"><h2>当天句子</h2>${sentences.map(item => `<div class="notes-example"><span class="inline-english"><code>${escapeHtml(item.english)}</code>${speechButtonHtml(item.english, "播放句子发音")}</span><span>${escapeHtml(item.chinese)}</span></div>`).join("")}</section>` : "",
      patterns.length ? `<section class="notes-section"><h2>核心句型</h2>${patterns.map(pattern => `<div class="notes-pattern"><h3>${escapeHtml(pattern.title)}</h3><p>${escapeHtml(pattern.note)}</p>${(Array.isArray(pattern.examples) ? pattern.examples : []).map(example => `<div class="notes-example"><span class="inline-english"><code>${escapeHtml(example.english)}</code>${speechButtonHtml(example.english, "播放例句发音")}</span><span>${escapeHtml(example.chinese)}</span></div>`).join("")}</div>`).join("")}</section>` : "",
      mistakes.length ? `<section class="notes-section"><h2>易错点</h2>${listHtml(mistakes)}</section>` : "",
      `<div class="notes-review"><strong>复习重点：</strong>${escapeHtml(note.review || "复习当天单词、句子和发音提示。")}</div>`
    ].join("");
    $("#notesBody").innerHTML = body;
    refreshIcons();
  }

  function previewInlineHtml(value) {
    return String(value || "").split(/(`[^`\n]+`)/g).map(part => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return escapeHtml(part);
    }).join("");
  }

  function previewTableCells(value) {
    return String(value || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
  }

  function isPreviewTableDivider(value) {
    const cells = previewTableCells(value);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  function previewMarkdownHtml(value) {
    const lines = String(value || "").replace(/\r/g, "").split("\n");
    const output = [];
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed) { index += 1; continue; }

      if (trimmed.startsWith("```")) {
        const code = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) { code.push(lines[index]); index += 1; }
        if (index < lines.length) index += 1;
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        output.push(`<h${level}>${previewInlineHtml(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^-\s+/.test(trimmed)) {
        const items = [];
        while (index < lines.length && /^-\s+/.test(lines[index].trim())) {
          items.push(lines[index].trim().replace(/^-\s+/, ""));
          index += 1;
        }
        output.push(`<ul>${items.map(item => `<li>${previewInlineHtml(item)}</li>`).join("")}</ul>`);
        continue;
      }

      if (trimmed.includes("|") && index + 1 < lines.length && isPreviewTableDivider(lines[index + 1])) {
        const headers = previewTableCells(trimmed);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          rows.push(previewTableCells(lines[index]));
          index += 1;
        }
        output.push(`<div class="preview-table-wrap"><table class="preview-table"><thead><tr>${headers.map(cell => `<th>${previewInlineHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${previewInlineHtml(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      output.push(`<p>${previewInlineHtml(trimmed)}</p>`);
      index += 1;
    }
    return `<article class="preview-document">${output.join("")}</article>`;
  }

  function previewUpdatedLabel(value) {
    const date = new Date(String(value || ""));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function renderPreview() {
    const documents = Array.isArray(previewState.previews) ? previewState.previews : [];
    const selected = documents.find(document => document.name === selectedPreviewName) || previewState.preview || documents.at(-1) || null;
    if (selected) selectedPreviewName = selected.name;

    const picker = $("#previewHistoryPicker");
    const select = $("#previewHistorySelect");
    picker.hidden = documents.length < 2;
    select.replaceChildren(...documents.map(previewDocument => {
      const option = document.createElement("option");
      option.value = previewDocument.name;
      option.textContent = previewDocument.name.replace(/\.md$/i, "");
      return option;
    }));
    if (selected) select.value = selected.name;
    $("#refreshPreviewButton").disabled = previewState.loading;

    if (previewState.loading && !selected) {
      $("#previewStatus").textContent = "正在获取最新预习…";
      $("#previewBody").innerHTML = '<p class="empty-message">正在获取最新预习…</p>';
    } else if (previewState.error && !selected) {
      $("#previewStatus").textContent = "暂时无法获取预习";
      $("#previewBody").innerHTML = `<div class="preview-empty"><h2>预习暂不可用</h2><p>${escapeHtml(previewState.error)}</p><p>学习窗口生成预习并完成同步后，会自动显示在这里。</p></div>`;
    } else if (!selected) {
      $("#previewStatus").textContent = "还没有同步预习文件";
      $("#previewBody").innerHTML = '<div class="preview-empty"><h2>等待下一份预习</h2><p>学习窗口完成课程并生成预习后，网站会在同步完成后自动更新。</p></div>';
    } else {
      const updated = previewUpdatedLabel(previewState.updatedAt);
      $("#previewStatus").textContent = previewState.loading
        ? `正在检查更新 · 当前显示 ${selected.name.replace(/\.md$/i, "")}`
        : `${documents.length || 1} 份预习${updated ? ` · ${updated} 同步` : ""}`;
      $("#previewBody").innerHTML = previewMarkdownHtml(selected.content);
    }
    refreshIcons();
  }

  function renderPreviewWords() {
    const words = Array.isArray(previewWordsState.words) ? previewWordsState.words : [];
    const nextDay = Math.max(1, Number(previewWordsState.nextDay) || (Number(DATA.currentDay) || 1) + 1);
    const button = $("#refreshPreviewWordsButton");
    button.disabled = previewWordsState.loading;
    $("#previewWordsGrid").innerHTML = words.map(item => `
      <article class="preview-word-card">
        <header>
          <span class="type-badge">第 ${item.day} 天预习</span>
          ${speechButtonHtml(item.english, `慢速播放预习单词 ${item.english}`)}
        </header>
        <div class="preview-word-english"><code>${escapeHtml(item.english)}</code><span>${escapeHtml(item.phonetic || "等待正式课讲解")}</span></div>
        <div class="preview-word-meaning"><span>中文</span><strong>${escapeHtml(item.chinese)}</strong></div>
        <p>${escapeHtml(item.pronunciation || `先点击喇叭听 ${item.english}，正式课程会详细讲解发音。`)}</p>
      </article>
    `).join("");
    $("#previewWordsEmpty").hidden = words.length > 0 || previewWordsState.loading;

    if (previewWordsState.loading && !words.length) {
      $("#previewWordsStatus").textContent = `正在获取第 ${nextDay} 天预习单词…`;
    } else if (previewWordsState.error) {
      $("#previewWordsStatus").textContent = previewWordsState.error;
    } else if (!words.length) {
      $("#previewWordsStatus").textContent = `当前课程第 ${previewWordsState.currentDay} 天 · 第 ${nextDay} 天暂无未学新词`;
    } else {
      $("#previewWordsStatus").textContent = `当前课程第 ${previewWordsState.currentDay} 天 · 只显示第 ${nextDay} 天的 ${words.length} 个未学单词`;
    }
    refreshIcons();
  }

  function mistakeRows() {
    const seeded = DATA.seedMistakes.map(item => ({ ...item, seeded: true }));
    const dynamic = (model.mistakes || []).map(item => ({ ...item, seeded: false }));
    const seen = new Set();
    return [...dynamic.reverse(), ...seeded].filter(row => {
      if (!row.taskId || seen.has(row.taskId) || mistakeIsResolved(model.attempts, row.taskId)) return false;
      seen.add(row.taskId);
      row.correctStreak = mistakeCorrectStreak(model.attempts, row.taskId);
      return true;
    });
  }

  function renderMistakes() {
    const rows = mistakeRows();
    $("#mistakeCount").textContent = `${rows.length} 条`;
    $("#mistakeBody").innerHTML = rows.map(row => `<tr><td>${escapeHtml(row.prompt)}</td><td>${escapeHtml(row.userAnswer)}</td><td>${escapeHtml(row.correctAnswer)}</td><td class="day-cell">第 ${row.day} 天</td><td><span class="mistake-resolution-progress">连续答对 ${row.correctStreak}/${MISTAKE_AUTO_RESOLVE_STREAK}</span></td><td><button class="table-action" type="button" data-mistake-task="${escapeHtml(row.taskId)}">再练</button></td></tr>`).join("");
    $("#mistakeEmpty").hidden = rows.length > 0;
    $$('[data-mistake-task]').forEach(button => button.addEventListener("click", () => practiceMistakeQueue(button.dataset.mistakeTask)));
  }

  function renderProgress() {
    const stats = todayStats();
    $("#libraryTotal").textContent = String(learnedItems.length);
    const mastered = learnedItems.filter(item => (item.directions || ["en-zh"]).every(direction => taskState(`${item.id}:${direction}`).level >= 2)).length;
    $("#masteredTotal").textContent = String(mastered);
    $("#streakTotal").textContent = `${calculateStreak()} 天`;
    $("#updatedAtLabel").textContent = DATA.updatedAt;
    const days = Array.from({ length: 7 }, (_, index) => addDays(localDate(), index - 6));
    const max = Math.max(1, ...days.map(day => (model.history[day] || { reviewed: 0 }).reviewed));
    $("#weeklyChart").innerHTML = days.map(day => { const count = (model.history[day] || { reviewed: 0 }).reviewed; const height = Math.max(3, Math.round((count / max) * 100)); return `<div class="bar-column"><span class="bar-value">${count || ""}</span><div class="bar-track"><div class="bar-fill" style="height:${height}%"></div></div><span class="bar-day">${day.slice(5).replace("-", "/")}</span></div>`; }).join("");
    const dayRows = Array.from(new Set(learnedItems.map(item => item.day))).sort((a, b) => a - b).map(day => { const words = DATA.words.filter(item => !item.preview && item.day === day).length; const sentences = DATA.sentences.filter(item => !item.preview && item.day === day).length; const total = words + sentences; return { day, words, sentences, total }; });
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
    stopStudyClock("复习记录已重置", false);
    localStorage.removeItem(storageKey());
    model = loadModel();
    saveModel();
    renderHome(); renderAiView(); renderPreviewPractice(); renderMistakes(); renderProgress();
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
    $("#studyTimerButton").addEventListener("click", () => {
      if (studyClockRunning) stopStudyClock("手动暂停");
      else openCurrentStudyStage();
    });
    $("#studyPlanDockToggle").addEventListener("click", () => {
      if (studyClockRunning) stopStudyClock("手动暂停");
      else openCurrentStudyStage();
    });
    $("#studyPlanSteps").addEventListener("click", event => {
      const button = event.target.closest("[data-study-stage]");
      if (!button) return;
      const stage = currentStudyPlan().stages.find(item => item.id === button.dataset.studyStage);
      if (stage) openStudyStage(stage, stage.current);
    });
    ["pointerdown", "keydown", "touchstart", "input", "scroll"].forEach(type => document.addEventListener(type, markStudyActivity, { passive: true }));
    document.addEventListener("visibilitychange", handleStudyVisibility);
    window.addEventListener("pagehide", () => stopStudyClock("页面关闭", true));
    $$("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
    $$("[data-mode]").forEach(button => button.addEventListener("click", () => setReviewMode(button.dataset.mode)));
    $$("[data-library-type]").forEach(button => button.addEventListener("click", () => { libraryType = button.dataset.libraryType; libraryPage = 1; renderLibrary(); }));
    $("#librarySearch").addEventListener("input", () => { libraryPage = 1; renderLibrary(); });
    $("#dayFilter").addEventListener("change", () => { libraryPage = 1; renderLibrary(); });
    $("#libraryPageSize").addEventListener("change", () => { libraryPage = 1; renderLibrary(); });
    $("#libraryPrevPage").addEventListener("click", () => { libraryPage = Math.max(1, libraryPage - 1); renderLibrary(); });
    $("#libraryNextPage").addEventListener("click", () => { libraryPage += 1; renderLibrary(); });
    $$("[data-pronunciation-filter]").forEach(button => button.addEventListener("click", () => {
      pronunciationFilter = button.dataset.pronunciationFilter;
      renderPronunciation();
    }));
    $("#notesDaySelect").addEventListener("change", event => {
      notesDay = Number(event.target.value) || notesDay;
      renderNotes();
    });
    $("#previewHistorySelect").addEventListener("change", event => {
      selectedPreviewName = event.target.value;
      renderPreview();
    });
    $("#refreshPreviewButton").addEventListener("click", loadPreview);
    $("#refreshPreviewWordsButton").addEventListener("click", loadPreviewWords);
    $$('[data-preview-practice-mode]').forEach(button => button.addEventListener("click", () => setPreviewPracticeMode(button.dataset.previewPracticeMode)));
    $("#previewPracticeForm").addEventListener("submit", submitPreviewPractice);
    $("#previewPracticeNext").addEventListener("click", advancePreviewPractice);
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
    const aiTutorLaunchButton = $("#openAiTutorButton");
    aiTutorLaunchButton.addEventListener("click", event => {
      if (Date.now() < aiTutorLaunchSuppressClickUntil) {
        event.preventDefault();
        return;
      }
      openAiTutorWindow();
    });
    aiTutorLaunchButton.addEventListener("pointerdown", startAiTutorLaunchDrag);
    window.addEventListener("pointermove", moveAiTutorLaunchButton);
    window.addEventListener("pointerup", endAiTutorLaunchDrag);
    window.addEventListener("pointercancel", endAiTutorLaunchDrag);
    window.addEventListener("resize", constrainAiTutorLaunchPosition);
    window.addEventListener("orientationchange", constrainAiTutorLaunchPosition);
    $("#closeAiTutorButton").addEventListener("click", closeAiTutorWindow);
    $("#minimizeAiTutorButton").addEventListener("click", toggleAiTutorMinimize);
    $("#maximizeAiTutorButton").addEventListener("click", toggleAiTutorMaximize);
    $("#clearAiTutorButton").addEventListener("click", clearAiTutor);
    $("#aiTutorProvider").addEventListener("change", event => {
      const provider = availableAiTutorProviders().find(item => item.id === event.target.value);
      if (!provider) return;
      const practice = normalizeClientAiPractice(model.aiPractice);
      const modelName = provider.models.includes(practice.tutorSettings.model) ? practice.tutorSettings.model : provider.models[0] || "";
      updateAiTutorPreferences({ providerId: provider.id, model: modelName });
      renderAiTutorWindow();
    });
    $("#aiTutorModel").addEventListener("change", event => {
      updateAiTutorPreferences({ model: event.target.value });
      renderAiTutorWindow();
    });
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
    $("#examModelSelect").addEventListener("change", event => updateExamPreferences({ model: event.target.value }));
    $$('[data-exam-effort]').forEach(button => button.addEventListener("click", () => updateExamPreferences({ reasoningEffort: button.dataset.examEffort })));
    $$('[data-exam-points]').forEach(button => button.addEventListener("click", () => updateExamPreferences({ totalPoints: Number(button.dataset.examPoints) })));
    $("#examIncludeEssay").addEventListener("change", event => updateExamPreferences({ includeEssay: event.target.checked }));
    $("#examIncludeListening").addEventListener("change", event => updateExamPreferences({ includeListening: event.target.checked }));
    $("#generateExamButton").addEventListener("click", generateExam);
    $("#printExamButton").addEventListener("click", () => window.print());
    $("#openExamPhotoButton").addEventListener("click", () => $("#examPhotoInput").click());
    $("#examPhotoInput").addEventListener("change", selectExamPhotos);
    $("#cancelExamPhotoButton").addEventListener("click", clearExamPhotos);
    $("#gradeExamPhotoButton").addEventListener("click", gradeExamPhotos);
    $("#refreshAbilitiesButton").addEventListener("click", () => loadAbilities(true));
    $("#dictationModelSelect").addEventListener("change", event => updateDictationPreferences({ model: event.target.value }));
    $$('[data-dictation-effort]').forEach(button => button.addEventListener("click", () => updateDictationPreferences({ reasoningEffort: button.dataset.dictationEffort })));
    $("#dictationCount").addEventListener("change", event => updateDictationPreferences({ count: Number(event.target.value) }));
    $("#generateDictationButton").addEventListener("click", generateDictation);
    $("#dictationForm").addEventListener("input", updateDictationAnswer);
    $("#dictationForm").addEventListener("submit", submitDictation);
    $("#view-dictation").addEventListener("click", event => {
      const button = event.target.closest("[data-dictation-listen]");
      if (button) playDictationItem(button);
    });
    $("#focusedTypeSelect").addEventListener("change", event => updateFocusedPreferences({ focusedType: event.target.value }));
    $("#focusedModelSelect").addEventListener("change", event => updateFocusedPreferences({ model: event.target.value }));
    $$('[data-focused-effort]').forEach(button => button.addEventListener("click", () => updateFocusedPreferences({ reasoningEffort: button.dataset.focusedEffort })));
    $("#generateFocusedButton").addEventListener("click", generateFocusedPractice);
    $("#focusedForm").addEventListener("input", updateFocusedAnswer);
    $("#focusedForm").addEventListener("submit", submitFocusedPractice);
    $("#view-focused").addEventListener("click", event => {
      const button = event.target.closest("[data-focused-listen]");
      if (button) playFocusedListening(button);
    });
    $("#appBody").addEventListener("click", event => {
      const button = event.target.closest("[data-speak-text]");
      if (button) speakEnglish(button.dataset.speakText, button);
    });
    $("#examForm").addEventListener("input", event => {
      const article = event.target.closest("[data-exam-question]");
      if (article) article.classList.remove("is-unanswered");
      updateExamAnswer(event);
    });
    $("#examForm").addEventListener("submit", submitExam);
    $("#view-exam").addEventListener("click", event => {
      const jumpButton = event.target.closest("[data-exam-jump-question]");
      if (jumpButton) {
        jumpToExamQuestion(jumpButton.dataset.examJumpQuestion);
        return;
      }
      const button = event.target.closest("[data-exam-listen]");
      if (button) playExamListening(button.dataset.examId, button.dataset.examListen);
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
    if (API_ENABLED && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=37", { updateViaCache: "none" }).then(registration => registration.update()).catch(() => {});
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
  loadPreviewWords();
  refreshIcons();
  await loadAiOptions();
  await loadAiExams();
  syncRemoteState();
})();
