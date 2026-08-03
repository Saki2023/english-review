"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAiSettingsStore, normalizeSettings, selectAiCandidates, selectAiSettings } = require("../server/ai-settings");

test("multi-provider settings preserve keys, redact secrets, and keep manual routing fixed", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-settings-"));
  try {
    const store = createAiSettingsStore(dataDir);
    assert.equal(store.public().configured, false);
    assert.equal(store.public().timeoutMs, 30000);
    assert.equal(Object.hasOwn(store.public(), "apiKey"), false);

    store.save({
      schema: 2,
      mode: "manual",
      manualProviderId: "sub2api",
      providers: [
        { id: "sub2api", name: "sub2api", enabled: true, baseUrl: "https://sub2api.example/v1", apiKey: "private-sub2api-key", models: ["shared-model", "sub-model"], timeoutMs: 12000 },
        { id: "newapi", name: "NewAPI", enabled: true, baseUrl: "https://newapi.example/v1", apiKey: "private-newapi-key", models: ["shared-model", "new-model"], timeoutMs: 18000 }
      ],
      defaultModel: "sub-model",
      rateLimitPerMinute: 15
    });
    const visible = store.public();
    assert.equal(visible.configured, true);
    assert.equal(visible.schema, 2);
    assert.equal(visible.mode, "manual");
    assert.equal(visible.hasApiKey, true);
    assert.equal(visible.defaultModel, "sub-model");
    assert.deepEqual(visible.availableModels, ["shared-model", "sub-model"]);
    assert.equal(visible.providers.length, 2);
    assert.equal(visible.providers.every(provider => provider.hasApiKey), true);
    assert.deepEqual(visible.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(JSON.stringify(visible).includes("private-sub2api-key"), false);
    assert.equal(JSON.stringify(visible).includes("private-newapi-key"), false);

    const manualRoute = selectAiCandidates(store.load(), { model: "shared-model", reasoningEffort: "max" });
    assert.equal(manualRoute.mode, "manual");
    assert.deepEqual(manualRoute.candidates.map(provider => provider.providerId), ["sub2api"]);
    assert.equal(manualRoute.candidates[0].reasoningEffort, "max");
    assert.equal(manualRoute.candidates[0].upstreamReasoningEffort, "max");
    assert.equal(manualRoute.candidates[0].providerFamily, "openai-compatible");
    assert.equal(manualRoute.candidates[0].timeoutMs, 12000);

    const testedProvider = selectAiCandidates(store.load(), { providerId: "newapi", model: "new-model" }, { allowDisabledProvider: true });
    assert.deepEqual(testedProvider.candidates.map(provider => provider.providerId), ["newapi"]);
    assert.equal(testedProvider.mode, "manual");

    store.save({
      mode: "manual",
      manualProviderId: "sub2api",
      providers: visible.providers.map(provider => ({ ...provider, apiKey: "" })),
      defaultModel: "shared-model",
      rateLimitPerMinute: 15
    });
    assert.equal(store.load().providers[0].apiKey, "private-sub2api-key");
    assert.equal(store.load().providers[1].apiKey, "private-newapi-key");
    assert.equal(selectAiSettings(store.load(), { model: "shared-model" }).providerId, "sub2api");
    assert.throws(() => selectAiSettings(store.load(), { model: "not-allowed" }), /not allowed/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("official DeepSeek V4 models map all five UI efforts and extend reasoning timeouts", () => {
  const settings = normalizeSettings({
    mode: "manual",
    providers: [{
      id: "deepseek",
      name: "DeepSeek",
      enabled: true,
      baseUrl: "https://api.deepseek.com",
      apiKey: "private-deepseek-key",
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      timeoutMs: 30000
    }],
    manualProviderId: "deepseek",
    defaultModel: "deepseek-v4-flash"
  });
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const flashExpected = ["low", "high", "high", "high", "max"];
  const proExpected = ["high", "high", "high", "max", "max"];

  function routes(model) {
    return efforts.map(reasoningEffort => selectAiCandidates(settings, { model, reasoningEffort }));
  }

  const flashRoutes = routes("deepseek-v4-flash");
  const proRoutes = routes("deepseek-v4-pro");
  assert.deepEqual(flashRoutes.map(route => route.reasoningEffort), efforts);
  assert.deepEqual(flashRoutes.map(route => route.candidates[0].upstreamReasoningEffort), flashExpected);
  assert.deepEqual(flashRoutes.map(route => route.candidates[0].timeoutMs), [30000, 90000, 90000, 90000, 120000]);
  assert.deepEqual(proRoutes.map(route => route.reasoningEffort), efforts);
  assert.deepEqual(proRoutes.map(route => route.candidates[0].upstreamReasoningEffort), proExpected);
  assert.deepEqual(proRoutes.map(route => route.candidates[0].timeoutMs), [90000, 90000, 90000, 120000, 120000]);
  assert.equal(flashRoutes.every(route => route.candidates[0].providerFamily === "deepseek"), true);
});

test("automatic routing rotates enabled providers that support the selected model", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-settings-"));
  try {
    const store = createAiSettingsStore(dataDir);
    store.save({
      mode: "auto",
      providers: [
        { id: "first", name: "First", enabled: true, baseUrl: "https://first.example/v1", apiKey: "first-key", models: ["shared"], timeoutMs: 10000 },
        { id: "skipped", name: "Skipped", enabled: true, baseUrl: "https://skipped.example/v1", apiKey: "skipped-key", models: ["other"], timeoutMs: 10000 },
        { id: "second", name: "Second", enabled: true, baseUrl: "https://second.example/v1", apiKey: "second-key", models: ["shared"], timeoutMs: 10000 }
      ],
      defaultModel: "shared"
    });
    assert.deepEqual(selectAiCandidates(store.load(), { model: "shared" }).candidates.map(provider => provider.providerId), ["first", "second"]);
    store.advanceRotation("first");
    assert.deepEqual(selectAiCandidates(store.load(), { model: "shared" }).candidates.map(provider => provider.providerId), ["second", "first"]);
    store.advanceRotation("second");
    assert.deepEqual(selectAiCandidates(store.load(), { model: "shared" }).candidates.map(provider => provider.providerId), ["first", "second"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("legacy single-provider settings migrate to schema 2 without exposing the key", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-settings-"));
  try {
    fs.writeFileSync(path.join(dataDir, "ai-settings.json"), JSON.stringify({
      schema: 1,
      baseUrl: "https://legacy.example/v1",
      apiKey: "legacy-private-key",
      models: ["legacy-model"],
      defaultModel: "legacy-model",
      timeoutMs: 9000,
      rateLimitPerMinute: 9
    }));
    const store = createAiSettingsStore(dataDir);
    const loaded = store.load();
    assert.equal(loaded.schema, 2);
    assert.equal(loaded.mode, "manual");
    assert.equal(loaded.providers[0].apiKey, "legacy-private-key");
    assert.equal(loaded.providers[0].baseUrl, "https://legacy.example/v1");
    const migratedFile = JSON.parse(fs.readFileSync(path.join(dataDir, "ai-settings.json"), "utf8"));
    assert.equal(migratedFile.schema, 2);
    assert.equal(Array.isArray(migratedFile.providers), true);
    assert.equal(JSON.stringify(store.public()).includes("legacy-private-key"), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("AI connection settings cannot be loaded from environment variables", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-settings-"));
  try {
    const store = createAiSettingsStore(dataDir, {
      AI_BASE_URL: "https://ignored.example/v1",
      AI_API_KEY: "ignored-key",
      AI_MODEL: "ignored-model"
    });
    assert.equal(store.load(), null);
    assert.equal(store.public().configured, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
