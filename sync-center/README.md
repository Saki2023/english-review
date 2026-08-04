# 英语学习同步中心

这是本地学习窗口使用的同步工具。它调用仓库中的 `scripts/sync-learning-profile.ps1`，但提供了可视化界面，能够显示：

- 本次准备同步的学习进度、错题本、每日课程词句、最近每日笔记和预习文件；
- 实际上传到网站的文件；
- 从网站下载的 `网站学习档案.json`；
- 网站当前课程天数、词句与笔记总数，以及 AI 做题、问答、试卷、待复习、听写、专项训练和能力证据统计；
- 最近 50 次同步记录及失败原因；
- 上传和下载各自的成功状态，以及网络、TLS、超时、HTTP 401/403、HTTP 5xx 或本地资料错误类别。

上传教学档案、上传课程内容和下载网站档案是相互独立的阶段。某个上传阶段失败时，工具仍会尝试下载；只要下载成功，`网站学习档案.json` 就会立即刷新，并把本次结果显示为“部分成功”。临时网络、TLS、超时或 HTTP 5xx 错误会有限重试 3 次，权限错误不会反复请求。

如果旧版 Windows PowerShell 的 HTTPS/TLS 网络栈发生连接中断，同步脚本会自动寻找项目可用的 Node.js 运行时并切换到兼容 HTTPS 通道。账号和令牌只通过子进程标准输入在内存中传递，不放入命令行、不写入临时文件，也不会出现在同步报告里。

## 启动

在工作区根目录双击：

```text
学习同步\启动同步中心.cmd
```

也可以在 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\sync-center\同步中心.ps1"
```

首次使用前，`学习同步\.sync.env` 需要已经填写 `SYNC_BASE_URL`、`SYNC_USERNAME`、`SYNC_READ_TOKEN`；要把本地进度上传到网站，还需要 `SYNC_WRITE_TOKEN`。同步中心只显示配置是否存在，不显示任何令牌。

## 自动同步

界面中的“安装每日自动任务”会为当前 Windows 用户安装每天 03:00 执行的任务。任务使用无界面的安全模式，只写入同步记录，不弹出窗口：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\sync-center\同步中心.ps1" -Headless
```

同步记录保存在工作区外的 `学习同步\同步记录` 目录：

- `最近一次同步.json`：供界面读取的最近一次安全摘要；
- `同步历史.json`：最近 50 次摘要。

这些文件只包含文件名、时间、分阶段成功状态、脱敏错误类别和学习统计，不包含账号密码、Cookie、API Key 或同步令牌。下载失败时，界面会把统计明确标成“本地旧快照”，不会冒充本次刚下载的数据。`.sync.env` 永远不应提交到 Git。

## 预览模式

需要检查本地将会同步哪些文件时，可以先运行：

```powershell
powershell -ExecutionPolicy Bypass -File ".\每日英语复习\sync-center\同步中心.ps1" -Headless -DryRun
```

预览模式不会联网，也不会修改网站或学习档案。
