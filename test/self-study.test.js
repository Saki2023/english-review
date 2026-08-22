"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  SELF_STUDY_SCHEDULE_ANCHOR_DATE,
  SELF_STUDY_SCHEDULE_ANCHOR_DAY,
  continueSelfStudyStep,
  currentLessonCandidate,
  localStepGrade,
  markLessonCompleted,
  mergeSelfStudyLessons,
  publicSelfStudyState,
  sanitizeSelfStudyLesson,
  sanitizeSelfStudyState,
  selfStudyHistory,
  selfStudyPreviewContent,
  selfStudyScheduledDate,
  startSelfStudyLesson,
  submitSelfStudyStep
} = require("../server/self-study");

const LEARNED_WORDS = ["it", "is", "a", "big", "cat", "sam", "man", "sat", "on", "mat"];

function question(stepId, category, overrides = {}) {
  return {
    stepId,
    type: "choice",
    category,
    prompt: "It is a cat.",
    choices: [
      { id: "A", text: "A" },
      { id: "B", text: "B" }
    ],
    acceptedAnswers: ["A"],
    correctionHint: "当前选择不正确，请再看一次题目。",
    ...overrides
  };
}

function lesson(version = "1", id = "trip-day-9", studyDay = 9) {
  return {
    lessonId: id,
    studyDay,
    title: `第 ${studyDay} 天完整自学课程`,
    version,
    enabledFrom: "2026-08-01T00:00:00.000Z",
    plannedContent: {
      words: [{ id: `d${studyDay}-dog`, english: "dog", chinese: "狗", phonetic: "/dɒɡ/", pronunciation: "道格", directions: ["en-zh", "zh-en"] }],
      sentences: [{ id: `d${studyDay}-dog-sentence`, english: "It is a dog.", chinese: "它是一只狗。", directions: ["en-zh", "zh-en"] }],
      note: { day: studyDay, summary: "学习 dog。", review: "复习 dog。" }
    },
    stages: [
      { stageId: "review", type: "review", title: "旧知识复习", steps: [question("review-1", "review")] },
      { stageId: "phonics", type: "phonics", title: "拼读与词汇", steps: [{ stepId: "teach-dog", type: "teach", content: "dog", phonetic: "/dɒɡ/", pronunciation: "道格" }] },
      { stageId: "pattern", type: "pattern", title: "句子结构", steps: [{ stepId: "teach-pattern", type: "teach", content: "It is a dog." }] },
      { stageId: "reading", type: "reading", title: "阅读与翻译", steps: [{ stepId: "read-dog", type: "read-aloud", content: "It is a dog." }] },
      {
        stageId: "test",
        type: "test",
        title: "测验与订正",
        steps: [
          question("test-p-1", "phonics"),
          question("test-p-2", "phonics"),
          question("test-ez-1", "en-zh", { type: "en-zh", direction: "en-zh", prompt: "dog", english: "dog", acceptedAnswers: ["狗"] }),
          question("test-ez-2", "en-zh", { type: "en-zh", direction: "en-zh", prompt: "It is a dog.", english: "It is a dog.", acceptedAnswers: ["它是一只狗"] }),
          question("test-ze-1", "zh-en", { type: "zh-en", direction: "zh-en", prompt: "狗", english: "dog", acceptedAnswers: ["dog"] }),
          question("test-ze-2", "zh-en", { type: "zh-en", direction: "zh-en", prompt: "它是一只狗。", english: "It is a dog.", acceptedAnswers: ["It is a dog."] }),
          question("test-r-1", "reading"),
          question("test-r-2", "reading"),
          question("test-r-3", "reading"),
          question("test-r-4", "reading")
        ]
      },
      { stageId: "summary", type: "summary", title: "总结与预习", steps: [{ stepId: "summary-1", type: "summary", prompt: "请用中文总结今天学到的内容。" }] }
    ],
    nextPreview: "下一课预习内容"
  };
}

function upload(lessons) {
  return mergeSelfStudyLessons(null, { updatedAt: "2026-08-07T00:00:00.000Z", lessons }, { learnedWords: LEARNED_WORDS }).state;
}

async function submit(state, answer, attemptId) {
  const current = publicSelfStudyState(state, new Date("2026-08-07T01:00:00.000Z")).current;
  return submitSelfStudyStep(state, {
    lessonId: current.lessonId,
    stepId: current.step.stepId,
    answer,
    attemptId
  }, { now: new Date("2026-08-07T01:00:00.000Z") });
}

