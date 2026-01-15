param(
  [string]$Output = ".\\dist\\context-health-bar.zip"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$outPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $root $Output }
$dist = Split-Path -Parent $outPath

if (-not (Test-Path $dist)) {
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
}

$temp = Join-Path $env:TEMP "context-health-bar-package"
if (Test-Path $temp) {
  Remove-Item -Recurse -Force $temp
}
New-Item -ItemType Directory -Path $temp | Out-Null

$include = @(
  "manifest.json",
  "content.js",
  "healthbar.css",
  "icons",
  "README.md",
  "LICENSE"
)

foreach ($item in $include) {
  $src = Join-Path $root $item
  if (Test-Path $src) {
    Copy-Item -Recurse -Force $src (Join-Path $temp $item)
  }
}

if (Test-Path $outPath) {
  Remove-Item -Force $outPath
}

Compress-Archive -Path (Join-Path $temp "*") -DestinationPath $outPath
Remove-Item -Recurse -Force $temp

Write-Host "Package created: $outPath"
