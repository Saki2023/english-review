"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { deriveLearningSyncToken, validLearningSyncToken } = require("../server/learning-sync-token");

const ROOT = path.resolve(__dirname, "..");

test("learning sync uses a derived read-only token instead of the content API token", () => {
  const apiToken = "content-management-token-for-test";
  const readToken = deriveLearningSyncToken(apiToken);
  assert.equal(readToken.length, 43);
  assert.notEqual(readToken, apiToken);
  assert.equal(validLearningSyncToken(readToken, apiToken), true);
  assert.equal(validLearningSyncToken(apiToken, apiToken), false);
  assert.equal(validLearningSyncToken(`${readToken}x`, apiToken), false);
});

test("sync token CLI prints the derived token only when API_TOKEN is configured", () => {
  const apiToken = "content-management-token-for-cli-test";
  const result = spawnSync(process.execPath, [path.join(ROOT, "server", "show-sync-token.js")], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, API_TOKEN: apiToken }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), deriveLearningSyncToken(apiToken));
  assert.equal(result.stdout.includes(apiToken), false);
});
