"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { createUser, loadUsers, saveUsers } = require("../server/accounts");
const { buildChatCompletionsUrl, buildModelsUrl, buildResponsesUrl, createAiGrader, createAiPreviewSentenceGenerator, createAiReviewVariantGenerator, createAiTutor, createRateLimiter, parseGeneratedQuestionGroups, parseGeneratedQuestions, parseGradeResponse, parseModelList, parsePreviewSentenceResponse, parseReviewVariantResponse } = require("../server/ai-grader");

const ROOT = path.resolve(__dirname, "..");

function temporaryDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-"));
}

function aiConfig(overrides = {}) {
  return {
    apiKey: "secret",
    configured: true,
    endpoint: buildChatCompletionsUrl("https://sub2api.example/v1"),
    responsesEndpoint: buildResponsesUrl("https://sub2api.example/v1"),
    model: "test-model",
    reasoningEffort: "",
    timeoutMs: 10000,
    rateLimitPerMinute: 20,
    ...overrides
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

async function requestReviewVariants(baseUrl, cookie, input) {
  let response = await fetch(`${baseUrl}/api/review/sentence-variants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify(input)
  });
  const startStatus = response.status;
  let body = await response.json();
  for (let attempt = 0; response.status === 202 && attempt < 100; attempt += 1) {
    assert.equal(body.status, "pending");
    assert.ok(body.jobId);
    await new Promise(resolve => setTimeout(resolve, 25));
    response = await fetch(`${baseUrl}/api/review/sentence-variants?jobId=${encodeURIComponent(body.jobId)}`, { headers: { "Cookie": cookie } });
    body = await response.json();
  }
  if (response.status === 202) throw new Error("review variant background job did not finish");
  return { response, body, startStatus };
}

test("AI configuration builds OpenAI-compatible chat, responses, and model endpoints", () => {
  assert.equal(buildChatCompletionsUrl("https://sub2api.example/v1"), "https://sub2api.example/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://sub2api.example"), "https://sub2api.example/v1/chat/completions");
  assert.equal(buildChatCompletionsUrl("https://sub2api.example/v1/chat/completions"), "https://sub2api.example/v1/chat/completions");
  assert.equal(buildResponsesUrl("https://sub2api.example/v1"), "https://sub2api.example/v1/responses");
  assert.equal(buildResponsesUrl("https://sub2api.example"), "https://sub2api.example/v1/responses");
  assert.equal(buildResponsesUrl("https://sub2api.example/v1/chat/completions"), "https://sub2api.example/v1/responses");
  assert.equal(buildModelsUrl("https://sub2api.example/v1"), "https://sub2api.example/v1/models");
  assert.equal(buildModelsUrl("https://sub2api.example"), "https://sub2api.example/v1/models");
  assert.equal(buildModelsUrl("https://sub2api.example/v1/chat/completions"), "https://sub2api.example/v1/models");
});

test("upstream model lists accept OpenAI and common proxy response shapes", () => {
  assert.deepEqual(parseModelList({ data: [{ id: "model-10" }, { id: "model-2" }, { id: "model-2" }] }), ["model-2", "model-10"]);
  assert.deepEqual(parseModelList({ models: ["model-b", { name: "model-a" }] }), ["model-a", "model-b"]);
  assert.deepEqual(parseModelList({ success: true, data: { items: [{ model: "proxy-model" }, { model_name: "relay-model" }] } }), ["proxy-model", "relay-model"]);
  assert.deepEqual(parseModelList({ result: { data: [{ slug: "nested-model" }] } }), ["nested-model"]);
  assert.throws(() => parseModelList({ data: [{ object: "model" }] }), /no models/);
});

test("AI grade parsing requires a boolean result and a Chinese explanation", () => {
  const result = parseGradeResponse({ choices: [{ message: { content: "```json\n{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\uff0c\u53ef\u4ee5\u8fd9\u6837\u7ffb\u8bd1\u3002\"}\n```" } }] });
  assert.deepEqual(result, { correct: true, score: 1, gradingStatus: "correct", explanation: "\u610f\u601d\u76f8\u540c\uff0c\u53ef\u4ee5\u8fd9\u6837\u7ffb\u8bd1\u3002", problemWords: [] });
  assert.throws(() => parseGradeResponse({ choices: [{ message: { content: "{\"correct\":\"yes\",\"explanation\":\"ok\"}" } }] }), /invalid grade/);
});

test("AI grader cannot approve a Chinese-to-English answer with a missing article", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ correct: true, explanation: "语义一致。" }) } }] }), { status: 200 });
  };
  const grader = createAiGrader(aiConfig(), { fetchImpl });
  const result = await grader.grade({
    direction: "zh-en",
    sourceText: "一头大猪坐在一张垫子上。",
    acceptedAnswers: ["A big pig sat on a mat."],
    answer: "a big pig sat on mat"
  });

  assert.equal(result.correct, false);
  assert.match(result.explanation, /冠词/);
  assert.match(requestBody.messages[0].content, /missing or extra a, an, the/);
});

test("AI grader cannot approve an explicit pair quantity for singular English", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ correct: true, explanation: "意思相同。" }) } }] }), { status: 200 });
  };
  const grader = createAiGrader(aiConfig(), { fetchImpl });
  const result = await grader.grade({
    direction: "en-zh",
    sourceText: "It is a boot.",
    acceptedAnswers: ["它是一只靴子。"],
    answer: "它是一双靴子"
  });

  assert.equal(result.correct, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.problemWords, []);
  assert.match(result.explanation, /一双|数量/);
  assert.match(requestBody.messages[0].content, /omitting an optional singular classifier/);
  assert.match(requestBody.messages[0].content, /Never accept 一双/);
});

