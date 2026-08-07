param(
  [string]$BaseUrl = "",
  [string]$Username = "",
  [string]$SyncToken = "",
  [string]$WriteToken = "",
  [string]$ConfigPath = "",
  [string]$OutputPath = "",
  [string]$StatusPath = "",
  [switch]$NoExitOnFailure
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$sharedDirectory = Join-Path $workspaceRoot "学习同步"

if (-not $ConfigPath) { $ConfigPath = Join-Path $sharedDirectory ".sync.env" }
if (-not $OutputPath) { $OutputPath = Join-Path $sharedDirectory "网站学习档案.json" }
$script:statusPathWasProvided = [bool]$StatusPath
if (-not $StatusPath) { $StatusPath = Join-Path $sharedDirectory "同步记录\最近一次同步.json" }
$script:historyPath = Join-Path (Split-Path -Parent $StatusPath) "同步历史.json"

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
$script:syncErrors = @()
$syncStatus = [ordered]@{
  schemaVersion = 2
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  finishedAt = $null
  uploadAttempted = [bool]$WriteToken
  teachingUploadAttempted = $false
  teachingUploadSuccess = $null
  courseUploadAttempted = $false
  courseUploadSuccess = $null
  uploadSuccess = $null
  downloadAttempted = $false
  downloadSuccess = $false
  compatibilityTransportUsed = $false
  success = $false
  errors = @()
}

function Redact-SyncText([string]$Value) {
  if ($null -eq $Value) { return "" }
  $safe = $Value -replace '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+', '$1<已隐藏>'
  $safe = $safe -replace '(?i)(SYNC_(READ|WRITE)_TOKEN|API_TOKEN)\s*[=:]\s*[^\s,;]+', '$1=<已隐藏>'
  $safe = $safe -replace '(?i)(username=)[^&\s"'']+', '$1<已隐藏>'
  return $safe
}

function Get-SyncRequestError($ErrorRecord) {
  $exception = $ErrorRecord.Exception
  $response = $exception.Response
  $statusCode = 0
  try {
    if ($response -and $null -ne $response.StatusCode) { $statusCode = [int]$response.StatusCode }
  } catch { $statusCode = 0 }
  $technicalCode = ""
  try {
    if ($null -ne $exception.Status) { $technicalCode = [string]$exception.Status }
  } catch { }
  $rawMessage = Redact-SyncText ([string]$exception.Message)
  $category = "unknown"
  $message = "请求失败（$($exception.GetType().Name)）。"
  $retryable = $false

  if ($statusCode -eq 401 -or $statusCode -eq 403) {
    $category = "authorization"
    $message = "HTTP $statusCode：同步令牌无效或权限不足。"
  } elseif ($statusCode -ge 500) {
    $category = "http-5xx"
    $message = "远端服务暂时不可用（HTTP $statusCode）。"
    $retryable = $true
  } elseif ($statusCode -gt 0) {
    $category = "http"
    $message = "远端接口返回 HTTP $statusCode。"
  } elseif ($technicalCode -eq "Timeout" -or $rawMessage -match '(?i)timed?\s*out|超时') {
    $category = "timeout"
    $message = "请求超时。"
    $retryable = $true
  } elseif ($technicalCode -match 'TrustFailure|SecureChannelFailure' -or $rawMessage -match '(?i)TLS|SSL|certificate|证书|安全通道') {
    $category = "tls"
    $message = "TLS 安全连接失败。"
    $retryable = $true
  } elseif ($technicalCode -match 'NameResolutionFailure|ConnectFailure|ConnectionClosed|ReceiveFailure|SendFailure|KeepAliveFailure|PipelineFailure' -or $rawMessage -match '(?i)connection|network|连接|网络') {
    $category = "network"
    $message = if ($technicalCode) { "网络连接失败（$technicalCode）。" } else { "网络连接失败。" }
    $retryable = $true
  }

  return [pscustomobject]@{
    category = $category
    message = $message
    retryable = $retryable
    statusCode = $statusCode
    technicalCode = $technicalCode
  }
}

function Add-SyncError([string]$Phase, $Info, [int]$Attempts = 1) {
  $script:syncErrors += [pscustomobject]@{
    phase = $Phase
    category = [string]$Info.category
    message = Redact-SyncText ([string]$Info.message)
    attempts = $Attempts
    statusCode = [int]$Info.statusCode
    technicalCode = Redact-SyncText ([string]$Info.technicalCode)
  }
}

function New-LocalSyncError([string]$Message) {
  return [pscustomobject]@{
    category = "local"
    message = Redact-SyncText $Message
    retryable = $false
    statusCode = 0
    technicalCode = ""
  }
}

function Resolve-SyncNodeExecutable {
  if ($script:syncNodeChecked) { return $script:syncNodeExecutable }
  $script:syncNodeChecked = $true
  $script:syncNodeExecutable = ""
  $candidates = @()
  $command = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($command) {
    if ($command.Source) { $candidates += $command.Source }
    elseif ($command.Path) { $candidates += $command.Path }
  }
  if ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
    if (Test-Path -LiteralPath $runtimeRoot) {
      foreach ($directory in Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue) {
        $candidates += Join-Path $directory.FullName "dependencies\node\bin\node.exe"
      }
    }
  }
  foreach ($candidate in @($candidates | Select-Object -Unique)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $script:syncNodeExecutable = [IO.Path]::GetFullPath($candidate)
      break
    }
  }
  return $script:syncNodeExecutable
}

