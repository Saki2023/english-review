"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function runPowerShell(args, timeoutMs = 30000) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, args, { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell sync regression test timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("a failed upload does not prevent downloading a fresh website learning profile", { skip: process.platform !== "win32" }, async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.method === "PUT" && request.url.startsWith("/api/sync/teaching-profile")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/content/batch") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ currentDay: 4, words: 1, sentences: 1, notes: 1, added: 0, updated: 0, notesAdded: 0, notesUpdated: 0, previewWords: 0 }));
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/api/sync/profile")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        summary: { aiQuestions: 9, aiAccuracy: 78, tutorQuestions: 2, previewPracticeRounds: 2, previewPracticeQuestions: 12, previewPracticeFullyCorrect: 8, previewPracticePartiallyCorrect: 1, previewPracticeIncorrect: 3, previewPracticeAverageScore: 74, exams: 0, itemsNeedingReview: 3, dictations: 1, focusedSessions: 1 },
        abilities: { totalEvidence: 12 },
        marker: "fresh-download-after-upload-failure"
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-sync-test-"));
  const outputPath = path.join(temporaryDirectory, "profile.json");
  const statusPath = path.join(temporaryDirectory, "status.json");
  try {
    const address = server.address();
    const result = await runPowerShell([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "sync-learning-profile.ps1"),
      "-BaseUrl", `http://127.0.0.1:${address.port}`,
      "-Username", "sync-regression-user",
      "-SyncToken", "test-read-token",
      "-WriteToken", "test-write-token",
      "-ConfigPath", path.join(temporaryDirectory, "missing.env"),
      "-OutputPath", outputPath,
      "-StatusPath", statusPath
    ]);

    assert.equal(result.code, 1, "partial synchronization should retain a failure exit code");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const profile = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(status.uploadAttempted, true);
    assert.equal(status.teachingUploadSuccess, false);
    assert.equal(status.courseUploadSuccess, true);
    assert.equal(status.uploadSuccess, false);
    assert.equal(status.downloadSuccess, true);
    assert.equal(status.success, false);
    assert.equal(status.errors[0].category, "authorization");
    assert.equal(status.summary.aiQuestions, 9);
    assert.equal(status.summary.aiAccuracy, 78);
    assert.equal(status.summary.tutorQuestions, 2);
    assert.equal(status.summary.previewPracticeRounds, 2);
    assert.equal(status.summary.previewPracticeQuestions, 12);
    assert.equal(status.summary.previewPracticePartiallyCorrect, 1);
    assert.equal(status.summary.previewPracticeAverageScore, 74);
    assert.equal(status.summary.evidence, 12);
    assert.deepEqual(status.profileSummary, status.summary);
    assert.equal(profile.marker, "fresh-download-after-upload-failure");
    assert.ok(requests.some(entry => entry.startsWith("GET /api/sync/profile")));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
