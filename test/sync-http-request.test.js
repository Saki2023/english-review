"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT, "scripts", "sync-http-request.js");

function invokeHelper(envelope) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [HELPER], { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("ascii");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`helper failed with ${code}: ${stderr}`));
      const decoded = Buffer.from(stdout.trim(), "base64").toString("utf8");
      resolve(JSON.parse(decoded));
    });
    const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    child.stdin.end(encoded, "ascii");
  });
}

test("sync HTTPS compatibility helper preserves UTF-8 bodies without returning credentials", async () => {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      accepted: request.headers.authorization === "Bearer test-only-token",
      chinese: body.chinese
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const body = Buffer.from(JSON.stringify({ chinese: "学习档案" }), "utf8");
    const result = await invokeHelper({
      method: "PUT",
      uri: `http://127.0.0.1:${address.port}/sync`,
      headers: { Authorization: "Bearer test-only-token", "Content-Type": "application/json; charset=utf-8" },
      timeoutMs: 5000,
      bodyBase64: body.toString("base64")
    });
    assert.equal(result.transportOk, true);
    assert.equal(result.status, 200);
    const response = JSON.parse(Buffer.from(result.bodyBase64, "base64").toString("utf8"));
    assert.deepEqual(response, { accepted: true, chinese: "学习档案" });
    assert.doesNotMatch(JSON.stringify(result), /test-only-token/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("sync HTTPS compatibility helper source never logs request headers", () => {
  const source = fs.readFileSync(HELPER, "utf8");
  assert.doesNotMatch(source, /console\.(?:log|error)/);
  assert.doesNotMatch(source, /JSON\.stringify\(request\)/);
});