test("AI grader retries once without JSON mode when a compatible proxy rejects it", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response("unsupported", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":false,\"explanation\":\"\u4e3b\u8bed\u4e0d\u4e00\u81f4\u3002\"}" } }] }), { status: 200 });
  };
  const config = aiConfig();
  const grader = createAiGrader(config, { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["\u5b83\u5f88\u5927"], answer: "\u4ed6\u5f88\u5927" });

  assert.equal(result.correct, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
});

test("AI grader drops unsupported reasoning effort while retaining JSON mode", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return new Response("unsupported", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\u3002\"}" } }] }), { status: 200 });
  };
  const base = aiConfig();
  const grader = createAiGrader({ ...base, reasoningEffort: "high" }, { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["\u5b83\u5f88\u5927"], answer: "\u5b83\u975e\u5e38\u5927" });

  assert.equal(result.correct, true);
  assert.equal(requests[0].reasoning_effort, "high");
  assert.equal(Object.hasOwn(requests[1], "reasoning_effort"), false);
  assert.deepEqual(requests[1].response_format, { type: "json_object" });
});

test("AI requests send the mapped upstream effort and honor an explicit omission", async () => {
  const mappedRequests = [];
  const mappedFetch = async (_url, options) => {
    mappedRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":true,\"explanation\":\"意思相同。\"}" } }] }), { status: 200 });
  };
  const mapped = createAiGrader(aiConfig({ reasoningEffort: "medium", upstreamReasoningEffort: "high" }), { fetchImpl: mappedFetch });
  await mapped.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["它很大"], answer: "它很大" });
  assert.equal(mappedRequests[0].reasoning_effort, "high");

  const omittedRequests = [];
  const omittedFetch = async (_url, options) => {
    omittedRequests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"correct\":true,\"explanation\":\"意思相同。\"}" } }] }), { status: 200 });
  };
  const omitted = createAiGrader(aiConfig({ reasoningEffort: "max", upstreamReasoningEffort: "" }), { fetchImpl: omittedFetch });
  await omitted.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["它很大"], answer: "它很大" });
  assert.equal(Object.hasOwn(omittedRequests[0], "reasoning_effort"), false);
});

test("AI grader falls back to the Responses API when chat completions are unavailable", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ body, url });
    if (url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"correct\":true,\"explanation\":\"意思相同。\"}" }] }] }), { status: 200 });
  };
  const grader = createAiGrader(aiConfig({ reasoningEffort: "high" }), { fetchImpl });
  const result = await grader.grade({ direction: "en-zh", sourceText: "It is big.", acceptedAnswers: ["它很大"], answer: "它很大" });

  assert.deepEqual(result, { correct: true, score: 1, gradingStatus: "correct", explanation: "意思相同。", problemWords: [] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://sub2api.example/v1/chat/completions");
  assert.equal(requests[1].url, "https://sub2api.example/v1/responses");
  assert.equal(requests[1].body.instructions.includes("translation answer"), true);
  assert.deepEqual(requests[1].body.reasoning, { effort: "high" });
  assert.equal(Array.isArray(requests[1].body.input), true);
  assert.equal(Object.hasOwn(requests[1].body, "messages"), false);
});

test("AI tutor requests plain Chinese guidance with the selected maximum effort", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "先看 in 前后的词，再判断位置关系。" } }] }), { status: 200 });
  };
  const tutor = createAiTutor(aiConfig({ reasoningEffort: "max" }), { fetchImpl });
  const answer = await tutor.answer({
    exercise: { direction: "en-zh", english: "A cat is in a mat.", chinese: "一只猫在垫子里面。", answered: false },
    history: [],
    message: "in 在这里起什么作用？"
  });

  assert.equal(answer, "先看 in 前后的词，再判断位置关系。");
  assert.equal(requestBody.reasoning_effort, "max");
  assert.equal(Object.hasOwn(requestBody, "response_format"), false);
  assert.match(requestBody.messages[0].content, /never reveal the full translation or final answer/);
});

test("AI tutor retries and falls back to Chinese when an answer introduces unlearned English words", async () => {
  let calls = 0;
  const tutor = createAiTutor(aiConfig(), { fetchImpl: async () => {
    calls += 1;
    const content = calls === 1 ? "good 比 great 弱，weather 也可以这样用。" : "先用中文看这个词在题目中的意思。";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  } });
  const answer = await tutor.answer({
    exercise: { direction: "en-zh", english: "It is good.", chinese: "它很好。", answered: true },
    history: [],
    message: "good 是什么意思？",
    allowedWords: ["it", "is", "good"],
    wordMeanings: { good: ["好的"] }
  });
  assert.equal(calls, 2);
  assert.equal(answer, "先用中文看这个词在题目中的意思。");
});

test("AI review variant parser keeps task ids and Chinese answer alternatives", () => {
  const result = parseReviewVariantResponse({ choices: [{ message: { content: JSON.stringify({ variants: [
    { taskId: "d2-s3:en-zh", english: "A pig sat on a box.", chinese: "一头猪坐在一个箱子上。", acceptedChinese: ["一只猪坐在箱子上"] }
  ] }) } }] });
  assert.deepEqual(result[0], { taskId: "d2-s3:en-zh", english: "A pig sat on a box.", chinese: "一头猪坐在一个箱子上。", acceptedChinese: ["一头猪坐在一个箱子上。", "一只猪坐在箱子上"] });
});

