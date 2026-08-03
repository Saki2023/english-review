"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { buildChatCompletionsUrl, buildModelsUrl, buildResponsesUrl } = require("./ai-grader");

const SETTINGS_FILE = "ai-settings.json";
const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const AI_ROUTING_MODES = ["manual", "auto"];
const DEFAULT_AI_TIMEOUT_MS = 30000;
const MAX_AI_TIMEOUT_MS = 120000;
const DEEPSEEK_HIGH_TIMEOUT_MS = 90000;
const MAX_AI_MODELS = 200;
const MAX_AI_PROVIDERS = 20;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function cleanText(value, maximum) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function normalizeModels(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  const models = [];
  const seen = new Set();
  source.forEach(item => {
    const model = String(typeof item === "string" ? item : (item && (item.id || item.name)) || "").trim();
    if (!model || model.length > 120 || seen.has(model)) return;
    seen.add(model);
    models.push(model);
  });
  return models.slice(0, MAX_AI_MODELS);
}

function configurationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeProviderId(value, fallback = "") {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) ? id : fallback;
}

function legacyProvider(value) {
  if (!value || typeof value !== "object" || !value.baseUrl) return null;
  return {
    id: "legacy-primary",
    name: cleanText(value.providerName || "默认供应商", 60),
    enabled: true,
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
    models: value.models,
    timeoutMs: value.timeoutMs,
    updatedAt: value.updatedAt
  };
}

function rawProviders(value) {
  if (value && Array.isArray(value.providers)) return value.providers;
  const legacy = legacyProvider(value);
  return legacy ? [legacy] : [];
}

function normalizeProvider(input, previous = {}, index = 0) {
  const source = input && typeof input === "object" ? input : {};
  const prior = previous && typeof previous === "object" ? previous : {};
  const id = normalizeProviderId(source.id, normalizeProviderId(prior.id)) || `provider-${crypto.randomUUID()}`;
  const name = cleanText(source.name ?? prior.name ?? `供应商 ${index + 1}`, 60);
  const baseUrl = String(source.baseUrl ?? prior.baseUrl ?? "").trim();
  const apiKey = String(source.apiKey || prior.apiKey || "").trim();
  const models = normalizeModels(source.models !== undefined ? source.models : prior.models);
  const timeoutMs = boundedInteger(source.timeoutMs, boundedInteger(prior.timeoutMs, DEFAULT_AI_TIMEOUT_MS, 1000, MAX_AI_TIMEOUT_MS), 1000, MAX_AI_TIMEOUT_MS);
  const enabled = source.enabled !== undefined ? Boolean(source.enabled) : prior.enabled !== undefined ? Boolean(prior.enabled) : true;

  if (!name) throw configurationError("provider name is required");
  if (!baseUrl) throw configurationError(`Base URL is required for ${name}`);
  if (baseUrl.length > 2048) throw configurationError(`Base URL is too long for ${name}`);
  try { buildModelsUrl(baseUrl); }
  catch (_) { throw configurationError(`Base URL must be a valid HTTP or HTTPS URL for ${name}`); }
  if (!apiKey) throw configurationError(`API key is required for ${name}`);
  if (apiKey.length > 500) throw configurationError(`API key is too long for ${name}`);
  if (!models.length) throw configurationError(`at least one model is required for ${name}`);

  return {
    id,
    name,
    enabled,
    baseUrl,
    apiKey,
    models,
    timeoutMs,
    updatedAt: String(source.updatedAt || prior.updatedAt || new Date().toISOString())
  };
}

function enabledProviders(settings) {
  return settings && Array.isArray(settings.providers) ? settings.providers.filter(provider => provider.enabled) : [];
}

function manualProvider(settings) {
  const providers = enabledProviders(settings);
  return providers.find(provider => provider.id === settings.manualProviderId) || providers[0] || null;
}

function routingProviders(settings) {
  if (!settings) return [];
  return settings.mode === "auto" ? enabledProviders(settings) : [manualProvider(settings)].filter(Boolean);
}

