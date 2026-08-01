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
| GET | `/api/sync/profile?username=账号名` | 获取供本地学习窗口使用的学习档案，需要只读同步令牌 |

登录和复习状态使用 HTTP-only Cookie。网页不提供注册接口，账号只能在服务器终端创建。内容新增、修改、删除只允许管理员账号，或使用服务器配置的 `API_TOKEN`。本地学习档案使用由 `API_TOKEN` 派生的只读令牌，不能修改词库。

## 创建账号

VPS 部署后，通过 SSH 进入项目目录并运行：

```bash
docker compose -f docker-compose.vps.yml exec -it english-review npm run user:add
```

用户名会正常显示，密码和确认密码在终端中隐藏输入。首个账号自动成为管理员，后续账号默认为普通成员。需要创建额外管理员时运行：

```bash
docker compose -f docker-compose.vps.yml exec -it english-review npm run user:add -- --admin
```

网页没有账号创建入口，`POST /api/auth/register` 也不存在。

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

## 同步到本地学习窗口

`GET /api/sync/profile` 使用只读同步令牌鉴权，并按账号名返回学习档案。响应只包含课程内容、复习状态、AI 做题历史、错题和薄弱点统计，不包含密码、Cookie、会话令牌或 AI Key。

在 VPS 生成只读令牌：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml exec english-review npm run sync:token
```

该命令不会显示原始 `API_TOKEN`。只读令牌只能调用学习档案接口，不能新增、修改或删除内容。

```powershell
$headers = @{ Authorization = "Bearer 你的只读同步令牌" }
Invoke-RestMethod -Uri "https://你的域名/api/sync/profile?username=你的账号名" -Headers $headers
```

本项目同时提供本地同步脚本。把父目录 `学习同步\.sync.env.example` 复制为 `.sync.env` 并填写三项配置后，在“三年英语学习计划”目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\scripts\sync-learning-profile.ps1"
```

同步结果保存为 `学习同步\网站学习档案.json`，供独立的英语学习窗口读取。不要提交 `.sync.env`，也不要把任何令牌发到聊天中。

## 数据保存位置

Docker 部署时，复习记录和通过 API 添加的内容保存在 `server/data`，由 `docker-compose.yml` 映射到宿主机，不会因为容器重新创建而丢失。

不要把 8080 端口直接暴露到公网。VPS 使用 `docker-compose.vps.yml` 运行 Cloudflare Tunnel；应用容器没有宿主机端口映射，公网 API 地址为 `https://你的域名/api/...`。

## AI 判题接口

`POST /api/ai/grade` 只允许已登录账号调用，并且只接受句子任务。服务器会根据 `taskId` 从自己的题库读取参考答案，网页不能提交或替换参考答案。

请求：

```json
{
  "taskId": "d2-s4:en-zh",
  "answer": "它是一只很大的猫"
}
```

响应：

```json
{
  "correct": true,
  "explanation": "意思相同，只是说法不同。",
  "source": "ai"
}
```

服务端 sub2api 设置见 [AI判题配置.md](AI判题配置.md)。不要向判题或出题接口发送 `API Key`。

## AI 配置与出题接口

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| GET | `/api/ai/options` | 已登录 | 获取允许使用的模型、强度和当前账号选择 |
| PUT | `/api/admin/ai-config` | 管理员 | 保存 Base URL、Key、模型和调用限制 |
| GET | `/api/admin/ai-config` | 管理员 | 获取脱敏后的配置；响应永远不包含 Key |
| POST | `/api/admin/ai-config/models` | 管理员 | 使用当前或已保存的连接信息获取上游模型列表，不保存配置 |
| POST | `/api/admin/ai-config/test` | 管理员 | 使用已保存配置测试模型连接 |
| POST | `/api/ai/questions/generate` | 已登录 | 根据当前账号进度生成 5 或 10 道题 |
| POST | `/api/ai/questions/ask` | 已登录 | 询问当前 AI 题目并保存该题的简短问答记录 |
| POST | `/api/ai/questions/grade` | 已登录 | 判定一道 AI 生成题并保存练习历史 |

生成题目请求：

```json
{
  "model": "管理员允许的模型 ID",
  "reasoningEffort": "medium",
  "count": 5
}
```

题目问答请求中的 `reasoningEffort` 是问答窗口自己的强度，不跟随生成题组时使用的强度，并会按账号保存：

```json
{
  "setId": "当前题组 ID",
  "questionId": "当前题目 ID",
  "historyId": "询问历史题时发送该记录 ID，否则留空",
  "message": "这个句子应该先看哪里？",
  "reasoningEffort": "medium"
}
```

`reasoningEffort` 允许 `low`、`medium`、`high`、`xhigh`、`max`。模型必须位于管理员网页配置的允许列表中。AI 超时配置范围为 1 至 120 秒，默认 30 秒。

服务端从当前账号状态读取题目，不接受客户端伪造的参考答案。每个当前题目最多保留最近 12 条问答消息。

获取上游模型时可发送 `baseUrl`、`apiKey` 和 `timeoutMs`。`apiKey` 留空时使用服务器已保存的 Key；响应只包含模型 ID 和数量，不返回 Key。服务端请求 OpenAI 兼容的 `GET /v1/models`。

出题和判题默认调用 OpenAI 兼容的 `POST /v1/chat/completions`。当该接口返回 `400`、`404`、`405`、`422` 或 `501` 且兼容参数重试仍失败时，服务端自动改试 `POST /v1/responses`。上游鉴权、限流、超时、接口不兼容和返回格式错误会转换为不包含 Key 的中文错误响应。
