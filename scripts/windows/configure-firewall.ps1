param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ruleName = 'SymbioteControlRoomWeb'
$ruleDisplayName = 'Symbiote Control Room (LAN)'

$rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($CheckOnly) {
  if (-not $rule -or $rule.Enabled -ne 'True') {
    exit 1
  }
  $portFilter = $rule | Get-NetFirewallPortFilter
  $addressFilter = $rule | Get-NetFirewallAddressFilter
  if ($portFilter.Protocol -eq 'TCP' -and
      $portFilter.LocalPort -contains [string]$Port -and
      $addressFilter.RemoteAddress -contains 'LocalSubnet') {
    exit 0
  }
  exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-Port', [string]$Port
  )
  try {
    $elevated = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
      -ArgumentList $arguments -Verb RunAs -Wait -PassThru -ErrorAction Stop
    exit $elevated.ExitCode
  }
  catch {
    if ($_.Exception.NativeErrorCode -eq 1223) {
      Write-Output 'Firewall permission was declined. Symbiote remains available on this computer.'
      exit 1223
    }
    throw
  }
}

if ($rule) {
  Remove-NetFirewallRule -Name $ruleName
}

New-NetFirewallRule `
  -Name $ruleName `
  -DisplayName $ruleDisplayName `
  -Group 'Symbiote' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -RemoteAddress LocalSubnet `
  -Profile Domain,Private | Out-Null

Write-Output "Allowed local-subnet access to the Symbiote Control Room on TCP port $Port for Domain and Private networks."
