[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$ExcludeProcessId = 0
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$unixRoot = '/' + $root.Substring(0, 1).ToLowerInvariant() + '/' + $root.Substring(3).Replace('\', '/')

function Test-CommandBelongsToWorkspace {
  param([string]$CommandLine)

  if (-not $CommandLine) { return $false }
  $normalized = $CommandLine.Replace('/', '\') -replace '\\{2,}', '\'
  return $normalized.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -or $CommandLine.IndexOf($unixRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$all = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }

$roots = @()
foreach ($item in $all) {
  if ($item.Name -ieq 'electron.exe' -and $item.CommandLine -match 'desktop[\\/]+main\.cjs') {
    if (Test-CommandBelongsToWorkspace $item.CommandLine) { $roots += $item }
    continue
  }

  if ($item.Name -ine 'node.exe' -or $item.CommandLine -notmatch 'dist[\\/]+gateway[\\/]+daemon\.js') {
    continue
  }

  $ancestor = $item
  while ($ancestor) {
    if (Test-CommandBelongsToWorkspace $ancestor.CommandLine) {
      $roots += $item
      break
    }
    $parentId = [int]$ancestor.ParentProcessId
    if ($parentId -eq 0 -or -not $byId.ContainsKey($parentId)) { break }
    $ancestor = $byId[$parentId]
  }
}

$processRecords = @(
  (Join-Path $root '.session\gateway-instance.lock'),
  (Join-Path $root '.session\desktop-gateway-process.json')
)
foreach ($recordPath in $processRecords) {
  if (-not (Test-Path -LiteralPath $recordPath)) { continue }
  try {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $recordPid = 0
    if ([int]::TryParse([string]$record.pid, [ref]$recordPid)) {
      $recordedProcess = $byId[$recordPid]
      if ($recordedProcess -and $recordedProcess.Name -ieq 'node.exe' -and $recordedProcess.CommandLine -match 'dist[\\/]+gateway[\\/]+daemon\.js') {
        $roots += $recordedProcess
      }
    }
  } catch {
    Write-Warning "Could not read Symbiote process record $recordPath`: $($_.Exception.Message)"
  }
}

$ids = [System.Collections.Generic.HashSet[int]]::new()
foreach ($item in $roots) { [void]$ids.Add([int]$item.ProcessId) }
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {
      $added = $true
    }
  }
} while ($added)

if ($ExcludeProcessId -gt 0) {
  [void]$ids.Remove($ExcludeProcessId)
}

if ($WhatIfPreference) {
  foreach ($processId in $ids) { Write-Output "Would stop Symbiote process $processId." }
  return
}

foreach ($processId in $ids) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
  } catch {
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
      throw "Could not stop Symbiote process $($processId): $($_.Exception.Message)"
    }
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ($true) {
  $remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $ids.Contains([int]$_.ProcessId)
  })
  if ($remaining.Count -eq 0) { break }
  if ([DateTime]::UtcNow -ge $deadline) {
    throw "Symbiote processes did not exit within ten seconds: $(($remaining.ProcessId) -join ', ')."
  }
  Start-Sleep -Milliseconds 500
}

Write-Output "Stopped $($ids.Count) Symbiote process(es) for $root."
