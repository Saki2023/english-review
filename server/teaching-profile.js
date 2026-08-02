"use strict";

function cleanText(value, maximum = 12000) {
  return Array.from(String(value || "").replace(/\u0000/g, "").trim()).slice(0, maximum).join("");
}

function cleanName(value) {
  return cleanText(value, 120).replace(/[\\/:*?"<>|]/g, "_");
}

function sanitizeDocument(value, maximum = 10000) {
  const source = value && typeof value === "object" ? value : {};
  const content = cleanText(source.content, maximum);
  return content ? { name: cleanName(source.name) || "未命名文档", content } : null;
}

function sanitizeDocuments(values, maximumItems = 30) {
  const documents = (Array.isArray(values) ? values : []).map(item => sanitizeDocument(item, 10000)).filter(Boolean);
  const unique = new Map();
  documents.forEach(document => unique.set(document.name, document));
  return Array.from(unique.values()).slice(-maximumItems);
}

function sanitizeTeachingProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  const explicitPreview = sanitizeDocument(source.preview, 10000);
  const previewHistory = sanitizeDocuments(source.previews, 30);
  if (explicitPreview) {
    const existing = previewHistory.findIndex(document => document.name === explicitPreview.name);
    if (existing >= 0) previewHistory[existing] = explicitPreview;
    else previewHistory.push(explicitPreview);
  }
  const previews = previewHistory.slice(-30);
  const preview = explicitPreview || previews.at(-1) || null;
  return {
    schemaVersion: 1,
    updatedAt: cleanText(source.updatedAt, 40),
    progress: sanitizeDocument(source.progress, 16000),
    mistakes: sanitizeDocument(source.mistakes, 16000),
    recentNotes: (Array.isArray(source.recentNotes) ? source.recentNotes : []).map(item => sanitizeDocument(item, 10000)).filter(Boolean).slice(0, 5),
    preview,
    previews,
    teachingFocus: (Array.isArray(source.teachingFocus) ? source.teachingFocus : []).map(item => cleanText(item, 240)).filter(Boolean).slice(0, 20),
    nextPlan: cleanText(source.nextPlan, 3000)
  };
}

function publicTeachingProfile(value) {
  return sanitizeTeachingProfile(value);
}

function excerpt(value, maximum) {
  const text = cleanText(value, maximum);
  return text.length < maximum ? text : `${text.slice(0, Math.max(0, maximum - 12))}\n[内容已截断]`;
}

function teachingProfileForAi(value) {
  const profile = sanitizeTeachingProfile(value);
  const present = Boolean(profile.progress || profile.mistakes || profile.recentNotes.length || profile.preview || profile.teachingFocus.length || profile.nextPlan);
  if (!present) return null;
  return {
    updatedAt: profile.updatedAt,
    progress: profile.progress ? { name: profile.progress.name, content: excerpt(profile.progress.content, 6000) } : null,
    mistakes: profile.mistakes ? { name: profile.mistakes.name, content: excerpt(profile.mistakes.content, 6000) } : null,
    recentNotes: profile.recentNotes.slice(-3).map(item => ({ name: item.name, content: excerpt(item.content, 3500) })),
    preview: profile.preview ? { name: profile.preview.name, content: excerpt(profile.preview.content, 5000) } : null,
    teachingFocus: profile.teachingFocus,
    nextPlan: excerpt(profile.nextPlan, 2500)
  };
}

module.exports = { publicTeachingProfile, sanitizeTeachingProfile, teachingProfileForAi };
