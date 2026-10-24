$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $compiler) {
  throw 'The .NET Framework C# compiler is required to build symbiote.exe.'
}

$source = Join-Path $PSScriptRoot 'symbiote-launcher.cs'
$icon = Join-Path $root 'assets\biohazard_green.ico'
$output = Join-Path $root 'symbiote.exe'
if (-not (Test-Path $icon)) {
  throw "The green launcher icon is missing: $icon"
}

& $compiler /nologo /target:winexe "/out:$output" "/win32icon:$icon" /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) {
  throw "C# launcher compilation failed with exit code $LASTEXITCODE."
}

& $output --configure-shortcut
if ($LASTEXITCODE -ne 0) {
  throw "The Symbiote shortcut could not be configured (exit code $LASTEXITCODE)."
}

Write-Host "Built $output and configured symbiote.link.lnk."
