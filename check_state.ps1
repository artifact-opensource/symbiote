$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root 'symbiote.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Symbiote configuration is missing: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
$port = 3009
if ($null -ne $config.webPort -and -not [int]::TryParse([string]$config.webPort, [ref]$port)) {
  throw "Invalid webPort in $configPath."
}
if ($port -lt 1 -or $port -gt 65535) {
  throw "Invalid webPort in $configPath."
}
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"

Write-Output "=== GATEWAY DAEMONS (daemon.js) ==="
$daemonPath = Join-Path $root 'dist\gateway\daemon.js'
$daemons = $procs | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($daemonPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($d in $daemons) {
  Write-Output ("PID={0}  Created={1}  Config={2}" -f $d.ProcessId, $d.CreationDate, $configPath)
}
Write-Output ("Gateway daemon count: {0}" -f @($daemons).Count)

Write-Output ""
Write-Output ("=== PORT {0} LISTENER (from {1}) ===" -f $port, $configPath)
try {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
    ForEach-Object { Write-Output ("Listen PID={0} addr={1}:{2}" -f $_.OwningProcess, $_.LocalAddress, $_.LocalPort) }
} catch { Write-Output "query failed: $($_.Exception.Message)" }

Write-Output ""
Write-Output "=== SYSTEM LOAD ==="
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Write-Output ("CPU load: {0}%" -f [math]::Round($cpu,1))
$os = Get-CimInstance Win32_OperatingSystem
$freeGb = [math]::Round($os.FreePhysicalMemory/1MB,2)
$totalGb = [math]::Round($os.TotalVisibleMemorySize/1MB,2)
Write-Output ("RAM free: {0}GB / {1}GB" -f $freeGb, $totalGb)
Write-Output ("node.exe count: {0}" -f @($procs).Count)
