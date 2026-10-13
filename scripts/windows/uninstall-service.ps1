param(
  [string]$NssmPath = '',
  [string]$ServiceName = 'SymbioteGateway'
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Remove the Symbiote service from an elevated PowerShell window.'
}

if (-not $NssmPath) {
  $NssmPath = Join-Path $PSScriptRoot '..\..\nssm.exe'
}
$NssmPath = (Resolve-Path -LiteralPath $NssmPath).Path
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  Write-Host "Service '$ServiceName' is already absent."
  exit 0
}

$servicePath = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").PathName
if ($servicePath -notmatch [Regex]::Escape($NssmPath)) {
  throw "Refusing to remove '$ServiceName': it is not managed by the specified NSSM executable."
}

if ($service.Status -ne 'Stopped') {
  Stop-Service -Name $ServiceName -Force
  $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}

& $NssmPath remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) {
  throw "NSSM could not remove service '$ServiceName' (exit $LASTEXITCODE)."
}
Write-Host "Removed '$ServiceName'. Configuration, logs, sessions, and memory under ProgramData were preserved."
