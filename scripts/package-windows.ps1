param(
  [string]$OutputDirectory = ".release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$NodeVersion = "24.21.0"
$CloudflaredVersion = "2026.9.1"
$CloudflaredSha256 = "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Out = [System.IO.Path]::GetFullPath((Join-Path $Root $OutputDirectory))
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
$PnpmVersion = ([string]$Package.packageManager -split "@")[1].Split("+")[0]
$DistCli = Join-Path $Root "dist\cli.js"
if (-not (Test-Path $DistCli)) {
  throw "dist\cli.js is missing; run pnpm build first."
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("flyto2-runtime-package-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Work | Out-Null

try {
  $Bundle = Join-Path $Work "Flyto2 Runtime"
  New-Item -ItemType Directory -Force -Path $Bundle | Out-Null

  Write-Host "==> Node $NodeVersion (windows-x64)"
  $NodeArchive = "node-v$NodeVersion-win-x64.zip"
  $NodeArchivePath = Join-Path $Work $NodeArchive
  $NodeShasums = Join-Path $Work "SHASUMS256.txt"
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$NodeArchive" -OutFile $NodeArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $NodeShasums
  $NodeLine = Select-String -Path $NodeShasums -Pattern ("\s" + [regex]::Escape($NodeArchive) + "$") | Select-Object -First 1
  if (-not $NodeLine) {
    throw "$NodeArchive is missing from Node.js SHASUMS256.txt."
  }
  $ExpectedNodeSha = ($NodeLine.Line.Trim() -split "\s+")[0].ToLowerInvariant()
  $ActualNodeSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $NodeArchivePath).Hash.ToLowerInvariant()
  if ($ActualNodeSha -ne $ExpectedNodeSha) {
    throw "Node.js archive digest mismatch: expected $ExpectedNodeSha, got $ActualNodeSha."
  }
  Expand-Archive -LiteralPath $NodeArchivePath -DestinationPath $Work
  $NodeSource = Join-Path $Work "node-v$NodeVersion-win-x64"
  $BundledNodeDir = Join-Path $Bundle "node"
  New-Item -ItemType Directory -Force -Path $BundledNodeDir | Out-Null
  Copy-Item (Join-Path $NodeSource "node.exe") $BundledNodeDir
  Copy-Item (Join-Path $NodeSource "LICENSE") $BundledNodeDir

  Write-Host "==> Runtime $Version files"
  & npm.cmd pack --silent --pack-destination $Work | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed." }
  $Tarball = Join-Path $Work "flyto2-runtime-$Version.tgz"
  & tar.exe -xzf $Tarball -C $Work
  if ($LASTEXITCODE -ne 0) { throw "Could not extract $Tarball." }
  Copy-Item (Join-Path $Work "package\*") $Bundle -Recurse -Force
  Copy-Item (Join-Path $Root "pnpm-lock.yaml") $Bundle
  Copy-Item (Join-Path $Root "pnpm-workspace.yaml") $Bundle

  Write-Host "==> Production dependencies for Node $NodeVersion"
  Push-Location $Bundle
  try {
    & pnpm.cmd install --prod --frozen-lockfile --config.node-linker=hoisted --config.confirmModulesPurge=false
    if ($LASTEXITCODE -ne 0) { throw "pnpm production install failed." }
  } finally {
    Pop-Location
  }
  Remove-Item (Join-Path $Bundle "pnpm-lock.yaml") -Force
  Remove-Item (Join-Path $Bundle "pnpm-workspace.yaml") -Force
  Remove-Item (Join-Path $Bundle "node_modules\.modules.yaml") -Force -ErrorAction SilentlyContinue

  $BundledNode = Join-Path $BundledNodeDir "node.exe"
  Push-Location $Bundle
  try {
    & $BundledNode -e "new (require('better-sqlite3'))(':memory:').close(); require('node-pty'); require('koffi'); console.log('native modules load under', process.version)"
    if ($LASTEXITCODE -ne 0) { throw "Packaged native modules do not load under bundled Node.js." }
    & $BundledNode "dist\cli.js" version
    if ($LASTEXITCODE -ne 0) { throw "Packaged Runtime version check failed." }
  } finally {
    Pop-Location
  }

  Write-Host "==> cloudflared $CloudflaredVersion"
  $CloudflaredDownload = Join-Path $Work "cloudflared-windows-amd64.exe"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe" -OutFile $CloudflaredDownload
  $ActualCloudflaredSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $CloudflaredDownload).Hash.ToLowerInvariant()
  if ($ActualCloudflaredSha -ne $CloudflaredSha256) {
    throw "cloudflared digest mismatch: expected $CloudflaredSha256, got $ActualCloudflaredSha."
  }
  $CloudflaredSignature = Get-AuthenticodeSignature -LiteralPath $CloudflaredDownload
  if (
    $CloudflaredSignature.Status -ne "Valid" -or
    $CloudflaredSignature.SignerCertificate.Subject -notmatch "Cloudflare, Inc\."
  ) {
    throw "cloudflared is not Authenticode-signed by Cloudflare, Inc."
  }
  $Vendor = Join-Path $Bundle "vendor"
  New-Item -ItemType Directory -Force -Path $Vendor | Out-Null
  Copy-Item $CloudflaredDownload (Join-Path $Vendor "cloudflared.exe")

  @{
    kind = "windows-portable"
    version = $Version
    arch = "x64"
  } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Bundle "distribution.json")

  $Zip = Join-Path $Out "Flyto2-Runtime-$Version-windows-x64.zip"
  Remove-Item $Zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path $Bundle -DestinationPath $Zip -CompressionLevel Optimal
  Write-Host $Zip
} finally {
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
