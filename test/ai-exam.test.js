"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  POINT_SCHEMES,
  TYPE_COUNTS,
  completeExam,
  createExam,
  examAnswersComplete,
  listeningSpeech,
  objectiveGrades,
  parseExamGrade,
  parseGeneratedExam,
  publicExam
} = require("../server/ai-exam");

const ALLOWED_WORDS = ["i", "am", "a", "man", "it", "is", "mat", "big", "pig", "cat", "sat", "on", "in", "sit"];

function generatedPayload() {
  const questions = [
    { type: "fill-blank", prompt: "填写单词。", sourceText: "I _ a man.", acceptedAnswers: ["am"] },
    { type: "fill-blank", prompt: "填写单词。", sourceText: "It _ big.", acceptedAnswers: ["is"] },
    { type: "fill-blank", prompt: "填写单词。", sourceText: "A cat _ on a mat.", acceptedAnswers: ["sat"] },
    { type: "single-choice", prompt: "选择正确单词。", sourceText: "man", options: ["man", "pig"], correctOption: 0 },
    { type: "single-choice", prompt: "选择正确单词。", sourceText: "cat", options: ["cat", "mat"], correctOption: 0 },
    { type: "single-choice", prompt: "选择正确单词。", sourceText: "big", options: ["big", "sit"], correctOption: 0 },
    { type: "multiple-choice", prompt: "选择两项。", sourceText: "pig cat mat", options: ["pig", "cat", "mat"], correctOptions: [0, 1] },
    { type: "multiple-choice", prompt: "选择两项。", sourceText: "sat on big", options: ["sat", "on", "big"], correctOptions: [0, 1] },
    { type: "true-false", prompt: "判断句意。", sourceText: "It is big.", correctAnswer: true },
    { type: "true-false", prompt: "判断句意。", sourceText: "A cat sat on a mat.", correctAnswer: true },
    { type: "true-false", prompt: "判断句意。", sourceText: "I am a man.", correctAnswer: true },
    { type: "cloze", prompt: "选择第 1 空。", sourceText: "", options: ["sat", "sit"], correctOption: 0 },
    { type: "cloze", prompt: "选择第 2 空。", sourceText: "", options: ["mat", "man"], correctOption: 0 },
    { type: "cloze", prompt: "选择第 3 空。", sourceText: "", options: ["is", "in"], correctOption: 0 },
    { type: "cloze", prompt: "选择第 4 空。", sourceText: "", options: ["am", "is"], correctOption: 0 },
    { type: "reading-comprehension", prompt: "谁坐在垫子上？", sourceText: "", options: ["猫", "猪"], correctOption: 0 },
    { type: "reading-comprehension", prompt: "猫在哪里？", sourceText: "", options: ["垫子上", "里面"], correctOption: 0 },
    { type: "reading-comprehension", prompt: "猫大吗？", sourceText: "", options: ["大", "不大"], correctOption: 0 },
    { type: "translation", prompt: "翻译成中文。", sourceText: "It is big.", direction: "en-zh", acceptedAnswers: ["它很大"] },
    { type: "translation", prompt: "翻译成英文。", sourceText: "它是一只猫。", direction: "zh-en", acceptedAnswers: ["It is a cat."] },
    { type: "translation", prompt: "翻译成中文。", sourceText: "A big pig sat on a mat.", direction: "en-zh", acceptedAnswers: ["一只大猪坐在垫子上"] },
    { type: "listening", prompt: "听音后选择意思。", sourceText: "", speechText: "A pig sat on a big mat.", options: ["一只猪坐在一张大垫子上", "一只猫坐在一张大垫子上"], correctOption: 0 },
    { type: "listening", prompt: "听音后选择意思。", sourceText: "", speechText: "A cat sat on a mat.", options: ["一只猪坐在垫子上", "一只猫坐在垫子上"], correctOption: 1 },
    { type: "listening", prompt: "听音后选择意思。", sourceText: "", speechText: "It is a big cat.", options: ["它是一只大猫", "它是一只大猪"], correctOption: 0 },
    { type: "essay", prompt: "用已学单词写几句。", sourceText: "", requiredWords: ["cat", "mat"], minWords: 3, maxWords: 20, rubric: "句意清楚。" }
  ];
  return { choices: [{ message: { content: JSON.stringify({ title: "测试试卷", instructions: "完成后交卷。", clozePassage: "A big cat [1] on a [2]. It [3] big. I [4] a man.", readingPassage: "A big cat sat on a mat.", questions }) } }] };
}

