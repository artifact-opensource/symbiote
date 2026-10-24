[CmdletBinding()]
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\..'),
  [switch]$FromTray,
  [switch]$RestartOnly,
  [int]$DesktopProcessId = 0,
  [string]$DesktopControlPath
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Root).Path
$logPath = Join-Path $root '.session\update.log'

function Write-UpdateLog {
  param(
    [Parameter(Mandatory = $true)][string]$Message
  )

  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message
  Write-Host $line
  try {
    $directory = Split-Path -Parent $logPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {
    Write-Warning "Could not write the Symbiote maintenance log: $($_.Exception.Message)"
  }
}

function Invoke-CheckedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $errorPath = Join-Path $env:TEMP "symbiote-native-$PID-$([guid]::NewGuid().ToString('N')).log"
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& $Command @Arguments 2> $errorPath)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $details = @($output | ForEach-Object { $_.ToString() })
      if (Test-Path -LiteralPath $errorPath) {
        $details += @(Get-Content -LiteralPath $errorPath | Select-Object -Last 12)
      }
      $detailText = ($details | Select-Object -Last 12) -join "`n"
      throw "$Label failed with exit code $exitCode.$([Environment]::NewLine)$detailText"
    }
    return $output
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
  }
}

function Show-MaintenanceMessage {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [Parameter(Mandatory = $true)][string]$Title,
    [int]$Icon = 0
  )

  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]$Icon
  )
}