function getAvailableModels(settings) {
  const models = [];
  const seen = new Set();
  routingProviders(settings).forEach(provider => provider.models.forEach(model => {
    if (seen.has(model) || models.length >= MAX_AI_MODELS) return;
    seen.add(model);
    models.push(model);
  }));
  return models.sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }));
}

function normalizeSettings(input, previous = {}) {
  const source = input && typeof input === "object" ? input : {};
  const prior = previous && typeof previous === "object" ? previous : {};
  const previousProviders = rawProviders(prior);
  const previousById = new Map(previousProviders.map(provider => [String(provider.id || ""), provider]));
  let requestedProviders;

  if (Array.isArray(source.providers)) requestedProviders = source.providers;
  else if (source.baseUrl !== undefined || source.apiKey !== undefined || source.models !== undefined) {
    const targetId = normalizeProviderId(source.providerId, normalizeProviderId(prior.manualProviderId)) || String(previousProviders[0] && previousProviders[0].id || "legacy-primary");
    if (previousProviders.length) {
      requestedProviders = previousProviders.map(provider => provider.id === targetId ? {
        ...provider,
        name: source.providerName ?? provider.name,
        baseUrl: source.baseUrl ?? provider.baseUrl,
        apiKey: source.apiKey || provider.apiKey,
        models: source.models ?? provider.models,
        timeoutMs: source.timeoutMs ?? provider.timeoutMs
      } : provider);
    } else requestedProviders = [{ id: targetId, name: source.providerName || "默认供应商", enabled: true, ...source }];
  } else requestedProviders = previousProviders;

  if (!requestedProviders.length) throw configurationError("at least one provider is required");
  if (requestedProviders.length > MAX_AI_PROVIDERS) throw configurationError(`no more than ${MAX_AI_PROVIDERS} providers are allowed`);

  const providers = requestedProviders.map((provider, index) => {
    const previousProvider = previousById.get(String(provider && provider.id || "")) || {};
    return normalizeProvider(provider, previousProvider, index);
  });
  const ids = new Set();
  providers.forEach(provider => {
    if (ids.has(provider.id)) throw configurationError("provider IDs must be unique");
    ids.add(provider.id);
  });

  const mode = AI_ROUTING_MODES.includes(source.mode) ? source.mode : AI_ROUTING_MODES.includes(prior.mode) ? prior.mode : "manual";
  const activeProviders = providers.filter(provider => provider.enabled);
  const requestedManualId = normalizeProviderId(source.manualProviderId, normalizeProviderId(prior.manualProviderId));
  const manualProviderId = (activeProviders.find(provider => provider.id === requestedManualId) || activeProviders[0] || providers[0]).id;
  const partial = { mode, manualProviderId, providers };
  const availableModels = getAvailableModels(partial);
  const requestedDefault = String(source.defaultModel ?? prior.defaultModel ?? "").trim();
  const defaultModel = availableModels.includes(requestedDefault) ? requestedDefault : (availableModels[0] || "");

  return {
    schema: 2,
    mode,
    manualProviderId,
    rotationCursor: boundedInteger(source.rotationCursor, boundedInteger(prior.rotationCursor, 0, 0, Number.MAX_SAFE_INTEGER), 0, Number.MAX_SAFE_INTEGER),
    providers,
    defaultModel,
    rateLimitPerMinute: boundedInteger(source.rateLimitPerMinute, boundedInteger(prior.rateLimitPerMinute, 20, 1, 60), 1, 60),
    updatedAt: String(source.updatedAt || prior.updatedAt || new Date().toISOString()),
    rotationUpdatedAt: String(source.rotationUpdatedAt || prior.rotationUpdatedAt || "")
  };
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    hasApiKey: Boolean(provider.apiKey),
    models: [...provider.models],
    timeoutMs: provider.timeoutMs,
    updatedAt: String(provider.updatedAt || "")
  };
}

