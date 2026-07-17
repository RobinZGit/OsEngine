#Requires -Version 5.1
<#
.SYNOPSIS
  Builds MultiLogicTradePgSetup.exe with Inno Setup.
.EXAMPLE
  .\installer\windows\build-installer.ps1

.EXAMPLE
  .\installer\windows\build-installer.ps1 -InstallInnoSetup
#>
[CmdletBinding()]
param(
    [switch] $InstallInnoSetup
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$IssPath = Join-Path $ScriptDir "MultiLogicTradePg.iss"

function Get-IsccPath {
    $cmd = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$iscc = Get-IsccPath
if (-not $iscc -and $InstallInnoSetup) {
    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "Inno Setup not found and winget.exe is unavailable. Install Inno Setup 6 manually: https://jrsoftware.org/isinfo.php"
    }
    & $winget.Source install --id JRSoftware.InnoSetup --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed to install Inno Setup (exit code $LASTEXITCODE)."
    }
    $iscc = Get-IsccPath
}

if (-not $iscc) {
    throw "ISCC.exe not found. Install Inno Setup 6 or rerun with -InstallInnoSetup."
}

Write-Host "Inno Setup: $iscc" -ForegroundColor Cyan
Write-Host "Script:     $IssPath" -ForegroundColor Cyan
& $iscc $IssPath
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compiler failed with exit code $LASTEXITCODE."
}

$exe = Join-Path $ScriptDir "dist\MultiLogicTradePgSetup.exe"
Write-Host ""
Write-Host "Installer built:" -ForegroundColor Green
Write-Host "  $exe"
