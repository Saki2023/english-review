"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAiSettingsStore, selectAiSettings } = require("../server/ai-settings");

test("web AI settings persist the key without returning it to clients", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-ai-settings-"));
  try {
    const store = createAiSettingsStore(dataDir);
    assert.equal(store.public().configured, false);
    assert.equal(store.public().timeoutMs, 30000);
    assert.equal(Object.hasOwn(store.public(), "apiKey"), false);

    store.save({
      baseUrl: "https://sub2api.example/v1",
      apiKey: "private-web-key",
      models: ["model-fast", "model-strong"],
      defaultModel: "model-strong",
      timeoutMs: 12000,
      rateLimitPerMinute: 15
    });
    const visible = store.public();
    assert.equal(visible.configured, true);
    assert.equal(visible.hasApiKey, true);
    assert.equal(visible.defaultModel, "model-strong");
    assert.deepEqual(visible.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(JSON.stringify(visible).includes("private-web-key"), false);

    store.save({ models: ["model-fast"], defaultModel: "model-fast", apiKey: "" });
    assert.equal(store.load().apiKey, "private-web-key");
    assert.equal(store.load().defaultModel, "model-fast");
    assert.equal(selectAiSettings(store.load(), { model: "model-fast", reasoningEffort: "max" }).reasoningEffort, "max");
    assert.throws(() => selectAiSettings(store.load(), { model: "not-allowed" }), /not allowed/);
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
