param(
  [string]$OutputDirectory = '',
  [string]$WixDirectory = '',
  [string]$DependencyCacheDirectory = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repositoryRoot 'dist\windows-installer'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($DependencyCacheDirectory) {
  $DependencyCacheDirectory = (Resolve-Path -LiteralPath $DependencyCacheDirectory).Path
}
$workDirectory = Join-Path ([IO.Path]::GetTempPath()) "symbiote-msi-$([Guid]::NewGuid().ToString('N'))"

$nodeVersion = '26.7.0'
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$nodeSha256 = 'D3BD72755141ED32BBCD841228EE81897C8A98D50DFA7DAE2179399A0A7C90F8'
$nssmUrl = 'https://nssm.cc/ci/nssm-2.24-103-gdee49fc.zip'
$nssmSha256 = 'DD65D65D805CE646148D7BA18A9FCD1A1E8402F9E3822981252A6544136AAD22'
$wixUrl = 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip'
$wixSha256 = '2C1888D5D1DBA377FC7FA14444CF556963747FF9A0A289A3599CF09DA03B9E2E'

function Get-VerifiedArchive([string]$Url, [string]$Destination, [string]$ExpectedSha256) {
  $archiveName = [IO.Path]::GetFileName($Destination)
  $cachedArchive = if ($DependencyCacheDirectory) { Join-Path $DependencyCacheDirectory $archiveName } else { '' }
  if ($cachedArchive -and (Test-Path -LiteralPath $cachedArchive -PathType Leaf)) {
    Write-Host "Using cached $archiveName"
    Copy-Item -LiteralPath $cachedArchive -Destination $Destination
  }
  else {
    Write-Host "Downloading $archiveName"
    & curl.exe --retry 5 --retry-all-errors --retry-delay 2 --location --fail --silent --show-error --max-time 300 $Url --output $Destination
    if ($LASTEXITCODE -ne 0) {
      throw "Download failed for $Url (curl exit $LASTEXITCODE)."
    }
  }

  $actualSha256 = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
  if ($actualSha256 -ne $ExpectedSha256) {
    throw "SHA-256 verification failed for $Destination."
  }
}

try {
  New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null
  $downloads = Join-Path $workDirectory 'downloads'
  $appSource = Join-Path $workDirectory 'app'
  $wixSource = Join-Path $workDirectory 'wix'
  $objectDirectory = Join-Path $workDirectory 'obj'
  New-Item -ItemType Directory -Path $downloads, $appSource, $objectDirectory -Force | Out-Null

  if (-not $SkipBuild) {
    Push-Location $repositoryRoot
    try {
      npm run build
      if ($LASTEXITCODE -ne 0) { throw "Project build failed (npm exit $LASTEXITCODE)." }
    }
    finally {
      Pop-Location
    }
  }

  $applicationFiles = @(
    'dist',
    'desktop',
    'package.json',
    'package-lock.json',
    'symbiote.example.json',
    'symbiote.schema.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE'
  )
  foreach ($relativePath in $applicationFiles) {
    $sourcePath = Join-Path $repositoryRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath)) {
      throw "Required application input is missing: $sourcePath"
    }
    Copy-Item -LiteralPath $sourcePath -Destination $appSource -Recurse -Force
  }

  $electronDistribution = Join-Path $repositoryRoot 'node_modules\electron\dist'
  if (-not (Test-Path -LiteralPath (Join-Path $electronDistribution 'electron.exe') -PathType Leaf)) {
    throw "Electron runtime is missing. Run npm install before building the MSI: $electronDistribution"
  }
  Copy-Item -LiteralPath $electronDistribution -Destination (Join-Path $appSource 'electron-runtime') -Recurse -Force

  $stagedInstallerDirectory = Join-Path $appSource 'dist\windows-installer'
  if (Test-Path -LiteralPath $stagedInstallerDirectory -PathType Container) {
    Remove-Item -LiteralPath $stagedInstallerDirectory -Recurse -Force
  }

  $scriptStage = Join-Path $appSource 'scripts\windows'
  New-Item -ItemType Directory -Path $scriptStage -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-service.ps1') -Destination $scriptStage
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-service.ps1') -Destination $scriptStage
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'configure-firewall.ps1') -Destination $scriptStage

  Push-Location $repositoryRoot
  try {
    npm ci --omit=dev --prefix $appSource
    if ($LASTEXITCODE -ne 0) { throw "Production dependency install failed (npm exit $LASTEXITCODE)." }
  }
  finally {
    Pop-Location
  }

  $nodeArchive = Join-Path $downloads "node-v$nodeVersion-win-x64.zip"
  Get-VerifiedArchive $nodeUrl $nodeArchive $nodeSha256
  $nodeExtract = Join-Path $workDirectory 'node'
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
  $nodeRoot = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
  Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination (Join-Path $appSource 'node.exe')
  Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $appSource 'NODE-LICENSE.txt')

  $nssmArchive = Join-Path $downloads 'nssm-2.24-103-gdee49fc.zip'
  Get-VerifiedArchive $nssmUrl $nssmArchive $nssmSha256
  $nssmExtract = Join-Path $workDirectory 'nssm'
  Expand-Archive -LiteralPath $nssmArchive -DestinationPath $nssmExtract
  $nssmRoot = Join-Path $nssmExtract 'nssm-2.24-103-gdee49fc'
  $nssmExecutable = Join-Path $workDirectory 'nssm.exe'
  Copy-Item -LiteralPath (Join-Path $nssmRoot 'win64\nssm.exe') -Destination $nssmExecutable
  Copy-Item -LiteralPath (Join-Path $nssmRoot 'README.txt') -Destination (Join-Path $appSource 'NSSM-README.txt')

  if (-not $WixDirectory) {
    $wixArchive = Join-Path $downloads 'wix311-binaries.zip'
    Get-VerifiedArchive $wixUrl $wixArchive $wixSha256
    Expand-Archive -LiteralPath $wixArchive -DestinationPath $wixSource
    $WixDirectory = $wixSource
  }
  $WixDirectory = (Resolve-Path -LiteralPath $WixDirectory).Path
  foreach ($tool in @('candle.exe', 'light.exe', 'heat.exe', 'WixUtilExtension.dll', 'WixUIExtension.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $WixDirectory $tool) -PathType Leaf)) {
      throw "WiX tool not found in '$WixDirectory': $tool"
    }
  }

  $package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
  $version = [Version]$package.version
  $versionArgument = '{0}.{1}.{2}' -f $version.Major, $version.Minor, $version.Build
  $harvestedFiles = Join-Path $workDirectory 'ApplicationFiles.wxs'
  $productSource = Join-Path $repositoryRoot 'installer\windows\Symbiote.wxs'
  & (Join-Path $WixDirectory 'heat.exe') dir $appSource -cg ApplicationFiles -dr INSTALLFOLDER -arch x64 -gg -scom -sreg -sfrag -srd -var 'var.AppSource' -out $harvestedFiles
  if ($LASTEXITCODE -ne 0) { throw "WiX heat failed (exit $LASTEXITCODE)." }
  [xml]$harvestedXml = Get-Content -LiteralPath $harvestedFiles -Raw
  foreach ($component in $harvestedXml.SelectNodes('//*[local-name()="Component"]')) {
    $component.SetAttribute('Win64', 'yes')
  }
  foreach ($electronExecutableComponent in $harvestedXml.SelectNodes('//*[local-name()="File" and contains(@Source, "electron-runtime\electron.exe")]/..')) {
    $electronComponentId = $electronExecutableComponent.GetAttribute('Id')
    $electronExecutableComponent.ParentNode.RemoveChild($electronExecutableComponent) | Out-Null
    foreach ($componentReference in $harvestedXml.SelectNodes('//*[local-name()="ComponentRef"]')) {
      if ($componentReference.GetAttribute('Id') -eq $electronComponentId) {
        $componentReference.ParentNode.RemoveChild($componentReference) | Out-Null
      }
    }
  }
  foreach ($electronRuntimeDirectory in $harvestedXml.SelectNodes('//*[local-name()="Directory" and @Name="electron-runtime"]')) {
    $electronRuntimeDirectory.SetAttribute('Id', 'ElectronRuntimeFolder')
  }
  $harvestedXml.Save($harvestedFiles)

  Push-Location $objectDirectory
  try {
    & (Join-Path $WixDirectory 'candle.exe') -nologo `
      "-dProductVersion=$versionArgument" `
      "-dAppSource=$appSource" `
      "-dNssmSource=$nssmExecutable" `
      -ext (Join-Path $WixDirectory 'WixUtilExtension.dll') `
      -ext (Join-Path $WixDirectory 'WixUIExtension.dll') `
      $productSource $harvestedFiles
    if ($LASTEXITCODE -ne 0) { throw "WiX candle failed (exit $LASTEXITCODE)." }
  }
  finally {
    Pop-Location
  }

  $msiPath = Join-Path $OutputDirectory "Symbiote-$versionArgument-x64.msi"
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  & (Join-Path $WixDirectory 'light.exe') -nologo `
    -ext (Join-Path $WixDirectory 'WixUtilExtension.dll') `
    -ext (Join-Path $WixDirectory 'WixUIExtension.dll') `
    -out $msiPath `
    (Join-Path $objectDirectory 'Symbiote.wixobj') `
    (Join-Path $objectDirectory 'ApplicationFiles.wixobj')
  if ($LASTEXITCODE -ne 0) { throw "WiX light failed (exit $LASTEXITCODE)." }

  $hash = (Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash
  Write-Host "Created $msiPath"
  Write-Host "SHA-256 $hash"
}
finally {
  if (Test-Path -LiteralPath $workDirectory) {
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
  }
}
