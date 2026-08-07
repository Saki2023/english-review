param(
  [switch]$Headless,
  [switch]$InstallDailyTask,
  [switch]$RemoveDailyTask,
  [switch]$PreviewPracticeOnly,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$sharedDirectory = Join-Path $workspaceRoot "学习同步"
$syncScript = Join-Path $repoRoot "scripts\sync-learning-profile.ps1"
$fullProfilePath = Join-Path $sharedDirectory "网站学习档案.json"
$previewPracticePath = Join-Path $sharedDirectory "网站预习练习.json"
$reportDirectory = Join-Path $sharedDirectory "同步记录"
$latestReportPath = Join-Path $reportDirectory "最近一次同步.json"
$historyPath = Join-Path $reportDirectory "同步历史.json"
$centerConfigPath = Join-Path $reportDirectory "同步中心配置.json"
$taskName = "EnglishReview-LearningSync"

function Ensure-ReportDirectory {
  if (-not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
  }
}

function Resolve-PowerShellExecutable {
  foreach ($name in @("powershell.exe", "pwsh.exe")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      if ($command.Source) { return $command.Source }
      if ($command.Path) { return $command.Path }
    }
  }
  $fallback = Join-Path $PSHOME "powershell.exe"
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw "找不到 PowerShell，无法启动同步脚本。"
}

function Redact-SensitiveText([string]$Value) {
  if ($null -eq $Value) { return "" }
  $safe = $Value -replace '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+', '$1<已隐藏>'
  $safe = $safe -replace '(?i)(SYNC_(READ|WRITE)_TOKEN|API_TOKEN)\s*[=:]\s*[^\s,;]+', '$1=<已隐藏>'
  return $safe
}

function Get-RelativeWorkspacePath([string]$Path) {
  if ($Path.StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return $Path.Substring($workspaceRoot.Length).TrimStart([char[]]"\/")
  }
  return [IO.Path]::GetFileName($Path)
}

function New-DocumentRecord([string]$Path, [string]$Kind) {
  $exists = Test-Path -LiteralPath $Path
  return [pscustomobject]@{
    path = Get-RelativeWorkspacePath $Path
    kind = $Kind
    exists = $exists
    size = if ($exists) { (Get-Item -LiteralPath $Path).Length } else { 0 }
  }
}

function Get-InputSnapshot {
  $documents = @()
  $documents += New-DocumentRecord (Join-Path $workspaceRoot "学习进度.md") "学习进度"
  $documents += New-DocumentRecord (Join-Path $workspaceRoot "错题本.md") "错题本"
  $documents += New-DocumentRecord (Join-Path $sharedDirectory "网站课程内容.json") "网站课程内容"

  $notesDirectory = Join-Path $workspaceRoot "每日笔记"
  if (Test-Path -LiteralPath $notesDirectory) {
    $notes = @(Get-ChildItem -LiteralPath $notesDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 3 | Sort-Object Name)
    foreach ($note in $notes) { $documents += New-DocumentRecord $note.FullName "每日笔记" }
  }

  $previewDirectory = Join-Path $workspaceRoot "预习"
  $previews = @()
  if (Test-Path -LiteralPath $previewDirectory) {
    $previews = @(Get-ChildItem -LiteralPath $previewDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 30 | Sort-Object Name)
    foreach ($preview in $previews) { $documents += New-DocumentRecord $preview.FullName "每日预习" }
  }

  return [pscustomobject]@{
    documents = @($documents)
    previewCount = $previews.Count
    latestPreview = if ($previews.Count -gt 0) { $previews[-1].Name } else { "" }
  }
}

function Get-ConfigState {
  $configPath = Join-Path $sharedDirectory ".sync.env"
  $names = @()
  if (Test-Path -LiteralPath $configPath) {
    foreach ($line in Get-Content -LiteralPath $configPath -Encoding UTF8) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
      $separator = $trimmed.IndexOf("=")
      if ($separator -gt 0) { $names += $trimmed.Substring(0, $separator).Trim() }
    }
  }
  return [pscustomobject]@{
    exists = Test-Path -LiteralPath $configPath
    hasBaseUrl = $names -contains "SYNC_BASE_URL"
    hasUsername = $names -contains "SYNC_USERNAME"
    hasReadToken = $names -contains "SYNC_READ_TOKEN"
    hasWriteToken = $names -contains "SYNC_WRITE_TOKEN"
  }
}

function Get-ObjectValue($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) {
    $value = $Object.PSObject.Properties[$Name].Value
    if ($null -ne $value) { return $value }
  }
  return $Default
}

function Get-NumberValue($Object, [string]$Name, [int]$Default = 0) {
  $value = Get-ObjectValue $Object $Name $Default
  try { return [int]$value } catch { return $Default }
}

