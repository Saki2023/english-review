(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_OFFLINE_AI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function clean(value, maximum = 180) {
    return String(value || "").trim().slice(0, maximum);
  }

  function randomId(environment, prefix) {
    const cryptoObject = environment && environment.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") return `${prefix}-${cryptoObject.randomUUID()}`;
    if (environment && typeof environment.randomUUID === "function") return `${prefix}-${environment.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function operationTime(pack, environment) {
    const current = environment && environment.now instanceof Date ? environment.now.getTime() : Date.now();
    const next = Math.max(current, Number(pack.localOutboxSequence) + 1 || 0);
    pack.localOutboxSequence = next;
    return next;
  }

  function currentPractice(pack) {
    if (!pack || typeof pack !== "object" || !pack.account || !clean(pack.account.id, 120)) throw new Error("当前账号离线包不可用");
    if (!pack.aiPractice || typeof pack.aiPractice !== "object") pack.aiPractice = {};
    const practice = pack.aiPractice;
    practice.preparedSets = Array.isArray(practice.preparedSets) ? practice.preparedSets : [];
    practice.generationQueue = Array.isArray(practice.generationQueue) ? practice.generationQueue : [];
    return practice;
  }

  function currentSetFor(practice, setId) {
    const set = practice.currentSet;
    if (!set || !Array.isArray(set.questions) || clean(set.id, 80) !== clean(setId, 80)) throw new Error("离线题组已经变化，请重新进入当前题组");
    return set;
  }

  function operation(pack, id, path, method, body, environment) {
    const timestamp = operationTime(pack, environment);
    return {
      id,
      accountId: clean(pack.account.id, 120),
      path,
      method,
      body: clone(body),
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      lastError: ""
    };
  }

  function touch(pack, practice, environment) {
    const now = environment && environment.now instanceof Date ? environment.now : new Date();
    const timestamp = now.toISOString();
    practice.updatedAt = timestamp;
    pack.localUpdatedAt = timestamp;
  }

  function cycleNumber(set) {
    return Math.max(1, Number(set.offlineReviewCycle) || 1);
  }

  function removePreparedMetadata(practice, setId) {
    const index = practice.generationQueue.findIndex(item => item && item.status === "ready" && (
      Array.isArray(item.groups) && item.groups.some(group => clean(group && group.id, 80) === setId)
      || !Array.isArray(item.groups) && Number(item.readyGroups) > 0
    ));
    if (index < 0) return;
    const item = practice.generationQueue[index];
    if (Array.isArray(item.groups)) item.groups = item.groups.filter(group => clean(group && group.id, 80) !== setId);
    item.readyGroups = Math.max(0, Number(item.readyGroups) - 1);
    if (!item.readyGroups || (Array.isArray(item.groups) && !item.groups.length)) practice.generationQueue.splice(index, 1);
  }

  function operateAiPractice(value, path, body = {}, environment = {}) {
    const pack = clone(value);
    const practice = currentPractice(pack);
    const suffix = clean(path, 40).replace(/^\//, "");
    const set = suffix === "next" ? practice.currentSet : currentSetFor(practice, body.setId);
    const now = environment.now instanceof Date ? environment.now : new Date();
    const nowIso = now.toISOString();
    let queuedOperation;
    let duplicate = false;

    if (suffix === "draft") {
      if (set.phase !== "answering") throw new Error("当前题组不在作答阶段");
      const index = Math.min(Math.max(Number(body.index) || 0, 0), set.questions.length - 1);
      const question = set.questions[index];
      if (body.questionId && clean(body.questionId, 80) !== clean(question.id, 80)) throw new Error("离线题目已经变化，请刷新后重试");
      question.userAnswer = clean(body.answer, 500);
      question.answeredAt = "";
      set.index = Object.hasOwn(body, "nextIndex") ? Math.min(Math.max(Number(body.nextIndex) || 0, 0), set.questions.length - 1) : index;
      set.offlineReviewCycle = cycleNumber(set);
      set.updatedAt = nowIso;
      set.lastError = "";
      const requestBody = { setId: set.id, questionId: question.id, index, nextIndex: set.index, answer: question.userAnswer };
      queuedOperation = operation(pack, `ai-draft:${set.id}:${set.offlineReviewCycle}:${question.id}`, "/api/ai/questions/batch/draft", "PUT", requestBody, environment);
    } else if (suffix === "review") {
      if (set.phase === "completed") throw new Error("题组已经完成批改");
      const missingIndex = set.questions.findIndex(question => !clean(question.userAnswer, 500));
      if (missingIndex >= 0) {
        set.phase = "answering";
        set.index = missingIndex;
        const error = new Error(`第 ${missingIndex + 1} 题还没有作答`);
        error.missingIndex = missingIndex;
        throw error;
      }
      set.offlineReviewCycle = cycleNumber(set);
      set.phase = "review";
      set.reviewOpenedAt ||= nowIso;
      set.gradeRequestId ||= randomId(environment, `aigrade-offline-${set.id}`);
      set.updatedAt = nowIso;
      set.lastError = "";
      queuedOperation = operation(pack, `ai-review:${set.id}:${set.offlineReviewCycle}`, "/api/ai/questions/batch/review", "POST", { setId: set.id, gradeRequestId: set.gradeRequestId }, environment);
    } else if (suffix === "edit") {
      if (set.phase === "completed") throw new Error("题组已经完成批改");
      if (set.offlineGradePending) throw new Error("整组答案已确认并等待联网批改，不能继续修改");
      set.offlineReviewCycle = cycleNumber(set) + 1;
      set.phase = "answering";
      set.index = Math.min(Math.max(Number(body.index) || 0, 0), set.questions.length - 1);
      set.updatedAt = nowIso;
      set.lastError = "";
      queuedOperation = operation(pack, `ai-edit:${set.id}:${set.offlineReviewCycle}`, "/api/ai/questions/batch/edit", "POST", { setId: set.id, index: set.index }, environment);
    } else if (suffix === "grade") {
      if (set.phase === "completed") throw new Error("题组已经完成批改");
      if (!["review", "grading"].includes(set.phase)) throw new Error("请先核对整组答案");
      set.gradeRequestId = clean(body.gradeRequestId || set.gradeRequestId, 180) || randomId(environment, `aigrade-offline-${set.id}`);
      duplicate = set.offlineGradePending === true;
      set.phase = "grading";
      set.offlineGradePending = true;
      set.gradingStartedAt ||= nowIso;
      set.updatedAt = nowIso;
      set.lastError = "整组答案已保存在本机，待联网后统一批改。";
      queuedOperation = operation(pack, `ai-grade:${set.gradeRequestId}`, "/api/ai/questions/batch/grade", "POST", { setId: set.id, gradeRequestId: set.gradeRequestId }, environment);
    } else if (suffix === "next") {
      if (!set || !["completed", "grading"].includes(set.phase) || (set.phase === "grading" && !set.offlineGradePending)) throw new Error("当前题组尚未确认并等待批改");
      const next = practice.preparedSets[0];
      if (!next || !Array.isArray(next.questions) || !next.questions.length) throw new Error("没有已下载的下一组题目；实时生成需要联网");
      const requestedSetId = clean(body.setId || next.id, 80);
      if (clean(next.id, 80) !== requestedSetId) throw new Error("下一组题目与离线队首快照不一致");
      practice.preparedSets.shift();
      removePreparedMetadata(practice, requestedSetId);
      practice.currentSet = {
        ...clone(next),
        phase: "answering",
        completed: false,
        index: Math.min(Math.max(Number(next.index) || 0, 0), Math.max(0, next.questions.length - 1)),
        offlineReviewCycle: 1,
        offlineGradePending: false,
        updatedAt: nowIso
      };
      const nextRequestId = clean(body.nextRequestId, 180) || `ainext-${requestedSetId}`;
      queuedOperation = operation(pack, `ai-next:${requestedSetId}`, "/api/ai/questions/next", "POST", { setId: requestedSetId, nextRequestId }, environment);
    } else {
      throw new Error("不支持的离线 AI 操作");
    }

    touch(pack, practice, environment);
    return { pack, practice: clone(practice), operation: queuedOperation, pendingOnline: true, duplicate, formalEvidence: false };
  }

  return { operateAiPractice };
});
