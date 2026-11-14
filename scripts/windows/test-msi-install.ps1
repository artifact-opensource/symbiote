$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installerDirectory = Join-Path $repositoryRoot 'dist\windows-installer'
$testLogDirectory = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$installLog = Join-Path $testLogDirectory 'symbiote-msi-install.log'
$uninstallLog = Join-Path $testLogDirectory 'symbiote-msi-uninstall.log'
$serviceInstallLog = Join-Path $testLogDirectory 'symbiote-service-install.log'
$installer = Get-ChildItem -LiteralPath $installerDirectory -Filter 'Symbiote-*-x64.msi' -File |
  Select-Object -First 1
if (-not $installer) {
  throw "No Symbiote MSI was found in $installerDirectory."
}

$dataDirectory = Join-Path $env:ProgramData 'Symbiote'
$serviceName = 'SymbioteGateway'

function Invoke-Msi([string[]]$Arguments, [string]$LogPath) {
  $processArguments = (@($Arguments + @('/L*V', $LogPath) | ForEach-Object {
    if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ }
  }) -join ' ')
  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList $processArguments -Wait -PassThru -NoNewWindow
  $exitCode = $process.ExitCode
  if ($exitCode -notin @(0, 3010)) {
    if (Test-Path -LiteralPath $LogPath) {
      Get-Content -LiteralPath $LogPath -Tail 100
    }
    if (Test-Path -LiteralPath $serviceInstallLog) {
      Get-Content -LiteralPath $serviceInstallLog -Tail 100
    }
    throw "msiexec failed with exit code $exitCode. Full log: $LogPath"
  }
}

$installCompleted = $false
try {
  Invoke-Msi @('/i', $installer.FullName, '/qn', '/norestart', "SYMBIOTE_TRANSCRIPT_PATH=$serviceInstallLog") $installLog
  $installCompleted = $true

  $service = Get-Service -Name $serviceName -ErrorAction Stop
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    throw "The installed Gateway service is not running. Full MSI log: $installLog"
  }
  foreach ($requiredPath in @(
      (Join-Path $dataDirectory 'symbiote.json'),
      (Join-Path $dataDirectory '.env'),
      (Join-Path $dataDirectory 'workspace\.sessions')
    )) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "The MSI did not create its required data path: $requiredPath"
    }
  }
}
finally {
  if ($installCompleted -or (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
    Invoke-Msi @('/x', $installer.FullName, '/qn', '/norestart') $uninstallLog
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
      throw "The MSI uninstall left the '$serviceName' service installed. Full MSI log: $uninstallLog"
    }
  }
}

Write-Host "MSI install and uninstall smoke test passed. Logs: $installLog; $uninstallLog"
