#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPO_DIR="${ENGLISH_REVIEW_REPO_DIR:-/opt/english-review}"
readonly COMPOSE_FILE="${ENGLISH_REVIEW_COMPOSE_FILE:-docker-compose.vps.yml}"
readonly BRANCH="${ENGLISH_REVIEW_BRANCH:-main}"
readonly STATE_DIR="${ENGLISH_REVIEW_STATE_DIR:-/var/lib/english-review-updater}"
readonly DEPLOYED_FILE="${STATE_DIR}/deployed-revision"
readonly PINNED_FILE="${STATE_DIR}/pinned-revision"
readonly LOCK_FILE="/run/lock/english-review-update.lock"
readonly BACKUP_DIR="/var/backups/english-review"
readonly BACKUP_RETENTION=10
readonly APP_CONTAINER="english-review"
readonly TUNNEL_CONTAINER="english-review-cloudflared"
paused_container=false

log() {
  local message="english-review-update: $*"
  printf '%s\n' "$message"
  logger -t english-review-update -- "$*" 2>/dev/null || true
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  if [[ "$paused_container" == "true" ]]; then
    docker unpause "$APP_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

verify_data_mount() {
  local expected mounted
  expected="$(readlink -f "${REPO_DIR}/server/data")"
  mounted="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Source}}{{end}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
  [[ -n "$mounted" ]] || fail "container data mount is missing"
  [[ "$(readlink -f "$mounted")" == "$expected" ]] || fail "container data mount does not match ${expected}"
}

backup_data() {
  local revision="$1"
  local timestamp archive status
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  archive="${BACKUP_DIR}/backup-${timestamp}-${revision:0:12}.tar.gz"
  install -d -m 0700 "$BACKUP_DIR"

  status="$(docker inspect --format '{{.State.Status}}' "$APP_CONTAINER" 2>/dev/null || true)"
  if [[ "$status" == "running" ]]; then
    docker pause "$APP_CONTAINER" >/dev/null
    paused_container=true
  fi

  if ! tar -C "$REPO_DIR" -czf "$archive" .env server/data; then
    rm -f "$archive"
    fail "failed to create backup"
  fi

  if [[ "$paused_container" == "true" ]]; then
    docker unpause "$APP_CONTAINER" >/dev/null
    paused_container=false
  fi
  chmod 0600 "$archive"

  shopt -s nullglob
  local backups=("${BACKUP_DIR}"/backup-*.tar.gz)
  shopt -u nullglob
  while (( ${#backups[@]} > BACKUP_RETENTION )); do
    rm -f -- "${backups[0]}"
    backups=("${backups[@]:1}")
  done
  log "backup created: ${archive}"
}

for command_name in bash date docker flock git grep install readlink tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

[[ -d "${REPO_DIR}/.git" ]] || fail "Git repository not found: ${REPO_DIR}"
[[ -f "${REPO_DIR}/.env" ]] || fail "environment file not found: ${REPO_DIR}/.env"
[[ -f "${REPO_DIR}/${COMPOSE_FILE}" ]] || fail "Compose file not found: ${COMPOSE_FILE}"
[[ -d "${REPO_DIR}/server/data" ]] || fail "data directory not found: ${REPO_DIR}/server/data"

install -d -m 0755 "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another update is already running"; exit 0; }

cd "$REPO_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "tracked files contain local changes; automatic update stopped"
fi

verify_data_mount

pinned_revision="$(cat "$PINNED_FILE" 2>/dev/null || true)"
if [[ -n "$pinned_revision" ]]; then
  [[ "$pinned_revision" =~ ^[0-9a-f]{40}$ ]] || fail "pinned revision state is invalid"
  local_revision="$(git rev-parse HEAD)"
  deployed_revision="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"
  [[ "$local_revision" == "$pinned_revision" ]] || fail "pinned revision does not match the checked-out program; run english-review-version status"
  [[ "$deployed_revision" == "$pinned_revision" ]] || fail "pinned revision does not match the deployed marker; run english-review-version status"
  log "version pinned at ${pinned_revision:0:12}; automatic update skipped"
  exit 0
fi

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "$current_branch" == "$BRANCH" ]] || fail "expected branch ${BRANCH}, found ${current_branch:-detached HEAD}"

git fetch --quiet origin "$BRANCH"
local_revision="$(git rev-parse HEAD)"
remote_revision="$(git rev-parse "origin/${BRANCH}")"
deployed_revision="$(cat "$DEPLOYED_FILE" 2>/dev/null || true)"

if [[ "$local_revision" == "$remote_revision" && "$deployed_revision" == "$remote_revision" ]]; then
  log "already current at ${remote_revision:0:12}"
  exit 0
fi

backup_data "$local_revision"

if [[ "$local_revision" != "$remote_revision" ]]; then
  git merge-base --is-ancestor "$local_revision" "$remote_revision" || fail "origin/${BRANCH} is not a fast-forward update"
  log "updating ${local_revision:0:12} -> ${remote_revision:0:12}"
  git merge --ff-only "origin/${BRANCH}"
else
  log "retrying deployment for ${remote_revision:0:12}"
fi

grep -Fq -- "./server/data:/app/server/data" "$COMPOSE_FILE" || fail "Compose data mount declaration is missing"
docker compose -f "$COMPOSE_FILE" config --quiet
docker compose -f "$COMPOSE_FILE" up -d --build

app_status=""
tunnel_status=""
for ((attempt = 1; attempt <= 60; attempt += 1)); do
  app_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
  tunnel_status="$(docker inspect --format '{{.State.Status}}' "$TUNNEL_CONTAINER" 2>/dev/null || true)"
  if [[ "$app_status" == "healthy" && "$tunnel_status" == "running" ]]; then
    break
  fi
  if [[ "$app_status" == "dead" || "$app_status" == "exited" ]]; then
    break
  fi
  sleep 2
done

if [[ "$app_status" != "healthy" || "$tunnel_status" != "running" ]]; then
  log "deployment unhealthy: app=${app_status:-missing}, tunnel=${tunnel_status:-missing}"
  docker compose -f "$COMPOSE_FILE" ps || true
  docker compose -f "$COMPOSE_FILE" logs --tail=60 english-review cloudflared || true
  exit 1
fi

verify_data_mount

if [[ -f "${REPO_DIR}/deploy/auto-update.sh" ]]; then
  bash -n "${REPO_DIR}/deploy/auto-update.sh" || fail "updated auto-update.sh has invalid Bash syntax"
  install -m 0755 "${REPO_DIR}/deploy/auto-update.sh" /usr/local/sbin/english-review-update.next
  mv -f /usr/local/sbin/english-review-update.next /usr/local/sbin/english-review-update
fi

if [[ -f "${REPO_DIR}/deploy/english-review-version" ]]; then
  bash -n "${REPO_DIR}/deploy/english-review-version" || fail "updated english-review-version has invalid Bash syntax"
  install -m 0755 "${REPO_DIR}/deploy/english-review-version" /usr/local/sbin/english-review-version.next
  mv -f /usr/local/sbin/english-review-version.next /usr/local/sbin/english-review-version
fi

printf '%s\n' "$remote_revision" > "${DEPLOYED_FILE}.tmp"
mv -f "${DEPLOYED_FILE}.tmp" "$DEPLOYED_FILE"
log "deployed ${remote_revision:0:12}; app healthy; tunnel running"
