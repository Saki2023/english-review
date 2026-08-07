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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
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
    if (request.method === "PUT" && request.url.startsWith("/api/sync/self-study-lessons")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid self-study package" }));
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
  const selfStudyCoursePath = path.join(temporaryDirectory, "self-study.json");
  try {
    fs.writeFileSync(selfStudyCoursePath, JSON.stringify({ lessons: [{ lessonId: "must-not-appear-in-report", acceptedAnswers: ["hidden-reference"] }] }), "utf8");
    const address = server.address();
    const result = await runPowerShell([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "sync-learning-profile.ps1"),
      "-BaseUrl", `http://127.0.0.1:${address.port}`,
      "-Username", "sync-regression-user",
      "-SyncToken", "test-read-token",
      "-WriteToken", "test-write-token",
      "-ConfigPath", path.join(temporaryDirectory, "missing.env"),
      "-SelfStudyCoursePath", selfStudyCoursePath,
      "-OutputPath", outputPath,
      "-StatusPath", statusPath
    ]);

    assert.equal(result.code, 1, "partial synchronization should retain a failure exit code");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const profile = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(status.uploadAttempted, true);
    assert.equal(status.teachingUploadSuccess, false);
    assert.equal(status.courseUploadSuccess, true);
    assert.equal(status.selfStudyUploadAttempted, true);
    assert.equal(status.selfStudyUploadSuccess, false);
    assert.equal(status.uploadSuccess, false);
    assert.equal(status.downloadSuccess, true);
    assert.equal(status.success, false);
    assert.equal(status.errors[0].category, "authorization");
    assert.ok(status.errors.some(error => error.phase === "upload-self-study-lessons" && error.category === "http"));
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
    const serializedStatus = JSON.stringify(status);
    assert.equal(serializedStatus.includes("test-write-token"), false);
    assert.equal(serializedStatus.includes("hidden-reference"), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("full sync uploads a self-study package with the write token and reports its exported progress", { skip: process.platform !== "win32" }, async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "", body });
    if (request.method === "PUT" && request.url.startsWith("/api/sync/teaching-profile")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/content/batch") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ currentDay: 8, words: 20, previewWords: 2, sentences: 12, notes: 8, added: 0, updated: 0, notesAdded: 0, notesUpdated: 0 }));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/sync/self-study-lessons?username=self-study-sync-user") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ received: 2, lessons: 2, activeSnapshotsRetained: 1 }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/sync/profile?username=self-study-sync-user") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 7,
        course: { currentDay: 8, words: 20, previewWords: 2, sentences: 12, notes: 8 },
        summary: {
          aiQuestions: 0,
          aiCorrect: 0,
          aiAccuracy: 0,
          tutorQuestions: 0,
          previewPracticeRounds: 0,
          previewPracticeQuestions: 0,
          selfStudyCompletedLessons: 1,
          selfStudyCurrentLessonId: "trip-day-9",
          selfStudyCurrentStageId: "reading",
          selfStudyCurrentStepId: "reading-2",
          selfStudyFormalAttempts: 7,
          selfStudyFirstCorrect: 6,
          selfStudyCorrections: 1,
          selfStudyUnattempted: 8,
          selfStudyPending: 0,
          selfStudyLastStudiedAt: "2026-08-07T10:00:00.000Z"
        },
        abilities: { totalEvidence: 6, comprehensiveScore: 12 },
        selfStudyHistory: [{ lessonId: "trip-day-8", status: "completed" }],
        selfStudyPlannedLessons: [{ lessonId: "trip-day-10", plannedContent: { status: "planned" } }]
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "english-self-study-sync-test-"));
  const outputPath = path.join(temporaryDirectory, "profile.json");
  const statusPath = path.join(temporaryDirectory, "status.json");
  const selfStudyCoursePath = path.join(temporaryDirectory, "self-study.json");
  const hiddenReference = "answer-that-must-not-enter-status";
  fs.writeFileSync(selfStudyCoursePath, JSON.stringify({
    updatedAt: "2026-08-07T09:00:00.000Z",
    lessons: [{ lessonId: "trip-day-9", acceptedAnswers: [hiddenReference] }]
  }), "utf8");
  try {
    const address = server.address();
    const result = await runPowerShell([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "sync-learning-profile.ps1"),
      "-BaseUrl", `http://127.0.0.1:${address.port}`,
      "-Username", "self-study-sync-user",
      "-SyncToken", "self-study-read-token",
      "-WriteToken", "self-study-write-token",
      "-ConfigPath", path.join(temporaryDirectory, "missing.env"),
      "-SelfStudyCoursePath", selfStudyCoursePath,
      "-OutputPath", outputPath,
      "-StatusPath", statusPath
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const profile = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const upload = requests.find(entry => entry.url === "/api/sync/self-study-lessons?username=self-study-sync-user");
    assert.ok(upload);
    assert.equal(upload.authorization, "Bearer self-study-write-token");
    assert.equal(JSON.parse(upload.body).lessons[0].acceptedAnswers[0], hiddenReference);
    assert.equal(status.selfStudyUploadAttempted, true);
    assert.equal(status.selfStudyUploadSuccess, true);
    assert.equal(status.uploadSuccess, true);
    assert.equal(status.downloadSuccess, true);
    assert.equal(status.summary.selfStudyCompletedLessons, 1);
    assert.equal(status.summary.selfStudyCurrentStageId, "reading");
    assert.equal(status.summary.selfStudyFormalAttempts, 7);
    assert.equal(status.summary.selfStudyCorrections, 1);
    assert.equal(profile.selfStudyPlannedLessons[0].plannedContent.status, "planned");
    const serializedStatus = JSON.stringify(status);
    assert.equal(serializedStatus.includes("self-study-sync-user"), false);
    assert.equal(serializedStatus.includes("self-study-read-token"), false);
    assert.equal(serializedStatus.includes("self-study-write-token"), false);
    assert.equal(serializedStatus.includes(hiddenReference), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("preview-practice-only sync downloads a filtered file and never uploads local learning data", { skip: process.platform !== "win32" }, async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.method === "GET" && request.url.startsWith("/api/sync/profile")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 6,
        generatedAt: "2026-08-07T10:00:00.000Z",
        course: { currentDay: 7, contentUpdatedAt: "2026-08-07" },
        summary: { previewPracticeRounds: 1, previewPracticeQuestions: 2, previewPracticeFullyCorrect: 1, previewPracticePartiallyCorrect: 0, previewPracticeIncorrect: 1, previewPracticeAverageScore: 50, latestPreviewPracticeAt: "2026-08-07T09:00:00.000Z", aiQuestions: 999 },
        previewPracticeHistory: [{ id: "preview-round-1", previewDay: 8, formalEvidence: false, questions: [{ id: "q1", prompt: "It is in school.", learnerAnswer: "它在学校。", referenceAnswer: "它在学校里。", detailedExplanation: "位置表达。", formalEvidence: false }] }],
        aiHistory: [{ prompt: "must-not-copy-other-profile-data" }],
        tutorHistory: [{ learnerQuestion: "must-not-copy-other-profile-data" }]
      }));
      return;
    }
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "preview-only mode must not upload" }));
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "english-preview-practice-sync-test-"));
  const outputPath = path.join(temporaryDirectory, "preview-practice.json");
  const statusPath = path.join(temporaryDirectory, "status.json");
  const selfStudyCoursePath = path.join(temporaryDirectory, "self-study-that-must-not-upload.json");
  try {
    fs.writeFileSync(selfStudyCoursePath, JSON.stringify({ lessons: [{ lessonId: "must-not-upload" }] }), "utf8");
    const address = server.address();
    const result = await runPowerShell([
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "sync-learning-profile.ps1"),
      "-BaseUrl", `http://127.0.0.1:${address.port}`,
      "-Username", "preview-sync-user",
      "-SyncToken", "test-read-token",
      "-WriteToken", "test-write-token-that-must-be-ignored",
      "-ConfigPath", path.join(temporaryDirectory, "missing.env"),
      "-SelfStudyCoursePath", selfStudyCoursePath,
      "-OutputPath", outputPath,
      "-StatusPath", statusPath,
      "-PreviewPracticeOnly"
    ]);

    assert.equal(result.code, 0);
    assert.deepEqual(requests, ["GET /api/sync/profile?username=preview-sync-user"]);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const preview = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(status.mode, "preview-practice");
    assert.equal(status.uploadAttempted, false);
    assert.equal(status.downloadSuccess, true);
    assert.equal(status.success, true);
    assert.equal(status.summary.previewPracticeRounds, 1);
    assert.equal(preview.schemaVersion, 1);
    assert.equal(preview.formalEvidence, false);
    assert.equal(preview.course.currentDay, 7);
    assert.equal(preview.previewPracticeHistory[0].questions[0].prompt, "It is in school.");
    assert.equal(Object.hasOwn(preview, "aiHistory"), false);
    assert.equal(Object.hasOwn(preview, "tutorHistory"), false);
    assert.equal(JSON.stringify(preview).includes("must-not-copy-other-profile-data"), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
