param(
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$ConfigPath = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'Symbiote'),
  [string]$NssmPath = '',
  [string]$NodePath = '',
  [string]$SeedDirectory = '',
  [string]$ServiceName = 'SymbioteGateway'
)

$ErrorActionPreference = 'Stop'

function Invoke-Nssm([string[]]$Arguments) {
  & $script:NssmPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "NSSM failed ($LASTEXITCODE): $($Arguments -join ' ')"
  }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Install the Symbiote service from an elevated PowerShell window.'
}

$installLogDirectory = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Path $installLogDirectory -Force | Out-Null
$script:transcriptStarted = $false
Start-Transcript -Path (Join-Path $installLogDirectory 'service-install.log') -Append | Out-Null
$script:transcriptStarted = $true
trap {
  if ($script:transcriptStarted) {
    Stop-Transcript | Out-Null
    $script:transcriptStarted = $false
  }
  throw
}

$runningGateways = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'dist[\\/]+gateway[\\/]+daemon\.js' })
if ($runningGateways.Count -gt 0) {
  $processIds = ($runningGateways | ForEach-Object ProcessId) -join ', '
  throw "Stop existing Symbiote gateway process(es) ($processIds) before installing the service."
}

$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
if ($SeedDirectory) {
  if (-not (Test-Path -LiteralPath $SeedDirectory -PathType Container)) {
    throw "Seed directory not found: $SeedDirectory"
  }
  $SeedDirectory = (Resolve-Path -LiteralPath $SeedDirectory).Path
  if (-not (Test-Path -LiteralPath (Join-Path $SeedDirectory 'symbiote.json') -PathType Leaf)) {
    throw "Seed directory does not contain symbiote.json: $SeedDirectory"
  }
}
if (-not $ConfigPath) {
  $ConfigPath = Join-Path $DataDir 'symbiote.json'
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$DataDir = [IO.Path]::GetFullPath($DataDir)

if (-not $NssmPath) {
  $NssmPath = Join-Path $InstallDir 'nssm.exe'
}
$NssmPath = (Resolve-Path -LiteralPath $NssmPath).Path
if (-not $NodePath) {
  $bundledNode = Join-Path $InstallDir 'node.exe'
  if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $NodePath = $bundledNode
  }
  else {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $NodePath = $nodeCommand.Source
  }
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$GatewayPath = Join-Path $InstallDir 'dist\gateway\daemon.js'
$LogDir = Join-Path $DataDir 'logs'

foreach ($requiredPath in @($GatewayPath, $NssmPath, $NodePath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required file not found: $requiredPath"
  }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  throw "Service '$ServiceName' already exists. Stop and remove it before installing a replacement."
}

New-Item -ItemType Directory -Path $DataDir, $LogDir, (Split-Path -Parent $ConfigPath), (Join-Path $DataDir 'workspace'), (Join-Path $DataDir 'sessions') -Force | Out-Null
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  $seedConfig = if ($SeedDirectory) { Join-Path $SeedDirectory 'symbiote.json' } else { '' }
  if ($seedConfig) {
    Copy-Item -LiteralPath $seedConfig -Destination $ConfigPath
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $config.workspace = '.\workspace'
    $config.sessionsDir = '.\sessions'
    $config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  }
  else {
    $examplePath = Join-Path $InstallDir 'symbiote.example.json'
    if (-not (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
      throw "Neither a seed config nor the example config exists: $ConfigPath"
    }

    $config = Get-Content -LiteralPath $examplePath -Raw | ConvertFrom-Json
    $config.workspace = '.\workspace'
    $config.sessionsDir = '.\sessions'
    $config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  }
}
else {
  $configDirectory = Split-Path -Parent $ConfigPath
  if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  }
}

$configDirectory = Split-Path -Parent $ConfigPath
$environmentFile = Join-Path $configDirectory '.env'
$seedEnvironment = if ($SeedDirectory) { Join-Path $SeedDirectory '.env' } else { '' }
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf) -and
    $seedEnvironment -and (Test-Path -LiteralPath $seedEnvironment -PathType Leaf)) {
  Copy-Item -LiteralPath $seedEnvironment -Destination $environmentFile
}
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
  [IO.File]::WriteAllText($environmentFile, "# Add provider and channel credentials here.`r`n")
}

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $DataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' '/C' | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Could not restrict permissions on service data directory: $DataDir"
}

$script:NssmPath = $NssmPath
$serviceInstalled = $false
try {
  $nodeArguments = "`"$GatewayPath`" --config=`"$ConfigPath`""
  Invoke-Nssm @('install', $ServiceName, $NodePath, $nodeArguments)
  $serviceInstalled = $true
  Invoke-Nssm @('set', $ServiceName, 'ObjectName', 'LocalSystem')
  Invoke-Nssm @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
  Invoke-Nssm @('set', $ServiceName, 'AppDirectory', $configDirectory)
  Invoke-Nssm @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
  Invoke-Nssm @('set', $ServiceName, 'AppRestartDelay', '5000')
  Invoke-Nssm @('set', $ServiceName, 'AppThrottle', '1500')
  Invoke-Nssm @('set', $ServiceName, 'AppStopMethodConsole', '5000')
  Invoke-Nssm @('set', $ServiceName, 'AppStdout', (Join-Path $LogDir 'gateway.stdout.log'))
  Invoke-Nssm @('set', $ServiceName, 'AppStderr', (Join-Path $LogDir 'gateway.stderr.log'))
  Invoke-Nssm @('set', $ServiceName, 'AppRotateFiles', '1')
  Invoke-Nssm @('set', $ServiceName, 'AppRotateOnline', '1')
  Invoke-Nssm @('set', $ServiceName, 'AppRotateBytes', '10485760')
  Invoke-Nssm @('set', $ServiceName, 'AppEnvironmentExtra', 'NODE_ENV=production')

  $serviceControl = Join-Path $env:SystemRoot 'System32\sc.exe'
  & $serviceControl failure $ServiceName 'reset=' '86400' 'actions=' 'restart/5000/restart/5000/restart/5000' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not configure Windows Service Control Manager recovery for '$ServiceName'."
  }

  Start-Service -Name $ServiceName
  $service = Get-Service -Name $ServiceName
  $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
}
catch {
  if ($serviceInstalled) {
    & $NssmPath stop $ServiceName 2>$null | Out-Null
    & $NssmPath remove $ServiceName confirm 2>$null | Out-Null
  }
  throw "The service could not be installed and started: $($_.Exception.Message)"
}

Write-Host "Symbiote service '$ServiceName' is running as LocalSystem."
Write-Host "Config: $ConfigPath"
Write-Host "Data:   $DataDir"
Write-Host "Logs:   $LogDir"
Stop-Transcript | Out-Null
$script:transcriptStarted = $false