function continueCurrent(state, continueId) {
  const current = publicSelfStudyState(state, new Date("2026-08-07T01:00:00.000Z")).current;
  return continueSelfStudyStep(state, { lessonId: current.lessonId, stepId: current.step.stepId, continueId }, new Date("2026-08-07T01:00:00.000Z"));
}

test("self-study lesson package enforces six stages, ten-test blueprint, and approved vocabulary", () => {
  const normalized = sanitizeSelfStudyLesson(lesson(), { learnedWords: LEARNED_WORDS });
  assert.equal(normalized.stages.length, 6);
  assert.equal(normalized.stages[4].steps.length, 10);
  assert.equal(normalized.plannedContent.words[0].status, "planned");
  assert.throws(() => sanitizeSelfStudyLesson({ ...lesson(), stages: lesson().stages.slice(0, 5) }, { learnedWords: LEARNED_WORDS }), /exactly six stages/);
  const unsafe = lesson();
  unsafe.stages[1].steps[0].content = "dog apple";
  assert.throws(() => sanitizeSelfStudyLesson(unsafe, { learnedWords: LEARNED_WORDS }), /unapproved English words: apple/);
});

test("self-study stores natural deep references and repairs a legacy false answer", () => {
  const source = lesson();
  source.plannedContent.sentences[0] = {
    id: "d9-deep-pool",
    english: "We see a deep pool.",
    chinese: "我们看见一个深的水池。",
    acceptedChinese: ["我们看见一个深的水池。"],
    directions: ["en-zh", "zh-en"]
  };
  const rawStep = source.stages[4].steps.find(step => step.stepId === "test-ez-2");
  Object.assign(rawStep, {
    prompt: "We see a deep pool.",
    english: "We see a deep pool.",
    acceptedAnswers: ["我们看见一个深的水池。"]
  });
  const learnedWords = [...LEARNED_WORDS, "we", "see", "deep", "pool"];
  const normalized = sanitizeSelfStudyLesson(source, { learnedWords });
  assert.equal(normalized.plannedContent.sentences[0].chinese, "我们看见一个很深的水池。");
  assert.ok(normalized.plannedContent.sentences[0].acceptedChinese.includes("我们看见一个很深的游泳池。"));
  const step = normalized.stages[4].steps.find(item => item.stepId === "test-ez-2");
  assert.equal(step.referenceAnswer, "我们看见一个很深的水池。");
  assert.equal(localStepGrade(step, "我们看见一个很深的游泳池").score, 1);

  const restored = sanitizeSelfStudyState({
    enabled: true,
    lessons: [source],
    progress: {
      [source.lessonId]: {
        lessonVersion: source.version,
        status: "in-progress",
        snapshot: source,
        stageIndex: 4,
        stepIndex: 3,
        steps: {
          "test-ez-2": {
            status: "needs-correction",
            firstAttemptId: "legacy-deep-attempt",
            attempts: [{
              attemptId: "legacy-deep-attempt",
              answer: "我们看见一个很深的游泳池",
              status: "graded",
              correct: false,
              score: 0,
              gradingStatus: "incorrect",
              explanation: "多写了很。",
              detailedExplanation: "请删除很。",
              problemWords: ["deep"],
              submittedAt: "2026-08-08T01:00:00.000Z",
              gradedAt: "2026-08-08T01:00:01.000Z",
              formalEvidence: true,
              referenceAnswer: "我们看见一个深的水池。"
            }]
          }
        }
      }
    }
  });
  const repairedProgress = restored.progress[source.lessonId].steps["test-ez-2"];
  assert.equal(repairedProgress.status, "completed");
  assert.equal(repairedProgress.attempts[0].correct, true);
  assert.equal(repairedProgress.attempts[0].score, 1);
  assert.equal(repairedProgress.attempts[0].formalEvidence, true);
  assert.deepEqual(repairedProgress.attempts[0].problemWords, []);
  assert.doesNotMatch(`${repairedProgress.attempts[0].explanation} ${repairedProgress.attempts[0].detailedExplanation}`, /多写了很|删除很/);
});