function Get-DesktopProcess {
  if ($DesktopProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$DesktopProcessId" -ErrorAction SilentlyContinue
}

function Test-ExpectedDesktopProcess {
  param([object]$Process)

  return $Process `
    -and $Process.Name -ieq 'electron.exe' `
    -and $Process.CommandLine -match 'desktop[\\/]+main\.cjs' `
    -and $Process.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Wait-ForDesktopExit {
  if ($DesktopProcessId -le 0) {
    throw 'The desktop process ID is required for this operation.'
  }

  $process = Get-DesktopProcess
  if ($process -and -not (Test-ExpectedDesktopProcess $process)) {
    throw "Process $DesktopProcessId is not the Symbiote desktop from $root; refusing to wait on or stop it."
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ($process -and (Test-ExpectedDesktopProcess $process)) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "The Symbiote desktop process $DesktopProcessId did not stop within 90 seconds."
    }
    Start-Sleep -Milliseconds 300
    $process = Get-DesktopProcess
  }
}

function Request-DesktopQuit {
  if (-not $DesktopControlPath -or -not (Test-Path -LiteralPath $DesktopControlPath)) {
    throw 'The authenticated desktop control record is unavailable; the running app was not stopped.'
  }
  $control = Get-Content -LiteralPath $DesktopControlPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $controlPort = 0
  $hasValidPort = [int]::TryParse([string]$control.port, [ref]$controlPort)
  $hasValidToken = $control.token -is [string] -and $control.token.Length -ge 32
  if (($control.pid -ne $DesktopProcessId) -or (-not $hasValidPort) -or ($controlPort -lt 1) `
    -or ($controlPort -gt 65535) -or (-not $hasValidToken)) {
    throw 'The desktop control record does not match the active Symbiote process.'
  }

  $response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$controlPort/quit" `
    -Method Post `
    -Headers @{ 'X-Symbiote-Control-Token' = $control.token } `
    -TimeoutSec 5 `
    -UseBasicParsing
  if ([int]$response.StatusCode -ne 202) {
    throw "The desktop rejected the orderly shutdown request (HTTP $([int]$response.StatusCode))."
  }
}

function Stop-RunningDesktopGracefully {
  if ($DesktopProcessId -le 0) {
    if (-not $DesktopControlPath) {
      $DesktopControlPath = Join-Path $root '.session\desktop-control.json'
    }
    if (-not (Test-Path -LiteralPath $DesktopControlPath)) { return }

    $control = Get-Content -LiteralPath $DesktopControlPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $recordedProcessId = 0
    if (-not [int]::TryParse([string]$control.pid, [ref]$recordedProcessId) -or $recordedProcessId -le 0) {
      throw "The desktop control record has an invalid process ID: $DesktopControlPath"
    }
    $DesktopProcessId = $recordedProcessId
  }

  $process = Get-DesktopProcess
  if (-not $process) {
    $DesktopProcessId = 0
    return
  }
  if (-not (Test-ExpectedDesktopProcess $process)) {
    throw "Process $DesktopProcessId is not the Symbiote desktop from $root; refusing to stop it."
  }
  Request-DesktopQuit
  Wait-ForDesktopExit
}

function Start-CanonicalLauncher {
  $launcher = Join-Path $root 'symbiote.exe'
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "The canonical Symbiote launcher is missing: $launcher"
  }
  $process = Start-Process -FilePath $launcher -WorkingDirectory $root -PassThru -ErrorAction Stop
  if (-not $process.WaitForExit(5 * 60 * 1000)) {
    throw 'The Symbiote launcher did not finish its startup health check within five minutes.'
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) {
    throw "The Symbiote launcher failed startup validation with exit code $($process.ExitCode)."
  }
}

try {
  if ($RestartOnly) {
    Write-UpdateLog "Waiting for desktop PID $DesktopProcessId to stop before a full application restart."
    Wait-ForDesktopExit
    Start-CanonicalLauncher
    Write-UpdateLog 'The full Symbiote launcher restarted the desktop and Gateway.'
    exit 0
  }

  $hasGitMetadata = Test-Path -LiteralPath (Join-Path $root '.git')
  $hasRootLockfile = Test-Path -LiteralPath (Join-Path $root 'package-lock.json')
  $hasWebappLockfile = Test-Path -LiteralPath (Join-Path $root 'webapp\package-lock.json')
  if (-not $hasGitMetadata -or -not $hasRootLockfile -or -not $hasWebappLockfile) {
    throw "The updater requires a complete Symbiote source checkout at $root."
  }
  $configPath = Join-Path $root 'symbiote.json'
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "The checkout configuration is missing: $configPath"
  }
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
  $configuredPort = 3009
  if ($null -ne $config.webPort -and -not [int]::TryParse([string]$config.webPort, [ref]$configuredPort)) {
    throw "The checkout has an invalid webPort in $configPath."
  }
  if ($configuredPort -lt 1 -or $configuredPort -gt 65535) {
    throw "The checkout has an invalid webPort in $configPath."
  }
  $service = Get-Service -Name 'SymbioteGateway' -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    throw 'The Windows SymbioteGateway service is active. Stop or update the service separately before rebuilding this checkout.'
  }

  $git = (Get-Command git.exe -ErrorAction Stop).Source
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $gitStatus = @(Invoke-CheckedNative $git @('-C', $root, 'status', '--porcelain', '--untracked-files=all') 'Git status')
  if ($gitStatus) {
    throw "The worktree has local changes. Commit or stash them before updating; no files were changed.`n$($gitStatus -join "`n")"
  }

  $upstreamOutput = @(Invoke-CheckedNative $git @('-C', $root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') 'Upstream lookup')
  if ($upstreamOutput.Count -ne 1 -or -not $upstreamOutput[0]) {
    throw 'The current branch has no upstream branch. Configure one before updating.'
  }
  $upstream = $upstreamOutput[0].Trim()

  Write-UpdateLog "Fetching updates for $upstream."
  [void](Invoke-CheckedNative $git @('-C', $root, 'fetch') 'Git fetch')

  $counts = @(Invoke-CheckedNative $git @('-C', $root, 'rev-list', '--left-right', '--count', "HEAD...$upstream") 'Upstream comparison')
  if ($counts.Count -ne 1) {
    throw 'Could not compare the current branch with its upstream after fetching.'
  }
  $parts = $counts.Trim() -split '\s+'
  if ($parts.Count -ne 2 -or $parts[0] -notmatch '^\d+$' -or $parts[1] -notmatch '^\d+$') {
    throw "Git returned an invalid upstream comparison: $counts"
  }
  $localOnly = [int]$parts[0]
  $upstreamOnly = [int]$parts[1]
  if ($localOnly -gt 0 -and $upstreamOnly -gt 0) {
    throw "The local branch and $upstream have diverged; resolve the branch history manually before updating."
  }
  if ($upstreamOnly -eq 0) {
    $message = 'Your Symbiant is up to date.'
    Write-UpdateLog $message
    if ($FromTray) { Show-MaintenanceMessage $message 'Symbiote updates' 0 }
    exit 0
  }

  Write-UpdateLog "$upstreamOnly upstream commit(s) found; requesting a clean desktop and Gateway restart."
  if ($FromTray) {
    if ($localOnly -ne 0) { throw 'The local branch is not a fast-forward target; refusing to overwrite local commits.' }
    Show-MaintenanceMessage `
      "$upstreamOnly update commit(s) are available. Symbiote will now rebuild and restart the desktop and Gateway." `
      'Symbiote update available' `
      0
    Request-DesktopQuit
    Wait-ForDesktopExit
  } else {
    Stop-RunningDesktopGracefully
  }

  $windowsScripts = Join-Path $root 'scripts\windows'
  $stopScript = Join-Path $windowsScripts 'stop-symbiote.ps1'
  Write-UpdateLog 'Stopping Symbiote processes owned by this checkout.'
  & $stopScript -Root $root -ExcludeProcessId $PID

  Write-UpdateLog "Fast-forwarding to $upstream."
  [void](Invoke-CheckedNative $git @('-C', $root, 'merge', '--ff-only', $upstream) 'Fast-forward update')

  Write-UpdateLog 'Installing root dependencies with npm ci.'
  [void](Invoke-CheckedNative $npm @('--prefix', $root, 'ci') 'Root npm ci')
  Write-UpdateLog 'Installing Web UI dependencies with npm ci.'
  [void](Invoke-CheckedNative $npm @('--prefix', (Join-Path $root 'webapp'), 'ci') 'Web UI npm ci')
  Write-UpdateLog 'Rebuilding Symbiote and the Web UI.'
  [void](Invoke-CheckedNative $npm @('--prefix', $root, 'run', 'build') 'Production build')

  Write-UpdateLog 'Rebuilding the green-icon launcher and shortcut.'
  & (Join-Path $windowsScripts 'build-launcher.ps1')
  if ($LASTEXITCODE -ne 0) { throw "Windows launcher rebuild failed with exit code $LASTEXITCODE." }

  Write-UpdateLog 'Starting the updated Symbiote desktop and Gateway.'
  Start-CanonicalLauncher
  Write-UpdateLog 'Update and startup completed successfully.'
  exit 0
} catch {
  $message = $_.Exception.Message
  Write-UpdateLog "Maintenance failed: $message"
  if ($FromTray -or $RestartOnly) {
    try {
      Show-MaintenanceMessage `
        "Symbiote maintenance failed:`n`n$message`n`nDetails: $logPath" `
        'Symbiote maintenance failed' `
        16
    } catch {
      Write-Error "Could not display the maintenance error dialog: $($_.Exception.Message)"
    }
  }
  exit 1
}
