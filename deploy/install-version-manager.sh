#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPO_DIR="/opt/english-review"
readonly LOCK_FILE="/run/lock/english-review-update.lock"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash deploy/install-version-manager.sh" >&2
  exit 1
fi

for command_name in bash docker flock git install mv systemctl systemd-analyze; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "缺少命令：${command_name}" >&2; exit 1; }
done

[[ -d "${REPO_DIR}/.git" ]] || { echo "未找到仓库：${REPO_DIR}" >&2; exit 1; }
[[ -f "${REPO_DIR}/.env" ]] || { echo "未找到配置：${REPO_DIR}/.env" >&2; exit 1; }
[[ -d "${REPO_DIR}/server/data" ]] || { echo "未找到学习数据目录：${REPO_DIR}/server/data" >&2; exit 1; }
docker compose version >/dev/null

bash -n "${REPO_DIR}/deploy/auto-update.sh"
bash -n "${REPO_DIR}/deploy/english-review-version"
bash -n "${REPO_DIR}/deploy/install-version-manager.sh"
systemd-analyze verify "${REPO_DIR}/deploy/english-review-update.service" "${REPO_DIR}/deploy/english-review-update.timer"

exec 9>"$LOCK_FILE"
flock -w 30 9 || { echo "自动更新正在运行，请稍后重新执行安装命令" >&2; exit 1; }

install -d -m 0755 /usr/local/sbin /var/lib/english-review-updater
install -m 0755 "${REPO_DIR}/deploy/auto-update.sh" /usr/local/sbin/english-review-update.next
install -m 0755 "${REPO_DIR}/deploy/english-review-version" /usr/local/sbin/english-review-version.next
mv -f /usr/local/sbin/english-review-update.next /usr/local/sbin/english-review-update
mv -f /usr/local/sbin/english-review-version.next /usr/local/sbin/english-review-version
install -m 0644 "${REPO_DIR}/deploy/english-review-update.service" /etc/systemd/system/english-review-update.service
install -m 0644 "${REPO_DIR}/deploy/english-review-update.timer" /etc/systemd/system/english-review-update.timer

systemctl daemon-reload
systemctl enable --now english-review-update.timer

flock -u 9

echo
echo "SSH 版本管理器已安装；网页没有获得任何 VPS 权限。"
echo "列出版本：sudo english-review-version list"
echo "查看状态：sudo english-review-version status"
echo "切换版本：sudo english-review-version switch v69"
echo "恢复最新版：sudo english-review-version latest"