function answersFor(exam) {
  const counts = {};
  return Object.fromEntries(exam.questions.map(question => {
    counts[question.type] = (counts[question.type] || 0) + 1;
    if (question.type === "fill-blank") return [question.id, ["am", "is", "sat"][counts[question.type] - 1]];
    if (question.type === "single-choice") return [question.id, "A"];
    if (question.type === "multiple-choice") return [question.id, ["A", "B"]];
    if (question.type === "true-false") return [question.id, true];
    if (["cloze", "reading-comprehension"].includes(question.type)) return [question.id, "A"];
    if (question.type === "translation") return [question.id, ["它很大", "It is a cat.", "一只大猪坐在垫子上"][counts[question.type] - 1]];
    if (question.type === "listening") return [question.id, ["A", "B", "A"][counts[question.type] - 1]];
    return [question.id, "A cat sat on a mat."];
  }));
}

test("all exam option and total-score combinations allocate exact points", () => {
  for (const totalPoints of [100, 150]) {
    for (const includeEssay of [false, true]) {
      for (const includeListening of [false, true]) {
        const exam = parseGeneratedExam(generatedPayload(), { ALLOWED_WORDS, allowedWords: ALLOWED_WORDS, totalPoints, includeEssay, includeListening });
        assert.equal(exam.questions.reduce((sum, question) => sum + question.points, 0), totalPoints);
        assert.equal(exam.totalPoints, totalPoints);
        assert.equal(exam.questions.some(question => question.type === "essay"), includeEssay);
        assert.equal(exam.questions.some(question => question.type === "listening"), includeListening);
        Object.entries(TYPE_COUNTS).forEach(([type, count]) => {
          const expected = type === "essay" ? (includeEssay ? count : 0) : type === "listening" ? (includeListening ? count : 0) : count;
          assert.equal(exam.questions.filter(question => question.type === type).length, expected, `${type} count`);
        });
      }
    }
  }
  assert.equal(Object.keys(POINT_SCHEMES).length, 8);
});

test("draft exam redacts answer keys and listening transcript until completion", () => {
  const generated = parseGeneratedExam(generatedPayload(), { allowedWords: ALLOWED_WORDS, totalPoints: 150, includeEssay: true, includeListening: true });
  const exam = createExam(generated, { providerId: "p1", providerName: "Test", model: "test-model", reasoningEffort: "high" });
  const listening = exam.questions.find(question => question.type === "listening");
  const draft = publicExam(exam);

  assert.equal(draft.totalPoints, 150);
  assert.equal(draft.questions.find(question => question.id === listening.id).transcript, "");
  assert.equal(listeningSpeech(exam, listening.id), listening.speechText);
  assert.equal(JSON.stringify(draft).includes("answerKey"), false);
  assert.equal(JSON.stringify(draft).includes("correctOption"), false);
  assert.equal(JSON.stringify(draft).includes(listening.speechText), false);

  exam.answers = answersFor(exam);
  assert.equal(examAnswersComplete(exam, exam.answers), true);
  const objective = objectiveGrades(exam, exam.answers);
  const subjectiveGrades = exam.questions.filter(question => ["translation", "essay"].includes(question.type)).map(question => ({ questionId: question.id, score: question.points, explanation: "表达正确。" }));
  const completed = completeExam(exam, { objectiveGrades: objective, subjectiveGrades, weakPoints: [], summary: "表现稳定。" }, { providerId: "p1", providerName: "Test" }, ALLOWED_WORDS);
  const result = publicExam(completed);

  assert.equal(result.status, "completed");
  assert.equal(result.result.score, 150);
  assert.equal(result.result.possible, 150);
  assert.equal(result.questions.find(question => question.id === listening.id).transcript, listening.speechText);
  assert.equal(result.questions.every(question => question.result && Number.isInteger(question.result.score)), true);
});