function Get-DecimalValue($Object, [string]$Name, [double]$Default = 0) {
  $value = Get-ObjectValue $Object $Name $Default
  try { return [double]$value } catch { return $Default }
}

function Read-WebsiteSummary([string]$ProfilePath = $fullProfilePath) {
  $profilePath = $ProfilePath
  if (-not (Test-Path -LiteralPath $profilePath)) { return $null }
  try {
    $profile = Get-Content -Raw -Encoding UTF8 -LiteralPath $profilePath | ConvertFrom-Json
    $summary = Get-ObjectValue $profile "summary"
    $abilities = Get-ObjectValue $profile "abilities"
    $course = Get-ObjectValue $profile "course"
    return [ordered]@{
      courseDay = Get-NumberValue $course "currentDay"
      courseWords = Get-NumberValue $course "words"
      coursePreviewWords = Get-NumberValue $course "previewWords"
      courseSentences = Get-NumberValue $course "sentences"
      courseNotes = Get-NumberValue $course "notes"
      aiQuestions = Get-NumberValue $summary "aiQuestions"
      aiCorrect = Get-DecimalValue $summary "aiCorrect"
      aiAccuracy = Get-NumberValue $summary "aiAccuracy"
      tutorQuestions = Get-NumberValue $summary "tutorQuestions"
      previewPracticeRounds = Get-NumberValue $summary "previewPracticeRounds"
      previewPracticeQuestions = Get-NumberValue $summary "previewPracticeQuestions"
      previewPracticeFullyCorrect = Get-NumberValue $summary "previewPracticeFullyCorrect"
      previewPracticePartiallyCorrect = Get-NumberValue $summary "previewPracticePartiallyCorrect"
      previewPracticeIncorrect = Get-NumberValue $summary "previewPracticeIncorrect"
      previewPracticeAverageScore = Get-ObjectValue $summary "previewPracticeAverageScore" "—"
      exams = Get-NumberValue $summary "exams"
      latestExamScore = Get-ObjectValue $summary "latestExamScore" "—"
      latestExamPossible = Get-ObjectValue $summary "latestExamPossible" "—"
      itemsNeedingReview = Get-NumberValue $summary "itemsNeedingReview"
      dictations = Get-NumberValue $summary "dictations"
      focusedSessions = Get-NumberValue $summary "focusedSessions"
      evidence = Get-NumberValue $abilities "totalEvidence"
      abilityScore = Get-NumberValue $abilities "comprehensiveScore"
    }
  } catch {
    return $null
  }
}

function Read-ReportHistory {
  Ensure-ReportDirectory
  if (-not (Test-Path -LiteralPath $historyPath)) { return @() }
  try {
    $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $historyPath | ConvertFrom-Json
    if ($value -is [array]) { return @($value) }
    if ($null -ne $value) { return @($value) }
  } catch { }
  return @()
}

function Save-Report($Report) {
  Ensure-ReportDirectory
  $json = $Report | ConvertTo-Json -Depth 15
  [IO.File]::WriteAllText($latestReportPath, "$json`n", (New-Object Text.UTF8Encoding($false)))
  $history = @(Read-ReportHistory)
  $history += [pscustomobject]$Report
  if ($history.Count -gt 50) { $history = @($history | Select-Object -Last 50) }
  $historyJson = $history | ConvertTo-Json -Depth 15
  [IO.File]::WriteAllText($historyPath, "$historyJson`n", (New-Object Text.UTF8Encoding($false)))
}

function Get-OutputMessages([string[]]$Lines) {
  $messages = @()
  foreach ($line in $Lines) {
    if (-not $line) { continue }
    if ($line -match "已上传|已同步|预习练习|网站 AI|网站试卷|待复习|听写：|专项训练") {
      $messages += Redact-SensitiveText $line
    }
  }
  return @($messages | Select-Object -Last 20)
}