test("later planned lessons may reuse words introduced by an earlier planned lesson but not unknown words", () => {
  const dayNine = lesson("1", "trip-day-9", 9);
  const dayTen = lesson("1", "trip-day-10", 10);
  dayTen.plannedContent.words = [{ id: "d10-hen", english: "hen", chinese: "母鸡", phonetic: "/hen/", pronunciation: "汉", directions: ["en-zh", "zh-en"] }];

  const together = mergeSelfStudyLessons(null, { lessons: [dayTen, dayNine] }, { learnedWords: LEARNED_WORDS }).state;
  assert.deepEqual(together.lessons.map(item => item.lessonId), ["trip-day-9", "trip-day-10"]);

  const dayNineOnly = mergeSelfStudyLessons(null, { lessons: [dayNine] }, { learnedWords: LEARNED_WORDS }).state;
  const sequential = mergeSelfStudyLessons(dayNineOnly, { lessons: [dayTen] }, { learnedWords: LEARNED_WORDS }).state;
  assert.equal(sequential.lessons[1].plannedContent.sentences[0].english, "It is a dog.");

  const unsafeDayTen = structuredClone(dayTen);
  unsafeDayTen.stages[1].steps[0].content = "dog apple";
  assert.throws(
    () => mergeSelfStudyLessons(dayNineOnly, { lessons: [unsafeDayTen] }, { learnedWords: LEARNED_WORDS }),
    /unapproved English words: apple/
  );
});

test("self-study schedule anchors day 12 on 2026-08-18 and keeps day 10/11 dates", () => {
  assert.equal(SELF_STUDY_SCHEDULE_ANCHOR_DAY, 12);
  assert.equal(SELF_STUDY_SCHEDULE_ANCHOR_DATE, "2026-08-18");
  assert.equal(selfStudyScheduledDate(11), "");
  assert.equal(selfStudyScheduledDate(12), "2026-08-18");
  assert.equal(selfStudyScheduledDate(13), "2026-08-19");

  const day10 = lesson("1", "trip-day-10", 10);
  day10.formalDate = "2026-08-09";
  day10.enabledFrom = "2026-08-09T00:00:00+08:00";
  day10.plannedContent.note.date = "2026-08-09";
  const day11 = lesson("1", "trip-day-11", 11);
  day11.formalDate = "2026-08-10";
  day11.enabledFrom = "2026-08-10T00:00:00+08:00";
  day11.plannedContent.note.date = "2026-08-10";
  const day12 = lesson("1", "trip-day-12", 12);
  day12.formalDate = "2026-08-11";
  day12.enabledFrom = "2026-08-11T00:00:00+08:00";
  day12.expiresAt = "2026-09-10T23:59:59+08:00";
  day12.plannedContent.note.date = "2026-08-11";
  const day13 = lesson("1", "trip-day-13", 13);
  day13.formalDate = "2026-08-12";
  day13.enabledFrom = "2026-08-12T00:00:00+08:00";
  day13.expiresAt = "2026-09-10T23:59:59+08:00";
  day13.plannedContent.note.date = "2026-08-12";

  const state = upload([day10, day11, day12, day13]);
  const dates = new Map(state.lessons.map(item => [item.lessonId, item]));
  assert.equal(dates.get("trip-day-10").formalDate, "2026-08-09");
  assert.equal(dates.get("trip-day-11").formalDate, "2026-08-10");
  assert.equal(dates.get("trip-day-12").formalDate, "2026-08-18");
  assert.equal(dates.get("trip-day-12").enabledFrom, "2026-08-17T16:00:00.000Z");
  assert.equal(dates.get("trip-day-12").expiresAt, "2026-09-17T15:59:59.000Z");
  assert.equal(dates.get("trip-day-12").plannedContent.note.date, "2026-08-18");
  assert.equal(dates.get("trip-day-13").formalDate, "2026-08-19");
  assert.equal(dates.get("trip-day-13").enabledFrom, "2026-08-18T16:00:00.000Z");
  assert.equal(dates.get("trip-day-13").expiresAt, "2026-09-17T15:59:59.000Z");
  assert.equal(dates.get("trip-day-13").plannedContent.note.date, "2026-08-19");

  const preview = selfStudyPreviewContent(state, new Date("2026-08-17T12:00:00.000Z"));
  assert.equal(preview.lessonId, "trip-day-10");
  assert.equal(preview.formalDate, "2026-08-09");
  assert.equal(preview.formalEvidence, false);
  assert.equal(preview.words[0].status, "planned");
});

