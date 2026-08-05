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
| PUT | `/api/content/batch` | 幂等同步每日词句和结构化学习笔记，需要教学写入令牌或管理员权限 |
| PATCH | `/api/content/:id` | 修改一条内容 |
| DELETE | `/api/content/:id` | 删除一条内容 |
| GET | `/api/state` | 获取当前账号的复习记录，需要登录 |
| PUT | `/api/state` | 保存当前账号的复习记录，需要登录 |
| GET | `/api/export` | 导出当前账号的词库和复习记录，需要登录 |
| GET | `/api/sync/profile?username=账号名` | 获取供本地学习窗口使用的学习档案，需要只读同步令牌 |
| PUT | `/api/sync/teaching-profile?username=账号名` | 上传本地教学档案，需要独立的教学写入令牌 |
| GET | `/api/preview` | 获取当前账号最新及近期预习，需要登录 |
| GET | `/api/preview/words` | 获取当前课程紧邻下一天的未学预习词，需要登录 |
| POST | `/api/preview/practice/sentences` | 按当前预习词生成预习句子练习，需要登录及已配置的 AI |
| GET | `/api/abilities` | 获取当前账号七维能力分析，需要登录 |
| POST | `/api/review/sentence-variants` | 创建或恢复今日复习的后台 AI 句子变式任务，需要登录；返回 `202` 时按 `jobId` 查询 |
| GET | `/api/review/sentence-variants?jobId=...` | 查询当前账号的后台句子变式任务；单次上游等待最多 10 分钟，网络/上游失败后每 5 分钟重试，内容连续 3 轮不合格后停止自动重试 |
| GET | `/api/ai/exams` | 获取当前账号的试卷草稿、历史和薄弱点，需要登录 |
| POST | `/api/ai/exams/generate` | 创建按学习进度生成完整试卷的后台任务，需要登录及当前试卷接口版本头，返回 `202` |
| PUT | `/api/ai/exams/current` | 保存当前试卷草稿答案，需要登录 |
| POST | `/api/ai/exams/listening` | 获取当前听力题的语音合成文本，需要登录 |
| POST | `/api/ai/exams/photo-grade` | 识别纸质答卷图片并统一判分，需要登录 |
| POST | `/api/ai/exams/submit` | 完成整卷后统一 AI 判分，需要登录 |
| GET | `/api/ai/dictation` | 获取听写草稿、权重摘要和历史，需要登录 |
| POST | `/api/ai/dictation/generate` | 从已学单词生成 5/10/20 词听写，需要登录 |
| PUT | `/api/ai/dictation/current` | 保存当前听写草稿，需要登录 |
| POST | `/api/ai/dictation/speech` | 获取一项听写的受控英文朗读文本，需要登录 |
| POST | `/api/ai/dictation/submit` | 完成听写后统一分析并更新权重，需要登录 |
| GET | `/api/ai/focused` | 获取定向增强草稿、八项评分和历史，需要登录 |
| POST | `/api/ai/focused/generate` | 生成指定题型的专项训练，需要登录 |
| PUT | `/api/ai/focused/current` | 保存当前专项草稿，需要登录 |
| POST | `/api/ai/focused/listening` | 获取听力专项的受控英文朗读文本，需要登录 |
| POST | `/api/ai/focused/submit` | 完成专项后统一分析，需要登录 |

登录和复习状态使用 HTTP-only Cookie。网页不提供注册接口，账号只能在服务器终端创建。普通内容新增、修改、删除只允许管理员账号，或使用服务器配置的 `API_TOKEN`。本地学习档案使用由 `API_TOKEN` 派生的只读令牌；独立的教学写入令牌只能上传教学档案，以及通过 `PUT /api/content/batch` 幂等同步每日词句和结构化笔记，不能调用其他管理接口。

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

## 自动同步每日课程内容

完整学习工作区会把当天正式新增内容写入父目录 `学习同步\网站课程内容.json`。该文件包含 `updatedAt`、`words`、`sentences` 和 `notes`；每个单词或句子必须使用稳定且唯一的 `id`，每份结构化笔记使用唯一的正整数 `day`。同步脚本还会读取最新的 `预习\第NNN天预习.md`，从“单词 / 发音 / 中文”表格生成 `previewWords`，无需手工重复录入。

同步脚本使用教学写入令牌调用 `PUT /api/content/batch`。接口会先验证整个请求，再按 `id` 更新或新增正式词句、按 `day` 更新或新增笔记；重复运行不会产生重复内容，也不会删除请求中未包含的旧正式课程。`previewWords` 使用替换语义，只接受 `currentDay + 1` 的词，自动排除已学英文、重复项和更远日期；正式 `words` 与预习项同 ID 时正式内容优先。响应中的 `previewWords` 是当前保留的预习词数量。

