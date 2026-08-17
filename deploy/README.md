# 自动更新

自动更新使用 Debian 的 `systemd` timer，每 1 分钟检查一次 GitHub `main` 分支。只有远端提交变化时才会执行 Docker 构建。

## 安装

```bash
cd /opt/english-review
git pull --ff-only
bash deploy/install-auto-update.sh
```

安装程序会立即执行一次部署并检查 `english-review` 为 `healthy`、`english-review-cloudflared` 为 `running`。之后定时器会自动运行。

每次部署前会短暂暂停应用，将 `.env` 和 `server/data` 备份到 `/var/backups/english-review`，并保留最近 10 份。备份目录只有 root 可以访问。

## 查看状态和日志

```bash
systemctl list-timers english-review-update.timer --no-pager
systemctl status english-review-update.timer --no-pager
journalctl -u english-review-update.service -n 100 --no-pager
```

立即检查并部署：

```bash
systemctl start english-review-update.service
```

关闭自动更新：

```bash
systemctl disable --now english-review-update.timer
```

自动更新不会修改 `.env` 或 `server/data`，并会在更新前后核对 Docker 实际挂载的宿主机数据目录。如果 Git 仓库的受跟踪文件存在本地修改、数据挂载不正确，或者远端更新不是快进提交，更新会停止并写入日志，不会强制覆盖文件。

## SSH 版本管理

版本切换不开放网页入口，也不会把 `root`、`sudo`、SSH 私钥或任意命令执行能力交给网站。先在最新版仓库中安装一次独立管理器：

```bash
cd /opt/english-review
sudo git switch main
sudo git pull --ff-only
sudo bash deploy/install-version-manager.sh
```

之后只能在 SSH 终端中运行：

```bash
sudo english-review-version list
sudo english-review-version status
sudo english-review-version switch v69
sudo english-review-version latest
```

`list` 只显示 `origin/main` 历史中页面版本、Service Worker 缓存版本和 VPS 数据挂载声明一致的版本。`switch` 只接受 `v` 加数字，并要求再次输入同一版本确认；它不接受提交哈希、路径或 Shell 参数。

实际切换前会备份 `.env` 与 `server/data`。切换成功后程序固定在所选版本，一分钟自动更新只记录固定状态而不会覆盖它；`latest` 会先健康部署 `origin/main`，成功后才解除固定。目标版本构建或健康检查失败时会自动重建原程序，学习数据不会随程序版本回退。

管理器安装在 `/usr/local/sbin/english-review-version`，固定状态保存在 `/var/lib/english-review-updater/pinned-revision`，两者都位于应用 Git 目录之外。因此即使退回到不含管理器的旧程序版本，仍可继续执行 `status`、切换其他版本或恢复最新版。
