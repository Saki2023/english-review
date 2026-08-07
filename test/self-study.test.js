"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  continueSelfStudyStep,
  markLessonCompleted,
  mergeSelfStudyLessons,
  publicSelfStudyState,
  sanitizeSelfStudyLesson,
  selfStudyHistory,
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