`GET /api/preview/words` 返回：

```json
{
  "currentDay": 5,
  "nextDay": 6,
  "updatedAt": "2026-08-04",
  "words": [
    { "id": "d6-dog", "day": 6, "learned": "", "preview": true, "english": "dog", "phonetic": "/dɔɡ/", "chinese": "狗" }
  ]
}
```

响应只包含紧邻下一天、尚无正式学习日期且未在正式词库学过的词。预习词不会进入今日复习、听写、能力证据或同步档案中的 `learnedContent`。

### 预习句子练习

`POST /api/preview/practice/sentences` 用于“预习练习”页面的句子模式。请求体可传入要覆盖的预习词 ID；省略 `wordIds` 时会为当前下一天的全部预习词生成句子：

```json
{ "wordIds": ["d6-dog", "d6-run"] }
```

每个返回句子都对应一个 `wordId`，并且必须包含该预习词；句子可以组合已经正式学过的单词来帮助记忆，但服务端会拒绝未学过且不在当前预习列表中的英文词。返回的 `source` 固定为 `ai`，不会把句子写入正式词库、今日复习、错题本或能力统计。

AI 未配置、上游失败、限流或返回不完整时，接口返回 `503`（限流也可能返回 `429`），并包含 `retryAfterMs: 300000` 及 `Retry-After: 300`。前端会保留“待生成”状态，每 5 分钟自动重试；不会用固定本地句子冒充 AI 结果。

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

`GET /api/sync/profile` 使用只读同步令牌鉴权，并按账号名返回学习档案。响应包含课程内容、复习状态、AI 做题历史、按题目保存的 `tutorHistory` 问答记录、试卷成绩与逐题证据、听写和专项历史、七维能力、错题、薄弱点统计及网站保存的本地教学档案，不包含密码、Cookie、会话令牌或 AI Key。问答记录是疑惑线索，不会自动计入错题。`summary.studyGoalSeconds` 为每日 60 分钟目标，`summary.studyGoalDaysMet` 为已达标天数；`activity.dailyStudyTime` 保存各日期的有效秒数，`activity.studyPlan` 给出六个阶段、目标分钟数以及该阶段能否切换到英语学习窗口继续。

在 VPS 生成只读令牌：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml exec english-review npm run sync:token
```

该命令不会显示原始 `API_TOKEN`。只读令牌只能调用学习档案接口，不能新增、修改或删除内容。

如需让本地英语教学窗口把 `学习进度.md`、`错题本.md`、最近三份每日笔记、最近 30 份预习以及 `网站课程内容.json` 中的每日词句和结构化笔记上传到网站，再生成一个权限独立的教学写入令牌：

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml exec english-review npm run sync:write-token
```

只读令牌不能上传；写入令牌不能读取学习档案，也不能使用单条新增、修改或删除接口，只能更新教学档案和受限的每日课程批量同步接口。两者不可互换。

```powershell
$headers = @{ Authorization = "Bearer 你的只读同步令牌" }
Invoke-RestMethod -Uri "https://你的域名/api/sync/profile?username=你的账号名" -Headers $headers
```

