"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function findBash() {
  const candidates = [
    process.env.BASH_PATH,
    process.platform === "win32"
      ? path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "usr", "bin", "sh.exe")
      : "/bin/bash",
    "bash"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return "";
}

function bashEnvironment(bash) {
  return { ...process.env, PATH: `${path.dirname(bash)}${path.delimiter}${process.env.PATH || ""}` };
}

function toBashPath(filePath) {
  if (process.platform !== "win32") return filePath;
  return filePath.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
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
  assert.match(updater, /PINNED_FILE=.*pinned-revision/);
  assert.match(updater, /version pinned at .*automatic update skipped/);
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
  assert.match(timer, /OnBootSec=1min/);
  assert.match(timer, /OnUnitInactiveSec=1min/);
  assert.match(timer, /AccuracySec=5s/);
  assert.doesNotMatch(timer, /RandomizedDelaySec/);
  assert.match(installer, /systemctl enable --now english-review-update\.timer/);
  assert.match(installer, /systemd-analyze verify/);
  assert.match(installer, /bash -n/);
  assert.match(installer, /\$\{REPO_DIR\}\/\.env/);
  assert.match(installer, /install -m 0755 .*english-review-version.*\/usr\/local\/sbin\/english-review-version/);
});

test("SSH version manager accepts only catalogued PWA versions and never exposes a web control plane", () => {
  const manager = read("deploy/english-review-version");
  const updater = read("deploy/auto-update.sh");
  const server = read("server.js");

  assert.match(manager, /english-review-version list/);
  assert.match(manager, /english-review-version switch v69/);
  assert.match(manager, /english-review-version status/);
  assert.match(manager, /english-review-version latest/);
  assert.match(manager, /\[\[ "\$requested_version" =~ \^v\[0-9\]\+\$ \]\]/);
  assert.match(manager, /git rev-list --first-parent "origin\/\$\{BRANCH\}"/);
  assert.match(manager, /CATALOG_FILE=.*version-catalog/);
  assert.match(manager, /cached_revision.*remote_revision/);
  assert.match(manager, /chmod 0600 "\$\{CATALOG_FILE\}\.tmp"/);
  assert.match(manager, /git merge-base --is-ancestor/);
  assert.match(manager, /id="appVersionBadge"/);
  assert.match(manager, /daily-english-review-v\[0-9\]\+/);
  assert.match(manager, /\.\/server\/data:\/app\/server\/data/);
  assert.doesNotMatch(manager, /\beval\b|bash -c|sh -c|reset --hard|clean -fd|system prune/);
  assert.doesNotMatch(server, /english-review-version|pinned-revision|\/api\/.*deploy|\/api\/.*rollback/);
  assert.match(updater, /english-review-version status/);
});

test("SSH version switching backs up first, health-gates markers, and restores the original program on failure", () => {
  const manager = read("deploy/english-review-version");
  const deployTarget = manager.indexOf("deploy_target() {");
  const backup = manager.indexOf('backup_data "$original_revision"', deployTarget);
  const deploy = manager.indexOf('perform_checkout_and_deploy "$target_revision"', deployTarget);
  const restore = manager.indexOf('restore_original_deployment "$original_revision"', deployTarget);
  const commitState = manager.indexOf('commit_target_state "$target_revision"', deployTarget);
  const pinnedMarker = manager.indexOf('write_state_file "$PINNED_FILE" "$target_revision"');
  const deployedMarker = manager.indexOf('write_state_file "$DEPLOYED_FILE" "$target_revision"');

  assert.ok(deployTarget >= 0 && backup > deployTarget, "backup must exist in the deployment transaction");
  assert.ok(deploy > backup, "Docker deployment must start only after backup");
  assert.ok(restore > deploy, "failed deployment must restore the original revision");
  assert.ok(commitState > restore, "state commit must happen only after a healthy target path");
  assert.ok(pinnedMarker >= 0 && deployedMarker >= 0, "both root-owned markers must be committed");
  assert.match(manager, /flock -n 9/);
  assert.match(manager, /docker pause "\$APP_CONTAINER"/);
  assert.match(manager, /BACKUP_RETENTION=10/);
  assert.match(manager, /wait_for_healthy_deployment/);
  assert.match(manager, /systemctl enable --now english-review-update\.timer/);
});

test("version manager installer stays outside the application checkout and shares the updater lock", () => {
  const installer = read("deploy/install-version-manager.sh");
  const manager = read("deploy/english-review-version");
  const updater = read("deploy/auto-update.sh");

  assert.match(installer, /\/usr\/local\/sbin\/english-review-version\.next/);
  assert.match(installer, /\/usr\/local\/sbin\/english-review-update\.next/);
  assert.match(installer, /\/var\/lib\/english-review-updater/);
  assert.match(installer, /flock -w 30 9/);
  assert.match(installer, /systemctl enable --now english-review-update\.timer/);
  assert.match(manager, /english-review-update\.lock/);
  assert.match(updater, /english-review-update\.lock/);
  assert.match(manager, /pinned-revision/);
  assert.match(updater, /pinned-revision/);
});