function Invoke-UnderlyingSync([switch]$PreviewOnly, [switch]$PreviewPracticeOnly) {
  $started = Get-Date
  $snapshot = Get-InputSnapshot
  if ($PreviewOnly) {
    $report = [ordered]@{
      schemaVersion = 2
      mode = "dry-run"
      success = $true
      partialSuccess = $false
      uploadAttempted = $false
      uploadSuccess = $null
      downloadAttempted = $false
      downloadSuccess = $false
      compatibilityTransportUsed = $false
      errorCategory = ""
      errors = @()
      startedAt = $started.ToString("o")
      finishedAt = (Get-Date).ToString("o")
      preparedFiles = @($snapshot.documents | Where-Object { $_.exists } | ForEach-Object { $_.path })
      uploadedFiles = @()
      previewFiles = @($snapshot.documents | Where-Object { $_.exists -and $_.kind -eq "每日预习" } | ForEach-Object { $_.path })
      downloadedFiles = @()
      summary = Read-WebsiteSummary
      messages = @("预览模式：未连接网站，也未修改任何学习数据。")
      error = ""
    }
    Save-Report $report
    return $report
  }

  $statusPath = Join-Path $env:TEMP ("english-review-sync-" + [guid]::NewGuid().ToString("N") + ".status.json")
  $stdoutLines = @()
  $stderrLines = @()
  $syncStatus = $null
  $exitCode = 1
  try {
    $syncArguments = @("-StatusPath", $statusPath, "-NoExitOnFailure")
    if ($PreviewPracticeOnly) { $syncArguments += "-PreviewPracticeOnly" }
    $records = @(& $syncScript @syncArguments *>&1)
    foreach ($record in $records) {
      $line = Redact-SensitiveText ([string]$record)
      if (-not $line) { continue }
      if ($record -is [System.Management.Automation.ErrorRecord]) { $stderrLines += $line }
      else { $stdoutLines += $line }
    }
    if (Test-Path -LiteralPath $statusPath) {
      try { $syncStatus = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath | ConvertFrom-Json } catch { $syncStatus = $null }
    }
    $exitCode = if ($syncStatus -and [bool](Get-ObjectValue $syncStatus "success" $false)) { 0 } else { 1 }
  } catch {
    $stderrLines = @((Redact-SensitiveText $_.Exception.Message))
  } finally {
    Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
  }

  $configState = Get-ConfigState
  $profilePath = if ($PreviewPracticeOnly) { $previewPracticePath } else { $fullProfilePath }
  $profileAvailable = Test-Path -LiteralPath $profilePath
  $uploadAttempted = if ($PreviewPracticeOnly) { $false } elseif ($syncStatus) { [bool](Get-ObjectValue $syncStatus "uploadAttempted" $configState.hasWriteToken) } else { [bool]$configState.hasWriteToken }
  $uploadSucceeded = if ($PreviewPracticeOnly) { $false } elseif ($syncStatus) { [bool](Get-ObjectValue $syncStatus "uploadSuccess" $false) } else { ($exitCode -eq 0 -and $configState.hasWriteToken) }
  $teachingUploadSucceeded = if ($PreviewPracticeOnly) { $false } elseif ($syncStatus) { [bool](Get-ObjectValue $syncStatus "teachingUploadSuccess" $false) } else { $uploadSucceeded }
  $courseUploadSucceeded = if ($PreviewPracticeOnly) { $false } elseif ($syncStatus) { [bool](Get-ObjectValue $syncStatus "courseUploadSuccess" $false) } else { $uploadSucceeded }
  $downloadAttempted = if ($syncStatus) { [bool](Get-ObjectValue $syncStatus "downloadAttempted" $false) } else { $true }
  $downloadSucceeded = if ($syncStatus) { [bool](Get-ObjectValue $syncStatus "downloadSuccess" $false) } else { ($exitCode -eq 0 -and $profileAvailable) }
  $compatibilityTransportUsed = if ($syncStatus) { [bool](Get-ObjectValue $syncStatus "compatibilityTransportUsed" $false) } else { $false }
  $preparedFiles = if ($PreviewPracticeOnly) { @() } else { @($snapshot.documents | Where-Object { $_.exists } | ForEach-Object { $_.path }) }
  $uploadedFiles = @()
  if ($teachingUploadSucceeded) {
    $uploadedFiles += @($snapshot.documents | Where-Object { $_.exists -and $_.kind -ne "网站课程内容" } | ForEach-Object { $_.path })
  }
  if ($courseUploadSucceeded) {
    $uploadedFiles += @($snapshot.documents | Where-Object { $_.exists -and $_.kind -eq "网站课程内容" } | ForEach-Object { $_.path })
  }
  $uploadedFiles = @($uploadedFiles | Select-Object -Unique)
  $previewFiles = @()
  if ($teachingUploadSucceeded) { $previewFiles = @($snapshot.documents | Where-Object { $_.exists -and $_.kind -eq "每日预习" } | ForEach-Object { $_.path }) }
  $downloadedFiles = @()
  if ($downloadSucceeded -and $profileAvailable) {
    $downloadedFiles = @($(if ($PreviewPracticeOnly) { "学习同步\网站预习练习.json" } else { "学习同步\网站学习档案.json" }))
  }
  $errors = @()
  if ($syncStatus) { $errors = @((Get-ObjectValue $syncStatus "errors" @())) }
  $errorCategories = @($errors | ForEach-Object { Redact-SensitiveText ([string](Get-ObjectValue $_ "category" "unknown")) } | Where-Object { $_ } | Select-Object -Unique)
  $errorText = ""
  if ($errors.Count -gt 0) {
    $errorText = @($errors | ForEach-Object {
      $phase = Redact-SensitiveText ([string](Get-ObjectValue $_ "phase" "sync"))
      $message = Redact-SensitiveText ([string](Get-ObjectValue $_ "message" "同步阶段失败。"))
      "$phase：$message"
    } | Select-Object -Unique) -join "；"
  } elseif ($exitCode -ne 0) {
    $errorText = Redact-SensitiveText (($stderrLines + $stdoutLines | Where-Object { $_ } | Select-Object -Last 1) -join "")
    if (-not $errorText) { $errorText = "同步脚本返回错误代码 $exitCode。" }
  }
  $messages = @(Get-OutputMessages ($stdoutLines + $stderrLines))
  $websiteSummary = Read-WebsiteSummary $profilePath
  if ($uploadSucceeded) { $messages += "本地教学档案和课程内容已上传到网站。" }
  if ($previewFiles.Count -gt 0) { $messages += "每日预习已同步：$($previewFiles[-1])（共 $($previewFiles.Count) 份）" }
  if ($courseUploadSucceeded -and $websiteSummary -and ($preparedFiles -contains "学习同步\网站课程内容.json")) {
    $messages += "网站课程已同步：第 $($websiteSummary.courseDay) 天，$($websiteSummary.courseWords) 个正式单词、$($websiteSummary.coursePreviewWords) 个预习单词、$($websiteSummary.courseSentences) 个句子、$($websiteSummary.courseNotes) 份笔记。"
  }
  if ($downloadedFiles.Count -gt 0) {
    $messages += $(if ($PreviewPracticeOnly) { "预习练习记录已单独下载到本地；本次没有上传任何内容。" } else { "网站学习档案已下载到本地。" })
  }
  if ($compatibilityTransportUsed) { $messages += "Windows PowerShell 网络通道异常，本次已自动使用兼容 HTTPS 通道。" }
  if (-not $uploadSucceeded -and $downloadSucceeded -and $uploadAttempted) { $messages += "上传失败，但网站学习档案已成功下载并刷新。" }
  $overallSuccess = ($downloadSucceeded -and (-not $uploadAttempted -or $uploadSucceeded))
  $partialSuccess = (($downloadSucceeded -and $uploadAttempted -and -not $uploadSucceeded) -or ($uploadSucceeded -and -not $downloadSucceeded))
  $report = [ordered]@{
    schemaVersion = 2
    mode = if ($PreviewPracticeOnly) { "preview-practice" } else { "sync" }
    success = $overallSuccess
    partialSuccess = $partialSuccess
    uploadAttempted = $uploadAttempted
    uploadSuccess = if ($uploadAttempted) { $uploadSucceeded } else { $null }
    teachingUploadSuccess = if ($uploadAttempted) { $teachingUploadSucceeded } else { $null }
    courseUploadSuccess = if ($uploadAttempted) { $courseUploadSucceeded } else { $null }
    downloadAttempted = $downloadAttempted
    downloadSuccess = $downloadSucceeded
    compatibilityTransportUsed = $compatibilityTransportUsed
    errorCategory = ($errorCategories -join ",")
    errors = $errors
    startedAt = $started.ToString("o")
    finishedAt = (Get-Date).ToString("o")
    preparedFiles = $preparedFiles
    uploadedFiles = $uploadedFiles
    previewFiles = $previewFiles
    downloadedFiles = $downloadedFiles
    summary = $websiteSummary
    messages = @($messages | Select-Object -Unique)
    error = $errorText
  }
  Save-Report $report
  return $report
}