本项目同时提供本地同步脚本。把父目录 `学习同步\.sync.env.example` 复制为 `.sync.env`，填写 `SYNC_BASE_URL`、`SYNC_USERNAME`、`SYNC_READ_TOKEN` 和 `SYNC_WRITE_TOKEN` 后，在“三年英语学习计划”目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\scripts\sync-learning-profile.ps1"
```

脚本会先上传本地教学档案，将最新预习设为网页默认内容并保留最近 30 份预习供选择；随后解析最新预习的单词表，并与 `学习同步\网站课程内容.json` 一起幂等更新网站正式词句、预习词与“学习笔记”；最后把网站档案保存为 `学习同步\网站学习档案.json`，供独立的英语学习窗口读取。省略 `SYNC_WRITE_TOKEN` 时会退化为只下载模式。不要提交 `.sync.env`，也不要把任何令牌发到聊天中。

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

服务端多供应商设置见 [AI判题配置.md](AI判题配置.md)。不要向判题或出题接口发送 `API Key`。

## AI 配置与出题接口

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| GET | `/api/ai/options` | 已登录 | 获取允许使用的模型、强度和当前账号选择 |
| PUT | `/api/admin/ai-config` | 管理员 | 保存多套供应商、手动/自动模式和调用限制 |
| GET | `/api/admin/ai-config` | 管理员 | 获取脱敏后的配置；响应永远不包含 Key |
| POST | `/api/admin/ai-config/models` | 管理员 | 使用当前或已保存的连接信息获取上游模型列表，不保存配置 |
| POST | `/api/admin/ai-config/test` | 管理员 | 测试指定供应商和模型，不触发轮换 |
| POST | `/api/ai/questions/generate` | 已登录 | 根据当前账号进度生成 5 或 10 道题 |
| POST | `/api/ai/questions/ask` | 已登录 | 询问当前或历史 AI 题目；请求可带独立 `model` 和 `reasoningEffort`，并按账号及题目追加长期问答记录 |
| POST | `/api/ai/questions/tutor/clear` | 已登录 | 切断指定题目的当前 AI 会话上下文，旧问答仍保留为学习历史 |
| POST | `/api/ai/questions/grade` | 已登录 | 判定一道 AI 生成题并保存练习历史 |
| POST | `/api/review/sentence-variants` | 已登录 | 按已学词句、近期变式和薄弱点创建或恢复后台句子变式任务；可带当前账号选择的 `model`、`reasoningEffort` 和强制新一轮的 `force` |
| GET | `/api/review/sentence-variants?jobId=...` | 已登录 | 轮询后台句子变式任务；单次上游等待最多 10 分钟，合格项立即保留，失败项最多修正 3 轮并返回精确原因；网络/上游失败会在 5 分钟后继续尝试，内容失败不会无限自动请求 |
| GET | `/api/ai/exams` | 已登录 | 获取脱敏后的试卷状态和历史 |
| POST | `/api/ai/exams/generate` | 已登录 | 创建 100 分或 150 分完整试卷的后台生成任务，需发送 `X-English-Review-Exam-Version: 2`，返回 `202`；旧网页会收到明确的刷新提示 |
| PUT | `/api/ai/exams/current` | 已登录 | 保存整卷草稿，不触发判分 |
| POST | `/api/ai/exams/listening` | 已登录 | 获取当前试卷中一题的英文朗读文本 |
| POST | `/api/ai/exams/photo-grade` | 已登录 | 识别最多 6 张纸质答卷图片并完成统一判分 |
| POST | `/api/ai/exams/submit` | 已登录 | 检查整卷完成后发起一次统一判分 |
| GET | `/api/abilities` | 已登录 | 获取七维 0-100 能力、综合分和证据量 |
| GET | `/api/ai/dictation` | 已登录 | 获取听写草稿、历史和错词权重摘要 |
| POST | `/api/ai/dictation/generate` | 已登录 | 按权重抽取 5/10/20 个已学单词 |
| PUT | `/api/ai/dictation/current` | 已登录 | 保存听写草稿 |
| POST | `/api/ai/dictation/speech` | 已登录 | 获取一个听写单词的朗读文本 |
| POST | `/api/ai/dictation/submit` | 已登录 | 统一分析听写并更新错词权重 |
| GET | `/api/ai/focused` | 已登录 | 获取专项草稿、历史和八项 0-5 分能力 |
| POST | `/api/ai/focused/generate` | 已登录 | 生成指定题型的专项训练 |
| PUT | `/api/ai/focused/current` | 已登录 | 保存专项草稿 |
| POST | `/api/ai/focused/listening` | 已登录 | 获取听力专项的朗读文本 |
| POST | `/api/ai/focused/submit` | 已登录 | 统一分析专项并更新能力 |

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

`reasoningEffort` 允许 `low`、`medium`、`high`、`xhigh`、`max`。模型必须位于管理员网页配置的允许列表中。一般 AI 请求的超时配置范围为 1 至 120 秒，默认 30 秒；完整试卷输出较长，试卷生成任务会把本次上游等待时间提高到 120 秒。今日复习句子变式使用账号当前选择的模型和强度，并在独立后台任务中运行；每次后台任务最多运行 10 分钟，单次上游请求会被安全中止，避免连接卡住后永久 `pending`。网页通过 `jobId` 轮询，因此 Cloudflare 单次网页请求结束也不会取消后台生成。内容不达标时最多修正 3 轮，随后停止自动重试并提示手动重试或更换模型；只有网络、限流或上游暂时不可用才按 5 分钟自动重试，重试没有总次数上限。

生成试卷请求：

```json
{
  "model": "管理员允许的模型 ID",
  "reasoningEffort": "medium",
  "totalPoints": 150,
  "includeEssay": true,
  "includeListening": true
}
```

接口会立即返回 HTTP `202`，不会让浏览器和 Cloudflare 一直等待 AI 完成。响应中的 `generation` 示例：

```json
{
  "id": "examgen-任务 ID",
  "status": "pending",
  "startedAt": "2026-08-02T00:00:00.000Z",
  "finishedAt": "",
  "examId": "",
  "error": "",
  "providerStatus": null
}
```

随后轮询 `GET /api/ai/exams`。`generation.status` 为 `completed` 时，`generation.examId` 对应新的 `currentExam.id`；为 `failed` 时，`generation.error` 提供经过脱敏的超时、上游状态或格式校验说明。任务进行中再次生成会返回 `409`。服务重启会把未完成任务标记为失败，已有试卷不会被覆盖。

`totalPoints` 只能选择 `100` 或 `150`。单选 3 题、多选 2 题、填空 3 题、判断 3 题、完形填空 4 题、材料题 3 题和翻译 3 题是固定部分，共 21 题；听力可选，开启后增加 3 题；作文可选，开启后增加 1 题。AI 返回的题型或数量不足时整卷生成失败，不会保存残缺试卷。听力题答题时不返回可见原文，网页点击播放后通过 `/api/ai/exams/listening` 取得文本，并使用设备的英文语音合成慢速朗读。设备不支持语音合成时，网页会禁用听力选项。

草稿保存请求：

```json
{
  "examId": "当前试卷 ID",
  "answers": {
    "题目 ID": "文本、选项 ID、布尔值或多选 ID 数组"
  }
}
```

交卷使用同样的 `examId` 和 `answers` 请求 `/api/ai/exams/submit`。服务器先验证每题均已完成，再计算客观题，并只向 AI 发起一次整卷主观题判分与薄弱点分析。未交卷时，所有答案键留在服务端；普通 `/api/state` 和 `/api/export` 不返回试卷内部状态，`PUT /api/state` 也会保留已有试卷数据。

纸质答卷请求 `/api/ai/exams/photo-grade`：

```json
{
  "examId": "当前试卷 ID",
  "images": ["data:image/jpeg;base64,..."]
}
```

只接受 JPEG、PNG 或 WebP，最多 6 张；每张解码后不超过 3 MiB，全部图片解码后合计不超过 12 MiB。HTTP 请求解析上限为 18 MiB，用于容纳 Base64 的额外体积。服务器不会把图片写入账号状态，只保存识别出的答案、成绩和薄弱点。所选模型必须支持图片输入。

听写生成请求：

```json
{
  "model": "管理员允许的模型 ID",
  "reasoningEffort": "medium",
  "count": 10
}
```

`count` 只能为 `5`、`10` 或 `20`。朗读接口只接收当前 `sessionId` 和 `itemId`；草稿及提交接口发送 `sessionId` 与按项目 ID 保存的 `answers`。答错权重加 2，答对权重减 1，权重限制在 1-20。

定向增强生成请求：

```json
{
  "model": "管理员允许的模型 ID",
  "reasoningEffort": "medium",
  "focusedType": "reading"
}
```

`focusedType` 允许 `listening`、`choice`、`fill-blank`、`true-false`、`translation`、`cloze`、`reading` 和 `essay`。除作文为 1 题外，其余专项每次 5 题；完成后统一换算为 0-5 分，并写入专项历史、七维能力和学习同步档案。

服务端从当前账号状态读取题目，不接受客户端伪造的参考答案。账号最多保留最近 1000 次完整问答；每道题的记录互不覆盖。调用上游 AI 时只携带当前题目最近 12 条消息控制上下文长度，但较早记录仍保存在账号状态和学习同步档案中。

保存多供应商配置的请求结构：

```json
{
  "schema": 2,
  "mode": "manual",
  "manualProviderId": "sub2api-main",
  "providers": [
    {
      "id": "sub2api-main",
      "name": "sub2api",
      "enabled": true,
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "仅写入时发送；留空保留旧 Key",
      "models": ["model-a"],
      "timeoutMs": 30000
    }
  ],
  "defaultModel": "model-a",
  "rateLimitPerMinute": 20
}
```

`mode` 允许 `manual` 和 `auto`。手动模式只调用 `manualProviderId` 指定的已启用供应商，不进行跨供应商故障切换；自动模式在支持所选模型的已启用供应商间轮询，失败时尝试下一套。旧版单供应商配置会自动迁移为 schema 2 的手动模式。

读取配置时，`providers` 中只返回 `hasApiKey`，永远不返回 `apiKey`。获取上游模型时可发送 `providerId`、`providerName`、`baseUrl`、`apiKey` 和 `timeoutMs`；`apiKey` 留空时按 `providerId` 使用服务器已保存的 Key。响应只包含模型 ID 和数量。测试连接时发送 `providerId`、`model` 和 `reasoningEffort`。

出题和判题默认调用 OpenAI 兼容的 `POST /v1/chat/completions`。当该接口返回 `400`、`404`、`405`、`422` 或 `501` 且兼容参数重试仍失败时，服务端自动改试 `POST /v1/responses`。上游鉴权、限流、超时、接口不兼容和返回格式错误会转换为不包含 Key 的中文错误响应。
