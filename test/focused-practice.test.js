"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  FOCUSED_TYPES,
  completeFocusedSession,
  createFocusedSession,
  parseGeneratedFocusedPractice,
  publicFocusedState,
  recordCompletedFocused,
  skillSummaries
} = require("../server/focused-practice");

const profile = { allowedWords: ["a", "cat", "sat", "on", "mat"], learnedWords: [], learnedSentences: [] };
const provider = { providerId: "p1", providerName: "Test", model: "model", reasoningEffort: "high" };

function optionQuestions(type, count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    prompt: `选择第 ${index + 1} 题。`,
    sourceText: "A cat sat on a mat.",
    options: [{ id: "A", text: "猫" }, { id: "B", text: "垫子" }, { id: "C", text: "坐" }, { id: "D", text: "上面" }],
    answerKey: { kind: "option", correctOption: "A" },
    type
  }));
}

test("all eight focused types are defined with a five-point outcome", () => {
  assert.deepEqual(Object.keys(FOCUSED_TYPES), ["listening", "choice", "fill-blank", "true-false", "translation", "cloze", "reading", "essay"]);
});

test("focused generation enforces exact type count and learned English", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ title: "选择专项", questions: optionQuestions("single-choice") }) } }] };
  const generated = parseGeneratedFocusedPractice(payload, profile, "choice");
  assert.equal(generated.questions.length, 5);
  assert.equal(generated.questions.every(question => question.points === 1), true);

  const badPayload = { choices: [{ message: { content: JSON.stringify({ title: "选择专项", questions: optionQuestions("single-choice", 4) }) } }] };
  assert.throws(() => parseGeneratedFocusedPractice(badPayload, profile, "choice"), /exactly 5/);
});

test("focused listening never exposes English before completion", () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    prompt: `听第 ${index + 1} 题并选择。`,
    speechText: "A cat sat on a mat.",
    options: [{ id: "A", text: "猫坐在垫子上" }, { id: "B", text: "猫在垫子里" }, { id: "C", text: "垫子很大" }, { id: "D", text: "猫很大" }],
    answerKey: { kind: "option", correctOption: "A" }
  }));
  const payload = { choices: [{ message: { content: JSON.stringify({ title: "听力专项", questions }) } }] };
  const generated = parseGeneratedFocusedPractice(payload, profile, "listening");
  const session = createFocusedSession(generated, provider, "listening");
  const publicState = publicFocusedState({ currentSession: session });
  assert.equal(publicState.currentSession.questions[0].transcript, "");
  assert.equal(JSON.stringify(publicState.currentSession).includes("speechText"), false);
});

test("focused completion updates five-bar skill summaries", () => {
  const generated = { title: "选择专项", instructions: "", passage: "", questions: optionQuestions("single-choice").map((question, index) => ({ ...question, id: `q${index + 1}` })) };
  const session = createFocusedSession(generated, provider, "choice");
  const objectiveGrades = session.questions.map((question, index) => ({ questionId: question.id, score: index < 4 ? 1 : 0, correct: index < 4, explanation: "" }));
  const completed = completeFocusedSession(session, { objectiveGrades, subjectiveGrades: [], weakPoints: [], summary: "选择题较稳定。" }, provider);
  assert.equal(completed.result.levelScore, 4);
  const state = recordCompletedFocused({}, completed);
  assert.equal(skillSummaries(state.history).find(item => item.id === "choice").score, 4);
  assert.equal(skillSummaries(state.history).find(item => item.id === "listening").status, "unpracticed");
});
