# GitHub 自动上传 EXE

双击工作区根目录中的 `GitHub自动上传.exe` 后，工具会立即找到 `每日英语复习` 仓库并执行以下检查：

1. 寻找能够正常启动的完整 Git；
2. 确认当前分支是 `main`，并确认已经配置 `origin`；
3. 统计尚未提交的修改，但绝不自动执行 `git add` 或 `git commit`；
4. 使用仓库现有 SSH 身份执行 `git push origin main`；
5. 显示“无需上传”“上传成功”或脱敏后的具体失败原因。

工具不会修改系统代理、DNS、路由、网卡或防火墙。它只上传已经提交到 Git 的内容，因此本地 `.env`、`.sync.env`、账号和令牌不会因为双击工具而被自动加入仓库。

## 供 Codex 或 PowerShell 直接调用

不打开窗口，直接执行上传并返回机器可读结果：

```powershell
& '..\GitHub自动上传.exe' --headless --json --result-file "$env:TEMP\english-review-upload-result.json"
$LASTEXITCODE
Get-Content -Raw -Encoding UTF8 "$env:TEMP\english-review-upload-result.json"
```

退出码 `0` 表示“上传成功”或“无需上传”，`1` 表示 Git/网络/SSH 上传失败，`2` 表示结果文件无法写入。结果 JSON 只含接口版本、成功状态和脱敏后的说明，不包含密钥、口令或令牌。Codex 后续可以直接调用这个接口；SSH 私钥仍必须预先加入并解锁到当前 Windows SSH Agent，本工具不会保存或绕过密钥口令。

查看命令行帮助：

```powershell
& '..\GitHub自动上传.exe' --help
```

重新生成 EXE：

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\github-auto-upload\build.ps1"
```

默认输出到程序仓库的上一级工作区根目录，生成文件不进入 Git 仓库。