function Read-CenterConfig {
  $defaults = [ordered]@{ autoSync = $true; intervalHours = 24 }
  if (-not (Test-Path -LiteralPath $centerConfigPath)) { return $defaults }
  try {
    $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $centerConfigPath | ConvertFrom-Json
    if ($null -ne $value.PSObject.Properties["autoSync"]) { $defaults.autoSync = [bool]$value.autoSync }
    if ($null -ne $value.PSObject.Properties["intervalHours"]) { $defaults.intervalHours = [Math]::Max(1, [int]$value.intervalHours) }
  } catch { }
  return $defaults
}

function Save-CenterConfig($Config) {
  Ensure-ReportDirectory
  $Config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $centerConfigPath -Encoding UTF8
}

function Register-DailySyncTask {
  $powerShell = Resolve-PowerShellExecutable
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw "当前 Windows 没有可用的任务计划程序命令。"
  }
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Headless"
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date).Date.AddHours(3)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "每日英语复习：自动同步学习进度、错题、笔记、预习和网站学习档案" -Force | Out-Null
  return "已安装每日 03:00 自动同步任务：$taskName"
}

function Remove-DailySyncTask {
  if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    return "已移除每日自动同步任务：$taskName"
  }
  return "当前 Windows 没有可用的任务计划程序命令。"
}

