# Debian VPS + Cloudflare Tunnel 部署

## 部署结构

VPS 不需要开放 80、443 或 8080 端口：

```text
手机 HTTPS -> Cloudflare -> Cloudflare Tunnel -> english-review:8080
```

`8080` 只存在于 Docker Compose 内部网络。`cloudflared` 主动连接 Cloudflare，因此 VPS 只需保留 SSH 入站端口；如果 VPS 限制出站流量，需要允许 `cloudflared` 使用 TCP/UDP 7844。

Cloudflare 官方资料：

- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

## 一、安装 Docker

Debian 按 Docker 官方方式安装 Docker Engine 和 Compose 插件：

```bash
sudo apt update
sudo apt install -y ca-certificates curl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo docker run --rm hello-world
```

## 二、创建 Cloudflare Tunnel

1. 登录 Cloudflare Zero Trust 控制台。
2. 进入 Networks 或 Connectors 下的 Cloudflare Tunnels。
3. 创建一个 remotely-managed Tunnel，类型选择 `cloudflared`。
4. 在安装连接器页面选择 Docker。
5. 复制命令中 `--token` 后面的整段 Tunnel Token。
6. 为 Tunnel 添加 Public Hostname，例如 `english.example.com`。
7. Service Type 选择 `HTTP`。
8. Service URL 填写 `english-review:8080`。

不要把 Service URL 写成 `localhost:8080`，因为 `cloudflared` 与应用位于不同容器中。

## 三、上传程序

从 Windows 上传：

```powershell
scp -r "C:\Users\w9423\Documents\三年英语学习计划\每日英语复习" root@VPS_IP:/opt/english-review
```

然后登录 VPS：

```bash
cd /opt/english-review
```

## 四、配置环境变量

```bash
cp .env.example .env
openssl rand -hex 32
nano .env
```

填写：

```text
DOMAIN=english.example.com
ALLOW_REGISTRATION=true
API_TOKEN=刚才由 openssl 生成的随机字符串
CLOUDFLARE_TUNNEL_TOKEN=Cloudflare 提供的 Tunnel Token
```

`.env` 包含敏感令牌，不要公开或提交到代码仓库。

## 五、启动

```bash
sudo docker compose -f docker-compose.vps.yml up -d --build
sudo docker compose -f docker-compose.vps.yml ps
```

查看日志：

```bash
sudo docker compose -f docker-compose.vps.yml logs --tail=100 english-review
sudo docker compose -f docker-compose.vps.yml logs --tail=100 cloudflared
```

两个容器正常后打开：

```text
https://english.example.com
```

## 六、创建账号并关闭注册

第一个注册账号自动成为管理员。创建完账号后修改 `.env`：

```text
ALLOW_REGISTRATION=false
```

重新应用配置：

```bash
sudo docker compose -f docker-compose.vps.yml up -d
```

已有账号仍可登录，页面将隐藏注册入口。

## 七、安装到荣耀手机

1. 用荣耀浏览器或 Chrome 打开 Cloudflare HTTPS 地址。
2. 登录账号。
3. 打开浏览器菜单，选择“添加到主屏幕”或“安装应用”。
4. 从手机桌面的“英语复习”图标进入。

## 八、备份

备份宿主机目录：

```text
/opt/english-review/server/data
```

这里保存账号、密码哈希、会话、用户学习进度以及通过 API 添加的词句。重新创建容器不会清空这个目录。
