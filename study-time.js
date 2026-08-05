(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ENGLISH_REVIEW_STUDY_TIME = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STUDY_TIME_TARGET_SECONDS = 60 * 60;
  const STUDY_TIME_SCHEMA = 2;
  const MAX_DAILY_ENTRIES = 400;
  const MAX_SECONDS_PER_DAY = 24 * 60 * 60;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const DAILY_STUDY_PLAN = Object.freeze([
    Object.freeze({ id: "review", label: "旧知识复习", minutes: 10, view: "home", actionLabel: "直接开始做题" }),
    Object.freeze({ id: "phonics", label: "拼读与词汇", minutes: 15, view: "pronunciation", actionLabel: "开始发音教学", allowBackground: true }),
    Object.freeze({ id: "pattern", label: "句子结构", minutes: 10, view: "notes", actionLabel: "开始句型教学", allowBackground: true }),
    Object.freeze({ id: "reading", label: "阅读与翻译", minutes: 15, view: "ai", actionLabel: "生成并开始 5 题", allowBackground: true }),
    Object.freeze({ id: "correction", label: "测验与订正", minutes: 5, view: "home", actionLabel: "直接订正错题" }),
    Object.freeze({ id: "preview", label: "总结与预习", minutes: 5, view: "preview-practice", actionLabel: "直接开始预习题" })
  ]);

  function clampStudySeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 0;
    return Math.max(0, Math.min(MAX_SECONDS_PER_DAY, Math.floor(seconds)));
  }

  function emptyStageProgress() {
    return Object.fromEntries(DAILY_STUDY_PLAN.map(stage => [stage.id, 0]));
  }

  function normalizeStageProgress(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(DAILY_STUDY_PLAN.map(stage => {
      const targetSeconds = stage.minutes * 60;
      return [stage.id, Math.min(targetSeconds, clampStudySeconds(source[stage.id]))];
    }));
  }

  function distributeLegacyStudySeconds(value) {
    let remaining = Math.min(STUDY_TIME_TARGET_SECONDS, clampStudySeconds(value));
    return Object.fromEntries(DAILY_STUDY_PLAN.map(stage => {
      const targetSeconds = stage.minutes * 60;
      const elapsedSeconds = Math.min(targetSeconds, remaining);
      remaining = Math.max(0, remaining - elapsedSeconds);
      return [stage.id, elapsedSeconds];
    }));
  }

  function stageProgressTotal(value) {
    const progress = normalizeStageProgress(value);
    return DAILY_STUDY_PLAN.reduce((sum, stage) => sum + progress[stage.id], 0);
  }

  function normalizeStudyTime(value) {
    const source = value && typeof value === "object" ? value : {};
    const legacyDaily = Object.fromEntries(Object.entries(source.daily && typeof source.daily === "object" ? source.daily : {})
      .filter(([date]) => DATE_PATTERN.test(date))
      .map(([date, seconds]) => [date, clampStudySeconds(seconds)])
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-MAX_DAILY_ENTRIES));
    const rawStages = source.stages && typeof source.stages === "object" ? source.stages : {};
    const dates = Array.from(new Set([
      ...Object.keys(legacyDaily),
      ...Object.keys(rawStages).filter(date => DATE_PATTERN.test(date))
    ])).sort().slice(-MAX_DAILY_ENTRIES);
    const stages = {};
    const daily = {};
    dates.forEach(date => {
      const hasStageRecord = rawStages[date] && typeof rawStages[date] === "object";
      const progress = hasStageRecord ? normalizeStageProgress(rawStages[date]) : distributeLegacyStudySeconds(legacyDaily[date]);
      stages[date] = progress;
      daily[date] = stageProgressTotal(progress);
    });
    const selected = Object.fromEntries(Object.entries(source.selected && typeof source.selected === "object" ? source.selected : {})
      .filter(([date, stageId]) => DATE_PATTERN.test(date) && DAILY_STUDY_PLAN.some(stage => stage.id === stageId))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-MAX_DAILY_ENTRIES));
    return {
      schema: STUDY_TIME_SCHEMA,
      daily,
      stages,
      selected,
      updatedAt: String(source.updatedAt || "").slice(0, 40)
    };
  }

  function mergeStudyTime(local, remote) {
    const left = normalizeStudyTime(local);
    const right = normalizeStudyTime(remote);
    const dates = Array.from(new Set([...Object.keys(left.daily), ...Object.keys(right.daily)])).sort().slice(-MAX_DAILY_ENTRIES);
    const stages = Object.fromEntries(dates.map(date => {
      const leftStages = left.stages[date] || emptyStageProgress();
      const rightStages = right.stages[date] || emptyStageProgress();
      return [date, Object.fromEntries(DAILY_STUDY_PLAN.map(stage => [stage.id, Math.max(leftStages[stage.id], rightStages[stage.id])]))];
    }));
    const daily = Object.fromEntries(dates.map(date => [date, stageProgressTotal(stages[date])]));
    return {
      schema: STUDY_TIME_SCHEMA,
      daily,
      stages,
      selected: { ...right.selected, ...left.selected },
      updatedAt: left.updatedAt >= right.updatedAt ? left.updatedAt : right.updatedAt
    };
  }

  function studySecondsForDate(value, date) {
    const normalized = normalizeStudyTime(value);
    return normalized.daily[date] || 0;
  }

  function studyStageSecondsForDate(value, date) {
    const normalized = normalizeStudyTime(value);
    return normalized.stages[date] || emptyStageProgress();
  }

  function formatStudyDuration(value) {
    const seconds = clampStudySeconds(value);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function studyPlanProgress(value, date = "") {
    const normalized = typeof value === "number" ? null : normalizeStudyTime(value);
    const progress = typeof value === "number"
      ? distributeLegacyStudySeconds(value)
      : normalized.stages[date] || emptyStageProgress();
    const seconds = stageProgressTotal(progress);
    const requestedStageId = normalized && normalized.selected[date];
    const firstIncompleteId = DAILY_STUDY_PLAN.find(stage => progress[stage.id] < stage.minutes * 60)?.id || "";
    const selectedStageId = DAILY_STUDY_PLAN.some(stage => stage.id === requestedStageId && progress[stage.id] < stage.minutes * 60)
      ? requestedStageId
      : firstIncompleteId;
    const stages = DAILY_STUDY_PLAN.map((stage, index) => {
      const targetSeconds = stage.minutes * 60;
      const elapsedSeconds = progress[stage.id];
      return {
        ...stage,
        index,
        targetSeconds,
        elapsedSeconds,
        complete: elapsedSeconds >= targetSeconds,
        current: stage.id === selectedStageId,
        available: true
      };
    });
    return {
      seconds,
      complete: stages.every(stage => stage.complete),
      stages,
      currentStage: stages.find(stage => stage.current) || null
    };
  }

  return {
    DATE_PATTERN,
    DAILY_STUDY_PLAN,
    MAX_DAILY_ENTRIES,
    STUDY_TIME_SCHEMA,
    STUDY_TIME_TARGET_SECONDS,
    clampStudySeconds,
    distributeLegacyStudySeconds,
    emptyStageProgress,
    formatStudyDuration,
    mergeStudyTime,
    normalizeStageProgress,
    normalizeStudyTime,
    studyPlanProgress,
    studyStageSecondsForDate,
    studySecondsForDate
  };
});
