# sub2api AI 判题配置

AI 只用于本地规则无法确定的句子翻译。单词仍使用严格的本地判题，已经被本地规则接受的句子也不会调用 AI。

## 一、准备信息

需要准备以下三项：

- sub2api 的 OpenAI 兼容 Base URL，例如 `https://你的-sub2api-域名/v1`
- sub2api Key
- sub2api 中可以使用的模型名

不要把 Key 发到聊天窗口，也不要写入 GitHub。Key 只保存在 VPS 的 `/opt/english-review/.env`。

如果 sub2api 在同一台 VPS 上，仍建议填写它的公网 HTTPS Base URL。不要填写 `http://127.0.0.1:8080`，因为在 `english-review` 容器中，`127.0.0.1` 指向英语软件自身，不是 sub2api 容器。

## 二、修改 VPS 配置

通过 SSH 运行：

```bash
cd /opt/english-review
nano .env
```

在原有配置下面增加：

```text
AI_BASE_URL=https://你的-sub2api-域名/v1
AI_API_KEY=你的-sub2api-key
AI_MODEL=你平时使用的模型名
AI_TIMEOUT_MS=10000
AI_RATE_LIMIT_PER_MINUTE=20
```

说明：

- `AI_BASE_URL` 可以填写到 `/v1`，程序会自动请求 `/v1/chat/completions`。
- `AI_TIMEOUT_MS` 默认 10 秒，允许范围是 1 至 30 秒。
- `AI_RATE_LIMIT_PER_MINUTE` 是每个登录账号每分钟最多调用次数，默认 20 次。
- `.env` 已被 Git 忽略，自动更新不会覆盖它。

修改后保持仅 root 可读：

```bash
chmod 600 /opt/english-review/.env
```

## 三、重建容器

```bash
cd /opt/english-review
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml ps
```

检查 AI 是否启用：

```bash
curl -s https://english.6584285.xyz/api/health
```

返回内容中应包含：

```json
"aiGrading": true
```

如果是 `false`，说明 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 至少有一项没有传入容器，或 Base URL 格式无效。检查变量是否存在时不要输出 Key 内容：

```bash
docker compose -f docker-compose.vps.yml exec english-review node -e "console.log({baseUrl:Boolean(process.env.AI_BASE_URL),apiKey:Boolean(process.env.AI_API_KEY),model:process.env.AI_MODEL||''})"
```

查看服务日志：

```bash
docker compose -f docker-compose.vps.yml logs --tail=100 english-review
```

日志只记录超时或 HTTP 状态，不会打印 Key。

## 四、判题方式

```text
本地规则已答对 -> 直接通过，不消耗 AI
单词答错 -> 按本地严格规则判错
句子不完全匹配 -> AI 判断意思是否相同并给出中文说明
AI 超时、限流或不可用 -> 自动退回本地判题，学习记录仍会保存
```

AI 只能通过已登录的账号调用。网页不会获得 sub2api Key，健康接口也只显示 AI 是否启用。
