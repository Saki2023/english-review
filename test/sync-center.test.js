const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("sync center provides a safe visible report and headless entry point", () => {
  const script = read("sync-center/同步中心.ps1");
  const readme = read("sync-center/README.md");
  assert.match(script, /\[switch\]\$Headless/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /最近一次同步\.json/);
  assert.match(script, /同步历史\.json/);
  assert.match(script, /uploadedFiles/);
  assert.match(script, /downloadedFiles/);
  assert.match(script, /网站课程内容\.json/);
  assert.match(script, /"网站课程内容"/);
  assert.match(script, /courseDay/);
  assert.match(script, /课程：第 \$\(\$summary\.courseDay\) 天/);
  assert.match(script, /Get-OutputMessages/);
  assert.match(script, /Redact-SensitiveText/);
  assert.match(script, /Register-ScheduledTask/);
  assert.doesNotMatch(script, /Write-Host\s+\"[^\"]*(SYNC_READ_TOKEN|SYNC_WRITE_TOKEN|API_TOKEN)/i);
  assert.match(readme, /最近 50 次同步记录/);
  assert.match(readme, /预览模式/);
  assert.equal(fs.existsSync(path.join(ROOT, "sync-center", "启动同步中心.cmd")), true);
});
