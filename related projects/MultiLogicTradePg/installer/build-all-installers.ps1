#Requires -Version 5.1
<#
.SYNOPSIS
  Rebuild Windows Setup.exe and Linux tar.gz (both must stay current).
.EXAMPLE
  .\installer\build-all-installers.ps1
#>
[CmdletBinding()]
param(
    [switch] $InstallInnoSetup
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $Root

Write-Host "==> Bump installer build number" -ForegroundColor Cyan
$ver = & (Join-Path $Root "Sync-InstallerVersion.ps1")
if (-not $ver) {
    throw "Sync-InstallerVersion.ps1 failed."
}

Write-Host "==> Windows installer" -ForegroundColor Cyan
& (Join-Path $Root "windows\build-installer.ps1") -InstallInnoSetup:$InstallInnoSetup
if ($LASTEXITCODE -ne 0) {
    throw "Windows installer build failed."
}

Write-Host ""
Write-Host "==> Linux installer" -ForegroundColor Cyan
& (Join-Path $Root "linux\build-installer.ps1")
if ($LASTEXITCODE -ne 0) {
    throw "Linux installer build failed."
}

Write-Host ""
Write-Host "Both installers ready (Version $($ver.Version), Build $($ver.Build)):" -ForegroundColor Green
Write-Host "  $(Join-Path $ProjectRoot 'installer\windows\dist\MultiLogicTradePgSetup.exe')"
Write-Host "  $(Join-Path $ProjectRoot 'installer\linux\dist\MultiLogicTradePg-linux.tar.gz')"