test("date normalization is idempotent and preserves completed historical snapshots", () => {
  const day12 = lesson("1", "trip-day-12-history", 12);
  day12.formalDate = "2026-08-11";
  day12.enabledFrom = "2026-08-11T00:00:00+08:00";
  day12.expiresAt = "2026-09-10T23:59:59+08:00";
  day12.plannedContent.note.date = "2026-08-11";
  const legacySnapshot = sanitizeSelfStudyLesson(day12, { skipVocabularyValidation: true });
  const state = {
    enabled: true,
    lessons: [day12],
    progress: {
      [day12.lessonId]: {
        lessonId: day12.lessonId,
        lessonVersion: day12.version,
        status: "completed",
        completedAt: "2026-08-11T02:00:00.000Z",
        snapshot: legacySnapshot,
        steps: {}
      }
    }
  };

  const replacement = structuredClone(day12);
  replacement.formalDate = "2026-08-11";
  replacement.enabledFrom = "2026-08-11T00:00:00+08:00";
  replacement.expiresAt = "2026-09-10T23:59:59+08:00";
  replacement.plannedContent.note.date = "2026-08-11";
  const merged = mergeSelfStudyLessons(state, { lessons: [replacement] }, { learnedWords: LEARNED_WORDS }).state;
  assert.equal(merged.lessons[0].formalDate, "2026-08-11");
  assert.equal(merged.lessons[0].enabledFrom, "2026-08-10T16:00:00.000Z");
  assert.equal(merged.lessons[0].plannedContent.note.date, "2026-08-11");
  assert.equal(merged.progress[day12.lessonId].snapshot.formalDate, "2026-08-11");

  const pending = lesson("1", "trip-day-13-pending", 13);
  pending.formalDate = "2026-08-12";
  pending.enabledFrom = "2026-08-12T00:00:00+08:00";
  pending.expiresAt = "2026-09-10T23:59:59+08:00";
  pending.publishedAt = "2026-08-07T00:00:00+08:00";
  pending.plannedContent.note.date = "2026-08-12";
  const first = mergeSelfStudyLessons(merged, { lessons: [pending] }, { learnedWords: LEARNED_WORDS }).state;
  const second = mergeSelfStudyLessons(first, { lessons: [pending] }, { learnedWords: LEARNED_WORDS }).state;
  assert.deepEqual(second.lessons.find(item => item.lessonId === pending.lessonId), first.lessons.find(item => item.lessonId === pending.lessonId));
  assert.equal(second.lessons.find(item => item.lessonId === pending.lessonId).formalDate, "2026-08-19");
});

test("self-study unlock boundaries follow the anchored dates and preview stays planned", () => {
  const lessons = [10, 11, 12, 13].map(day => lesson("1", `trip-day-boundary-${day}`, day));
  let state = upload(lessons);
  const completed = day => {
    const source = state.lessons.find(item => item.studyDay === day);
    return {
      lessonId: source.lessonId,
      lessonVersion: source.version,
      status: "completed",
      completedAt: "2026-08-16T00:00:00.000Z",
      snapshot: structuredClone(source),
      steps: {}
    };
  };
  state.progress["trip-day-boundary-10"] = completed(10);
  state.progress["trip-day-boundary-11"] = completed(11);

  let candidate = currentLessonCandidate(state, new Date("2026-08-17T15:59:59.000Z"));
  assert.equal(candidate.lesson, null);
  assert.equal(candidate.waitingLesson.lessonId, "trip-day-boundary-12");
  const waitingPreview = selfStudyPreviewContent(state, new Date("2026-08-17T15:59:59.000Z"));
  assert.equal(waitingPreview.lessonId, "trip-day-boundary-12");
  assert.equal(waitingPreview.formalDate, "2026-08-18");
  assert.equal(waitingPreview.formalEvidence, false);
  candidate = currentLessonCandidate(state, new Date("2026-08-17T16:00:00.000Z"));
  assert.equal(candidate.lesson.lessonId, "trip-day-boundary-12");

  state.progress["trip-day-boundary-12"] = completed(12);
  candidate = currentLessonCandidate(state, new Date("2026-08-18T15:59:59.000Z"));
  assert.equal(candidate.lesson, null);
  assert.equal(candidate.waitingLesson.lessonId, "trip-day-boundary-13");
  candidate = currentLessonCandidate(state, new Date("2026-08-18T16:00:00.000Z"));
  assert.equal(candidate.lesson.lessonId, "trip-day-boundary-13");
});

