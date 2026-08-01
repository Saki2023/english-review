# 每日英语复习 API

服务启动后，默认地址是 `http://电脑IP:8080`。手机和运行 Docker 的电脑连接同一个局域网时，在手机浏览器打开这个地址即可使用。

## Docker 部署

在 `每日英语复习` 文件夹中运行：

```powershell
docker compose up -d --build
```

检查服务：

```powershell
docker compose ps
Invoke-RestMethod http://localhost:8080/api/health
```

停止服务：

```powershell
docker compose down
```

默认端口是 `8080`。如果同一网络中的电脑地址是 `192.168.1.248`，手机访问地址就是 `http://192.168.1.248:8080`。电脑地址可能由路由器重新分配，可以用 `ipconfig` 重新查看 IPv4 地址。

VPS 使用 Cloudflare Tunnel，不开放 80、443 或 8080。HTTPS、域名和手机安装流程见 [VPS部署.md](VPS部署.md)。

## 接口总览

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 检查服务和词库数量 |
| GET | `/api/auth/status` | 查看当前浏览器是否已登录 |
| POST | `/api/auth/register` | 注册并自动登录 |
| POST | `/api/auth/login` | 登录并取得会话 |
| GET | `/api/auth/me` | 获取当前账号 |
| POST | `/api/auth/logout` | 退出当前会话 |
| GET | `/api/content` | 获取全部词汇、句子和错题种子 |
| GET | `/api/content?day=2&type=word` | 按天数或类型筛选 |
| GET | `/api/content/:id` | 获取一条内容 |
| POST | `/api/content` | 添加一个单词或句子 |
| POST | `/api/content/batch` | 批量添加内容 |
| PATCH | `/api/content/:id` | 修改一条内容 |
| DELETE | `/api/content/:id` | 删除一条内容 |
| GET | `/api/state` | 获取当前账号的复习记录，需要登录 |
| PUT | `/api/state` | 保存当前账号的复习记录，需要登录 |
| GET | `/api/export` | 导出当前账号的词库和复习记录，需要登录 |

注册、登录和复习状态使用 HTTP-only Cookie。内容新增、修改、删除只允许管理员账号，或使用服务器配置的 `API_TOKEN`。

## 账号调试

PowerShell 保存 Cookie 会话：

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ username = '你的用户名'; password = '你的密码' } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:8080/api/auth/login' -WebSession $session -ContentType 'application/json' -Body $loginBody
Invoke-RestMethod -Uri 'http://localhost:8080/api/state' -WebSession $session
```

登录响应中的 `accessToken` 也可用于无 Cookie 的 API 调试：

```powershell
$headers = @{ Authorization = "Bearer $($login.accessToken)" }
Invoke-RestMethod -Uri 'http://localhost:8080/api/content' -Headers $headers
```

## 添加单词

```json
{
  "kind": "word",
  "day": 3,
  "learned": "2026-08-02",
  "english": "pen",
  "phonetic": "/pen/",
  "chinese": "笔",
  "acceptedChinese": ["笔"],
  "pronunciation": "短元音 /e/，声音短促。",
  "example": "It is a red pen.",
  "exampleZh": "它是一支红笔。",
  "directions": ["en-zh", "zh-en"]
}
```

请求：`POST /api/content`，请求体为上面的 JSON。`id` 可以不填，服务会自动生成。

## 添加句子

```json
{
  "kind": "sentence",
  "day": 3,
  "learned": "2026-08-02",
  "english": "It is a red pen.",
  "chinese": "它是一支红笔。",
  "acceptedChinese": ["它是一支红笔"],
  "acceptedEnglish": ["it is a red pen"],
  "directions": ["en-zh", "zh-en"]
}
```

## 调试示例

PowerShell：

```powershell
Invoke-RestMethod http://localhost:8080/api/health
Invoke-RestMethod http://localhost:8080/api/content?day=2
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/content -ContentType 'application/json' -Body (Get-Content .\new-word.json -Raw)
```

如果设置了 `API_TOKEN`，添加、修改、删除内容时要增加请求头：

```text
Authorization: Bearer 你的令牌
```

可以在 `每日英语复习` 文件夹中新建 `.env` 文件：

```text
API_TOKEN=一段足够长的随机字符串
```

## 数据保存位置

Docker 部署时，复习记录和通过 API 添加的内容保存在 `server/data`，由 `docker-compose.yml` 映射到宿主机，不会因为容器重新创建而丢失。

不要把 8080 端口直接暴露到公网。VPS 使用 `docker-compose.vps.yml` 运行 Cloudflare Tunnel；应用容器没有宿主机端口映射，公网 API 地址为 `https://你的域名/api/...`。
