function ConvertFrom-PreviewWordTable([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $name = [IO.Path]::GetFileName($Path)
  $dayMatch = [regex]::Match($name, '第0*(\d+)天预习\.md$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $dayMatch.Success) { return @() }
  $day = [int]$dayMatch.Groups[1].Value
  $insideWordTable = $false
  $words = @()

  foreach ($line in [IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8)) {
    if (-not $insideWordTable) {
      if ($line -match '^\s*\|\s*单词\s*\|\s*发音\s*\|\s*中文\s*\|\s*$') { $insideWordTable = $true }
      continue
    }
    if (-not $line.Trim()) {
      if ($words.Count -gt 0) { break }
      continue
    }
    if ($line -notmatch '^\s*\|') {
      if ($words.Count -gt 0) { break }
      continue
    }
    $cells = @($line.Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() })
    if ($cells.Count -lt 3 -or $cells[0] -match '^:?-{3,}:?$') { continue }
    $english = ($cells[0] -replace '`', '').Trim()
    $phonetic = ($cells[1] -replace '`', '').Trim()
    $chinese = (($cells[2..($cells.Count - 1)] -join '|') -replace '`', '').Trim()
    if ($english -notmatch "^[A-Za-z]+(?:['-][A-Za-z]+)*$" -or -not $chinese) { continue }
    $slug = (($english.ToLowerInvariant() -replace '[^a-z0-9]+', '-') -replace '^-|-$', '')
    if (-not $slug) { continue }
    $acceptedChinese = @($chinese) + @($chinese -split '[；;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $words += [pscustomobject][ordered]@{
      id = "d$day-$slug"
      day = $day
      learned = ""
      preview = $true
      english = $english
      phonetic = $phonetic
      chinese = $chinese
      acceptedChinese = @($acceptedChinese | Select-Object -Unique)
      pronunciation = "先点击喇叭慢速听读，观察音标 $phonetic；正式课程会逐步讲解口型和拼读。"
      example = ""
      exampleZh = ""
      directions = @("en-zh", "zh-en")
    }
  }
  return @($words)
}
