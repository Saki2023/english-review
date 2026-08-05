"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_DIR = path.resolve(__dirname, "..", "audio", "phonemes");
const USER_AGENT = "DailyEnglishReview/1.0 (pronunciation audio import)";
const FETCH_SOURCE_METADATA = process.env.FETCH_SOURCE_METADATA === "1";
const SOURCES = [
  ["v-close-front.ogg", "Close front unrounded vowel.ogg"],
  ["v-near-close-front.ogg", "Near-close near-front unrounded vowel.ogg"],
  ["v-open-mid-front.ogg", "Open-mid front unrounded vowel.ogg"],
  ["v-near-open-front.ogg", "Near-open front unrounded vowel.ogg"],
  ["v-open-back.ogg", "Open back unrounded vowel.ogg"],
  ["v-open-mid-back-rounded.ogg", "Open-mid back rounded vowel.ogg"],
  ["v-near-close-back-rounded.ogg", "Near-close near-back rounded vowel.ogg"],
  ["v-close-back-rounded.ogg", "Close back rounded vowel.ogg"],
  ["v-open-mid-back-unrounded.ogg", "Open-mid back unrounded vowel.ogg"],
  ["v-mid-central.ogg", "Mid-central vowel.ogg"],
  ["v-open-mid-central.ogg", "Open-mid central unrounded vowel.ogg"],
  ["v-close-mid-front.ogg", "Close-mid front unrounded vowel.ogg"],
  ["v-open-front.ogg", "Open front unrounded vowel.ogg"],
  ["v-close-mid-back.ogg", "Close-mid back rounded vowel.ogg"],
  ["v-r-colored.ogg", "PR-r-coloured open-mid central unrounded vowel.ogg"],
  ["v-au.wav", "LL-Q1860 (eng)-Pvanp7-aʊ (diphthong).wav"],
  ["v-ea.wav", "LL-Q1860 (eng)-Pvanp7-ɛə (diphthong).wav"],
  ["v-ua.wav", "LL-Q1860 (eng)-Pvanp7-ʊə (diphthong).wav"],
  ["c-p.ogg", "Voiceless bilabial plosive.ogg"],
  ["c-b.ogg", "Voiced bilabial plosive.ogg"],
  ["c-t.ogg", "Voiceless alveolar plosive.ogg"],
  ["c-d.ogg", "Voiced alveolar plosive.ogg"],
  ["c-k.ogg", "Voiceless velar plosive.ogg"],
  ["c-g.ogg", "Voiced velar plosive 02.ogg"],
  ["c-f.ogg", "Voiceless labiodental fricative.ogg"],
  ["c-v.ogg", "Voiced labiodental fricative.ogg"],
  ["c-th-voiceless.ogg", "Voiceless dental fricative.ogg"],
  ["c-th-voiced.ogg", "Voiced dental fricative.ogg"],
  ["c-s.ogg", "Voiceless alveolar sibilant.ogg"],
  ["c-z.ogg", "Voiced alveolar sibilant.ogg"],
  ["c-sh.ogg", "Voiceless palato-alveolar sibilant.ogg"],
  ["c-zh.ogg", "Voiced palato-alveolar sibilant.ogg"],
  ["c-h.ogg", "Voiceless glottal fricative.ogg"],
  ["c-ch.ogg", "Voiceless palato-alveolar affricate.ogg"],
  ["c-j.ogg", "Voiced palato-alveolar affricate.ogg"],
  ["c-m.ogg", "Bilabial nasal.ogg"],
  ["c-n.ogg", "Alveolar nasal.ogg"],
  ["c-ng.ogg", "Velar nasal.ogg"],
  ["c-l.ogg", "Alveolar lateral approximant.ogg"],
  ["c-r.ogg", "Alveolar approximant.ogg"],
  ["c-y.ogg", "Palatal approximant.ogg"],
  ["c-w.ogg", "Voiced labio-velar approximant.ogg"]
].map(([file, sourceFile]) => ({ file, sourceFile }));

function commonsUploadUrl(sourceFile) {
  const normalized = sourceFile.replaceAll(" ", "_");
  const hash = crypto.createHash("md5").update(normalized).digest("hex");
  return `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(normalized)}`;
}

function commonsPageUrl(sourceFile) {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(sourceFile.replaceAll(" ", "_"))}`;
}

function commonsRawUrl(sourceFile) {
  return `${commonsPageUrl(sourceFile)}?action=raw`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, attempts = 12) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        ...options,
        headers: { "User-Agent": USER_AGENT, "Connection": "close", ...(options.headers || {}) },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }
    await wait(Math.min(6000, 500 + attempt * 500));
  }
  throw lastError || new Error("download failed");
}

function cleanWikiValue(value) {
  return String(value || "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function metadataFromWikitext(wikitext) {
  const author = wikitext.match(/^\s*\|\s*author\s*=\s*(.+)$/im)?.[1] || wikitext.match(/Recorded by\s+(.+?)(?:\.|$)/i)?.[1] || "";
  const description = wikitext.match(/^\s*\|\s*description\s*=\s*(.+)$/im)?.[1] || "";
  const licenseSection = wikitext.match(/==\s*\{\{int:license-header\}\}\s*==([\s\S]*?)(?:\n\s*\[\[Category:|$)/i)?.[1] || "";
  const licenseTemplates = Array.from(licenseSection.matchAll(/\{\{([^{}]+)\}\}/g), match => match[1].trim()).filter(Boolean);
  return {
    author: cleanWikiValue(author) || "See source page",
    description: cleanWikiValue(description),
    licenseTemplates
  };
}

async function downloadSource(source) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const destination = path.join(TARGET_DIR, source.file);
  let downloaded = false;
  if (!fs.existsSync(destination) || fs.statSync(destination).size < 256) {
    const response = await fetchWithRetry(commonsUploadUrl(source.sourceFile));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 256) throw new Error("downloaded audio is unexpectedly small");
    const temporary = `${destination}.part`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, destination);
    downloaded = true;
  }

  let metadata = { author: "See source page", description: "", licenseTemplates: [] };
  if (FETCH_SOURCE_METADATA) {
    try {
      const response = await fetchWithRetry(commonsRawUrl(source.sourceFile), {}, 5);
      metadata = metadataFromWikitext(await response.text());
    } catch (_) {
      // The source page is still preserved below so attribution can be completed without guessing.
    }
  }
  return {
    localFile: source.file,
    sourceFile: source.sourceFile,
    sourcePage: commonsPageUrl(source.sourceFile),
    sourceAudio: commonsUploadUrl(source.sourceFile),
    bytes: fs.statSync(destination).size,
    downloaded,
    ...metadata
  };
}

async function main() {
  const records = [];
  let nextIndex = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (nextIndex < SOURCES.length) {
      const index = nextIndex;
      nextIndex += 1;
      const source = SOURCES[index];
      try {
        const record = await downloadSource(source);
        records[index] = record;
        console.log(`${record.downloaded ? "downloaded" : "verified"} ${source.file} (${record.bytes} bytes)`);
      } catch (error) {
        records[index] = { error: String(error && error.message || error), localFile: source.file, sourceFile: source.sourceFile };
        console.error(`failed ${source.file}: ${records[index].error}`);
      }
    }
  });
  await Promise.all(workers);
  fs.writeFileSync(path.join(TARGET_DIR, "SOURCES.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), sources: records }, null, 2)}\n`, "utf8");
  const failures = records.filter(record => record && record.error);
  console.log(`audio sources: ${records.length - failures.length}/${records.length} ready`);
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