function New-NodeTransportError([string]$ErrorCode) {
  $technicalCode = (Redact-SyncText $ErrorCode) -replace '[^A-Za-z0-9_.-]', ''
  $category = "network"
  $message = if ($technicalCode) { "兼容 HTTPS 通道连接失败（$technicalCode）。" } else { "兼容 HTTPS 通道连接失败。" }
  if ($technicalCode -match '(?i)Abort|Timeout') {
    $category = "timeout"
    $message = "兼容 HTTPS 通道请求超时。"
  } elseif ($technicalCode -match '(?i)TLS|SSL|CERT') {
    $category = "tls"
    $message = "兼容 HTTPS 通道的 TLS 安全连接失败。"
  }
  return [pscustomobject]@{
    category = $category
    message = $message
    retryable = $true
    statusCode = 0
    technicalCode = $technicalCode
  }
}

function New-HttpStatusError([int]$StatusCode) {
  if ($StatusCode -eq 401 -or $StatusCode -eq 403) {
    return [pscustomobject]@{ category = "authorization"; message = "HTTP $StatusCode：同步令牌无效或权限不足。"; retryable = $false; statusCode = $StatusCode; technicalCode = "" }
  }
  if ($StatusCode -ge 500) {
    return [pscustomobject]@{ category = "http-5xx"; message = "远端服务暂时不可用（HTTP $StatusCode）。"; retryable = $true; statusCode = $StatusCode; technicalCode = "" }
  }
  return [pscustomobject]@{ category = "http"; message = "远端接口返回 HTTP $StatusCode。"; retryable = $false; statusCode = $StatusCode; technicalCode = "" }
}