function publicSettings(settings, source = "web") {
  const configured = Boolean(settings && getAvailableModels(settings).length && routingProviders(settings).length);
  const active = settings ? manualProvider(settings) || settings.providers[0] : null;
  return {
    schema: 2,
    configured,
    source: configured ? source : "none",
    mode: settings ? settings.mode : "manual",
    manualProviderId: settings ? settings.manualProviderId : "",
    rotationCursor: settings ? settings.rotationCursor : 0,
    providers: settings ? settings.providers.map(publicProvider) : [],
    availableModels: settings ? getAvailableModels(settings) : [],
    defaultModel: configured ? settings.defaultModel : "",
    rateLimitPerMinute: settings ? settings.rateLimitPerMinute : 20,
    efforts: [...AI_EFFORTS],
    updatedAt: settings ? String(settings.updatedAt || "") : "",
    baseUrl: active ? active.baseUrl : "",
    hasApiKey: Boolean(active && active.apiKey),
    models: active ? [...active.models] : [],
    timeoutMs: active ? active.timeoutMs : DEFAULT_AI_TIMEOUT_MS
  };
}

function resolveAiConnection(settings, requested = {}) {
  const source = requested && typeof requested === "object" ? requested : {};
  const providers = rawProviders(settings);
  const requestedId = normalizeProviderId(source.providerId, normalizeProviderId(source.id));
  const previous = providers.find(provider => provider.id === requestedId) || providers.find(provider => provider.id === settings?.manualProviderId) || providers[0] || {};
  const providerId = requestedId || previous.id || "";
  const providerName = cleanText(source.name || source.providerName || previous.name || "供应商", 60);
  const baseUrl = String(source.baseUrl ?? previous.baseUrl ?? "").trim();
  const apiKey = String(source.apiKey || previous.apiKey || "").trim();
  const timeoutMs = boundedInteger(source.timeoutMs, boundedInteger(previous.timeoutMs, DEFAULT_AI_TIMEOUT_MS, 1000, MAX_AI_TIMEOUT_MS), 1000, MAX_AI_TIMEOUT_MS);

  if (!baseUrl) throw configurationError("Base URL is required");
  if (baseUrl.length > 2048) throw configurationError("Base URL is too long");
  let endpoint;
  try { endpoint = buildModelsUrl(baseUrl); }
  catch (_) { throw configurationError("Base URL must be a valid HTTP or HTTPS URL"); }
  if (!apiKey) throw configurationError("API key is required");
  if (apiKey.length > 500) throw configurationError("API key is too long");

  return { providerId, providerName, baseUrl, apiKey, configured: true, endpoint, timeoutMs };
}

function providerFamily(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLocaleLowerCase() === "api.deepseek.com" ? "deepseek" : "openai-compatible";
  } catch (_) {
    return "openai-compatible";
  }
}

function deepSeekReasoningEffort(model, reasoningEffort) {
  const isV4Pro = String(model || "").trim().toLocaleLowerCase() === "deepseek-v4-pro";
  if (isV4Pro) return ["xhigh", "max"].includes(reasoningEffort) ? "max" : "high";
  if (reasoningEffort === "low") return "low";
  if (reasoningEffort === "max") return "max";
  return "high";
}

function providerConfig(settings, provider, model, reasoningEffort) {
  const family = providerFamily(provider.baseUrl);
  const upstreamReasoningEffort = family === "deepseek" ? deepSeekReasoningEffort(model, reasoningEffort) : reasoningEffort;
  const minimumTimeoutMs = family !== "deepseek"
    ? 0
    : upstreamReasoningEffort === "low"
      ? DEFAULT_AI_TIMEOUT_MS
      : upstreamReasoningEffort === "max"
        ? MAX_AI_TIMEOUT_MS
        : DEEPSEEK_HIGH_TIMEOUT_MS;
  return {
    providerId: provider.id,
    providerName: provider.name,
    providerFamily: family,
    apiKey: provider.apiKey,
    configured: true,
    endpoint: buildChatCompletionsUrl(provider.baseUrl),
    responsesEndpoint: buildResponsesUrl(provider.baseUrl),
    model,
    reasoningEffort,
    upstreamReasoningEffort,
    timeoutMs: Math.min(MAX_AI_TIMEOUT_MS, Math.max(provider.timeoutMs, minimumTimeoutMs)),
    rateLimitPerMinute: settings.rateLimitPerMinute
  };
}