test("authoritative schedule persists and never skips an unfinished course day", () => {
  const day15 = lesson("1", "trip-day-015", 15);
  day15.formalDate = "2026-08-21";
  day15.enabledFrom = "2026-08-20T16:00:00.000Z";
  day15.expiresAt = "2026-08-21T16:00:00.000Z";
  const day16 = lesson("1", "trip-day-016", 16);
  day16.formalDate = "2026-08-22";
  day16.enabledFrom = "2026-08-21T16:00:00.000Z";
  day16.expiresAt = "2026-09-22T16:00:00.000Z";
  const state = mergeSelfStudyLessons(null, {
    updatedAt: "2026-08-20T00:00:00.000Z",
    scheduleRevision: "course-days-15-17-v1",
    lessons: [day15, day16]
  }, { learnedWords: LEARNED_WORDS }).state;
  assert.equal(state.schema, 2);
  assert.equal(state.schedule.revision, "course-days-15-17-v1");
  assert.equal(state.schedule.timeZone, "Asia/Shanghai");
  assert.deepEqual(sanitizeSelfStudyState(state).schedule, state.schedule);

  const candidate = currentLessonCandidate(state, new Date("2026-08-22T12:00:00.000Z"));
  assert.equal(candidate.lesson, null);
  assert.equal(candidate.waitingLesson.lessonId, "trip-day-015");
  assert.equal(candidate.waitingReason, "schedule-expired");
  assert.notEqual(candidate.waitingLesson.lessonId, "trip-day-016");

  const unknown = lesson("1", "home-course-018", 18);
  unknown.formalDate = "";
  unknown.enabledFrom = "";
  unknown.expiresAt = "";
  const unknownState = mergeSelfStudyLessons(null, { updatedAt: "2026-08-22T00:00:00.000Z", scheduleRevision: "home-v1", lessons: [unknown] }, { learnedWords: LEARNED_WORDS }).state;
  const unknownCandidate = currentLessonCandidate(unknownState, new Date("2036-08-22T12:00:00.000Z"));
  assert.equal(unknownCandidate.lesson, null);
  assert.equal(unknownCandidate.waitingLesson.lessonId, "home-course-018");
  assert.equal(unknownCandidate.waitingReason, "schedule-unknown");
});

test("completed day 10 through 14 history keeps its dates and selects day 15 without calendar auto-advance", () => {
  const dates = {
    10: "2026-08-09",
    11: "2026-08-10",
    12: "2026-08-18",
    13: "2026-08-19",
    14: "2026-08-20",
    15: "2026-08-21",
    16: "2026-08-22",
    17: "2026-08-23"
  };
  const lessons = Object.entries(dates).map(([dayText, formalDate]) => {
    const studyDay = Number(dayText);
    const item = lesson("1", `trip-day-${String(studyDay).padStart(3, "0")}`, studyDay);
    item.formalDate = formalDate;
    item.enabledFrom = new Date(`${formalDate}T00:00:00+08:00`).toISOString();
    item.expiresAt = "2026-09-30T15:59:59.000Z";
    item.plannedContent.note.date = formalDate;
    return item;
  });
  const state = mergeSelfStudyLessons(null, {
    updatedAt: "2026-08-20T12:00:00.000Z",
    scheduleRevision: "returned-home-authoritative-v1",
    lessons
  }, { learnedWords: LEARNED_WORDS }).state;
  for (const studyDay of [10, 11, 12, 13, 14]) {
    const item = state.lessons.find(value => value.studyDay === studyDay);
    state.progress[item.lessonId] = {
      lessonId: item.lessonId,
      lessonVersion: item.version,
      status: "completed",
      startedAt: studyDay === 11 ? "2026-08-17T01:00:00.000Z" : `${dates[studyDay]}T01:00:00.000Z`,
      updatedAt: `${dates[studyDay]}T02:00:00.000Z`,
      completedAt: `${dates[studyDay]}T02:00:00.000Z`,
      pausedAt: "",
      pauseReason: "",
      activeSeconds: 3600,
      lastActiveAt: `${dates[studyDay]}T02:00:00.000Z`,
      stageIndex: 5,
      stepIndex: 1,
      snapshot: structuredClone(item),
      steps: {},
      promotion: null
    };
  }

  const normalized = sanitizeSelfStudyState(state);
  assert.equal(normalized.progress["trip-day-011"].snapshot.formalDate, "2026-08-10");
  assert.equal(normalized.progress["trip-day-011"].startedAt, "2026-08-17T01:00:00.000Z");
  assert.equal(Object.hasOwn(normalized.progress, "trip-day-015"), false);
  assert.equal(Object.hasOwn(normalized.progress, "trip-day-016"), false);

  const now = new Date("2026-08-22T08:00:00.000Z");
  const candidate = currentLessonCandidate(normalized, now);
  assert.equal(candidate.lesson.lessonId, "trip-day-015");
  const preview = selfStudyPreviewContent(normalized, now);
  assert.equal(preview.nextDay, 15);
  assert.equal(preview.lessonId, "trip-day-015");
  assert.equal(preview.formalEvidence, false);
});

