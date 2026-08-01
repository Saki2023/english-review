"use strict";

const { deriveLearningSyncToken } = require("./learning-sync-token");

const token = deriveLearningSyncToken(process.env.API_TOKEN);
if (!token) {
  console.error("API_TOKEN is not configured");
  process.exitCode = 1;
} else console.log(token);