test("AI review variant repair requests include validation feedback and honor an explicit timeout", async () => {
  let requestOptions;
  const generator = createAiReviewVariantGenerator(aiConfig({ timeoutMs: 1 }), { fetchImpl: async (_url, options) => {
    requestOptions = options;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ variants: [
      { taskId: "d2-s3:en-zh", english: "A red pig sat on a box.", chinese: "一头红色的猪坐在一个箱子上。" }
    ] }) } }] }), { status: 200 });
  } });
  const result = await generator.generate({
    allowedWords: ["a", "red", "pig", "sat", "on", "box"],
    grammarFamilies: { "sat-on": "subject + sat on + an object" },
    targets: [{ taskId: "d2-s3:en-zh", grammarFamily: "sat-on", sourceEnglish: "A pig sat on a mat.", sourceChinese: "一头猪坐在一张垫子上。" }],
    excludedEnglish: ["A pig sat on a mat."],
    weakItems: [],
    timeoutMs: 5000,
    validationFeedback: [{ taskId: "d2-s3:en-zh", reasonCode: "unlearned-word", problem: "含有未学单词", unlearnedWords: ["dog"] }]
  });
  assert.equal(result[0].english, "A red pig sat on a box.");
  assert.ok(requestOptions.signal instanceof AbortSignal, "review generation must use the explicit provider timeout abort signal");
  const requestBody = JSON.parse(requestOptions.body);
  const input = JSON.parse(requestBody.messages[1].content);
  assert.equal(input.validationFeedback[0].reasonCode, "unlearned-word");
  assert.match(requestBody.messages[0].content, /correct every listed failure/);
});

test("AI review variant generation aborts a hung upstream at the explicit timeout", async () => {
  let aborted = false;
  const generator = createAiReviewVariantGenerator(aiConfig({ timeoutMs: 10000 }), {
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      assert.ok(options.signal instanceof AbortSignal);
      options.signal.addEventListener("abort", () => {
        aborted = true;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })
  });
  await assert.rejects(() => generator.generate({
    allowedWords: ["a", "pig", "sat", "on", "a", "mat"],
    grammarFamilies: { "sat-on": "subject + sat on + an object" },
    targets: [{ taskId: "d2-s3:en-zh", grammarFamily: "sat-on", sourceEnglish: "A pig sat on a mat.", sourceChinese: "一头猪坐在一张垫子上。" }],
    excludedEnglish: ["A pig sat on a mat."],
    weakItems: [],
    timeoutMs: 25
  }), /timed out/);
  assert.equal(aborted, true);
});

test("AI preview sentence parser keeps target preview words and translations", async () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ sentences: [
    { wordId: "d5-sun", english: "I see the sun.", chinese: "我看见太阳。", acceptedChinese: ["我看到太阳"] }
  ] }) } }] };
  const parsed = parsePreviewSentenceResponse(payload);
  assert.deepEqual(parsed[0], { wordId: "d5-sun", english: "I see the sun.", chinese: "我看见太阳。", acceptedChinese: ["我看见太阳。", "我看到太阳"] });
  let requestBody;
  const generator = createAiPreviewSentenceGenerator(aiConfig(), { fetchImpl: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify(payload), { status: 200 });
  } });
  const result = await generator.generate({ allowedWords: ["i", "see", "the", "sun"], learnedWords: ["i", "see", "the"], previewWords: [{ wordId: "d5-sun", english: "sun" }], targets: [{ wordId: "d5-sun", english: "sun", chinese: "太阳" }] });
  assert.equal(result[0].wordId, "d5-sun");
  assert.match(requestBody.messages[0].content, /Every sentence must use its target preview word/);
  assert.match(requestBody.messages[0].content, /learnedWords/);
  assert.match(requestBody.messages[0].content, /in school.*在上学.*in a school.*一所学校/i);
  assert.deepEqual(JSON.parse(requestBody.messages[1].content).learnedWords, ["i", "see", "the"]);
  assert.deepEqual(JSON.parse(requestBody.messages[1].content).previewWords, [{ wordId: "d5-sun", english: "sun" }]);
});

test("AI question and preview parsers store natural deep translations with legacy alternatives", () => {
  const previewPayload = { choices: [{ message: { content: JSON.stringify({ sentences: [{
    wordId: "d9-deep",
    english: "A pool is deep.",
    chinese: "一个水池是深的。",
    acceptedChinese: ["一个水池是深的。"]
  }] }) } }] };
  const preview = parsePreviewSentenceResponse(previewPayload)[0];
  assert.equal(preview.chinese, "一个水池很深。");
  assert.ok(preview.acceptedChinese.includes("一个水池是深的。"));
  assert.ok(preview.acceptedChinese.includes("一个游泳池很深。"));

  const questionPayload = { choices: [{ message: { content: JSON.stringify({ questions: [{
    direction: "en-zh",
    english: "We see a deep pool.",
    chinese: "我们看见一个深的水池。",
    acceptedChinese: ["我们看见一个深的水池。"]
  }] }) } }] };
  const question = parseGeneratedQuestions(questionPayload, { allowedWords: ["we", "see", "a", "deep", "pool"], count: 1 })[0];
  assert.equal(question.chinese, "我们看见一个很深的水池。");
  assert.ok(question.acceptedChinese.includes("我们看见一个深的水池。"));
  assert.ok(question.acceptedChinese.includes("我们看见一个很深的游泳池。"));
});

