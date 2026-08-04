param(
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workspaceRoot = Split-Path -Parent $repoRoot
$sourcePath = Join-Path $PSScriptRoot "GitHubAutoUpload.cs"
$exeName = "GitHub" + [char]0x81EA + [char]0x52A8 + [char]0x4E0A + [char]0x4F20 + ".exe"
if (-not $OutputPath) { $OutputPath = Join-Path $workspaceRoot $exeName }

$compilerCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw "Windows .NET Framework C# compiler was not found." }
if (-not (Test-Path -LiteralPath $sourcePath)) { throw "GitHubAutoUpload.cs was not found." }

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

& $compiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$OutputPath" $sourcePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath)) {
  throw "GitHub auto upload EXE compilation failed."
}

$item = Get-Item -LiteralPath $OutputPath
Write-Output "Created: $($item.FullName)"
Write-Output "Size: $($item.Length) bytes"
