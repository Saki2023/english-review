"use strict";

const { deriveTeachingProfileWriteToken } = require("./learning-sync-token");

const token = deriveTeachingProfileWriteToken(process.env.API_TOKEN);
if (!token) {
  console.error("API_TOKEN is not configured");
  process.exitCode = 1;
} else console.log(token);