test("generated questions reject unlearned English words and duplicates", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ questions: [
    { direction: "en-zh", english: "big cat", chinese: "\u5927\u732b", acceptedEnglish: ["big cat", "large cat"], acceptedChinese: ["\u5927\u732b"], focus: "big" },
    { direction: "en-zh", english: "big cat", chinese: "\u5927\u732b", acceptedEnglish: ["big cat"], acceptedChinese: ["\u5927\u732b"], focus: "\u91cd\u590d" },
    { direction: "zh-en", english: "big dog", chinese: "\u5927\u72d7", acceptedEnglish: ["big dog"], acceptedChinese: ["\u5927\u72d7"], focus: "\u672a\u5b66" },
    { direction: "zh-en", english: "cat", chinese: "\u732b", acceptedEnglish: ["cat"], acceptedChinese: ["\u732b"], focus: "\u5355\u8bcd" }
  ] }) } }] };

  const questions = parseGeneratedQuestions(payload, { allowedWords: ["big", "cat"], count: 2 });
  assert.equal(questions.length, 2);
  assert.deepEqual(questions.map(item => item.english), ["big cat", "cat"]);
  assert.deepEqual(questions[0].acceptedEnglish, ["big cat"]);
  assert.throws(() => parseGeneratedQuestions(payload, { allowedWords: ["big", "cat"], count: 3 }), /too few valid/);
});

test("prepared AI groups stay independent and may reuse useful questions across groups", () => {
  const repeated = { direction: "en-zh", english: "big cat", chinese: "大猫", acceptedEnglish: ["big cat"], acceptedChinese: ["大猫"] };
  const payload = { choices: [{ message: { content: JSON.stringify({ groups: [
    { questions: [repeated] },
    { questions: [repeated] },
    { questions: [repeated] }
  ] }) } }] };
  const groups = parseGeneratedQuestionGroups(payload, { allowedWords: ["big", "cat"], count: 1, groupCount: 3 });
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.length), [1, 1, 1]);
  assert.deepEqual(groups.map(group => group[0].english), ["big cat", "big cat", "big cat"]);
  assert.throws(() => parseGeneratedQuestionGroups(payload, { allowedWords: ["big", "cat"], count: 1, groupCount: 5 }), /too few question groups/);
});

test("generated questions reject a Chinese subject that does not match the English pronoun", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ questions: [
    { direction: "zh-en", english: "It is a big cat.", chinese: "这是一只大猫。", acceptedEnglish: ["it is a big cat"], acceptedChinese: ["这是一只大猫"] },
    { direction: "zh-en", english: "It is a big cat.", chinese: "它是一只大猫。", acceptedEnglish: ["it is a big cat"], acceptedChinese: ["它是一只大猫", "这是一只大猫"] }
  ] }) } }] };
  const questions = parseGeneratedQuestions(payload, { allowedWords: ["it", "is", "a", "big", "cat"], count: 1 });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].chinese, "它是一只大猫。");
  assert.deepEqual(questions[0].acceptedChinese, ["它是一只大猫。", "它是一只大猫"]);
});

test("generated question labels never expose model-provided answer hints", () => {
  const payload = { choices: [{ message: { content: JSON.stringify({ questions: [
    { direction: "en-zh", english: "cat in mat", chinese: "猫在垫子里面", acceptedEnglish: ["cat in mat"], acceptedChinese: ["猫在垫子里面"], focus: "in 表示在里面" }
  ] }) } }] };
  const questions = parseGeneratedQuestions(payload, { allowedWords: ["cat", "in", "mat"], count: 1 });
  assert.equal(questions[0].focus, "介词辨析");
  assert.equal(questions[0].focus.includes("里面"), false);
});

test("AI rate limiter isolates callers and returns a retry delay", () => {
  let current = 1000;
  const take = createRateLimiter(2, 60000, () => current);
  assert.equal(take("user-a").allowed, true);
  assert.equal(take("user-a").allowed, true);
  assert.equal(take("user-b").allowed, true);
  assert.equal(take("user-a").allowed, false);
  current += 60001;
  assert.equal(take("user-a").allowed, true);
});

