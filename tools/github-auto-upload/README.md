# GitHub 自动上传 EXE

双击工作区根目录中的 `GitHub自动上传.exe` 后，工具会立即找到 `每日英语复习` 仓库并执行以下检查：

1. 寻找能够正常启动的完整 Git；
2. 确认当前分支是 `main`，并确认已经配置 `origin`；
3. 统计尚未提交的修改，但绝不自动执行 `git add` 或 `git commit`；
4. 使用仓库现有 SSH 身份执行 `git push origin main`；
5. 显示“无需上传”“上传成功”或脱敏后的具体失败原因。

工具不会修改系统代理、DNS、路由、网卡或防火墙。它只上传已经提交到 Git 的内容，因此本地 `.env`、`.sync.env`、账号和令牌不会因为双击工具而被自动加入仓库。

重新生成 EXE：

```powershell
powershell -ExecutionPolicy Bypass -File ".\tools\github-auto-upload\build.ps1"
```

默认输出到程序仓库的上一级工作区根目录，生成文件不进入 Git 仓库。
