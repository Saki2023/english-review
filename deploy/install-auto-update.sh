#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_DIR="/opt/english-review"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行：bash deploy/install-auto-update.sh" >&2
  exit 1
fi

for command_name in bash docker flock git install systemctl systemd-analyze; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "缺少命令：${command_name}" >&2; exit 1; }
done

[[ -d "${REPO_DIR}/.git" ]] || { echo "未找到仓库：${REPO_DIR}" >&2; exit 1; }
[[ -f "${REPO_DIR}/.env" ]] || { echo "未找到配置：${REPO_DIR}/.env" >&2; exit 1; }
docker compose version >/dev/null
bash -n "${REPO_DIR}/deploy/auto-update.sh"
bash -n "${REPO_DIR}/deploy/install-auto-update.sh"

install -d -m 0755 /usr/local/sbin /var/lib/english-review-updater
install -m 0755 "${REPO_DIR}/deploy/auto-update.sh" /usr/local/sbin/english-review-update
install -m 0644 "${REPO_DIR}/deploy/english-review-update.service" /etc/systemd/system/english-review-update.service
install -m 0644 "${REPO_DIR}/deploy/english-review-update.timer" /etc/systemd/system/english-review-update.timer
systemd-analyze verify /etc/systemd/system/english-review-update.service /etc/systemd/system/english-review-update.timer

systemctl daemon-reload
systemctl enable --now english-review-update.timer

if ! systemctl start english-review-update.service; then
  journalctl -u english-review-update.service -n 80 --no-pager
  exit 1
fi

echo
echo "自动更新已启用，每 1 分钟检查一次 GitHub。"
systemctl list-timers english-review-update.timer --no-pager
echo
echo "查看日志：journalctl -u english-review-update.service -n 100 --no-pager"