test("active legacy snapshots use the anchored schedule without changing answers or evidence", () => {
  const source = lesson("1", "trip-day-active-legacy", 12);
  source.formalDate = "2026-08-11";
  source.enabledFrom = "2026-08-11T00:00:00+08:00";
  source.expiresAt = "2026-09-10T23:59:59+08:00";
  source.plannedContent.note.date = "2026-08-11";
  let state = upload([source]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-18T00:00:00.000Z"));
  const snapshot = state.progress[source.lessonId].snapshot;
  snapshot.formalDate = "2026-08-11";
  snapshot.enabledFrom = "2026-08-11T00:00:00+08:00";
  snapshot.expiresAt = "2026-09-10T23:59:59+08:00";
  snapshot.plannedContent.note.date = "2026-08-11";

  const preview = selfStudyPreviewContent(state, new Date("2026-08-18T00:00:00.000Z"));
  assert.equal(preview.formalDate, "2026-08-18");
  assert.equal(preview.enabledFrom, "2026-08-17T16:00:00.000Z");
  assert.equal(preview.note.date, "2026-08-18");
  const publicState = publicSelfStudyState(state, new Date("2026-08-18T00:00:00.000Z"));
  assert.equal(publicState.current.formalDate, "2026-08-18");
  assert.equal(publicState.current.enabledFrom, "2026-08-17T16:00:00.000Z");
  const history = selfStudyHistory(state);
  assert.equal(history.lessons[0].formalDate, "2026-08-18");
  assert.equal(history.lessons[0].plannedContent.note.date, "2026-08-18");
  assert.equal(state.progress[source.lessonId].snapshot.formalDate, "2026-08-11");
  assert.equal(state.progress[source.lessonId].snapshot.stages[0].steps[0].acceptedAnswers[0], "A");
});

test("public self-study state shows only the current step and never leaks an unanswered reference", () => {
  let state = upload([lesson(), lesson("1", "trip-day-10", 10)]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-07T00:00:00.000Z"));
  const visible = publicSelfStudyState(state, new Date("2026-08-07T00:00:01.000Z"));
  assert.equal(visible.current.lessonId, "trip-day-9");
  assert.equal(visible.current.step.stepId, "review-1");
  assert.equal(Object.hasOwn(visible.current.step, "acceptedAnswers"), false);
  assert.equal(Object.hasOwn(visible.current.step, "referenceAnswer"), false);
  assert.equal(JSON.stringify(visible).includes('"trip-day-10"'), false);
});

test("wrong first answer stays on the same question and correction preserves the original score", async () => {
  let state = upload([lesson()]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-07T00:00:00.000Z"));

  let result = await submit(state, "A", "review-correct");
  state = result.state;
  state = continueCurrent(state, "continue-review").state;
  for (const attemptId of ["teach", "pattern", "read"]) {
    result = await submit(state, "已完成", attemptId);
    state = result.state;
  }
  assert.equal(publicSelfStudyState(state).current.step.stepId, "test-p-1");

  result = await submit(state, "B", "test-first-wrong");
  state = result.state;
  let visible = publicSelfStudyState(state);
  assert.equal(visible.current.step.stepId, "test-p-1");
  assert.equal(visible.current.step.status, "needs-correction");
  assert.equal(Object.hasOwn(visible.current.step, "referenceAnswer"), false);
  assert.match(visible.current.step.attempts[0].explanation, /选择不正确/);

  result = await submit(state, "A", "test-correction");
  state = result.state;
  assert.equal(publicSelfStudyState(state).current.step.stepId, "test-p-1");
  state = continueCurrent(state, "continue-corrected").state;
  assert.equal(publicSelfStudyState(state).current.step.stepId, "test-p-2");

  const answers = ["A", "狗", "它是一只狗", "dog", "It is a dog.", "A", "A", "A", "A"];
  for (let index = 0; index < answers.length; index += 1) {
    result = await submit(state, answers[index], `remaining-${index}`);
    state = result.state;
    state = continueCurrent(state, `continue-remaining-${index}`).state;
  }
  result = await submit(state, "我学会了 dog 和 It is a dog。", "summary");
  state = result.state;
  assert.equal(result.completionReady, true);
  const beforePromotion = selfStudyHistory(state);
  assert.deepEqual(beforePromotion.lessons[0].testSummary, { total: 10, firstScore: 9, firstCorrect: 9, corrected: 1, pending: 0, unattempted: 0 });

  state = markLessonCompleted(state, "trip-day-9", { learnedAt: "2026-08-07T02:00:00.000Z", firstReviewDue: "2026-08-08", contentIds: ["d9-dog", "d9-dog-sentence"] }, new Date("2026-08-07T02:00:00.000Z"));
  const history = selfStudyHistory(state);
  assert.equal(history.lessons[0].status, "completed");
  assert.equal(history.lessons[0].stages[4].steps[0].firstAttempt.answer, "B");
  assert.equal(history.lessons[0].stages[4].steps[0].corrections[0].answer, "A");
  assert.equal(history.lessons[0].plannedContent.status, "learned");
});

test("stable attemptId is idempotent and cannot be reused with another answer", async () => {
  let state = upload([lesson()]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-07T00:00:00.000Z"));
  const first = await submit(state, "A", "same-attempt");
  const replay = await submitSelfStudyStep(first.state, { lessonId: "trip-day-9", stepId: "review-1", answer: "A", attemptId: "same-attempt" });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.progress["trip-day-9"].steps["review-1"].attempts.length, 1);
  await assert.rejects(() => submitSelfStudyStep(first.state, { lessonId: "trip-day-9", stepId: "review-1", answer: "B", attemptId: "same-attempt" }), /not current|different answer/);
});

test("started lesson keeps its immutable snapshot when a later upload changes the catalog version", () => {
  let state = upload([lesson("1")]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-07T00:00:00.000Z"));
  const changed = lesson("2");
  changed.title = "新版标题";
  state = mergeSelfStudyLessons(state, { lessons: [changed] }, { learnedWords: LEARNED_WORDS }).state;
  assert.equal(state.lessons[0].version, "2");
  assert.equal(state.progress["trip-day-9"].lessonVersion, "1");
  assert.equal(state.progress["trip-day-9"].snapshot.title, "第 9 天完整自学课程");
});

test("AI grading failure preserves a pending answer without creating formal correctness evidence", async () => {
  const aiLesson = lesson();
  aiLesson.stages[0].steps[0].gradingMode = "ai";
  let state = upload([aiLesson]);
  state.enabled = true;
  state = startSelfStudyLesson(state, new Date("2026-08-07T00:00:00.000Z"));
  let pendingSaved = false;
  await assert.rejects(async () => {
    await submitSelfStudyStep(state, { lessonId: "trip-day-9", stepId: "review-1", answer: "A", attemptId: "pending-ai" }, {
      onPending(next) { state = next; pendingSaved = true; },
      async grade() { throw new Error("network unavailable"); }
    });
  }, /network unavailable/);
  assert.equal(pendingSaved, true);
  const attempt = state.progress["trip-day-9"].steps["review-1"].attempts[0];
  assert.equal(attempt.status, "pending");
  assert.equal(attempt.correct, null);
  assert.equal(selfStudyHistory(state).summary.formalAttempts, 0);

  const retried = await submitSelfStudyStep(state, { lessonId: "trip-day-9", stepId: "review-1", answer: "A", attemptId: "pending-ai", retry: true }, {
    async grade() { return { correct: true, score: 1, gradingStatus: "correct", explanation: "回答正确。", source: "ai" }; }
  });
  const resolved = retried.state.progress["trip-day-9"].steps["review-1"].attempts;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "graded");
  assert.equal(resolved[0].correct, true);
});
