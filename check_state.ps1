$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"

Write-Output "=== GATEWAY DAEMONS (daemon.js) ==="
$daemons = $procs | Where-Object { $_.CommandLine -like '*daemon.js*' }
foreach ($d in $daemons) {
  Write-Output ("PID={0}  Created={1}" -f $d.ProcessId, $d.CreationDate)
}
Write-Output ("Gateway daemon count: {0}" -f @($daemons).Count)

Write-Output ""
Write-Output "=== PORT 3009 LISTENER ==="
try {
  Get-NetTCPConnection -LocalPort 3009 -State Listen -ErrorAction Stop |
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
