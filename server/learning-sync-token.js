"use strict";

const crypto = require("node:crypto");

const TOKEN_CONTEXT = "daily-english-review:learning-sync:v1";

function deriveLearningSyncToken(apiToken) {
  const source = String(apiToken || "").trim();
  if (!source) return "";
  return crypto.createHmac("sha256", source).update(TOKEN_CONTEXT).digest("base64url");
}

function validLearningSyncToken(candidate, apiToken) {
  const expected = deriveLearningSyncToken(apiToken);
  const actual = String(candidate || "").trim();
  if (!expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

module.exports = { deriveLearningSyncToken, validLearningSyncToken };