function Get-ReportText($Report) {
  if ($null -eq $Report) { return "还没有同步记录。点击立即同步开始。" }
  $lines = @()
  $status = if ([bool]$Report.success) { "成功" } else { "失败" }
  if ([bool](Get-ObjectValue $Report "partialSuccess" $false)) { $status = "部分成功" }
  if ($Report.mode -eq "dry-run") { $status = "预览" }
  $lines += "状态：$status"
  if ($Report.mode -ne "dry-run") {
    $previewPracticeMode = $Report.mode -eq "preview-practice"
    $uploadAttempted = [bool](Get-ObjectValue $Report "uploadAttempted" $false)
    $uploadState = if ($previewPracticeMode) { "未执行（仅下载预习练习）" } elseif (-not $uploadAttempted) { "未配置写入令牌，本次跳过" } elseif ([bool](Get-ObjectValue $Report "uploadSuccess" $false)) { "成功" } else { "失败" }
    $downloadState = if ([bool](Get-ObjectValue $Report "downloadSuccess" $false)) {
      $(if ($previewPracticeMode) { "成功，已刷新本地网站预习练习记录" } else { "成功，已刷新本地网站学习档案" })
    } else {
      $(if ($previewPracticeMode) { "失败，本地旧预习练习记录已保留" } else { "失败，本地旧快照已保留" })
    }
    $lines += "上传阶段：$uploadState"
    $lines += "下载阶段：$downloadState"
    if ([bool](Get-ObjectValue $Report "compatibilityTransportUsed" $false)) { $lines += "网络通道：已自动使用兼容 HTTPS 通道" }
    $category = Redact-SensitiveText ([string](Get-ObjectValue $Report "errorCategory" ""))
    if ($category) { $lines += "错误类别：$category" }
  }
  $lines += "开始：$($Report.startedAt)"
  $lines += "完成：$($Report.finishedAt)"
  $lines += ""
  $lines += "准备同步的本地内容："
  if ($Report.mode -eq "preview-practice") { $lines += "  （仅下载预习练习，本模式不读取或上传本地学习文档）" }
  elseif (@($Report.preparedFiles).Count -eq 0) { $lines += "  （没有找到可上传的学习文档）" }
  else { foreach ($item in @($Report.preparedFiles)) { $lines += "  · $item" } }
  $lines += ""
  $lines += "已上传到网站："
  if ($Report.mode -eq "preview-practice") { $lines += "  （仅同步预习练习不会上传任何内容）" }
  elseif (@($Report.uploadedFiles).Count -eq 0) { $lines += "  （本次没有上传，可能未配置写入令牌）" }
  else { foreach ($item in @($Report.uploadedFiles)) { $lines += "  · $item" } }
  $lines += ""
  $lines += "从网站下载："
  if (@($Report.downloadedFiles).Count -eq 0) { $lines += $(if ($Report.mode -eq "preview-practice") { "  （没有生成网站预习练习记录）" } else { "  （没有生成网站学习档案）" }) }
  else { foreach ($item in @($Report.downloadedFiles)) { $lines += "  · $item" } }
  $lines += ""
  $downloadIsFresh = [bool](Get-ObjectValue $Report "downloadSuccess" $false)
  $lines += if ($downloadIsFresh) { "本次下载的网站学习统计：" } else { "本地旧快照统计（本次未刷新）：" }
  $summary = $Report.summary
  if ($null -eq $summary) { $lines += "  （暂无可读取的学习档案统计）" }
  elseif ($Report.mode -eq "preview-practice") {
    $lines += "  · 预习练习：$($summary.previewPracticeRounds) 轮、$($summary.previewPracticeQuestions) 题，完全正确 $($summary.previewPracticeFullyCorrect)、部分正确 $($summary.previewPracticePartiallyCorrect)、错误 $($summary.previewPracticeIncorrect)，平均 $($summary.previewPracticeAverageScore) 分（不计入正式能力）"
  }
  else {
    $lines += "  · 课程：第 $($summary.courseDay) 天，$($summary.courseWords) 个正式单词、$($summary.coursePreviewWords) 个预习单词、$($summary.courseSentences) 个句子、$($summary.courseNotes) 份笔记"
    $lines += "  · AI 做题：$($summary.aiQuestions) 题，正确 $($summary.aiCorrect) 题，正确率 $($summary.aiAccuracy)%"
    $lines += "  · AI 问答：$($summary.tutorQuestions) 次"
    $lines += "  · 预习练习：$($summary.previewPracticeRounds) 轮、$($summary.previewPracticeQuestions) 题，完全正确 $($summary.previewPracticeFullyCorrect)、部分正确 $($summary.previewPracticePartiallyCorrect)、错误 $($summary.previewPracticeIncorrect)，平均 $($summary.previewPracticeAverageScore) 分（不计入正式能力）"
    $lines += "  · 试卷：$($summary.exams) 份"
    $lines += "  · 待复习：$($summary.itemsNeedingReview) 项"
    $lines += "  · 听写：$($summary.dictations) 次；专项训练：$($summary.focusedSessions) 次"
    $lines += "  · 能力证据：$($summary.evidence) 条；综合能力：$($summary.abilityScore)/100"
  }
  if ($Report.error) {
    $lines += ""
    $lines += "错误：$(Redact-SensitiveText $Report.error)"
  }
  return ($lines -join [Environment]::NewLine)
}

