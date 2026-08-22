(function (root, factory) {
  "use strict";
  const answerUtils = typeof module === "object" && module.exports ? require("./answer-utils") : (root && root.ENGLISH_REVIEW_ANSWER_UTILS);
  const api = factory(answerUtils || {});
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_OFFLINE_LEARNING = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ANSWER_UTILS) {
  "use strict";

  const QUESTION_TYPES = new Set(["choice", "short-answer", "en-zh", "zh-en", "reading-question", "correction"]);
  const ACTIVE_STATUSES = new Set(["in-progress", "paused", "ready"]);

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeEnglish(value) {
    if (typeof ANSWER_UTILS.normalizeEnglish === "function") return ANSWER_UTILS.normalizeEnglish(value);
    return String(value || "").toLowerCase().replace(/[“”‘’.,!?;:，。！？；：]/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeChinese(value) {
    if (typeof ANSWER_UTILS.normalizeChinese === "function") return ANSWER_UTILS.normalizeChinese(value);
    return String(value || "").replace(/[\s“”‘’.,!?;:，。！？；：、]/g, "").replace(/([上下里外前后])面/g, "$1").trim();
  }

  function answerKey(value) {
    const text = String(value || "");
    return /[a-z]/i.test(text) ? `en:${normalizeEnglish(text)}` : `zh:${normalizeChinese(text)}`;
  }

  function textEncoder() {
    if (typeof TextEncoder === "function") return new TextEncoder();
    throw new Error("当前浏览器不支持离线答案校验");
  }

  function bytesFromBase64(value) {
    if (typeof atob === "function") {
      const binary = atob(String(value || ""));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(String(value || ""), "base64"));
    throw new Error("当前浏览器不支持离线参考答案解锁");
  }

  function textFromBase64(value) {
    const bytes = bytesFromBase64(value);
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("utf8");
    return Array.from(bytes).map(byte => String.fromCharCode(byte)).join("");
  }

  function hex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(value => value.toString(16).padStart(2, "0")).join("");
  }

  async function digestText(value, cryptoProvider = globalThis.crypto) {
    if (!cryptoProvider || !cryptoProvider.subtle) throw new Error("当前浏览器不支持离线答案校验");
    return hex(await cryptoProvider.subtle.digest("SHA-256", textEncoder().encode(String(value))));
  }

  async function answerDigest(salt, answer, cryptoProvider = globalThis.crypto) {
    return digestText(`${salt}\0${answerKey(answer)}`, cryptoProvider);
  }

  async function unlockReference(step, answer, digest, cryptoProvider = globalThis.crypto) {
    const record = (Array.isArray(step.referenceUnlocks) ? step.referenceUnlocks : []).find(item => item && item.digest === digest);
    if (!record) return "";
    const keyBytes = await cryptoProvider.subtle.digest("SHA-256", textEncoder().encode(`${step.answerSalt}\0reference\0${answerKey(answer)}`));
    const key = await cryptoProvider.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const ciphertext = bytesFromBase64(record.ciphertext);
    const tag = bytesFromBase64(record.tag);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const clear = await cryptoProvider.subtle.decrypt({ name: "AES-GCM", iv: bytesFromBase64(record.iv), tagLength: 128 }, key, combined);
    return new TextDecoder().decode(clear);
  }

  function timestamp(now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? clone(value) : {};
    return {
      schema: Math.max(1, Number(source.schema) || 1),
      enabled: source.enabled === true,
      lessons: (Array.isArray(source.lessons) ? source.lessons : []).filter(lesson => lesson && lesson.lessonId && Array.isArray(lesson.stages)).slice(0, 60),
      progress: source.progress && typeof source.progress === "object" ? source.progress : {},
      schedule: source.schedule && typeof source.schedule === "object" ? source.schedule : { schema: 0, revision: "", timeZone: "Asia/Shanghai", synchronizedAt: "", entries: [] },
      clock: source.clock && typeof source.clock === "object" ? source.clock : null,
      updatedAt: String(source.updatedAt || ""),
      answerDigest: String(source.answerDigest || "sha256-answer-key-v1")
    };
  }

  function candidateFor(state, now = new Date()) {
    const active = Object.values(state.progress).find(progress => progress && ACTIVE_STATUSES.has(progress.status));
    if (active) return { progress: active, lesson: active.snapshot, waitingLesson: null };
    for (const lesson of state.lessons) {
      const progress = state.progress[lesson.lessonId];
      if (progress) continue;
      if (lesson.availability === "available") return { progress: null, lesson, waitingLesson: null, waitingReason: "" };
      const waitingReason = lesson.availability === "waiting"
        ? "not-enabled"
        : lesson.availability === "expired" ? "schedule-expired" : "schedule-unknown";
      return { progress: null, lesson: null, waitingLesson: lesson, waitingReason };
    }
    return { progress: null, lesson: null, waitingLesson: null };
  }

  function stepProgress(progress, stepId) {
    progress.steps ||= {};
    progress.steps[stepId] ||= { status: "unattempted", draft: "", attempts: [], questions: [], firstAttemptId: "", completedAt: "", continueIds: [], hintLevel: 0, assistance: "", hintReceipts: [], automaticSummary: null };
    const state = progress.steps[stepId];
    state.attempts = Array.isArray(state.attempts) ? state.attempts : [];
    state.questions = Array.isArray(state.questions) ? state.questions : [];
    state.continueIds = Array.isArray(state.continueIds) ? state.continueIds : [];
    state.hintLevel = Math.max(0, Math.min(3, Number(state.hintLevel) || 0));
    state.assistance = ["assisted", "revealed"].includes(state.assistance) ? state.assistance : "";
    state.hintReceipts = Array.isArray(state.hintReceipts) ? state.hintReceipts : [];
    return state;
  }

  function currentPosition(progress) {
    const stage = progress && progress.snapshot && progress.snapshot.stages && progress.snapshot.stages[progress.stageIndex];
    const step = stage && stage.steps && stage.steps[progress.stepIndex];
    return stage && step ? { stage, step } : null;
  }

  function touchProgress(progress, now = new Date()) {
    const value = timestamp(now);
    if (progress.status === "in-progress" && progress.lastActiveAt && Number.isFinite(Date.parse(progress.lastActiveAt))) {
      const elapsed = Math.max(0, Math.min(300, Math.floor((now.getTime() - Date.parse(progress.lastActiveAt)) / 1000)));
      progress.activeSeconds = Math.max(0, Number(progress.activeSeconds) || 0) + elapsed;
    }
    progress.lastActiveAt = progress.status === "paused" ? progress.lastActiveAt : value;
    progress.updatedAt = value;
  }

  function initializeProgress(lesson, now) {
    const value = timestamp(now);
    return {
      lessonId: lesson.lessonId,
      lessonVersion: lesson.version,
      status: "in-progress",
      startedAt: value,
      updatedAt: value,
      completedAt: "",
      pausedAt: "",
      pauseReason: "",
      activeSeconds: 0,
      lastActiveAt: value,
      stageIndex: 0,
      stepIndex: 0,
      snapshot: clone(lesson),
      steps: {},
      promotion: null,
      offlineOnly: true
    };
  }

  function advance(progress, now) {
    const position = currentPosition(progress);
    if (!position) return false;
    if (progress.stepIndex + 1 < position.stage.steps.length) {
      progress.stepIndex += 1;
      touchProgress(progress, now);
      return false;
    }
    if (progress.stageIndex + 1 < progress.snapshot.stages.length) {
      progress.stageIndex += 1;
      progress.stepIndex = 0;
      touchProgress(progress, now);
      return false;
    }
    progress.status = "pending-sync";
    progress.completedAt = timestamp(now);
    progress.updatedAt = progress.completedAt;
    progress.lastActiveAt = "";
    return true;
  }

  function publicAttempt(attempt, revealReference) {
    const safe = {
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
      assistance: attempt.assistance || "",
      hintLevel: Math.max(0, Number(attempt.hintLevel) || 0),
      formalEvidence: false
    };
    if (revealReference && attempt.referenceAnswer) safe.referenceAnswer = attempt.referenceAnswer;
    return safe;
  }

  function publicCurrentStep(progress) {
    const position = currentPosition(progress);
    if (!position) return null;
    const step = position.step;
    const state = stepProgress(progress, step.stepId);
    const completed = state.status === "completed";
    return {
      stepId: step.stepId,
      type: step.type,
      category: step.category,
      title: step.title,
      instruction: step.instruction,
      content: step.content,
      prompt: step.prompt,
      passage: step.passage,
      english: step.english,
      chinese: step.chinese,
      phonetic: step.phonetic,
      pronunciation: step.pronunciation,
      choices: clone(step.choices || []),
      direction: step.direction,
      focus: step.focus,
      formalEvidence: false,
      required: step.required !== false,
      status: state.status,
      draft: state.draft || "",
      attempts: state.attempts.map(attempt => publicAttempt(attempt, completed)),
      questions: clone(state.questions),
      hintLevel: state.hintLevel,
      hintMaxLevel: QUESTION_TYPES.has(step.type) ? 3 : 0,
      assistance: state.assistance,
      hints: clone((Array.isArray(step.hints) ? step.hints : []).slice(0, Math.min(2, state.hintLevel))),
      automaticSummary: clone(state.automaticSummary || (step.type === "summary" ? automaticSummary(progress, new Date(progress.updatedAt || Date.now())) : null)),
      ...((completed || state.hintLevel >= 3) ? { referenceAnswer: state.referenceAnswer || textFromBase64(step.referenceAnswerReveal || "") } : {})
    };
  }

  function publicSelfStudyState(value, now = new Date()) {
    const state = normalizeState(value);
    const candidate = candidateFor(state, now);
    const progress = candidate.progress;
    const completedLessons = Object.values(state.progress).filter(item => item && ["completed", "pending-sync"].includes(item.status)).length;
    const pendingSyncLessons = Object.values(state.progress).filter(item => item && item.status === "pending-sync").length;
    const current = progress ? {
      lessonId: progress.lessonId,
      lessonVersion: progress.lessonVersion,
      studyDay: progress.snapshot.studyDay,
      formalDate: progress.snapshot.formalDate || "",
      title: progress.snapshot.title,
      enabledFrom: progress.snapshot.enabledFrom || "",
      expiresAt: progress.snapshot.expiresAt || "",
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
        completedSteps: stage.steps.filter(step => stepProgress(progress, step.stepId).status === "completed").length,
        totalSteps: stage.steps.length,
        status: index < progress.stageIndex ? "completed" : index === progress.stageIndex ? progress.status : "locked"
      })),
      step: state.enabled ? publicCurrentStep(progress) : null,
      testSummary: null,
      nextPreview: ""
    } : null;
    return {
      enabled: state.enabled,
      hasLessons: state.lessons.length > 0 || Object.keys(state.progress).length > 0,
      entryVisible: Boolean(state.enabled && (progress || candidate.lesson)),
      lessonCount: state.lessons.length,
      completedLessons,
      pendingSyncLessons,
      current,
      availableLesson: !progress && candidate.lesson ? { lessonId: candidate.lesson.lessonId, studyDay: candidate.lesson.studyDay, formalDate: candidate.lesson.formalDate || "", title: candidate.lesson.title, version: candidate.lesson.version, enabledFrom: candidate.lesson.enabledFrom || "", expiresAt: candidate.lesson.expiresAt || "" } : null,
      waitingUntil: candidate.waitingLesson ? candidate.waitingLesson.enabledFrom : "",
      waitingReason: String(candidate.waitingReason || ""),
      schedule: {
        schema: Number(state.schedule && state.schedule.schema) || 0,
        revision: String(state.schedule && state.schedule.revision || ""),
        timeZone: String(state.schedule && state.schedule.timeZone || "Asia/Shanghai"),
        synchronizedAt: String(state.schedule && state.schedule.synchronizedAt || ""),
        status: state.lessons.some(lesson => !["available", "waiting", "expired"].includes(lesson.availability)) ? "incomplete" : "authoritative"
      },
      serverNow: String(state.clock && state.clock.serverNow || ""),
      updatedAt: state.updatedAt,
      offline: true
    };
  }

  function requireCurrent(state, body) {
    const progress = state.progress[String(body.lessonId || "")];
    if (!progress || !ACTIVE_STATUSES.has(progress.status)) throw new Error("离线课程步骤已经变化，请联网同步后重试");
    const position = currentPosition(progress);
    if (!position || position.step.stepId !== String(body.stepId || "")) throw new Error("离线课程步骤已经变化，请联网同步后重试");
    return { progress, step: position.step, stepState: stepProgress(progress, position.step.stepId) };
  }

  function findAttemptReceipt(state, attemptId) {
    for (const [lessonId, progress] of Object.entries(state.progress || {})) {
      for (const [stepId, savedStep] of Object.entries(progress && progress.steps || {})) {
        const attempt = (Array.isArray(savedStep && savedStep.attempts) ? savedStep.attempts : []).find(item => item && item.attemptId === attemptId);
        if (attempt) return { lessonId, stepId, attempt };
      }
    }
    return null;
  }

  function operationId(path, body = {}) {
    if (path === "/draft") return `self-draft:${body.lessonId}:${body.stepId}`;
    if (path === "/submit") return `self-submit:${body.attemptId}`;
    if (path === "/hint") return `self-hint:${body.hintId}`;
    if (path === "/continue") return `self-continue:${body.continueId}`;
    if (path === "/question") return `self-question:${body.questionId}`;
    if (path === "/start") return `self-start:${body.lessonId}`;
    if (path === "/mode") return `self-mode:${body.enabled === true ? "on" : "off"}:${body.requestId || Date.now()}`;
    if (["/pause", "/resume"].includes(path)) return `self-${path.slice(1)}:${body.lessonId}:${body.requestId || Date.now()}`;
    return `self-operation:${path}:${body.requestId || Date.now()}`;
  }

  function automaticSummary(progress, now = new Date()) {
    if (!progress || !progress.snapshot) return null;
    const questionSteps = progress.snapshot.stages.flatMap(stage => stage.steps).filter(step => QUESTION_TYPES.has(step.type));
    const rows = questionSteps.map(step => {
      const state = stepProgress(progress, step.stepId);
      const graded = state.attempts.filter(attempt => attempt.status === "graded");
      return { step, state, first: graded[0] || null, last: graded[graded.length - 1] || null };
    });
    const completed = rows.filter(row => row.state.status === "completed");
    const assisted = completed.filter(row => row.state.assistance === "assisted");
    const revealed = completed.filter(row => row.state.assistance === "revealed");
    const independent = completed.filter(row => !row.state.assistance && row.last && row.last.correct === true);
    const incorrect = rows.filter(row => row.first && row.first.correct !== true);
    const pending = rows.filter(row => row.state.status === "pending");
    const errorReasons = Array.from(new Set(incorrect.map(row => String(row.first && (row.first.detailedExplanation || row.first.explanation) || "").trim()).filter(Boolean))).slice(0, 8);
    const weakPoints = Array.from(new Set(incorrect.map(row => String(row.step.focus || row.step.title || row.step.category || "").trim()).filter(Boolean))).slice(0, 8);
    const words = Array.isArray(progress.snapshot.plannedContent && progress.snapshot.plannedContent.words) ? progress.snapshot.plannedContent.words.map(item => ({ id: item.id, english: item.english, chinese: item.chinese })) : [];
    const sentences = Array.isArray(progress.snapshot.plannedContent && progress.snapshot.plannedContent.sentences) ? progress.snapshot.plannedContent.sentences.map(item => ({ id: item.id, english: item.english, chinese: item.chinese })) : [];
    const nextReview = weakPoints.length ? `下次先复习：${weakPoints.join("、")}，并重新独立完成使用过提示或首答错误的题目。` : "下次按记忆曲线复习今天的新词，并在句子中再次独立回忆。";
    const text = [
      `今天学习了 ${words.length} 个新词、${sentences.length} 个新句型或句子。`,
      `实际完成 ${completed.length}/${questionSteps.length} 道题：独立完成 ${independent.length} 道，提示后完成 ${assisted.length} 道，看答案后完成 ${revealed.length} 道；首答错误 ${incorrect.length} 道。`,
      pending.length ? `${pending.length} 道仍等待联网判定，不计为错误。` : "没有等待判定的题目。",
      errorReasons.length ? `实际错因：${errorReasons.join("；")}。` : "本次没有已确认的错误，未练习内容没有被写成答错。",
      nextReview
    ].join("\n");
    return { schema: 1, source: "deterministic-offline", generatedAt: timestamp(now), lessonId: progress.lessonId, newWords: words, newSentences: sentences, completedQuestions: completed.length, totalQuestions: questionSteps.length, independentCorrect: independent.length, initiallyIncorrect: incorrect.length, corrected: incorrect.filter(row => row.state.status === "completed").length, assistedCompleted: assisted.length, revealedCompleted: revealed.length, pending: pending.length, unattempted: rows.filter(row => !row.first).length, errorReasons, weakPoints, nextReview, text, formalEvidence: false };
  }

  async function operateSelfStudy(packValue, path, body = {}, options = {}) {
    const pack = clone(packValue);
    if (!pack || !pack.account || !pack.selfStudy) throw new Error("当前账号没有可用离线课程");
    const cryptoProvider = options.crypto || globalThis.crypto;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const state = normalizeState(pack.selfStudy);
    let duplicate = false;
    let pendingOnline = false;
    let courseReadyToSync = false;
    let operationBody = clone(body);

    if (path === "/mode") {
      state.enabled = body.enabled === true;
      state.updatedAt = timestamp(now);
    } else if (path === "/start") {
      const lessonId = String(body.lessonId || "");
      if (!state.enabled) throw new Error("请先开启出门自学模式");
      if (state.progress[lessonId]) duplicate = true;
      else {
        const candidate = candidateFor(state, now);
        if (!candidate.lesson || candidate.lesson.lessonId !== lessonId) {
          const message = candidate.waitingReason === "schedule-unknown"
            ? "课程日期尚未由服务器确认，请联网同步后再开始"
            : candidate.waitingReason === "schedule-expired"
              ? "课程开放信息已过期，请联网续期后再开始"
              : "这一天的课程当前不可开始";
          throw new Error(message);
        }
        state.progress[lessonId] = initializeProgress(candidate.lesson, now);
        state.updatedAt = timestamp(now);
      }
    } else if (path === "/draft") {
      const { progress, stepState } = requireCurrent(state, body);
      stepState.draft = String(body.draft || "").slice(0, 2000);
      stepState.status = stepState.status === "unattempted" ? "draft" : stepState.status;
      touchProgress(progress, now);
    } else if (path === "/pause") {
      const progress = state.progress[String(body.lessonId || "")];
      if (!progress || !ACTIVE_STATUSES.has(progress.status)) throw new Error("当前没有可暂停的离线课程");
      if (progress.status === "paused") duplicate = true;
      progress.status = "paused";
      progress.pausedAt = timestamp(now);
      progress.pauseReason = String(body.reason || "用户主动暂停").slice(0, 500);
      touchProgress(progress, now);
    } else if (path === "/resume") {
      const progress = state.progress[String(body.lessonId || "")];
      if (!progress || !ACTIVE_STATUSES.has(progress.status)) throw new Error("当前没有可继续的离线课程");
      duplicate = progress.status === "in-progress";
      progress.status = "in-progress";
      progress.pausedAt = "";
      progress.pauseReason = "";
      touchProgress(progress, now);
    } else if (path === "/hint") {
      const { progress, step, stepState } = requireCurrent(state, body);
      if (!QUESTION_TYPES.has(step.type)) throw new Error("当前步骤没有提示");
      const hintId = String(body.hintId || "").trim();
      if (!hintId) throw new Error("离线提示缺少稳定标识");
      const requestedLevel = Math.max(1, Math.min(3, Number(body.level) || stepState.hintLevel + 1));
      const receipt = stepState.hintReceipts.find(item => item.id === hintId);
      if (receipt) {
        if (Number(receipt.level) !== requestedLevel) throw new Error("同一提示标识不能改写为其他层级");
        duplicate = true;
      } else {
        if (requestedLevel > stepState.hintLevel + 1) throw new Error("请按顺序查看提示");
        if (requestedLevel === 3 && body.confirmReveal !== true) throw new Error("查看完整答案前需要明确确认");
        stepState.hintLevel = Math.max(stepState.hintLevel, requestedLevel);
        stepState.assistance = requestedLevel >= 3 ? "revealed" : "assisted";
        stepState.hintReceipts.push({ id: hintId, level: requestedLevel, requestedAt: timestamp(now) });
        touchProgress(progress, now);
      }
    } else if (path === "/submit") {
      const attemptId = String(body.attemptId || "");
      if (!attemptId) throw new Error("离线作答缺少稳定提交标识");
      const lessonId = String(body.lessonId || "");
      const stepId = String(body.stepId || "");
      const answer = String(body.answer || "").trim().slice(0, 2000);
      const savedReceipt = findAttemptReceipt(state, attemptId);
      if (savedReceipt) {
        if (savedReceipt.lessonId !== lessonId || savedReceipt.stepId !== stepId || savedReceipt.attempt.answer !== answer) {
          throw new Error("该离线提交标识已用于不同课程、步骤或答案，请重新提交");
        }
        duplicate = true;
        operationBody = { ...operationBody, lessonId, stepId, answer: savedReceipt.attempt.answer, attemptId };
      }
      else {
        const { progress, step, stepState } = requireCurrent(state, body);
        if (step.type === "summary") {
          stepState.automaticSummary = automaticSummary(progress, now);
          operationBody = { ...operationBody, answer: stepState.automaticSummary && stepState.automaticSummary.text || "" };
        }
        if (step.required !== false && !["teach", "read-aloud", "summary"].includes(step.type) && !answer) {
          throw new Error("请先填写或选择答案");
        }
        const correction = stepState.attempts.some(attempt => attempt.status === "graded" && attempt.correct !== true);
        let attempt;
        if (!QUESTION_TYPES.has(step.type)) {
          const confirmationAnswer = step.type === "summary" ? (stepState.automaticSummary && stepState.automaticSummary.text || "") : answer;
          attempt = { attemptId, answer: confirmationAnswer, status: "graded", correct: true, score: 1, gradingStatus: "correct", explanation: step.type === "summary" ? "系统已根据实际作答生成总结。" : "当前教学内容已确认。", detailedExplanation: "当前教学内容已确认；正式学习证据将在联网同步成功后由服务器写入。", submittedAt: timestamp(now), gradedAt: timestamp(now), correction, formalEvidence: false, referenceAnswer: "", assistance: stepState.assistance, hintLevel: stepState.hintLevel };
          stepState.status = "completed";
          stepState.completedAt = timestamp(now);
          courseReadyToSync = advance(progress, now);
        } else if (step.gradingMode === "ai") {
          attempt = { attemptId, answer, status: "pending", correct: null, score: null, gradingStatus: "pending", explanation: "答案已保存在本机，等待联网后由 AI 判定。", detailedExplanation: "断网期间不会把这条答案记为正确或错误，也不会写入正式能力证据。", submittedAt: timestamp(now), gradedAt: "", correction, formalEvidence: false, referenceAnswer: "", assistance: stepState.assistance, hintLevel: stepState.hintLevel };
          stepState.status = "pending";
          pendingOnline = true;
        } else {
          const digest = await answerDigest(step.answerSalt, answer, cryptoProvider);
          const correct = (Array.isArray(step.answerDigests) ? step.answerDigests : []).includes(digest);
          const referenceAnswer = correct ? await unlockReference(step, answer, digest, cryptoProvider) : "";
          const hint = (Array.isArray(step.correctionHints) ? step.correctionHints : [])[Math.min(stepState.attempts.length, Math.max(0, (step.correctionHints || []).length - 1))] || "当前答案不正确，请重新检查题干后订正。";
          attempt = { attemptId, answer, status: "graded", correct, score: correct ? 1 : 0, gradingStatus: correct ? "correct" : "incorrect", explanation: correct ? "回答正确。" : hint, detailedExplanation: correct ? "回答正确；参考答案已在本机解锁，正式学习证据将在联网同步成功后由服务器写入。" : `${hint} 请修改后重新提交同一道题；不会提前显示完整答案。`, submittedAt: timestamp(now), gradedAt: timestamp(now), correction, formalEvidence: false, referenceAnswer, assistance: stepState.assistance, hintLevel: stepState.hintLevel };
          stepState.status = correct ? "completed" : "needs-correction";
          stepState.completedAt = correct ? timestamp(now) : "";
          if (correct) stepState.referenceAnswer = referenceAnswer;
        }
        stepState.draft = step.type === "summary" ? (stepState.automaticSummary && stepState.automaticSummary.text || "") : answer;
        stepState.firstAttemptId ||= attemptId;
        stepState.attempts.push(attempt);
        touchProgress(progress, now);
        operationBody = { ...operationBody, lessonId, stepId, answer: attempt.answer, attemptId };
      }
    } else if (path === "/continue") {
      const progress = state.progress[String(body.lessonId || "")];
      if (!progress || !ACTIVE_STATUSES.has(progress.status)) throw new Error("离线课程步骤已经变化，请联网同步后重试");
      const continueId = String(body.continueId || "");
      const receipts = Array.isArray(progress.continueIds) ? progress.continueIds : [];
      progress.continueIds = receipts;
      if (continueId && receipts.includes(continueId)) duplicate = true;
      else {
        const position = currentPosition(progress);
        if (!position || position.step.stepId !== String(body.stepId || "")) throw new Error("离线课程步骤已经变化，请联网同步后重试");
        const stateForStep = stepProgress(progress, position.step.stepId);
        if (stateForStep.status !== "completed") throw new Error("请先正确完成当前题目");
        if (continueId) receipts.push(continueId);
        courseReadyToSync = advance(progress, now);
      }
    } else if (path === "/question") {
      const { progress, stepState } = requireCurrent(state, body);
      const questionId = String(body.questionId || "");
      if (!questionId) throw new Error("离线提问缺少稳定标识");
      if (stepState.questions.some(item => item.id === questionId || item.questionId === questionId)) duplicate = true;
      else stepState.questions.push({ id: questionId, questionId, question: String(body.question || "").trim().slice(0, 500), answer: "", status: "pending", askedAt: timestamp(now), answeredAt: "", formalEvidence: false });
      touchProgress(progress, now);
      pendingOnline = true;
    } else {
      throw new Error("当前操作不支持离线保存");
    }

    state.updatedAt = timestamp(now);
    pack.selfStudy = state;
    pack.selfStudyPublic = publicSelfStudyState(state, now);
    pack.localUpdatedAt = timestamp(now);
    return {
      pack,
      selfStudy: pack.selfStudyPublic,
      duplicate,
      pendingOnline,
      courseReadyToSync,
      formalEvidence: false,
      operation: {
        id: operationId(path, body),
        accountId: String(pack.account.id || ""),
        path: `/api/self-study${path}`,
        method: path === "/draft" ? "PUT" : "POST",
        body: clone(operationBody),
        createdAt: Number(options.createdAt) || now.getTime(),
        updatedAt: now.getTime()
      }
    };
  }

  return {
    answerDigest,
    answerKey,
    normalizeState,
    operateSelfStudy,
    operationId,
    automaticSummary,
    publicSelfStudyState,
    unlockReference
  };
});
