(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ENGLISH_REVIEW_STUDY_TIME = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STUDY_TIME_TARGET_SECONDS = 60 * 60;
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

  function normalizeStudyTime(value) {
    const source = value && typeof value === "object" ? value : {};
    const daily = Object.entries(source.daily && typeof source.daily === "object" ? source.daily : {})
      .filter(([date]) => DATE_PATTERN.test(date))
      .map(([date, seconds]) => [date, clampStudySeconds(seconds)])
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-MAX_DAILY_ENTRIES);
    return {
      daily: Object.fromEntries(daily),
      updatedAt: String(source.updatedAt || "").slice(0, 40)
    };
  }

  function mergeStudyTime(local, remote) {
    const left = normalizeStudyTime(local);
    const right = normalizeStudyTime(remote);
    const daily = { ...left.daily };
    Object.entries(right.daily).forEach(([date, seconds]) => {
      daily[date] = Math.max(Number(daily[date]) || 0, seconds);
    });
    const merged = Object.entries(daily)
      .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
      .slice(-MAX_DAILY_ENTRIES);
    return {
      daily: Object.fromEntries(merged),
      updatedAt: left.updatedAt >= right.updatedAt ? left.updatedAt : right.updatedAt
    };
  }

  function studySecondsForDate(value, date) {
    const normalized = normalizeStudyTime(value);
    return normalized.daily[date] || 0;
  }

  function formatStudyDuration(value) {
    const seconds = clampStudySeconds(value);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function studyPlanProgress(value) {
    const seconds = Math.min(STUDY_TIME_TARGET_SECONDS, clampStudySeconds(value));
    let boundary = 0;
    const stages = DAILY_STUDY_PLAN.map((stage, index) => {
      const targetSeconds = stage.minutes * 60;
      const startSeconds = boundary;
      const endSeconds = startSeconds + targetSeconds;
      boundary = endSeconds;
      const elapsedSeconds = Math.max(0, Math.min(targetSeconds, seconds - startSeconds));
      return {
        ...stage,
        index,
        targetSeconds,
        startSeconds,
        endSeconds,
        elapsedSeconds,
        complete: seconds >= endSeconds,
        current: seconds >= startSeconds && seconds < endSeconds
      };
    });
    return {
      seconds,
      complete: seconds >= STUDY_TIME_TARGET_SECONDS,
      stages,
      currentStage: stages.find(stage => stage.current) || null
    };
  }

  return {
    DATE_PATTERN,
    DAILY_STUDY_PLAN,
    MAX_DAILY_ENTRIES,
    STUDY_TIME_TARGET_SECONDS,
    clampStudySeconds,
    formatStudyDuration,
    mergeStudyTime,
    normalizeStudyTime,
    studyPlanProgress,
    studySecondsForDate
  };
});
