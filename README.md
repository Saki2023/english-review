# 每日英语复习

一个面向英语阅读学习的手机优先 PWA。它支持账号登录、跨设备复习、AI 出题、完整试卷、能力分析、单词听写、定向增强、学习笔记、错题本，以及本地英语教学窗口与网站之间的双向学习档案同步。

本项目推荐部署在 Debian VPS 上，通过 Cloudflare Tunnel 对外提供 HTTPS 服务。生产部署不会把应用的 `8080` 端口映射到 VPS 公网，也不要求应用占用 VPS 的 `80` 或 `443` 端口。

## 目录

- [主要功能](#主要功能)
- [部署结构](#部署结构)
- [部署前准备](#部署前准备)
- [一、检查或安装 Docker](#一检查或安装-docker)
- [二、创建 Cloudflare Tunnel](#二创建-cloudflare-tunnel)
- [三、下载项目](#三下载项目)
- [四、配置环境变量](#四配置环境变量)
- [五、启动服务](#五启动服务)
- [六、创建登录账号](#六创建登录账号)
- [七、在网页配置 AI](#七在网页配置-ai)
- [八、配置本地双向学习同步](#八配置本地双向学习同步)
- [九、安装到手机桌面](#九安装到手机桌面)
- [十、配置每分钟自动更新](#十配置每分钟自动更新)
- [十一、手动更新](#十一手动更新)
- [十二、备份与恢复](#十二备份与恢复)
- [十三、日常维护](#十三日常维护)
- [十四、常见故障排查](#十四常见故障排查)
- [十五、安全检查清单](#十五安全检查清单)
- [十六、停止或卸载](#十六停止或卸载)

## 主要功能

- 按账号保存普通复习进度、错题和间隔复习等级。
- AI 根据已学词句、历史作答、本地教学重点和薄弱点生成题目。
- 每次题目问答按账号和题目长期保存，并同步给本地教学 AI 作为疑惑线索。
- 支持多套 OpenAI 兼容 API，可手动固定供应商或开启自动轮换。
- 100 分或 150 分整卷考试，听力和作文可选。
- 固定包含单选、多选、填空、判断、完形填空、材料题和翻译题。
- 试卷按接近 A3 横向纸张分页，桌面双栏、手机单栏。
- 支持打印或保存 PDF、网页草稿恢复，以及纸质答卷照片 AI 判卷。
- 词汇、拼写、语法、阅读、翻译、听力、写作七维能力雷达图。
- 5、10 或 20 词听写，反复答错的单词会提高后续抽取权重。
- 听力、选择、填空、判断、翻译、完形、材料、作文八类定向增强。
- 单词和句子旁提供设备英文语音按钮，为后续听力和口语练习准备。
- 网站证据同步回本地教学窗口，本地学习计划也可同步给网站 AI。
- 网页没有注册入口，账号只能通过 VPS 的 SSH 终端创建。

## 部署结构

```text
手机或电脑浏览器
        |
        | HTTPS 443
        v
Cloudflare 边缘网络
        |
        | Cloudflare Tunnel 主动出站连接
        v
english-review-cloudflared 容器
        |
        | Docker 内部网络 HTTP
        v
english-review:8080 容器
        |
        v
/opt/english-review/server/data
```

生产 Compose 文件是 `docker-compose.vps.yml`。其中：

- `english-review` 只使用 Docker 内部的 `8080` 端口。
- `cloudflared` 主动连接 Cloudflare，不需要在 VPS 上监听 `80`、`443` 或 `8080`。
- `server/data` 通过宿主机目录绑定挂载，重新构建容器不会重置账号和学习数据。
- `.env` 保存域名、内容 API 主令牌和 Tunnel Token，不进入 Git。

> 本地局域网调试才使用 `docker-compose.yml`。它会把 `8080:8080` 映射到宿主机，不要把这份 Compose 文件用于公网生产部署。

即使 VPS 上已经有其他程序占用了宿主机的 `127.0.0.1:8080`，生产部署通常也不会冲突。这里的应用只在 Compose 内部网络中使用容器端口 `8080`，Cloudflare Tunnel 通过服务名 `english-review:8080` 访问它。

## 部署前准备

需要准备：

1. 一台可以 SSH 登录的 Debian VPS。
2. 一个已经接入 Cloudflare 的域名。
3. 一个用于本项目的子域名，例如 `english.example.com`。
4. GitHub 公网访问能力，用于克隆和自动更新。
5. 至少一个 OpenAI 兼容 AI API；也可以先完成部署，稍后再在网页填写。

建议资源：

- 1 核 CPU 或更高。
- 约 1 GiB 内存；内存较少时建议配置 Swap。
- 至少 3 GiB 可用磁盘，长期运行建议预留更多空间给 Docker 构建缓存和备份。
- Debian 12 或更新的仍受支持版本。

下面命令默认使用 `root`。如果使用普通 sudo 用户，请在需要系统权限的命令前加 `sudo`。

先确认系统和空间：

```bash
cat /etc/os-release
uname -m
free -h
df -h /
```

建议确保系统时间正确：

```bash
timedatectl status
timedatectl set-timezone Asia/Shanghai
```

## 一、检查或安装 Docker

### 1. 已经安装 Docker

先运行：

```bash
docker --version
docker compose version
systemctl is-active docker
docker ps
```

如果能看到 Docker 版本、Compose 版本，并且服务状态为 `active`，可以直接进入“二、创建 Cloudflare Tunnel”。

### 2. 全新 Debian 安装 Docker

先删除可能冲突的旧软件包。未安装时出现“找不到软件包”可以忽略：

```bash
apt update
apt remove -y docker.io docker-compose docker-doc podman-docker containerd runc || true
```

安装基础工具：

```bash
apt install -y ca-certificates curl git openssl
install -m 0755 -d /etc/apt/keyrings
```

添加 Docker 官方签名密钥：

```bash
curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
```

添加 Docker 官方软件源：

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
```

安装 Docker Engine 和 Compose 插件：

```bash
apt update
apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

启用并验证：

```bash
systemctl enable --now docker
docker run --rm hello-world
docker compose version
```

Docker 官方 Debian 安装说明：

- https://docs.docker.com/engine/install/debian/

## 二、创建 Cloudflare Tunnel

本项目使用 remotely-managed Tunnel，Tunnel 配置和 Token 由 Cloudflare 管理。

### 1. 创建 Tunnel

1. 登录 Cloudflare Zero Trust 控制台。
2. 进入 `Networks`、`Connectors` 或 `Tunnels` 页面。Cloudflare 可能调整菜单名称，以 `Cloudflare Tunnels` 页面为准。
3. 点击创建 Tunnel。
4. 连接器类型选择 `cloudflared`。
5. 输入名称，例如 `english-review`。
6. 保存 Tunnel。
7. 在安装连接器页面选择 `Docker`。
8. Cloudflare 会显示一条包含 `--token` 的命令。
9. 只复制 `--token` 后面的整段 Token，稍后填入 `.env`。

Tunnel Token 相当于连接器密码，不要截图公开，不要发到聊天中，也不要提交到 GitHub。

### 2. 配置 Public Hostname

在刚创建的 Tunnel 中添加 Public Hostname：

| Cloudflare 字段 | 填写内容 |
|---|---|
| Subdomain | 例如 `english` |
| Domain | 例如 `example.com` |
| Path | 留空 |
| Service Type | `HTTP` |
| Service URL | `english-review:8080` |

Service URL 必须填写：

```text
english-review:8080
```

不要填写：

```text
localhost:8080
127.0.0.1:8080
VPS公网IP:8080
```

原因是 `cloudflared` 与应用运行在两个 Docker 容器中。`localhost` 对 `cloudflared` 容器来说是它自己，不是应用容器。

Cloudflare 官方文档：

- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

### 3. 防火墙原则

VPS 入站通常只需要保留 SSH 端口。不要额外开放 `80`、`443` 或 `8080` 给本项目。

VPS 出站至少需要：

- HTTPS `443`，用于系统更新、Docker、GitHub 和 AI API。
- Cloudflare Tunnel 使用的 `7844/TCP` 与 `7844/UDP`。
- DNS 查询和系统时间同步所需流量。

如果使用服务商安全组，也要检查安全组的出站规则。

## 三、下载项目

项目固定放在 `/opt/english-review`，因为自动更新脚本默认使用这个路径。

```bash
git clone https://github.com/Saki2023/english-review.git /opt/english-review
cd /opt/english-review
```

确认文件：

```bash
git status
git log -1 --oneline
ls -la
```

应该能看到：

```text
docker-compose.vps.yml
Dockerfile
server.js
index.html
deploy/
```

如果 `/opt/english-review` 已经存在，不要再次 `git clone`。进入目录后检查：

```bash
cd /opt/english-review
git status
git remote -v
```

## 四、配置环境变量

复制示例文件：

```bash
cd /opt/english-review
cp .env.example .env
```

生成 64 个十六进制字符的随机 `API_TOKEN`：

```bash
openssl rand -hex 32
```

编辑 `.env`：

```bash
nano .env
```

内容格式：

```text
DOMAIN=english.example.com
API_TOKEN=这里填写openssl生成的随机字符串
CLOUDFLARE_TUNNEL_TOKEN=这里填写Cloudflare的TunnelToken
```

填写规则：

- `DOMAIN` 只写域名，不要带 `https://`，不要带路径，也不要在末尾加 `/`。
- `API_TOKEN` 使用刚生成的随机值，不要使用账号密码。
- `CLOUDFLARE_TUNNEL_TOKEN` 填写 Cloudflare `--token` 后面的完整内容。
- 等号两边不要额外添加空格。
- 不要把真实 `.env` 内容发给别人。

保存后限制权限并准备持久化目录：

```bash
chmod 600 .env
mkdir -p server/data
chmod 700 server/data
```

只检查配置是否存在和长度，不显示令牌本身：

```bash
awk -F= '
$1=="DOMAIN" {print "DOMAIN=" $2}
$1=="API_TOKEN" {print "API_TOKEN长度=" length($2)}
$1=="CLOUDFLARE_TUNNEL_TOKEN" {print "Tunnel Token长度=" length($2)}
' .env
```

检查 Compose 配置。`--quiet` 不会把展开后的令牌打印到终端：

```bash
docker compose -f docker-compose.vps.yml config --quiet
```

## 五、启动服务

首次启动会下载镜像并构建应用：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml up -d --build
```

查看状态：

```bash
docker compose -f docker-compose.vps.yml ps
```

正常状态应满足：

- `english-review` 为 `Up` 和 `healthy`。
- `english-review-cloudflared` 为 `Up`。
- 应用端口显示 `8080/tcp`，不应出现 `0.0.0.0:8080->8080/tcp`。

查看日志：

```bash
docker compose -f docker-compose.vps.yml logs --tail=100 english-review
docker compose -f docker-compose.vps.yml logs --tail=100 cloudflared
```

从应用容器内部检查健康状态：

```bash
docker compose -f docker-compose.vps.yml exec english-review \
  node -e "fetch('http://127.0.0.1:8080/api/health').then(async r=>{console.log(r.status,await r.text())})"
```

再检查公网地址：

```bash
curl -i https://english.example.com/api/health
```

把示例域名替换为你的真实域名。正常应返回 HTTP `200` 和类似内容：

```json
{
  "ok": true,
  "service": "daily-english-review",
  "authRequired": true
}
```

由于生产 Compose 没有宿主机端口映射，以下命令不能用来确认本应用是否健康：

```bash
curl http://127.0.0.1:8080/api/health
```

它通常会连接失败；如果 VPS 上另一个程序占用了宿主机 `8080`，它也可能返回另一个程序的响应。两种情况都不代表本应用有问题。生产环境应通过 Cloudflare 域名访问，或使用上面的容器内部健康检查。

## 六、创建登录账号

网页没有注册入口。账号必须通过 SSH 终端创建。

创建第一个账号：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml exec -it english-review npm run user:add
```

按提示输入：

```text
用户名：
密码（输入时不会显示）：
再次输入密码：
```

说明：

- 密码输入时终端不显示字符，这是正常的。
- 第一个账号始终是管理员。
- 后续不带参数创建的账号默认为普通成员。

创建额外管理员：

```bash
docker compose -f docker-compose.vps.yml exec -it english-review \
  npm run user:add -- --admin
```

创建普通成员：

```bash
docker compose -f docker-compose.vps.yml exec -it english-review \
  npm run user:add -- --member
```

只查看用户名和角色，不显示密码哈希：

```bash
docker compose -f docker-compose.vps.yml exec english-review \
  node -e "const u=require('./server/accounts').loadUsers('/app/server/data').users;console.log(u.map(x=>({username:x.username,role:x.role})))"
```

现在打开：

```text
https://english.example.com
```

使用刚创建的用户名和密码登录。

## 七、在网页配置 AI

AI 的 Base URL、Key、模型和轮换方式全部在网页配置，不需要写进 VPS `.env`。

1. 使用管理员账号登录。
2. 打开“AI 出题”。
3. 打开“AI 设置”。
4. 添加供应商。
5. 填写名称、Base URL 和 API Key。
6. 点击“获取模型”。
7. 选择默认模型。
8. 选择“手动固定”或“自动轮换”。
9. 点击“保存”或“保存并测试本套”。

常见 Base URL 示例：

```text
https://api.example.com/v1
https://你的NewAPI域名/v1
https://api.deepseek.com/v1
```

不要照抄示例域名。应填写你的 API 服务商提供的真实地址。

AI 设置支持：

- sub2api
- NewAPI
- DeepSeek
- OneAPI
- 标准 OpenAI 兼容 API
- 支持 Chat Completions 或 Responses API 的常见反代

使用纸质答卷照片判卷时，必须选择支持图片输入的模型。普通文本模型可以出题和判卷，但无法读取照片。

AI Key 保存在：

```text
/opt/english-review/server/data/ai-settings.json
```

该文件不会进入 Git，也不会通过网页读取接口返回 Key。详细说明见 [AI判题配置.md](AI判题配置.md)。

## 八、配置本地双向学习同步

双向同步由两个权限不同的令牌组成：

- 只读令牌：把网站学习档案下载到本地学习窗口。
- 教学写入令牌：把本地学习进度、错题、近期笔记和最新预习上传给网站 AI。

### 1. 在 VPS 生成只读令牌

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml exec english-review \
  npm run sync:token
```

### 2. 在 VPS 生成教学档案写入令牌

```bash
docker compose -f docker-compose.vps.yml exec english-review \
  npm run sync:write-token
```

两个命令都会输出一段令牌。不要把令牌发到聊天中。

这两个同步令牌都由 `.env` 中的 `API_TOKEN` 派生。如果以后更换 `API_TOKEN`，旧同步令牌会立即失效，需要重新运行上述两个命令，并更新本地 `.sync.env`。

### 3. 在本地 Windows 配置

在本地“三年英语学习计划”的 `学习同步` 目录中，将：

```text
.sync.env.example
```

复制为：

```text
.sync.env
```

填写：

```text
SYNC_BASE_URL=https://english.example.com
SYNC_USERNAME=你的网站账号名
SYNC_READ_TOKEN=只读令牌
SYNC_WRITE_TOKEN=教学档案写入令牌
```

运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\scripts\sync-learning-profile.ps1"
```

脚本会：

1. 上传本地 `学习进度.md`。
2. 上传本地 `错题本.md`。
3. 上传最近三份每日笔记。
4. 上传最新预习。
5. 下载网站复习、AI 做题与问答、试卷、听写、专项、能力和薄弱点档案。
6. 写入 `学习同步\网站学习档案.json`。

未填写 `SYNC_WRITE_TOKEN` 时，脚本仍可只下载网站档案。

在完整的“三年英语学习计划”工作区中，还可以阅读父目录的 `学习同步\学习窗口使用说明.md`。如果只克隆本仓库而没有父目录的学习文档，可直接使用 [API.md](API.md) 中的同步接口说明。

## 九、安装到手机桌面

以荣耀手机为例：

1. 使用荣耀浏览器或 Chrome 打开 HTTPS 域名。
2. 登录账号。
3. 打开浏览器菜单。
4. 选择“添加到主屏幕”或“安装应用”。
5. 确认后从桌面图标打开。

PWA 安装通常要求：

- 使用 HTTPS。
- 域名可正常访问。
- 浏览器允许添加到主屏幕。

如果没有出现安装按钮，可以先正常访问一次页面，刷新后再查看浏览器菜单。即使浏览器不提供安装入口，也可以直接在浏览器中使用全部功能。

发音、听写和听力依赖浏览器的系统英文语音能力。第一次使用时请确认手机媒体音量不是静音。

## 十、配置每分钟自动更新

自动更新使用 Debian `systemd` timer，每 1 分钟检查一次 GitHub `main` 分支。没有新提交时不会重新构建。

安装：

```bash
cd /opt/english-review
git pull --ff-only
bash deploy/install-auto-update.sh
```

安装程序会：

1. 检查 Git、Docker、Compose 和 systemd。
2. 验证脚本语法。
3. 安装更新服务和定时器。
4. 立即执行一次部署。
5. 检查应用为 `healthy`。
6. 检查 Tunnel 容器为 `running`。

查看定时器：

```bash
systemctl list-timers english-review-update.timer --no-pager
systemctl status english-review-update.timer --no-pager
```

查看最近日志：

```bash
journalctl -u english-review-update.service -n 100 --no-pager
```

立即检查 GitHub 并部署：

```bash
systemctl start english-review-update.service
journalctl -u english-review-update.service -n 100 --no-pager
```

自动更新的安全行为：

- 每次部署前备份 `.env` 和 `server/data`。
- 备份保存在 `/var/backups/english-review`。
- 默认保留最近 10 份。
- 只接受 Git 快进更新。
- Git 跟踪文件有本地改动时停止，不会强制覆盖。
- 数据挂载不正确时停止。
- 新容器健康检查失败时不会记录为已部署成功。
- 不修改 `.env` 或 `server/data`。

详细说明见 [deploy/README.md](deploy/README.md)。

## 十一、手动更新

未安装自动更新时：

```bash
cd /opt/english-review
git status
git pull --ff-only
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
```

再检查：

```bash
curl -s https://english.example.com/api/health
```

如果已经安装自动更新，优先使用：

```bash
systemctl start english-review-update.service
```

这样会自动执行备份、挂载检查和健康检查。

不要使用以下命令更新生产仓库：

```text
git reset --hard
git clean -fd
```

这些命令可能删除本地文件或掩盖部署问题。

## 十二、备份与恢复

### 1. 必须备份的内容

```text
/opt/english-review/.env
/opt/english-review/server/data
```

`server/data` 包含：

- 账号和密码哈希
- 登录会话
- 每个账号的复习记录
- AI 设置
- AI 做题与问答、试卷、听写和专项历史
- 能力证据
- 本地教学档案
- 通过 API 添加的词句

纸质答卷原始图片不会长期保存。

### 2. 查看自动备份

```bash
ls -lh /var/backups/english-review
```

自动备份名称类似：

```text
backup-20260802T120000Z-1953675abcde.tar.gz
```

### 3. 手动创建备份

```bash
cd /opt/english-review
mkdir -p /root/english-review-backups
chmod 700 /root/english-review-backups
docker compose -f docker-compose.vps.yml pause english-review
tar -czf "/root/english-review-backups/manual-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  .env server/data
docker compose -f docker-compose.vps.yml unpause english-review
```

如果 `tar` 失败，也要执行：

```bash
docker compose -f docker-compose.vps.yml unpause english-review
```

### 4. 恢复备份

恢复会覆盖当前 `.env` 和账号数据。先确认备份文件路径正确，并保留当前数据的额外副本。

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml down
tar -tzf /var/backups/english-review/你的备份文件.tar.gz
tar -xzf /var/backups/english-review/你的备份文件.tar.gz \
  -C /opt/english-review
chmod 600 .env
chmod 700 server/data
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
```

恢复后检查公网健康接口并登录确认数据。

## 十三、日常维护

### 查看容器

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml ps
```

### 查看应用日志

```bash
docker compose -f docker-compose.vps.yml logs --tail=200 english-review
```

### 查看 Tunnel 日志

```bash
docker compose -f docker-compose.vps.yml logs --tail=200 cloudflared
```

### 实时查看日志

```bash
docker compose -f docker-compose.vps.yml logs -f --tail=100
```

按 `Ctrl+C` 只会退出日志查看，不会停止容器。

### 查看资源

```bash
docker stats --no-stream english-review english-review-cloudflared
free -h
df -h /
docker system df
```

### 重启应用

```bash
docker compose -f docker-compose.vps.yml restart english-review
```

### 重启全部服务

```bash
docker compose -f docker-compose.vps.yml restart
```

## 十四、常见故障排查

### 1. `docker compose` 命令不存在

检查：

```bash
docker --version
docker compose version
```

新版命令是带空格的 `docker compose`，不是旧版 `docker-compose`。如果缺少 Compose 插件：

```bash
apt update
apt install -y docker-compose-plugin
```

### 2. 应用容器反复重启

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs --tail=200 english-review
docker compose -f docker-compose.vps.yml config --quiet
```

常见原因：

- `.env` 缺少字段。
- `server/data` 权限或挂载异常。
- 磁盘空间不足。
- Docker 构建失败。

### 3. Cloudflare 显示 502

先检查：

```bash
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs --tail=200 cloudflared
```

再到 Cloudflare 检查 Public Hostname：

```text
Type: HTTP
URL: english-review:8080
```

最常见错误是把 Service URL 写成 `localhost:8080`。

### 4. Cloudflare 显示 Tunnel 未连接

检查 Tunnel Token 是否完整：

```bash
awk -F= '$1=="CLOUDFLARE_TUNNEL_TOKEN" {print "Token长度=" length($2)}' .env
```

不要直接打印 Token。修改 `.env` 后重建 Tunnel 容器：

```bash
docker compose -f docker-compose.vps.yml up -d --force-recreate cloudflared
```

如果仍未连接，检查 VPS 出站 `7844/TCP`、`7844/UDP` 和 DNS。

### 5. 公网健康接口正常，但登录没反应

检查账号是否存在：

```bash
docker compose -f docker-compose.vps.yml exec english-review \
  node -e "const u=require('./server/accounts').loadUsers('/app/server/data').users;console.log(u.map(x=>({username:x.username,role:x.role})))"
```

检查浏览器开发者工具或应用日志：

```bash
docker compose -f docker-compose.vps.yml logs --tail=200 english-review
```

还可以用无痕窗口排除旧缓存，但不要长期在无痕窗口学习。

### 6. 忘记密码

程序不会显示原密码，服务器保存的是密码哈希。无法“查看密码”。可以通过 SSH 创建一个新的管理员账号：

```bash
docker compose -f docker-compose.vps.yml exec -it english-review \
  npm run user:add -- --admin
```

登录新管理员后再处理旧账号。不要尝试直接编辑密码哈希。

### 7. AI 设置保存了但无法获取模型

检查：

- Base URL 是否正确。
- Key 是否属于该上游。
- Base URL 是否需要 `/v1`。
- VPS 是否能出站访问上游。
- 上游是否支持 `GET /models`。
- 模型是否对当前 Key 开放。

可以在 AI 设置中使用“保存并测试本套”。程序不会把 Key 写入错误信息。

### 8. 照片判卷提示模型不支持图片

选择支持图片输入的模型。模型出现在上游模型列表中，不代表一定支持视觉输入。普通文本模型不能识别答卷照片。

照片限制：

- JPEG、PNG 或 WebP。
- 最多 6 张。
- 浏览器会先压缩。
- 原图不会写入长期学习数据。

### 9. 听力或喇叭没有声音

检查：

- 手机媒体音量。
- 浏览器是否支持 `SpeechSynthesis`。
- 页面是否为 HTTPS。
- 系统是否安装英文语音。
- 是否被浏览器的自动播放策略拦截。

听力题不会提前显示英文原文，这是防止答案泄露的正常行为。

### 10. 自动更新不运行

```bash
systemctl status english-review-update.timer --no-pager
systemctl status english-review-update.service --no-pager
journalctl -u english-review-update.service -n 200 --no-pager
```

检查仓库：

```bash
cd /opt/english-review
git status
git branch --show-current
git remote -v
```

自动更新要求：

- 路径为 `/opt/english-review`。
- 当前分支为 `main`。
- Git 跟踪文件没有本地修改。
- 远端更新可以快进。
- 应用容器的数据挂载正确。

### 11. 更新后仍显示旧页面

先确认 VPS 已更新：

```bash
cd /opt/english-review
git log -1 --oneline
docker compose -f docker-compose.vps.yml ps
```

再在手机浏览器中：

1. 完全关闭 PWA。
2. 重新打开。
3. 必要时刷新页面。
4. 仍未更新时清除该站点缓存后重新登录。

账号学习数据保存在服务器，不会因为清除浏览器缓存而丢失；本地离线草稿应先确认已经同步到服务器。

### 12. 担心更新会清空数据

生产 Compose 使用：

```text
./server/data:/app/server/data
```

数据在宿主机 `/opt/english-review/server/data`，不是只存在于容器中。正常执行：

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

不会重置数据。真正需要保护的是 `.env` 和 `server/data`，因此必须定期备份。

## 十五、安全检查清单

部署完成后逐项确认：

- [ ] `.env` 权限为 `600`。
- [ ] `server/data` 权限为 `700`。
- [ ] `.env` 没有提交到 Git。
- [ ] Tunnel Token、同步令牌和 AI Key 没有发到聊天中。
- [ ] `docker compose -f docker-compose.vps.yml ps` 没有显示宿主机 `8080` 映射。
- [ ] VPS 防火墙没有为本项目开放 `80`、`443` 或 `8080`。
- [ ] 网页没有注册入口。
- [ ] 管理员密码足够长且不与其他网站共用。
- [ ] AI Key 只在 HTTPS 网页的管理员设置中填写。
- [ ] 已测试备份，并知道恢复步骤。
- [ ] 已查看自动更新日志。

检查文件权限：

```bash
cd /opt/english-review
stat -c '%a %n' .env server/data
```

检查容器端口：

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## 十六、停止或卸载

### 临时停止

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml stop
```

重新启动：

```bash
docker compose -f docker-compose.vps.yml start
```

### 关闭自动更新

```bash
systemctl disable --now english-review-update.timer
```

### 删除容器但保留数据

先备份，然后运行：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml down
```

此命令删除容器和 Compose 网络，但不会删除宿主机的 `.env` 与 `server/data`。

不要在没有备份的情况下删除：

```text
/opt/english-review/.env
/opt/english-review/server/data
/var/backups/english-review
```

## 其他文档

- [VPS部署.md](VPS部署.md)：VPS 命令速查。
- [API.md](API.md)：内容、账号、学习同步、AI、试卷、听写和专项接口。
- [AI判题配置.md](AI判题配置.md)：多供应商、模型、强度和安全边界。
- [使用说明.md](使用说明.md)：普通学习者的功能说明。
- [deploy/README.md](deploy/README.md)：自动更新机制。

## 本地开发与测试

需要 Node.js 20 或更新版本：

```bash
npm test
npm start
```

本地 Docker 调试：

```bash
docker compose up -d --build
docker compose ps
```

打开：

```text
http://127.0.0.1:8080
```

本地 `docker-compose.yml` 会映射 `8080`，只适合可信局域网或本机调试。公网 VPS 请使用 `docker-compose.vps.yml` 和 Cloudflare Tunnel。