function Show-SyncCenter {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $script:uiConfig = Read-CenterConfig
  $script:syncRunning = $false
  $script:historyReports = @(Read-ReportHistory | Sort-Object finishedAt -Descending)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "英语学习同步中心"
  $form.StartPosition = "CenterScreen"
  $form.Size = New-Object System.Drawing.Size(940, 700)
  $form.MinimumSize = New-Object System.Drawing.Size(760, 560)
  $form.BackColor = [System.Drawing.Color]::White

  $header = New-Object System.Windows.Forms.Panel
  $header.Dock = "Top"
  $header.Height = 92
  $header.Padding = New-Object System.Windows.Forms.Padding(22, 16, 22, 12)
  $header.BackColor = [System.Drawing.Color]::FromArgb(236, 247, 244)
  $form.Controls.Add($header)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = "英语学习同步中心"
  $title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 18, [System.Drawing.FontStyle]::Bold)
  $title.AutoSize = $true
  $title.Location = New-Object System.Drawing.Point(22, 14)
  $header.Controls.Add($title)

  $configState = Get-ConfigState
  $configText = if ($configState.exists -and $configState.hasBaseUrl -and $configState.hasUsername -and $configState.hasReadToken) { "同步配置：已找到（令牌不会显示）" } else { "同步配置：不完整，请检查 学习同步\\.sync.env" }
  $configLabel = New-Object System.Windows.Forms.Label
  $configLabel.Text = $configText
  $configLabel.ForeColor = if ($configState.exists -and $configState.hasBaseUrl -and $configState.hasUsername -and $configState.hasReadToken) { [System.Drawing.Color]::FromArgb(30, 115, 83) } else { [System.Drawing.Color]::FromArgb(170, 80, 40) }
  $configLabel.AutoSize = $true
  $configLabel.Location = New-Object System.Drawing.Point(24, 54)
  $header.Controls.Add($configLabel)

  $syncButton = New-Object System.Windows.Forms.Button
  $syncButton.Text = "立即同步"
  $syncButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $syncButton.Width = 125
  $syncButton.Height = 38
  $syncButton.Location = New-Object System.Drawing.Point(760, 25)
  $syncButton.Anchor = "Top,Right"
  $header.Controls.Add($syncButton)
  $script:syncButton = $syncButton

  $previewSyncButton = New-Object System.Windows.Forms.Button
  $previewSyncButton.Text = "仅同步预习练习"
  $previewSyncButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $previewSyncButton.Width = 160
  $previewSyncButton.Height = 38
  $previewSyncButton.Location = New-Object System.Drawing.Point(585, 25)
  $previewSyncButton.Anchor = "Top,Right"
  $header.Controls.Add($previewSyncButton)
  $script:previewSyncButton = $previewSyncButton

  $split = New-Object System.Windows.Forms.SplitContainer
  $split.Dock = "Fill"
  $split.SplitterDistance = 285
  $split.Panel1MinSize = 220
  $split.Panel2MinSize = 450
  $split.Padding = New-Object System.Windows.Forms.Padding(18, 16, 18, 16)
  $form.Controls.Add($split)

  $historyLabel = New-Object System.Windows.Forms.Label
  $historyLabel.Text = "同步历史（最近 50 次）"
  $historyLabel.AutoSize = $true
  $historyLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $split.Panel1.Controls.Add($historyLabel)

  $historyList = New-Object System.Windows.Forms.ListBox
  $historyList.Top = 32
  $historyList.Width = 245
  $historyList.Height = 450
  $historyList.Anchor = "Top,Bottom,Left,Right"
  $split.Panel1.Controls.Add($historyList)
  $script:historyList = $historyList

  $autoCheck = New-Object System.Windows.Forms.CheckBox
  $autoCheck.Text = "打开软件后按设定间隔自动同步"
  $autoCheck.Checked = [bool]$script:uiConfig.autoSync
  $autoCheck.AutoSize = $true
  $autoCheck.Top = 494
  $autoCheck.Anchor = "Bottom,Left"
  $split.Panel1.Controls.Add($autoCheck)
  $script:autoCheck = $autoCheck

  $installButton = New-Object System.Windows.Forms.Button
  $installButton.Text = "安装每日自动任务"
  $installButton.Top = 522
  $installButton.Width = 245
  $installButton.Height = 32
  $installButton.Anchor = "Bottom,Left,Right"
  $split.Panel1.Controls.Add($installButton)

  $detailLabel = New-Object System.Windows.Forms.Label
  $detailLabel.Text = "同步详情"
  $detailLabel.AutoSize = $true
  $detailLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $split.Panel2.Controls.Add($detailLabel)

  $detailBox = New-Object System.Windows.Forms.RichTextBox
  $detailBox.Top = 32
  $detailBox.Dock = "Fill"
  $detailBox.ReadOnly = $true
  $detailBox.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 251)
  $detailBox.Font = New-Object System.Drawing.Font("Consolas", 10)
  $detailBox.BorderStyle = "FixedSingle"
  $split.Panel2.Controls.Add($detailBox)
  $script:detailBox = $detailBox

  $footer = New-Object System.Windows.Forms.Panel
  $footer.Dock = "Bottom"
  $footer.Height = 54
  $footer.Padding = New-Object System.Windows.Forms.Padding(18, 9, 18, 9)
  $form.Controls.Add($footer)

  $openFolderButton = New-Object System.Windows.Forms.Button
  $openFolderButton.Text = "打开同步目录"
  $openFolderButton.Width = 125
  $openFolderButton.Height = 32
  $footer.Controls.Add($openFolderButton)

  $openReportButton = New-Object System.Windows.Forms.Button
  $openReportButton.Text = "打开最近档案"
  $openReportButton.Width = 125
  $openReportButton.Height = 32
  $openReportButton.Left = 137
  $footer.Controls.Add($openReportButton)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = "同步内容只显示文件名和学习统计；账号、密码、令牌不会显示。"
  $hint.AutoSize = $true
  $hint.Left = 285
  $hint.Top = 9
  $hint.ForeColor = [System.Drawing.Color]::DimGray
  $footer.Controls.Add($hint)

  function Update-Detail($Report) {
    $script:detailBox.Text = Get-ReportText $Report
  }

  function Refresh-HistoryList {
    $script:historyReports = @(Read-ReportHistory | Sort-Object finishedAt -Descending)
    $script:historyList.Items.Clear()
    foreach ($report in $script:historyReports) {
      $state = if ([bool]$report.success) { "成功" } else { "失败" }
      if ([bool](Get-ObjectValue $report "partialSuccess" $false)) { $state = "部分成功" }
      if ($report.mode -eq "dry-run") { $state = "预览" }
      $stamp = try { ([DateTime]$report.finishedAt).ToString("MM-dd HH:mm") } catch { "未知时间" }
      $scope = if ($report.mode -eq "preview-practice") { "仅预习 $([int](Get-ObjectValue $report.summary 'previewPracticeRounds' 0)) 轮" } else { "正式 · 上传 $(@($report.uploadedFiles).Count) 项" }
      [void]$script:historyList.Items.Add("$stamp · $state · $scope")
    }
    if ($script:historyReports.Count -gt 0) {
      $script:historyList.SelectedIndex = 0
      Update-Detail $script:historyReports[0]
    } else {
      Update-Detail $null
    }
  }

  $script:syncWorker = New-Object System.ComponentModel.BackgroundWorker
  $script:syncWorker.DoWork += {
    param($sender, $event)
    $event.Result = Invoke-UnderlyingSync -PreviewPracticeOnly:([string]$event.Argument -eq "preview-practice")
  }
  $script:syncWorker.RunWorkerCompleted += {
    param($sender, $event)
    $script:syncRunning = $false
    $script:syncButton.Enabled = $true
    $script:previewSyncButton.Enabled = $true
    if ($event.Error) {
      [System.Windows.Forms.MessageBox]::Show("同步程序异常：$(Redact-SensitiveText $event.Error.Message)", "同步失败", "OK", "Error") | Out-Null
      Refresh-HistoryList
    } else {
      Refresh-HistoryList
      $latest = $event.Result
      if ($latest -and [bool](Get-ObjectValue $latest "partialSuccess" $false)) {
        [System.Windows.Forms.MessageBox]::Show("同步部分成功：网站学习档案已经刷新，但另一个阶段失败。请查看右侧详情。", "同步部分成功", "OK", "Warning") | Out-Null
      } elseif ($latest -and -not $latest.success) {
        $failureText = if ($latest.mode -eq "preview-practice") { "预习练习同步失败，请查看右侧同步详情。" } else { "同步失败，请查看右侧同步详情。" }
        [System.Windows.Forms.MessageBox]::Show($failureText, "同步失败", "OK", "Warning") | Out-Null
      }
    }
  }

  function Start-UiSync([switch]$OnlyPreviewPractice) {
    if ($script:syncRunning) { return }
    $script:syncRunning = $true
    $script:syncButton.Enabled = $false
    $script:previewSyncButton.Enabled = $false
    if ($OnlyPreviewPractice) {
      $script:detailBox.Text = "正在单独同步预习练习……`r`n`r`n本次只从网站下载已完成的预习练习，不读取或上传课程、笔记、进度和错题。"
      $script:syncWorker.RunWorkerAsync("preview-practice")
    } else {
      $script:detailBox.Text = "正在正式同步……`r`n`r`n正在读取学习进度、错题本、每日课程内容、学习笔记和预习，并与网站交换完整学习档案。"
      $script:syncWorker.RunWorkerAsync("full")
    }
  }

  $syncButton.Add_Click({ Start-UiSync })
  $previewSyncButton.Add_Click({ Start-UiSync -OnlyPreviewPractice })
  $historyList.Add_SelectedIndexChanged({
    if ($script:historyList.SelectedIndex -ge 0 -and $script:historyList.SelectedIndex -lt $script:historyReports.Count) {
      Update-Detail $script:historyReports[$script:historyList.SelectedIndex]
    }
  })
  $autoCheck.Add_CheckedChanged({
    $script:uiConfig.autoSync = $autoCheck.Checked
    Save-CenterConfig $script:uiConfig
  })
  $installButton.Add_Click({
    try {
      $message = Register-DailySyncTask
      [System.Windows.Forms.MessageBox]::Show($message, "每日同步", "OK", "Information") | Out-Null
    } catch {
      [System.Windows.Forms.MessageBox]::Show("安装失败：$(Redact-SensitiveText $_.Exception.Message)", "每日同步", "OK", "Error") | Out-Null
    }
  })
  $openFolderButton.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$sharedDirectory`"" })
  $openReportButton.Add_Click({
    $selectedReport = if ($script:historyList.SelectedIndex -ge 0 -and $script:historyList.SelectedIndex -lt $script:historyReports.Count) { $script:historyReports[$script:historyList.SelectedIndex] } else { $null }
    $path = if ($selectedReport -and $selectedReport.mode -eq "preview-practice") { $previewPracticePath } else { $fullProfilePath }
    if (Test-Path -LiteralPath $path) { Start-Process notepad.exe -ArgumentList "`"$path`"" }
    else { [System.Windows.Forms.MessageBox]::Show("还没有对应的本地同步档案，请先运行相应同步。", "提示", "OK", "Information") | Out-Null }
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 60000
  $timer.Add_Tick({
    if (-not $autoCheck.Checked -or $script:syncRunning) { return }
    $latest = @($script:historyReports | Where-Object { $_.mode -ne "preview-practice" -and $_.mode -ne "dry-run" } | Select-Object -First 1)
    $latest = if ($latest.Count -gt 0) { $latest[0] } else { $null }
    $due = $true
    if ($latest -and $latest.success) {
      try { $due = ((Get-Date) - [DateTime]$latest.finishedAt).TotalHours -ge [int]$script:uiConfig.intervalHours } catch { $due = $true }
    }
    if ($due) { Start-UiSync }
  })
  $timer.Start()
  $form.Add_Shown({
    Refresh-HistoryList
    $latest = @($script:historyReports | Where-Object { $_.mode -ne "preview-practice" -and $_.mode -ne "dry-run" } | Select-Object -First 1)
    $latest = if ($latest.Count -gt 0) { $latest[0] } else { $null }
    if ($autoCheck.Checked -and (-not $latest -or -not $latest.success)) { Start-UiSync }
  })
  $form.Add_FormClosed({
    $timer.Stop()
    Save-CenterConfig $script:uiConfig
  })

  [void]$form.ShowDialog()
}

if ($RemoveDailyTask) {
  Write-Output (Remove-DailySyncTask)
  exit 0
}

if ($InstallDailyTask) {
  Write-Output (Register-DailySyncTask)
  if (-not $Headless) { exit 0 }
}

if ($Headless) {
  $result = Invoke-UnderlyingSync -PreviewOnly:$DryRun -PreviewPracticeOnly:$PreviewPracticeOnly
  $result | ConvertTo-Json -Depth 15
  if (-not $result.success) { exit 1 }
  exit 0
}

Show-SyncCenter
