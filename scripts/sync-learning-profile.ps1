param(
  [string]$BaseUrl = "",
  [string]$Username = "",
  [string]$SyncToken = "",
  [string]$WriteToken = "",
  [string]$ConfigPath = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$sharedDirectory = Join-Path $workspaceRoot "学习同步"

if (-not $ConfigPath) { $ConfigPath = Join-Path $sharedDirectory ".sync.env" }
if (-not $OutputPath) { $OutputPath = Join-Path $sharedDirectory "网站学习档案.json" }

$config = @{}
if (Test-Path -LiteralPath $ConfigPath) {
  foreach ($line in Get-Content -LiteralPath $ConfigPath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { continue }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
    $config[$name] = $value
  }
}

if (-not $BaseUrl) { $BaseUrl = $env:SYNC_BASE_URL }
if (-not $BaseUrl) { $BaseUrl = $config["SYNC_BASE_URL"] }
if (-not $Username) { $Username = $env:SYNC_USERNAME }
if (-not $Username) { $Username = $config["SYNC_USERNAME"] }
if (-not $SyncToken) { $SyncToken = $env:SYNC_READ_TOKEN }
if (-not $SyncToken) { $SyncToken = $config["SYNC_READ_TOKEN"] }
if (-not $WriteToken) { $WriteToken = $env:SYNC_WRITE_TOKEN }
if (-not $WriteToken) { $WriteToken = $config["SYNC_WRITE_TOKEN"] }

if (-not $BaseUrl -or -not $Username -or -not $SyncToken) {
  throw "同步配置不完整。请在 学习同步\.sync.env 中填写 SYNC_BASE_URL、SYNC_USERNAME 和 SYNC_READ_TOKEN。"
}

$base = $BaseUrl.TrimEnd("/")
$encodedUsername = [Uri]::EscapeDataString($Username)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-LearningDocument([string]$Path, [int]$MaximumLength = 16000) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  if ($content.Length -gt $MaximumLength) { $content = $content.Substring(0, $MaximumLength) }
  return @{ name = [IO.Path]::GetFileName($Path); content = $content }
}

if ($WriteToken) {
  $progressDocument = Read-LearningDocument (Join-Path $workspaceRoot "学习进度.md")
  $mistakeDocument = Read-LearningDocument (Join-Path $workspaceRoot "错题本.md")
  $notesDirectory = Join-Path $workspaceRoot "每日笔记"
  $recentNotes = @()
  if (Test-Path -LiteralPath $notesDirectory) {
    $recentNotes = @(Get-ChildItem -LiteralPath $notesDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 3 | Sort-Object Name | ForEach-Object { Read-LearningDocument $_.FullName 10000 })
  }
  $previewDirectory = Join-Path $workspaceRoot "预习"
  $previewDocument = $null
  if (Test-Path -LiteralPath $previewDirectory) {
    $latestPreview = Get-ChildItem -LiteralPath $previewDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 1
    if ($latestPreview) { $previewDocument = Read-LearningDocument $latestPreview.FullName 10000 }
  }
  $teachingProfile = @{
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    progress = $progressDocument
    mistakes = $mistakeDocument
    recentNotes = $recentNotes
    preview = $previewDocument
  }
  $writeUri = "$base/api/sync/teaching-profile?username=$encodedUsername"
  $writeHeaders = @{ Authorization = "Bearer $WriteToken"; Accept = "application/json" }
  $writeBody = $teachingProfile | ConvertTo-Json -Depth 20
  Invoke-RestMethod -Method Put -Uri $writeUri -Headers $writeHeaders -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($writeBody)) | Out-Null
  Write-Host "本地教学档案已上传到网站。"
} else {
  Write-Warning "未配置 SYNC_WRITE_TOKEN，本次只下载网站档案，不上传本地教学计划。"
}

$uri = "$base/api/sync/profile?username=$encodedUsername"
$headers = @{ Authorization = "Bearer $SyncToken"; Accept = "application/json" }
$profile = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$json = $profile | ConvertTo-Json -Depth 40
[IO.File]::WriteAllText($OutputPath, "$json`n", $utf8NoBom)

Write-Host "学习档案已同步：$OutputPath"
Write-Host "网站 AI 做题：$($profile.summary.aiQuestions) 题，正确率 $($profile.summary.aiAccuracy)%"
Write-Host "网站 AI 问答：$($profile.summary.tutorQuestions) 次"
if ($profile.summary.exams -gt 0) {
  Write-Host "网站试卷：$($profile.summary.exams) 份，最近 $($profile.summary.latestExamScore)/$($profile.summary.latestExamPossible) 分，平均百分比 $($profile.summary.examAveragePercentage)%"
} else {
  Write-Host "网站试卷：尚未交卷"
}
Write-Host "待复习内容：$($profile.summary.itemsNeedingReview) 项"
Write-Host "听写：$($profile.summary.dictations) 次；专项训练：$($profile.summary.focusedSessions) 次；能力证据：$($profile.abilities.totalEvidence) 条"