function Invoke-NodeSyncRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    $Body = $null,
    [int]$TimeoutSeconds = 30
  )
  $node = Resolve-SyncNodeExecutable
  $helper = Join-Path $PSScriptRoot "sync-http-request.js"
  if (-not $node -or -not (Test-Path -LiteralPath $helper)) {
    return [pscustomobject]@{ attempted = $false; success = $false; value = $null; error = $null }
  }
  try {
    [byte[]]$bodyBytes = @()
    if ($null -ne $Body) {
      if ($Body -is [byte[]]) { $bodyBytes = $Body }
      else { $bodyBytes = [Text.Encoding]::UTF8.GetBytes([string]$Body) }
    }
    $requestEnvelope = @{
      method = $Method
      uri = $Uri
      headers = $Headers
      timeoutMs = [Math]::Max(1000, $TimeoutSeconds * 1000)
      bodyBase64 = if ($bodyBytes.Length) { [Convert]::ToBase64String($bodyBytes) } else { "" }
    }
    $requestJson = $requestEnvelope | ConvertTo-Json -Depth 8 -Compress
    $requestBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($requestJson))
    $responseLines = @($requestBase64 | & $node $helper 2>$null)
    $nativeExitCode = $LASTEXITCODE
    $responseBase64 = ($responseLines -join "").Trim()
    if ($nativeExitCode -ne 0 -or -not $responseBase64) {
      return [pscustomobject]@{ attempted = $true; success = $false; value = $null; error = (New-NodeTransportError "NODE_HELPER_FAILED") }
    }
    $responseJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($responseBase64))
    $response = $responseJson | ConvertFrom-Json
    if (-not [bool]$response.transportOk) {
      return [pscustomobject]@{ attempted = $true; success = $false; value = $null; error = (New-NodeTransportError ([string]$response.errorCode)) }
    }
    $statusCode = [int]$response.status
    if ($statusCode -lt 200 -or $statusCode -ge 300) {
      return [pscustomobject]@{ attempted = $true; success = $false; value = $null; error = (New-HttpStatusError $statusCode) }
    }
    $value = $null
    if ($response.bodyBase64) {
      $responseText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$response.bodyBase64))
      if ($responseText) {
        try { $value = $responseText | ConvertFrom-Json } catch { $value = $responseText }
      }
    }
    return [pscustomobject]@{ attempted = $true; success = $true; value = $value; error = $null }
  } catch {
    return [pscustomobject]@{ attempted = $true; success = $false; value = $null; error = (New-NodeTransportError "NODE_HELPER_INVALID_RESPONSE") }
  }
}

function Invoke-SyncRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [string]$ContentType = "",
    $Body = $null,
    [int]$MaximumAttempts = 3,
    [int]$TimeoutSeconds = 30
  )

  for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
    try {
      $parameters = @{
        Method = $Method
        Uri = $Uri
        Headers = $Headers
        TimeoutSec = $TimeoutSeconds
        ErrorAction = "Stop"
      }
      if ($ContentType) { $parameters.ContentType = $ContentType }
      if ($null -ne $Body) { $parameters.Body = $Body }
      $value = Invoke-RestMethod @parameters
      return [pscustomobject]@{ success = $true; value = $value; attempts = $attempt; error = $null }
    } catch {
      $info = Get-SyncRequestError $_
      if ($info.retryable) {
        $nodeResult = Invoke-NodeSyncRequest -Method $Method -Uri $Uri -Headers $Headers -Body $Body -TimeoutSeconds $TimeoutSeconds
        if ($nodeResult.attempted) {
          $syncStatus.compatibilityTransportUsed = $true
          if ($nodeResult.success) {
            Write-Warning "$Phase：Windows PowerShell 网络通道失败，兼容 HTTPS 通道已完成请求。"
            return [pscustomobject]@{ success = $true; value = $nodeResult.value; attempts = $attempt; error = $null }
          }
          $info = $nodeResult.error
          if (-not $info.retryable) {
            return [pscustomobject]@{ success = $false; value = $null; attempts = $attempt; error = $info }
          }
        }
      }
      if ($attempt -lt $MaximumAttempts -and $info.retryable) {
        Write-Warning "$Phase：$($info.message) 正在进行第 $($attempt + 1) 次尝试。"
        Start-Sleep -Seconds ([Math]::Min($attempt * 2, 4))
        continue
      }
      return [pscustomobject]@{ success = $false; value = $null; attempts = $attempt; error = $info }
    }
  }
}

function Save-SyncStatus {
  $syncStatus.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  $syncStatus.errors = @($script:syncErrors)
  $syncStatus.success = ([bool]$syncStatus.downloadSuccess -and (-not [bool]$syncStatus.uploadAttempted -or [bool]$syncStatus.uploadSuccess))
  if (-not $StatusPath) { return }
  $statusDirectory = Split-Path -Parent $StatusPath
  if ($statusDirectory -and -not (Test-Path -LiteralPath $statusDirectory)) {
    New-Item -ItemType Directory -Path $statusDirectory -Force | Out-Null
  }
  $statusJson = $syncStatus | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($StatusPath, "$statusJson`n", $utf8NoBom)
  if (-not $script:statusPathWasProvided) {
    $history = @()
    if (Test-Path -LiteralPath $script:historyPath) {
      try {
        $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $script:historyPath | ConvertFrom-Json
        if ($existing -is [array]) { $history = @($existing) } elseif ($null -ne $existing) { $history = @($existing) }
      } catch { $history = @() }
    }
    $history += [pscustomobject]$syncStatus
    if ($history.Count -gt 50) { $history = @($history | Select-Object -Last 50) }
    $historyDirectory = Split-Path -Parent $script:historyPath
    if ($historyDirectory -and -not (Test-Path -LiteralPath $historyDirectory)) { New-Item -ItemType Directory -Path $historyDirectory -Force | Out-Null }
    [IO.File]::WriteAllText($script:historyPath, "$($history | ConvertTo-Json -Depth 10)`n", $utf8NoBom)
  }
}

