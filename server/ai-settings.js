"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildChatCompletionsUrl } = require("./ai-grader");

const SETTINGS_FILE = "ai-settings.json";
const AI_EFFORTS = ["low", "medium", "high"];

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeModels(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  const models = [];
  const seen = new Set();
  source.forEach(item => {
    const model = String(item || "").trim();
    if (!model || model.length > 120 || seen.has(model)) return;
    seen.add(model);
    models.push(model);
  });
  return models.slice(0, 50);
}

function configurationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeSettings(input, previous = {}) {
  const source = input && typeof input === "object" ? input : {};
  const baseUrl = String(source.baseUrl ?? previous.baseUrl ?? "").trim();
  const apiKeyInput = String(source.apiKey || "").trim();
  const apiKey = apiKeyInput || String(previous.apiKey || "").trim();
  const models = normalizeModels(source.models !== undefined ? source.models : previous.models);
  const requestedDefault = String(source.defaultModel ?? previous.defaultModel ?? "").trim();
  const defaultModel = models.includes(requestedDefault) ? requestedDefault : (models[0] || "");
  const timeoutMs = boundedInteger(source.timeoutMs, boundedInteger(previous.timeoutMs, 10000, 1000, 30000), 1000, 30000);
  const rateLimitPerMinute = boundedInteger(source.rateLimitPerMinute, boundedInteger(previous.rateLimitPerMinute, 20, 1, 60), 1, 60);

  if (!baseUrl) throw configurationError("Base URL is required");
  try { buildChatCompletionsUrl(baseUrl); }
  catch (_) { throw configurationError("Base URL must be a valid HTTP or HTTPS URL"); }
  if (!apiKey) throw configurationError("API key is required");
  if (!models.length) throw configurationError("at least one model is required");

  return {
    schema: 1,
    baseUrl,
    apiKey,
    models,
    defaultModel,
    timeoutMs,
    rateLimitPerMinute,
    updatedAt: String(source.updatedAt || previous.updatedAt || new Date().toISOString())
  };
}

function publicSettings(settings, source = "web") {
  const configured = Boolean(settings && settings.baseUrl && settings.apiKey && settings.defaultModel);
  return {
    configured,
    source: configured ? source : "none",
    baseUrl: configured ? settings.baseUrl : "",
    hasApiKey: Boolean(settings && settings.apiKey),
    models: configured ? [...settings.models] : [],
    defaultModel: configured ? settings.defaultModel : "",
    timeoutMs: configured ? settings.timeoutMs : 10000,
    rateLimitPerMinute: configured ? settings.rateLimitPerMinute : 20,
    efforts: [...AI_EFFORTS],
    updatedAt: configured ? String(settings.updatedAt || "") : ""
  };
}

function createAiSettingsStore(dataDir) {
  const filePath = path.join(dataDir, SETTINGS_FILE);

  function readStored() {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeSettings(value, value);
    } catch (_) {
      return null;
    }
  }

  function loadWithSource() {
    const stored = readStored();
    if (stored) return { settings: stored, source: "web" };
    return { settings: null, source: "none" };
  }

  function save(input) {
    fs.mkdirSync(dataDir, { recursive: true });
    const previous = loadWithSource().settings || {};
    const settings = normalizeSettings({ ...input, updatedAt: new Date().toISOString() }, previous);
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return settings;
  }

  return {
    filePath,
    load: () => loadWithSource().settings,
    loadWithSource,
    public: () => {
      const current = loadWithSource();
      return publicSettings(current.settings, current.source);
    },
    save
  };
}

function selectAiSettings(settings, requested = {}) {
  if (!settings) throw Object.assign(new Error("AI is not configured"), { statusCode: 503 });
  const model = String(requested.model || settings.defaultModel || "").trim();
  if (!settings.models.includes(model)) throw configurationError("selected model is not allowed");
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : "medium";
  return {
    apiKey: settings.apiKey,
    configured: true,
    endpoint: buildChatCompletionsUrl(settings.baseUrl),
    model,
    reasoningEffort,
    timeoutMs: settings.timeoutMs,
    rateLimitPerMinute: settings.rateLimitPerMinute
  };
}

module.exports = {
  AI_EFFORTS,
  createAiSettingsStore,
  normalizeModels,
  normalizeSettings,
  publicSettings,
  selectAiSettings
};
