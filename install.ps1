param(
  [string]$Dir = "",
  [ValidateSet('ui','cli')]
  [string]$Mode = 'ui'
)

$ErrorActionPreference = 'Stop'
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  → $msg" -ForegroundColor Cyan }

if (-not $Dir) { $Dir = Join-Path (Get-Location) 'symbiote' }
$RepoUrl = 'https://github.com/artifact-opensource/symbiote.git'
$Branch = 'main'

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║  Symbiote — Desktop Installer                ║" -ForegroundColor Magenta
Write-Host "║  Apex · production-ready setup               ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

$nodeVer = (node -v) -replace 'v',''
if ([int]$nodeVer.Split('.')[0] -lt 20) { Write-Fail "Node.js 20+ is required"; exit 1 }
Write-Ok "Node.js v$nodeVer"
Write-Ok "npm $(npm -v)"
Write-Ok "git $((git --version) -replace 'git version ','')"

Write-Host ""
Write-Host "[2/4] Fetching source"
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Info "Updating existing install in $Dir"
  git -C $Dir fetch origin $Branch
  git -C $Dir checkout $Branch
  git -C $Dir pull --ff-only origin $Branch
} else {
  Write-Info "Cloning repository"
  git clone --branch $Branch $RepoUrl $Dir
}
Write-Ok 'Source ready'

Write-Host ""
Write-Host "[3/4] Installing and building"
npm install --prefix $Dir
npm run build --prefix $Dir
Write-Ok 'Build complete'

Write-Host ""
Write-Host "[4/4] Launching setup"
Set-Location $Dir
if ($Mode -eq 'ui') {
  Write-Info 'Opening desktop installer UI in your browser'
  node dist/index.js init --ui
} else {
  Write-Info 'Starting guided CLI setup'
  node dist/index.js install
}
