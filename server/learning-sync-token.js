"use strict";

const crypto = require("node:crypto");

const TOKEN_CONTEXT = "daily-english-review:learning-sync:v1";
const WRITE_TOKEN_CONTEXT = "daily-english-review:teaching-profile-write:v1";

function deriveToken(apiToken, context) {
  const source = String(apiToken || "").trim();
  if (!source) return "";
  return crypto.createHmac("sha256", source).update(context).digest("base64url");
}

function deriveLearningSyncToken(apiToken) {
  return deriveToken(apiToken, TOKEN_CONTEXT);
}

function deriveTeachingProfileWriteToken(apiToken) {
  return deriveToken(apiToken, WRITE_TOKEN_CONTEXT);
}

function validDerivedToken(candidate, expected) {
  const actual = String(candidate || "").trim();
  if (!expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function validLearningSyncToken(candidate, apiToken) {
  return validDerivedToken(candidate, deriveLearningSyncToken(apiToken));
}

function validTeachingProfileWriteToken(candidate, apiToken) {
  return validDerivedToken(candidate, deriveTeachingProfileWriteToken(apiToken));
}

module.exports = { deriveLearningSyncToken, deriveTeachingProfileWriteToken, validLearningSyncToken, validTeachingProfileWriteToken };
