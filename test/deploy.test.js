"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("automatic updater uses fast-forward deployment and health gating", () => {
  const updater = read("deploy/auto-update.sh");
  const backup = updater.indexOf('backup_data "$local_revision"');
  const composeUp = updater.indexOf('up -d --build');
  const healthCheck = updater.indexOf('app_status" != "healthy"');
  const deployedMarker = updater.indexOf('> "${DEPLOYED_FILE}.tmp"');

  assert.match(updater, /git merge --ff-only/);
  assert.match(updater, /docker compose -f "\$COMPOSE_FILE" up -d --build/);
  assert.match(updater, /tracked files contain local changes/);
  assert.match(updater, /verify_data_mount/);
  assert.match(updater, /\/var\/backups\/english-review/);
  assert.ok(backup >= 0 && composeUp > backup, "backup must run before Docker deployment");
  assert.ok(healthCheck >= 0 && deployedMarker > healthCheck, "deployment must be marked only after health checks");
  assert.doesNotMatch(updater, /reset --hard|clean -fd|system prune/);
});

test("systemd timer and installer use the expected updater", () => {
  const service = read("deploy/english-review-update.service");
  const timer = read("deploy/english-review-update.timer");
  const installer = read("deploy/install-auto-update.sh");

  assert.match(service, /ExecStart=\/usr\/local\/sbin\/english-review-update/);
  assert.match(service, /TimeoutStartSec=15min/);
  assert.match(timer, /OnUnitInactiveSec=5min/);
  assert.match(installer, /systemctl enable --now english-review-update\.timer/);
  assert.match(installer, /systemd-analyze verify/);
  assert.match(installer, /bash -n/);
  assert.match(installer, /\$\{REPO_DIR\}\/\.env/);
});