function Read-LearningDocument([string]$Path, [int]$MaximumLength = 16000) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  if ($content.Length -gt $MaximumLength) { $content = $content.Substring(0, $MaximumLength) }
  return @{ name = [IO.Path]::GetFileName($Path); content = $content }
}

. (Join-Path $PSScriptRoot "preview-words.ps1")

if ($WriteToken) {
  $syncStatus.teachingUploadAttempted = $true
  $writeHeaders = @{ Authorization = "Bearer $WriteToken"; Accept = "application/json" }
  $previewDocument = $null
  $previewDocuments = @()
  $latestPreviewFile = $null
  $previewWords = @()
  try {
    $progressDocument = Read-LearningDocument (Join-Path $workspaceRoot "学习进度.md")
    $mistakeDocument = Read-LearningDocument (Join-Path $workspaceRoot "错题本.md")
    $notesDirectory = Join-Path $workspaceRoot "每日笔记"
    $recentNotes = @()
    if (Test-Path -LiteralPath $notesDirectory) {
      $recentNotes = @(Get-ChildItem -LiteralPath $notesDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 3 | Sort-Object Name | ForEach-Object { Read-LearningDocument $_.FullName 10000 })
    }
    $previewDirectory = Join-Path $workspaceRoot "预习"
    if (Test-Path -LiteralPath $previewDirectory) {
      $previewFiles = @(Get-ChildItem -LiteralPath $previewDirectory -File -Filter "*.md" | Sort-Object Name -Descending | Select-Object -First 30 | Sort-Object Name)
      $previewDocuments = @($previewFiles | ForEach-Object { Read-LearningDocument $_.FullName 10000 })
      if ($previewDocuments.Count -gt 0) {
        $previewDocument = $previewDocuments[-1]
        $latestPreviewFile = $previewFiles[-1]
        $previewWords = @(ConvertFrom-PreviewWordTable $latestPreviewFile.FullName)
      }
    }
    $teachingProfile = @{
      updatedAt = (Get-Date).ToUniversalTime().ToString("o")
      progress = $progressDocument
      mistakes = $mistakeDocument
      recentNotes = $recentNotes
      preview = $previewDocument
      previews = $previewDocuments
    }
    $writeUri = "$base/api/sync/teaching-profile?username=$encodedUsername"
    $writeBody = $teachingProfile | ConvertTo-Json -Depth 20
    $teachingResult = Invoke-SyncRequest -Phase "上传本地教学档案" -Method Put -Uri $writeUri -Headers $writeHeaders -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($writeBody))
    $syncStatus.teachingUploadSuccess = [bool]$teachingResult.success
    if ($teachingResult.success) {
      Write-Host "本地教学档案已上传到网站。"
      if ($previewDocument) { Write-Host "每日预习已同步：$($previewDocument.name)（保留近期 $($previewDocuments.Count) 份）" }
    } else {
      Add-SyncError "upload-teaching-profile" $teachingResult.error $teachingResult.attempts
      Write-Warning "本地教学档案上传失败：$($teachingResult.error.message) 下载网站档案仍会继续。"
    }
  } catch {
    $syncStatus.teachingUploadSuccess = $false
    $localError = New-LocalSyncError "准备本地教学档案失败：$($_.Exception.Message)"
    Add-SyncError "prepare-teaching-profile" $localError 1
    Write-Warning $localError.message
  }

  $courseContentPath = Join-Path $sharedDirectory "网站课程内容.json"
  if (Test-Path -LiteralPath $courseContentPath) {
    $syncStatus.courseUploadAttempted = $true
    try {
      $courseContentJson = [IO.File]::ReadAllText($courseContentPath, [Text.Encoding]::UTF8)
      $courseContent = $courseContentJson | ConvertFrom-Json
      $formalWordIds = @{}
      $formalEnglish = @{}
      foreach ($word in @($courseContent.words)) {
        if ($word.id) { $formalWordIds[[string]$word.id] = $true }
        if ($word.english) { $formalEnglish[[string]$word.english] = $true }
      }
      $previewWords = @($previewWords | Where-Object { -not $formalWordIds.ContainsKey([string]$_.id) -and -not $formalEnglish.ContainsKey([string]$_.english) })
      $courseContent | Add-Member -NotePropertyName previewWords -NotePropertyValue @($previewWords) -Force
      $courseContentJson = $courseContent | ConvertTo-Json -Depth 40
      $courseUri = "$base/api/content/batch"
      $courseUpload = Invoke-SyncRequest -Phase "上传网站课程内容" -Method Put -Uri $courseUri -Headers $writeHeaders -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($courseContentJson))
      $syncStatus.courseUploadSuccess = [bool]$courseUpload.success
      if ($courseUpload.success) {
        $courseResult = $courseUpload.value
        $formalWordCount = [Math]::Max(0, [int]$courseResult.words - [int]$courseResult.previewWords)
        Write-Host "网站课程内容已同步：第 $($courseResult.currentDay) 天，$formalWordCount 个正式单词、$($courseResult.previewWords) 个预习单词、$($courseResult.sentences) 个句子、$($courseResult.notes) 份笔记（词句新增 $($courseResult.added)、更新 $($courseResult.updated)；笔记新增 $($courseResult.notesAdded)、更新 $($courseResult.notesUpdated)）。"
        if ($latestPreviewFile) { Write-Host "预习单词已同步：$($latestPreviewFile.BaseName)，$($courseResult.previewWords) 个未学单词。" }
      } else {
        Add-SyncError "upload-course-content" $courseUpload.error $courseUpload.attempts
        Write-Warning "网站课程内容上传失败：$($courseUpload.error.message) 下载网站档案仍会继续。"
      }
    } catch {
      $syncStatus.courseUploadSuccess = $false
      $localError = New-LocalSyncError "准备网站课程内容失败：$($_.Exception.Message)"
      Add-SyncError "prepare-course-content" $localError 1
      Write-Warning $localError.message
    }
  } else {
    Write-Warning "未找到 学习同步\网站课程内容.json，本次未更新词句库。"
  }
  $syncStatus.uploadSuccess = ([bool]$syncStatus.teachingUploadSuccess -and (-not [bool]$syncStatus.courseUploadAttempted -or [bool]$syncStatus.courseUploadSuccess))
} else {
  Write-Warning "未配置 SYNC_WRITE_TOKEN，本次只下载网站档案，不上传本地教学计划。"
}

