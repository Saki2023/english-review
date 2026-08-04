const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DAILY_STUDY_PLAN, STUDY_TIME_TARGET_SECONDS, formatStudyDuration, mergeStudyTime, normalizeStudyTime, studyPlanProgress, studySecondsForDate } = require("../study-time");

test("study time normalizes bounded daily records and formats the sixty-minute target", () => {
  const state = normalizeStudyTime({ daily: { "2026-08-04": 3599, invalid: 999, "2026-08-05": 999999 } });
  assert.equal(studySecondsForDate(state, "2026-08-04"), 3599);
  assert.equal(studySecondsForDate(state, "2026-08-05"), 86400);
  assert.equal(formatStudyDuration(STUDY_TIME_TARGET_SECONDS), "60:00");
});

test("study time merges accounts by the greatest recorded value for each day", () => {
  const merged = mergeStudyTime(
    { daily: { "2026-08-04": 1800, "2026-08-03": 1200 } },
    { daily: { "2026-08-04": 2400, "2026-08-02": 900 } }
  );
  assert.deepEqual(merged.daily, { "2026-08-02": 900, "2026-08-03": 1200, "2026-08-04": 2400 });
});

test("daily study plan is a sequential sixty-minute curriculum", () => {
  assert.equal(DAILY_STUDY_PLAN.length, 6);
  assert.equal(DAILY_STUDY_PLAN.reduce((sum, stage) => sum + stage.minutes * 60, 0), STUDY_TIME_TARGET_SECONDS);
  assert.deepEqual(DAILY_STUDY_PLAN.filter(stage => stage.allowBackground).map(stage => stage.id), ["phonics", "pattern", "reading"]);
  assert.deepEqual(DAILY_STUDY_PLAN.map(stage => stage.actionLabel), [
    "直接开始做题",
    "开始发音教学",
    "开始句型教学",
    "生成并开始 5 题",
    "直接订正错题",
    "直接开始预习题"
  ]);
  assert.deepEqual(DAILY_STUDY_PLAN.map(stage => stage.view), ["home", "pronunciation", "notes", "ai", "home", "preview-practice"]);
  const first = studyPlanProgress(0);
  assert.equal(first.currentStage.id, "review");
  assert.equal(first.currentStage.targetSeconds, 600);
  const middle = studyPlanProgress(600 + 900 + 600);
  assert.equal(middle.currentStage.id, "reading");
  assert.equal(middle.currentStage.elapsedSeconds, 0);
  const complete = studyPlanProgress(STUDY_TIME_TARGET_SECONDS);
  assert.equal(complete.complete, true);
  assert.equal(complete.currentStage, null);
  assert.equal(complete.stages.every(stage => stage.complete), true);
});