test("admin configures AI on the web and progress-based questions use the selected capability", async () => {
  const dataDir = temporaryDataDir();
  const store = loadUsers(dataDir);
  const reviewEfforts = ["low", "medium", "high", "xhigh", "max"];
  const reviewVariantAccounts = [
    ...reviewEfforts.map(reasoningEffort => ({ key: reasoningEffort, username: `review-${reasoningEffort}` })),
    { key: "repair", username: "review-repair" },
    { key: "reject", username: "review-reject" }
  ];
  createUser(store, { username: "owner", password: "strong-ai-password" });
  createUser(store, { username: "member", password: "strong-member-password" });
  reviewVariantAccounts.forEach(account => createUser(store, { username: account.username, password: "strong-review-password" }));
  saveUsers(dataDir, store);

  const providerRequests = [];
  const modelRequests = [];
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        modelRequests.push({ authorization: req.headers.authorization, accept: req.headers.accept });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "test-model" }, { id: "strong-model" }, { id: "test-model" }] }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      providerRequests.push({ authorization: req.headers.authorization, body, url: req.url });
      if (body.model === "missing-model") {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "model endpoint not found" } }));
      }
      const system = String(body.messages && body.messages[0] && body.messages[0].content || "");
      let content;
      if (system.includes("Create fresh sentence-review variants")) {
        const request = JSON.parse(body.messages[1].content);
        const repairing = new Set((request.validationFeedback || []).map(item => item.taskId));
        content = JSON.stringify({ variants: request.targets.map(target => target.taskId === "d2-s3:en-zh"
          ? repairing.has(target.taskId)
            ? { taskId: target.taskId, english: "A red pig sat on a box.", chinese: "一头红色的猪坐在一个箱子上。" }
            : { taskId: target.taskId, english: "A dog sat on a mat.", chinese: "一只狗坐在一张垫子上。" }
          : {
              taskId: target.taskId,
              english: "It is a hot box.",
              chinese: "它是一个热箱子。",
              acceptedChinese: ["它是一个热箱子"]
            }) });
      } else if (system.includes("Create personalized translation exercises")) {
        const questions = [
          { direction: "en-zh", english: "It is big.", chinese: "\u5b83\u5f88\u5927\u3002", acceptedEnglish: ["it is big"], acceptedChinese: ["\u5b83\u5f88\u5927"], focus: "big" },
          { direction: "zh-en", english: "A cat sat on a mat.", chinese: "\u4e00\u53ea\u732b\u5750\u5728\u4e00\u5f20\u57ab\u5b50\u4e0a\u3002", acceptedEnglish: ["a cat sat on a mat"], acceptedChinese: ["\u4e00\u53ea\u732b\u5750\u5728\u57ab\u5b50\u4e0a"], focus: "cat" },
          { direction: "en-zh", english: "I am Sam.", chinese: "\u6211\u662f\u8428\u59c6\u3002", acceptedEnglish: ["i am sam"], acceptedChinese: ["\u6211\u662f\u8428\u59c6"], focus: "am" },
          { direction: "zh-en", english: "It is a big pig.", chinese: "\u5b83\u662f\u4e00\u5934\u5927\u732a\u3002", acceptedEnglish: ["it is a big pig"], acceptedChinese: ["\u5b83\u662f\u4e00\u5934\u5927\u732a"], focus: "pig" },
          { direction: "en-zh", english: "She is a mom.", chinese: "她是一位妈妈。", acceptedEnglish: ["she is a mom"], acceptedChinese: ["她是一位妈妈"], focus: "mom" }
        ];
        const groupMatch = system.match(/Return exactly (\d+) independent groups/);
        content = groupMatch
          ? JSON.stringify({ groups: Array.from({ length: Number(groupMatch[1]) }, () => ({ questions })) })
          : JSON.stringify({ questions });
      } else if (system.includes("patient English tutor")) content = "先看句子的主语和位置词，再自己试一次。";
      else if (system.includes("ok set to true")) content = "{\"ok\":true}";
      else content = "{\"correct\":true,\"explanation\":\"\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002\"}";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve, reject) => provider.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const providerPort = provider.address().port;
  const appPort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(appPort),
      COOKIE_SECURE: "false",
      REVIEW_VARIANT_POOL_AUTOFILL: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    assert.equal(health.aiGrading, false);
    assert.equal(JSON.stringify(health).includes("private-test-key"), false);

    const unauthenticated = await fetch(`${baseUrl}/api/ai/grade`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "strong-ai-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const discovered = await fetch(`${baseUrl}/api/admin/ai-config/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "private-test-key", timeoutMs: 10000 })
    });
    assert.equal(discovered.status, 200);
    const discoveredBody = await discovered.json();
    assert.deepEqual(discoveredBody, { models: ["strong-model", "test-model"], count: 2 });
    assert.equal(JSON.stringify(discoveredBody).includes("private-test-key"), false);
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0].authorization, "Bearer private-test-key");
    assert.match(modelRequests[0].accept, /application\/json/);
    assert.equal((await (await fetch(`${baseUrl}/api/health`)).json()).aiGrading, false);

    const configured = await fetch(`${baseUrl}/api/admin/ai-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "private-test-key",
        models: ["test-model", "strong-model", "missing-model"],
        defaultModel: "test-model",
        timeoutMs: 10000,
        rateLimitPerMinute: 20
      })
    });
    assert.equal(configured.status, 200);
    assert.equal(JSON.stringify(await configured.json()).includes("private-test-key"), false);

    const visibleConfig = await (await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": cookie } })).json();
    assert.equal(visibleConfig.hasApiKey, true);
    assert.equal(Object.hasOwn(visibleConfig, "apiKey"), false);
    assert.equal(JSON.stringify(visibleConfig).includes("private-test-key"), false);
    assert.equal((await (await fetch(`${baseUrl}/api/health`)).json()).aiGrading, true);

    const reviewVariantCookies = new Map();
    for (const account of reviewVariantAccounts) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: account.username, password: "strong-review-password" })
      });
      assert.equal(response.status, 200);
      reviewVariantCookies.set(account.key, response.headers.get("set-cookie").split(";")[0]);
    }

    const connectionTest = await fetch(`${baseUrl}/api/admin/ai-config/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ model: "test-model", reasoningEffort: "medium" })
    });
    assert.equal(connectionTest.status, 200);
    const connectionBody = await connectionTest.json();
    assert.equal(connectionBody.reasoningEffort, "medium");
    assert.equal(connectionBody.appliedReasoningEffort, "medium");
    assert.equal(connectionBody.providerFamily, "openai-compatible");
    assert.equal(connectionBody.timeoutMs, 10000);
    assert.equal(providerRequests.length, 1);

    const localGrade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5927\u732b" })
    });
    assert.equal(localGrade.status, 200);
    assert.equal((await localGrade.json()).source, "local");
    assert.equal(providerRequests.length, 1);

    const omittedMeasureGrade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", variantId: "description-big-box", answer: "它是大箱子" })
    });
    assert.equal(omittedMeasureGrade.status, 200);
    const omittedMeasureBody = await omittedMeasureGrade.json();
    assert.equal(omittedMeasureBody.correct, true);
    assert.equal(omittedMeasureBody.score, 1);
    assert.equal(omittedMeasureBody.gradingStatus, "correct");
    assert.equal(omittedMeasureBody.source, "local");
    assert.match(omittedMeasureBody.detailedExplanation, /省略了可选/);
    assert.equal(providerRequests.length, 1);

    const partialGrade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d3-s3:en-zh", answer: "它是一只红色的笔" })
    });
    assert.equal(partialGrade.status, 200);
    const partialBody = await partialGrade.json();
    assert.equal(partialBody.correct, true);
    assert.equal(partialBody.gradingStatus, "partial");
    assert.equal(partialBody.score, 0.8);
    assert.deepEqual(partialBody.problemWords, []);
    assert.equal(providerRequests.length, 1);

    const grade = await fetch(`${baseUrl}/api/ai/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", answer: "\u5b83\u662f\u4e00\u53ea\u5f88\u5927\u7684\u732b", model: "strong-model", reasoningEffort: "high" })
    });
    assert.equal(grade.status, 200);
    const gradeBody = await grade.json();
    assert.equal(gradeBody.correct, true);
    assert.equal(gradeBody.score, 1);
    assert.equal(gradeBody.gradingStatus, "correct");
    assert.equal(gradeBody.explanation, "\u610f\u601d\u76f8\u540c\uff0c\u53ea\u662f\u8bf4\u6cd5\u4e0d\u540c\u3002");
    assert.equal(gradeBody.source, "ai");
    assert.equal(providerRequests.length, 2);
    assert.equal(providerRequests[1].url, "/v1/chat/completions");
    assert.equal(providerRequests[1].authorization, "Bearer private-test-key");
    assert.equal(providerRequests[1].body.model, "strong-model");
    assert.equal(providerRequests[1].body.reasoning_effort, "high");
    assert.deepEqual(providerRequests[1].body.response_format, { type: "json_object" });

    const stateUpdate = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        taskStates: { "d2-cat:en-zh": { level: 0, lastResult: false } },
        attempts: [{ taskId: "d2-cat:en-zh", answer: "\u72d7", correct: false }],
        mistakes: [{ id: "weak-cat", taskId: "d2-cat:en-zh", prompt: "cat", userAnswer: "\u72d7", correctAnswer: "\u732b" }]
      })
    });
    assert.equal(stateUpdate.status, 200);

    const generated = await fetch(`${baseUrl}/api/ai/questions/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ model: "strong-model", reasoningEffort: "high", count: 5, groupCount: 3 })
    });
    assert.equal(generated.status, 201);
    const generatedBody = await generated.json();
    const generatedSet = generatedBody.practice.currentSet;
    assert.equal(generatedSet.questions.length, 5);
    assert.equal(generatedSet.model, "strong-model");
    assert.equal(generatedSet.groupNumber, 1);
    assert.equal(generatedSet.groupCount, 3);
    assert.deepEqual(generatedBody.practice.queuedSets, []);
    assert.equal(generatedBody.practice.generationQueue.length, 1);
    assert.equal(generatedBody.practice.generationQueue[0].readyGroups, 2);
    assert.doesNotMatch(JSON.stringify(generatedBody.practice.generationQueue), /It is big|一只猫|acceptedChinese|acceptedEnglish/);
    assert.equal(generatedBody.settings.groupCount, 3);
    assert.equal(providerRequests.length, 3);
    const profile = JSON.parse(providerRequests[2].body.messages[1].content);
    assert.equal(profile.recentMistakes[0].correctAnswer, "\u732b");
    assert.equal(providerRequests[2].body.reasoning_effort, "high");

    const earlyNext = await fetch(`${baseUrl}/api/ai/questions/next`, { method: "POST", headers: { "Content-Type": "application/json", "Cookie": cookie }, body: "{}" });
    assert.equal(earlyNext.status, 409, "a prepared group must never start before the learner finishes the current group");
    const stateWithPreparedGroups = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.equal(stateWithPreparedGroups.aiPractice.generationQueue[0].readyGroups, 2);
    const legacySave = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ ...stateWithPreparedGroups, aiPractice: {} })
    });
    assert.equal(legacySave.status, 200);
    assert.equal((await legacySave.json()).aiPractice.generationQueue[0].readyGroups, 2, "an older page must not erase server-prepared groups");

    const answers = ["\u5b83\u975e\u5e38\u5927", "A cat sat on a mat.", "\u6211\u662f\u8428\u59c6", "It is a big pig.", "\u5979\u662f\u4e00\u4e2a\u5988\u5988"];
    for (let index = 0; index < generatedSet.questions.length; index += 1) {
      const draft = await fetch(`${baseUrl}/api/ai/questions/batch/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Cookie": cookie },
        body: JSON.stringify({ setId: generatedSet.id, questionId: generatedSet.questions[index].id, index, nextIndex: Math.min(index + 1, generatedSet.questions.length - 1), answer: answers[index] })
      });
      assert.equal(draft.status, 200);
    }
    const reviewResponse = await fetch(`${baseUrl}/api/ai/questions/batch/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ setId: generatedSet.id })
    });
    assert.equal(reviewResponse.status, 200);
    const reviewedSet = (await reviewResponse.json()).practice.currentSet;
    assert.equal(reviewedSet.phase, "review");
    assert.doesNotMatch(JSON.stringify(reviewedSet), /acceptedChinese|acceptedEnglish|correctAnswer|referenceAnswer/);
    const groupGrade = await fetch(`${baseUrl}/api/ai/questions/batch/grade`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ setId: generatedSet.id, gradeRequestId: reviewedSet.gradeRequestId })
    });
    assert.equal(groupGrade.status, 200);
    const groupResult = await groupGrade.json();
    const questionResult = { ...groupResult.practice.currentSet.questions[0], practice: groupResult.practice };
    assert.equal(questionResult.correct, true);
    assert.equal(questionResult.practice.currentSet.phase, "completed");
    assert.equal(questionResult.practice.history.length, 5);
    assert.equal(questionResult.practice.history[0].setId, generatedSet.id);
    assert.equal(questionResult.practice.history[0].model, "strong-model");
    assert.equal(questionResult.practice.history[0].reasoningEffort, "high");
    assert.equal(questionResult.practice.history[0].questionNumber, 1);
    assert.equal(questionResult.practice.history[0].questionCount, 5);
    assert.match(questionResult.practice.history[0].answeredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(providerRequests.length, 4);

    const tutorResponse = await fetch(`${baseUrl}/api/ai/questions/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ historyId: questionResult.practice.history[0].id, message: "这个句子应该先看哪里？", reasoningEffort: "low" })
    });
    assert.equal(tutorResponse.status, 200);
    const tutorBody = await tutorResponse.json();
    assert.equal(tutorBody.answer, "先看句子的主语和位置词，再自己试一次。");
    assert.equal(tutorBody.tutor.messages.length, 2);
    assert.equal(tutorBody.exchange.question, "这个句子应该先看哪里？");
    assert.equal(tutorBody.exchange.historyId, questionResult.practice.history[0].id);
    assert.deepEqual(tutorBody.tutorSettings, { providerId: "legacy-primary", model: "strong-model", reasoningEffort: "low" });
    assert.equal(providerRequests.length, 5);
    assert.equal(providerRequests[4].body.reasoning_effort, "low");
    assert.equal(Object.hasOwn(providerRequests[4].body, "response_format"), false);
    const tutorRequest = JSON.parse(providerRequests[4].body.messages[1].content);
    assert.equal(tutorRequest.exercise.answered, true);
    assert.equal(tutorRequest.exercise.learnerAnswer, "它非常大");
    assert.equal(tutorRequest.exercise.explanation, "意思相同，只是说法不同。");
    const stateAfterTutor = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.equal(stateAfterTutor.aiPractice.settings.reasoningEffort, "high");
    assert.equal(stateAfterTutor.aiPractice.tutorSettings.reasoningEffort, "low");
    assert.equal(stateAfterTutor.aiPractice.tutorHistory.length, 1);
    assert.equal(stateAfterTutor.aiPractice.tutorHistory[0].question, "这个句子应该先看哪里？");
    assert.equal(stateAfterTutor.aiPractice.tutorHistory[0].answer, "先看句子的主语和位置词，再自己试一次。");
    assert.equal(stateAfterTutor.aiPractice.tutor.historyId, questionResult.practice.history[0].id);
    assert.equal(stateAfterTutor.aiPractice.tutor.source, "history");

    const clearTutor = await fetch(`${baseUrl}/api/ai/questions/tutor/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ historyId: questionResult.practice.history[0].id })
    });
    assert.equal(clearTutor.status, 200);
    const clearedTutor = await clearTutor.json();
    assert.equal(clearedTutor.practice.tutorHistory.length, 1, "clearing context must retain the archived question and answer");
    assert.deepEqual(clearedTutor.practice.tutor.messages, []);
    assert.equal(clearedTutor.practice.tutorResets.length, 1);

    const restartedTutor = await fetch(`${baseUrl}/api/ai/questions/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ historyId: questionResult.practice.history[0].id, message: "现在重新解释一次。", reasoningEffort: "low" })
    });
    assert.equal(restartedTutor.status, 200);
    assert.equal(providerRequests.length, 6);
    const restartedTutorRequest = JSON.parse(providerRequests[5].body.messages[1].content);
    assert.deepEqual(restartedTutorRequest.conversation, [], "a cleared session must not send archived messages back to AI");
    const stateAfterRestart = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": cookie } })).json();
    assert.equal(stateAfterRestart.aiPractice.tutorHistory.length, 2);
    assert.equal(stateAfterRestart.aiPractice.tutorResets.length, 1);

    const reviewTutor = await fetch(`${baseUrl}/api/ai/questions/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s4:en-zh", message: "这道普通复习题应该看什么？", reasoningEffort: "low" })
    });
    assert.equal(reviewTutor.status, 200);
    const reviewTutorBody = await reviewTutor.json();
    assert.equal(reviewTutorBody.tutor.source, "review");
    assert.equal(reviewTutorBody.tutor.taskId, "d2-s4:en-zh");
    assert.equal(reviewTutorBody.tutor.variantId, "");
    assert.equal(reviewTutorBody.exchange.prompt, "It is a big cat.");
    assert.equal(reviewTutorBody.exchange.answered, false);
    assert.equal(JSON.parse(providerRequests.at(-1).body.messages[1].content).exercise.english, "It is a big cat.");

    const secondReviewTutor = await fetch(`${baseUrl}/api/ai/questions/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ taskId: "d2-s5:en-zh", message: "这不是上一道题。", reasoningEffort: "low" })
    });
    assert.equal(secondReviewTutor.status, 200);
    const secondReviewTutorBody = await secondReviewTutor.json();
    assert.notEqual(secondReviewTutorBody.tutor.questionId, reviewTutorBody.tutor.questionId);
    assert.equal(secondReviewTutorBody.exchange.prompt, "It is big.");
    assert.equal(JSON.parse(providerRequests.at(-1).body.messages[1].content).exercise.english, "It is big.");

    const preparedAdvanceRequestCount = providerRequests.length;
    const nextPrepared = await fetch(`${baseUrl}/api/ai/questions/next`, { method: "POST", headers: { "Content-Type": "application/json", "Cookie": cookie }, body: "{}" });
    assert.equal(nextPrepared.status, 200);
    const nextPreparedBody = await nextPrepared.json();
    assert.equal(nextPreparedBody.set.groupNumber, 2);
    assert.equal(nextPreparedBody.remainingGroups, 1);
    assert.equal(nextPreparedBody.practice.history.length, 5, "unanswered prepared groups must not enter practice history");
    assert.equal(providerRequests.length, preparedAdvanceRequestCount, "continuing a prepared group must not call AI again");

    const ownerRelogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "strong-ai-password" })
    });
    const ownerReloginCookie = ownerRelogin.headers.get("set-cookie").split(";")[0];
    const stateAfterRelogin = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": ownerReloginCookie } })).json();
    assert.equal(stateAfterRelogin.aiPractice.currentSet.groupNumber, 2);
    assert.equal(stateAfterRelogin.aiPractice.generationQueue[0].readyGroups, 1, "prepared groups must survive a fresh login");

    const unavailableGeneration = await fetch(`${baseUrl}/api/ai/questions/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ model: "missing-model", reasoningEffort: "high", count: 5 })
    });
    assert.equal(unavailableGeneration.status, 502);
    assert.deepEqual(await unavailableGeneration.json(), { error: "AI 上游不支持该模型的生成接口，请更换模型", providerStatus: 404 });

    for (const reasoningEffort of reviewEfforts) {
      const { response: reviewVariants, body: reviewBody, startStatus } = await requestReviewVariants(baseUrl, reviewVariantCookies.get(reasoningEffort), { taskIds: ["d4-s5:en-zh"], model: "strong-model", reasoningEffort, force: true });
      assert.equal(startStatus, 202);
      assert.equal(reviewVariants.status, 200);
      assert.equal(reviewBody.source, "ai");
      assert.equal(reviewBody.reasoningEffort, reasoningEffort);
      assert.equal(reviewBody.variants[0].english, "It is a hot box.");
      const reviewRequest = providerRequests.at(-1);
      assert.equal(reviewRequest.body.model, "strong-model");
      assert.equal(reviewRequest.body.reasoning_effort, reasoningEffort);
    }

    const repairStart = providerRequests.length;
    const repairedReview = await requestReviewVariants(baseUrl, reviewVariantCookies.get("repair"), {
      taskIds: ["d4-s5:en-zh", "d2-s3:en-zh"],
      model: "strong-model",
      reasoningEffort: "max",
      force: true
    });
    assert.equal(repairedReview.startStatus, 202);
    assert.equal(repairedReview.response.status, 200);
    assert.equal(repairedReview.body.status, "completed");
    assert.equal(repairedReview.body.repairRounds, 2);
    assert.deepEqual(repairedReview.body.variants.map(item => item.taskId), ["d4-s5:en-zh", "d2-s3:en-zh"]);
    const repairRequests = providerRequests.slice(repairStart).map(item => JSON.parse(item.body.messages[1].content));
    assert.deepEqual(repairRequests.map(item => item.targets.map(target => target.taskId)), [
      ["d4-s5:en-zh", "d2-s3:en-zh"],
      ["d2-s3:en-zh"]
    ]);
    assert.equal(repairRequests[1].validationFeedback[0].reasonCode, "unlearned-word");

    const rejectedStart = providerRequests.length;
    const rejectedReview = await requestReviewVariants(baseUrl, reviewVariantCookies.get("reject"), {
      taskIds: ["d2-s2:en-zh"],
      model: "strong-model",
      reasoningEffort: "max",
      force: true
    });
    assert.equal(rejectedReview.response.status, 200);
    assert.equal(rejectedReview.body.status, "needs-attention");
    assert.equal(rejectedReview.body.repairRounds, 3);
    assert.equal(rejectedReview.body.autoRetry, false);
    assert.equal(rejectedReview.body.retryAfterMs, 0);
    assert.equal(rejectedReview.body.variants.length, 0);
    assert.equal(rejectedReview.body.failures[0].reasonCode, "wrong-family");
    assert.equal(providerRequests.slice(rejectedStart).length, 3, "content repair must stop after three rounds");

    const memberLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "member", password: "strong-member-password" })
    });
    const memberCookie = memberLogin.headers.get("set-cookie").split(";")[0];
    const memberState = await (await fetch(`${baseUrl}/api/state`, { headers: { "Cookie": memberCookie } })).json();
    assert.equal(memberState.aiPractice.currentSet, null);
    assert.equal(memberState.aiPractice.tutor, null);
    assert.deepEqual(memberState.aiPractice.tutorHistory, []);
    assert.deepEqual(memberState.aiPractice.tutorResets, []);
    assert.deepEqual(memberState.aiPractice.history, []);
    const memberOptions = await (await fetch(`${baseUrl}/api/ai/options`, { headers: { "Cookie": memberCookie } })).json();
    assert.equal(memberOptions.selectedModel, "test-model");
    assert.equal(memberOptions.selectedEffort, "medium");
    const forbidden = await fetch(`${baseUrl}/api/admin/ai-config`, { headers: { "Cookie": memberCookie } });
    assert.equal(forbidden.status, 403);
    const forbiddenModels = await fetch(`${baseUrl}/api/admin/ai-config/models`, { method: "POST", headers: { "Content-Type": "application/json", "Cookie": memberCookie }, body: "{}" });
    assert.equal(forbiddenModels.status, 403);
  } finally {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
