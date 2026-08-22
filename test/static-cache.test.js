"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
}

test("static files use immutable version caches and stable conditional responses", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-static-cache-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), COOKIE_SECURE: "false", REVIEW_VARIANT_POOL_AUTOFILL: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForHealth(baseUrl, child);

    const versioned = await fetch(`${baseUrl}/app.js?v=79`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(Number(versioned.headers.get("content-length")) > 1000, true);
    const entityTag = versioned.headers.get("etag");
    const lastModified = versioned.headers.get("last-modified");
    assert.match(entityTag, /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(Number.isFinite(Date.parse(lastModified)), true);
    const versionedBody = await versioned.text();
    assert.match(versionedBody, /serviceWorker\.register\("\/sw\.js\?v=79"/);

    const byEntityTag = await fetch(`${baseUrl}/app.js?v=79`, { headers: { "If-None-Match": `W/${entityTag}` } });
    assert.equal(byEntityTag.status, 304);
    assert.equal(await byEntityTag.text(), "");
    assert.equal(byEntityTag.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const byDate = await fetch(`${baseUrl}/app.js?v=79`, { headers: { "If-Modified-Since": lastModified } });
    assert.equal(byDate.status, 304);
    assert.equal(await byDate.text(), "");

    const staleVersion = await fetch(`${baseUrl}/app.js?v=76`);
    assert.equal(staleVersion.status, 200);
    assert.equal(staleVersion.headers.get("cache-control"), "no-cache");

    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.match(index.headers.get("etag"), /^"[0-9a-f]+-[0-9a-f]+"$/);

    const serviceWorker = await fetch(`${baseUrl}/sw.js?v=79`);
    assert.equal(serviceWorker.status, 200);
    assert.equal(serviceWorker.headers.get("cache-control"), "no-cache");

    const head = await fetch(`${baseUrl}/app.js?v=79`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(versionedBody)));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
  } finally {
    await stopApp(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
