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
