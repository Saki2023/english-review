param(
  [string]$BaseUrl = "",
  [string]$Username = "",
  [string]$SyncToken = "",
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

if (-not $BaseUrl -or -not $Username -or -not $SyncToken) {
  throw "同步配置不完整。请在 学习同步\.sync.env 中填写 SYNC_BASE_URL、SYNC_USERNAME 和 SYNC_READ_TOKEN。"
}

$base = $BaseUrl.TrimEnd("/")
$encodedUsername = [Uri]::EscapeDataString($Username)
$uri = "$base/api/sync/profile?username=$encodedUsername"
$headers = @{ Authorization = "Bearer $SyncToken"; Accept = "application/json" }
$profile = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
$json = $profile | ConvertTo-Json -Depth 40
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($OutputPath, "$json`n", $utf8NoBom)

Write-Host "学习档案已同步：$OutputPath"
Write-Host "网站 AI 做题：$($profile.summary.aiQuestions) 题，正确率 $($profile.summary.aiAccuracy)%"
Write-Host "待复习内容：$($profile.summary.itemsNeedingReview) 项"
