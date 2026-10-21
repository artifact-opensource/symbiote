$ErrorActionPreference = 'SilentlyContinue'

$keep = 17680

Write-Output "=== Inspecting leftover build processes before killing ==="
foreach ($id in 5856, 11596, 16292, 17584, 2248) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if ($p) {
        $age = ((Get-Date) - $p.CreationDate).ToString('hh\:mm\:ss')
        Write-Output ("PID {0,-7} Age {1,-10} {2}" -f $id, $age, $p.CommandLine)
    }
}

Write-Output ""
Write-Output "=== Killing stale gateway daemons (keeping PID $keep) ==="
$stale = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like '*daemon.js*' -and $_.ProcessId -ne $keep
}
$count = 0
foreach ($s in $stale) {
    $id = $s.ProcessId
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Write-Output "  killed stale daemon PID $id"
    $count++
}
Write-Output "Killed $count stale daemon(s)."

Start-Sleep -Seconds 2

Write-Output ""
Write-Output "=== Remaining gateway daemons ==="
$remain = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*daemon.js*' }
foreach ($r in $remain) { Write-Output ("  PID {0}" -f $r.ProcessId) }
Write-Output ("Count: {0}" -f $remain.Count)