$uri = "$base/api/sync/profile?username=$encodedUsername"
$headers = @{ Authorization = "Bearer $SyncToken"; Accept = "application/json" }
$syncStatus.downloadAttempted = $true
$downloadResult = Invoke-SyncRequest -Phase "下载网站学习档案" -Method Get -Uri $uri -Headers $headers
if ($downloadResult.success) {
  $profile = $downloadResult.value
  $outputDirectory = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null }
  $json = $profile | ConvertTo-Json -Depth 40
  [IO.File]::WriteAllText($OutputPath, "$json`n", $utf8NoBom)
  $syncStatus.downloadSuccess = $true
  $profileSummary = $profile.summary
  $courseSummary = $profile.course
  $abilitySummary = $profile.abilities
  $latestSummary = [ordered]@{
    courseDay = if ($courseSummary) { [int]$courseSummary.currentDay } else { 0 }
    courseWords = if ($courseSummary) { [int]$courseSummary.words } else { 0 }
    coursePreviewWords = if ($courseSummary) { [int]$courseSummary.previewWords } else { 0 }
    courseSentences = if ($courseSummary) { [int]$courseSummary.sentences } else { 0 }
    courseNotes = if ($courseSummary) { [int]$courseSummary.notes } else { 0 }
    aiQuestions = if ($profileSummary) { [int]$profileSummary.aiQuestions } else { 0 }
    aiCorrect = if ($profileSummary) { [double]$profileSummary.aiCorrect } else { 0 }
    aiAccuracy = if ($profileSummary) { [int]$profileSummary.aiAccuracy } else { 0 }
    tutorQuestions = if ($profileSummary) { [int]$profileSummary.tutorQuestions } else { 0 }
    previewPracticeRounds = if ($profileSummary) { [int]$profileSummary.previewPracticeRounds } else { 0 }
    previewPracticeQuestions = if ($profileSummary) { [int]$profileSummary.previewPracticeQuestions } else { 0 }
    previewPracticeFullyCorrect = if ($profileSummary) { [int]$profileSummary.previewPracticeFullyCorrect } else { 0 }
    previewPracticePartiallyCorrect = if ($profileSummary) { [int]$profileSummary.previewPracticePartiallyCorrect } else { 0 }
    previewPracticeIncorrect = if ($profileSummary) { [int]$profileSummary.previewPracticeIncorrect } else { 0 }
    previewPracticeAverageScore = if ($profileSummary -and $null -ne $profileSummary.previewPracticeAverageScore) { [int]$profileSummary.previewPracticeAverageScore } else { $null }
    exams = if ($profileSummary) { [int]$profileSummary.exams } else { 0 }
    latestExamScore = if ($profileSummary) { $profileSummary.latestExamScore } else { $null }
    latestExamPossible = if ($profileSummary) { $profileSummary.latestExamPossible } else { $null }
    itemsNeedingReview = if ($profileSummary) { [int]$profileSummary.itemsNeedingReview } else { 0 }
    dictations = if ($profileSummary) { [int]$profileSummary.dictations } else { 0 }
    focusedSessions = if ($profileSummary) { [int]$profileSummary.focusedSessions } else { 0 }
    evidence = if ($abilitySummary) { [int]$abilitySummary.totalEvidence } else { 0 }
    abilityScore = if ($abilitySummary) { [int]$abilitySummary.comprehensiveScore } else { 0 }
  }
  # 同步中心和历史报告使用 summary 作为统一统计字段。保留
  # profileSummary 作为兼容别名，避免旧版读取器丢失统计。
  $syncStatus.summary = $latestSummary
  $syncStatus.profileSummary = $latestSummary

  Write-Host "学习档案已同步：$OutputPath"
  Write-Host "网站 AI 做题：$($profile.summary.aiQuestions) 题，正确率 $($profile.summary.aiAccuracy)%"
  Write-Host "网站 AI 问答：$($profile.summary.tutorQuestions) 次"
  Write-Host "网站预习练习：$($profile.summary.previewPracticeRounds) 轮、$($profile.summary.previewPracticeQuestions) 题（完全正确 $($profile.summary.previewPracticeFullyCorrect)、部分正确 $($profile.summary.previewPracticePartiallyCorrect)、错误 $($profile.summary.previewPracticeIncorrect)；仅供预习回顾，不计入正式能力）。"
  if ($profile.summary.exams -gt 0) {
    Write-Host "网站试卷：$($profile.summary.exams) 份，最近 $($profile.summary.latestExamScore)/$($profile.summary.latestExamPossible) 分，平均百分比 $($profile.summary.examAveragePercentage)%"
  } else {
    Write-Host "网站试卷：尚未交卷"
  }
  Write-Host "待复习内容：$($profile.summary.itemsNeedingReview) 项"
  Write-Host "听写：$($profile.summary.dictations) 次；专项训练：$($profile.summary.focusedSessions) 次；能力证据：$($profile.abilities.totalEvidence) 条"
} else {
  Add-SyncError "download-learning-profile" $downloadResult.error $downloadResult.attempts
  Write-Warning "网站学习档案下载失败：$($downloadResult.error.message) 本地旧快照已保留。"
}

Save-SyncStatus
if (-not $syncStatus.success -and -not $NoExitOnFailure) { exit 1 }