test("Bash parses every deployment script and the real Git history produces a stable version catalog", t => {
  const bash = findBash();
  if (!bash) {
    t.skip("Bash is unavailable in this development environment");
    return;
  }
  const bashEnv = bashEnvironment(bash);
  for (const script of [
    "deploy/auto-update.sh",
    "deploy/english-review-version",
    "deploy/install-auto-update.sh",
    "deploy/install-version-manager.sh"
  ]) {
    const syntax = spawnSync(bash, ["-n", script], { cwd: ROOT, encoding: "utf8", env: bashEnv });
    assert.equal(syntax.status, 0, `${script}: ${syntax.stderr}`);
  }

  const catalog = spawnSync(
    bash,
    ["-c", "source deploy/english-review-version; version_for_revision HEAD; catalog_lines"],
    { cwd: ROOT, encoding: "utf8", env: bashEnv }
  );
  assert.equal(catalog.status, 0, catalog.stderr);
  const lines = catalog.stdout.trim().split(/\r?\n/);
  const headHtml = spawnSync(bash, ["-c", "git show HEAD:index.html"], { cwd: ROOT, encoding: "utf8", env: bashEnv });
  assert.equal(headHtml.status, 0, headHtml.stderr);
  const headVersion = headHtml.stdout.match(/id=\"appVersionBadge\"[^>]*>v(\d+)<\/span>/)?.[1];
  assert.ok(headVersion, "HEAD should contain a visible PWA version");
  assert.equal(lines[0], headVersion);
  assert.match(lines[1], new RegExp(`^v${headVersion}\\t[0-9a-f]{40}\\t\\d{4}-\\d{2}-\\d{2}\\t`));
  const previousVersion = String(Math.max(0, Number(headVersion) - 1));
  assert.match(lines[2], new RegExp(`^v${previousVersion}\\t[0-9a-f]{40}\\t\\d{4}-\\d{2}-\\d{2}\\t`));
});

test("failed and successful version transactions preserve or advance root-owned markers atomically", t => {
  const bash = findBash();
  if (!bash) {
    t.skip("Bash is unavailable in this development environment");
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "english-review-version-state-"));
  const oldRevision = "1".repeat(40);
  const newRevision = "2".repeat(40);
  const stateDir = toBashPath(temp);
  const eventFile = toBashPath(path.join(temp, "events"));
  const env = {
    ...bashEnvironment(bash),
    ENGLISH_REVIEW_STATE_DIR: stateDir,
    TEST_EVENT_FILE: eventFile
  };
  fs.writeFileSync(path.join(temp, "pinned-revision"), `${oldRevision}\n`);
  fs.writeFileSync(path.join(temp, "deployed-revision"), `${oldRevision}\n`);

  const commonOverrides = `
source deploy/english-review-version
write_state_file() { printf '%s\\n' "$2" > "$1.tmp"; mv -f "$1.tmp" "$1"; }
data_mount_matches() { return 0; }
backup_data() { printf 'backup\\n' >> "$TEST_EVENT_FILE"; return 0; }
restore_original_deployment() { printf 'restore\\n' >> "$TEST_EVENT_FILE"; return 0; }
`;
  const failed = spawnSync(
    bash,
    ["-c", `${commonOverrides}\nperform_checkout_and_deploy() { printf 'deploy\\n' >> "$TEST_EVENT_FILE"; return 1; }\ndeploy_target '${newRevision}' pinned`],
    { cwd: ROOT, encoding: "utf8", env }
  );
  assert.equal(failed.status, 1);
  assert.equal(fs.readFileSync(path.join(temp, "pinned-revision"), "utf8").trim(), oldRevision);
  assert.equal(fs.readFileSync(path.join(temp, "deployed-revision"), "utf8").trim(), oldRevision);
  assert.deepEqual(fs.readFileSync(path.join(temp, "events"), "utf8").trim().split(/\r?\n/), ["backup", "deploy", "restore"]);

  fs.rmSync(path.join(temp, "events"));
  const succeeded = spawnSync(
    bash,
    ["-c", `${commonOverrides}\nperform_checkout_and_deploy() { printf 'deploy\\n' >> "$TEST_EVENT_FILE"; return 0; }\ndeploy_target '${newRevision}' pinned`],
    { cwd: ROOT, encoding: "utf8", env }
  );
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.equal(fs.readFileSync(path.join(temp, "pinned-revision"), "utf8").trim(), newRevision);
  assert.equal(fs.readFileSync(path.join(temp, "deployed-revision"), "utf8").trim(), newRevision);
  assert.deepEqual(fs.readFileSync(path.join(temp, "events"), "utf8").trim().split(/\r?\n/), ["backup", "deploy"]);
});
