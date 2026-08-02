"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  completeDictation,
  createDictationSession,
  dictationComplete,
  dictationSpeech,
  gradeDictation,
  parseDictationAnalysis,
  publicDictationState,
  recordCompletedDictation,
  saveDictationAnswers,
  selectDictationWords
} = require("../server/dictation");

const words = [
  { id: "cat", day: 2, english: "cat", chinese: "猫", phonetic: "/kæt/" },
  { id: "pig", day: 2, english: "pig", chinese: "猪", phonetic: "/pɪg/" }
];
const provider = { providerId: "p1", providerName: "Test", model: "model", reasoningEffort: "high" };

test("dictation draft hides English while speech stays available to its private endpoint", () => {
  const selected = selectDictationWords(words, { cat: 8, pig: 1 }, 5, () => 0.5);
  assert.equal(selected.length, 5);
  const session = createDictationSession(selected, provider);
  const publicState = publicDictationState({ currentSession: session });
  assert.equal(publicState.currentSession.items.length, 5);
  assert.equal(Object.hasOwn(publicState.currentSession.items[0], "english"), false);
  assert.equal(Object.hasOwn(publicState.currentSession.items[0], "wordId"), false);
  assert.equal(dictationSpeech(session, session.items[0].id).length > 0, true);
});

test("dictation saves a full draft, grades exact spelling, and increases repeated error weight", () => {
  let session = createDictationSession(words, provider);
  session = saveDictationAnswers(session, { [session.items[0].id]: "kat", [session.items[1].id]: "pig" });
  assert.equal(dictationComplete(session), true);
  session = gradeDictation(session);
  assert.equal(session.score, 1);
  const completed = completeDictation(session, { summary: "完成", weakWords: [{ wordId: "cat", detail: "c 写错", recommendation: "重听" }], recommendations: [] }, provider);
  const state = recordCompletedDictation({ weights: { cat: 3, pig: 2 } }, completed);
  assert.equal(state.weights.cat, 5);
  assert.equal(state.weights.pig, 1);
  assert.equal(state.history.length, 1);
});

test("dictation AI analysis is sanitized to words in the session", () => {
  const session = gradeDictation(saveDictationAnswers(createDictationSession(words, provider), {}));
  const payload = { choices: [{ message: { content: JSON.stringify({
    summary: "拼写需要加强。",
    weakWords: [
      { wordId: "cat", detail: "cat 写错。", recommendation: "慢速重听。" },
      { wordId: "future", detail: "越权内容", recommendation: "忽略" }
    ],
    recommendations: ["复习短元音。"]
  }) } }] };
  const analysis = parseDictationAnalysis(payload, session);
  assert.equal(analysis.weakWords.length, 1);
  assert.equal(analysis.weakWords[0].wordId, "cat");
});