test("structured AI grading summaries are normalized into readable text", () => {
  const generated = parseGeneratedExam(generatedPayload(), { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: false });
  const exam = createExam(generated, { providerId: "p1", providerName: "Test", model: "test-model", reasoningEffort: "high" });
  const subjectiveGrades = exam.questions.filter(question => question.type === "translation").map(question => ({ questionId: question.id, score: question.points, explanation: "翻译正确。" }));
  const payload = { choices: [{ message: { content: JSON.stringify({
    subjectiveGrades,
    weakPoints: [],
    summary: { analysis: "词汇理解稳定。", feedback: "继续复习易混单词。" }
  }) } }] };

  const grading = parseExamGrade(payload, { exam, allowedWords: ALLOWED_WORDS });
  assert.equal(grading.summary, "词汇理解稳定。 继续复习易混单词。");
  assert.doesNotMatch(grading.summary, /\[object Object\]/);
});

test("listening generation rejects visible English in prompts or options", () => {
  const payload = generatedPayload();
  const parsed = JSON.parse(payload.choices[0].message.content);
  const listening = parsed.questions.find(question => question.type === "listening");
  listening.prompt = "Listen to A big pig.";
  payload.choices[0].message.content = JSON.stringify(parsed);
  assert.throws(() => parseGeneratedExam(payload, { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: true }), /must not reveal English/);
});

test("listening generation rejects speech without English", () => {
  const payload = generatedPayload();
  const parsed = JSON.parse(payload.choices[0].message.content);
  const listening = parsed.questions.find(question => question.type === "listening");
  listening.speechText = "一只大猪坐在垫子上。";
  payload.choices[0].message.content = JSON.stringify(parsed);
  assert.throws(() => parseGeneratedExam(payload, { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: true }), /returned no English/);
});

test("exam generation rejects missing required types and incomplete cloze passages", () => {
  const missingTypePayload = generatedPayload();
  const missingTypeExam = JSON.parse(missingTypePayload.choices[0].message.content);
  missingTypeExam.questions = missingTypeExam.questions.filter(question => question.type !== "translation");
  missingTypePayload.choices[0].message.content = JSON.stringify(missingTypeExam);
  assert.throws(() => parseGeneratedExam(missingTypePayload, { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: false }), /too few 翻译题/);

  const incompleteClozePayload = generatedPayload();
  const incompleteClozeExam = JSON.parse(incompleteClozePayload.choices[0].message.content);
  incompleteClozeExam.clozePassage = incompleteClozeExam.clozePassage.replace("[4]", "");
  incompleteClozePayload.choices[0].message.content = JSON.stringify(incompleteClozeExam);
  assert.throws(() => parseGeneratedExam(incompleteClozePayload, { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: false }), /missing numbered blanks/);
});

test("exam generation rejects a claimed same-meaning option that adds object information", () => {
  const payload = generatedPayload();
  const parsed = JSON.parse(payload.choices[0].message.content);
  const question = parsed.questions.find(item => item.type === "single-choice");
  Object.assign(question, {
    prompt: "选择意思相近的句子。",
    sourceText: "It is big.",
    options: ["It is a big cat.", "I am a man."],
    correctOption: 0
  });
  payload.choices[0].message.content = JSON.stringify(parsed);

  assert.throws(
    () => parseGeneratedExam(payload, { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: false }),
    /semantic-equivalence answer changes sentence information/
  );
});

test("exam grading removes full credit when a Chinese-to-English translation omits a required article", () => {
  const generated = parseGeneratedExam(generatedPayload(), { allowedWords: ALLOWED_WORDS, totalPoints: 100, includeEssay: false, includeListening: false });
  const exam = createExam(generated, { providerId: "p1", providerName: "Test", model: "test-model", reasoningEffort: "high" });
  const answers = answersFor(exam);
  const target = exam.questions.find(question => question.type === "translation" && question.direction === "zh-en");
  answers[target.id] = "It is cat.";
  const subjectiveGrades = exam.questions.filter(question => question.type === "translation").map(question => ({ questionId: question.id, score: question.points, explanation: "表达正确。" }));
  const payload = { choices: [{ message: { content: JSON.stringify({ subjectiveGrades, weakPoints: [], summary: "完成。" }) } }] };

  const grading = parseExamGrade(payload, { exam, answers, allowedWords: ALLOWED_WORDS });
  const grade = grading.subjectiveGrades.find(item => item.questionId === target.id);
  assert.equal(grade.score, target.points - 1);
  assert.equal(grade.correct, false);
  assert.match(grade.explanation, /冠词/);
  assert.equal(grading.weakPoints.some(item => item.category === "grammar" && item.questionIds.includes(target.id)), true);
});