function selectAiCandidates(settings, requested = {}, options = {}) {
  if (!settings) throw Object.assign(new Error("AI is not configured"), { statusCode: 503 });
  const reasoningEffort = AI_EFFORTS.includes(requested.reasoningEffort) ? requested.reasoningEffort : "medium";
  const requestedProviderId = normalizeProviderId(requested.providerId);
  let model;
  let candidates;

  if (requestedProviderId) {
    const provider = settings.providers.find(item => item.id === requestedProviderId);
    if (!provider) throw configurationError("selected provider was not found");
    if (!provider.enabled && !options.allowDisabledProvider) throw configurationError("selected provider is not enabled");
    model = String(requested.model || (provider.models.includes(settings.defaultModel) ? settings.defaultModel : provider.models[0]) || "").trim();
    if (!provider.models.includes(model)) throw configurationError("selected provider does not support the model");
    candidates = [provider];
  } else {
    model = String(requested.model || settings.defaultModel || "").trim();
    const availableModels = getAvailableModels(settings);
    if (!availableModels.includes(model)) throw configurationError("selected model is not allowed");
  }

  if (!requestedProviderId && settings.mode === "manual") {
    const provider = manualProvider(settings);
    if (!provider || !provider.models.includes(model)) throw configurationError("manual provider does not support the model");
    candidates = [provider];
  } else if (!requestedProviderId) {
    const providers = enabledProviders(settings);
    const cursor = providers.length ? settings.rotationCursor % providers.length : 0;
    const ordered = [...providers.slice(cursor), ...providers.slice(0, cursor)];
    candidates = ordered.filter(provider => provider.models.includes(model));
    if (!candidates.length) throw configurationError("no enabled provider supports the model");
  }

  return {
    mode: requestedProviderId ? "manual" : settings.mode,
    model,
    reasoningEffort,
    candidates: candidates.map(provider => providerConfig(settings, provider, model, reasoningEffort))
  };
}

function selectAiSettings(settings, requested = {}) {
  return selectAiCandidates(settings, requested).candidates[0];
}

function createAiSettingsStore(dataDir) {
  const filePath = path.join(dataDir, SETTINGS_FILE);

  function write(settings) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}-${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return settings;
  }

  function readStored() {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const settings = normalizeSettings(value, value);
      if (value.schema !== 2 || !Array.isArray(value.providers)) write(settings);
      return settings;
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
    const previous = loadWithSource().settings || {};
    return write(normalizeSettings({ ...input, updatedAt: new Date().toISOString() }, previous));
  }

  function advanceRotation(providerId) {
    const settings = loadWithSource().settings;
    if (!settings || settings.mode !== "auto") return settings;
    const providers = enabledProviders(settings);
    const index = providers.findIndex(provider => provider.id === providerId);
    if (index < 0) return settings;
    settings.rotationCursor = (index + 1) % providers.length;
    settings.rotationUpdatedAt = new Date().toISOString();
    return write(settings);
  }

  return {
    filePath,
    load: () => loadWithSource().settings,
    loadWithSource,
    public: () => {
      const current = loadWithSource();
      return publicSettings(current.settings, current.source);
    },
    save,
    advanceRotation
  };
}

module.exports = {
  AI_EFFORTS,
  AI_ROUTING_MODES,
  DEFAULT_AI_TIMEOUT_MS,
  MAX_AI_PROVIDERS,
  MAX_AI_TIMEOUT_MS,
  createAiSettingsStore,
  getAvailableModels,
  normalizeModels,
  normalizeSettings,
  publicSettings,
  resolveAiConnection,
  selectAiCandidates,
  selectAiSettings
};
