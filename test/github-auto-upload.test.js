"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "tools", "github-auto-upload", "GitHubAutoUpload.cs"), "utf8");
const build = fs.readFileSync(path.join(ROOT, "tools", "github-auto-upload", "build.ps1"), "utf8");

test("GitHub auto upload executable only pushes committed main-branch content", () => {
  assert.match(source, /push --porcelain origin main/);
  assert.match(source, /GIT_TERMINAL_PROMPT/);
  assert.match(source, /BatchMode=yes/);
  assert.match(source, /未提交修改；这些内容不会被本工具上传/);
  assert.doesNotMatch(source, /\b(add|commit)\s+(?:--all|-A|\.)/i);
  assert.doesNotMatch(source, /netsh|Set-DnsClient|New-NetRoute|HTTP_PROXY|HTTPS_PROXY|ProxyEnable/i);
});

test("GitHub auto upload exposes a headless machine-readable interface", () => {
  assert.match(source, /--headless/);
  assert.match(source, /--json/);
  assert.match(source, /--result-file/);
  assert.match(source, /\\\"interfaceVersion\\\":1/);
  assert.match(source, /Environment\.ExitCode = result\.Success \? 0 : 1/);
  assert.match(source, /File\.WriteAllText\(fullPath, payload, new UTF8Encoding\(false\)\)/);
  assert.match(source, /UploadForm\.RunUpload/);
});

test("GitHub auto upload window keeps the log between its header and footer", () => {
  const contentIndex = source.indexOf("Controls.Add(content);");
  const footerIndex = source.indexOf("Controls.Add(footer);");
  const headerIndex = source.indexOf("Controls.Add(header);");
  assert.ok(contentIndex >= 0 && footerIndex >= 0 && headerIndex >= 0);
  assert.ok(contentIndex < footerIndex && footerIndex < headerIndex, "DockStyle.Fill must be added before the edge-docked panels");
});

test("GitHub auto upload build emits a WinForms executable outside the repository", () => {
  assert.match(build, /target:winexe/);
  assert.match(build, /0x81EA[\s\S]*0x52A8[\s\S]*0x4E0A[\s\S]*0x4F20/);
  assert.match(build, /\$workspaceRoot/);
  assert.doesNotMatch(build, /id_ed25519|SYNC_READ_TOKEN|SYNC_WRITE_TOKEN|API_TOKEN/);
});
