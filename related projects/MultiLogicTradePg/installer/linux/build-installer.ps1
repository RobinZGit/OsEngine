#Requires -Version 5.1
<#
.SYNOPSIS
  Builds MultiLogicTradePg-linux.tar.gz for Linux (incl. MacBook running Linux).
.EXAMPLE
  .\installer\linux\build-installer.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$DistDir = Join-Path $ScriptDir "dist"
$StageRoot = Join-Path $env:TEMP ("MultiLogicTradePg-linux-stage-" + [Guid]::NewGuid().ToString("N"))
$StageApp = Join-Path $StageRoot "MultiLogicTradePg"
$OutName = "MultiLogicTradePg-linux.tar.gz"
$OutPath = Join-Path $DistDir $OutName

function Convert-ToUnixLf {
    param([string] $Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    # strip UTF-8 BOM if present
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $text, $utf8)
}

function Copy-ProjectTree {
    param(
        [string] $SourceRoot,
        [string] $DestRoot
    )
    New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null

    $rootFiles = @(
        "00_create_database.sql",
        "01_multilogictrade_tables_and_data.sql",
        "02_multilogictrade_functions_and_procedures.sql",
        "03_multilogictrade_examples.sql",
        "README.md"
    )
    foreach ($name in $rootFiles) {
        $src = Join-Path $SourceRoot $name
        if (Test-Path $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $DestRoot $name) -Force
        }
    }

    $dirs = @("docs", "scripts", "sql", "api", "web", "installer")
    foreach ($dir in $dirs) {
        $src = Join-Path $SourceRoot $dir
        if (-not (Test-Path $src)) { continue }
        $dest = Join-Path $DestRoot $dir
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        # robocopy: /E copy subdirs, /XD exclude dirs, /XF exclude files, /NFL /NDL quiet-ish
        $xd = @("node_modules", ".angular", "dist", "_tmp_http_ext")
        $xf = @(".env")
        $args = @($src, $dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np")
        foreach ($d in $xd) { $args += @("/XD", $d) }
        foreach ($f in $xf) { $args += @("/XF", $f) }
        & robocopy @args | Out-Null
        $rc = $LASTEXITCODE
        # robocopy 0-7 = success-ish
        if ($rc -ge 8) {
            throw "robocopy failed for $dir with exit code $rc"
        }
    }

    # Ensure linux installer scripts have LF and are present
    $linuxDir = Join-Path $DestRoot "installer\linux"
    New-Item -ItemType Directory -Force -Path $linuxDir | Out-Null
    foreach ($name in @("install.sh", "start-multilogic-trade.sh", "README.md", "INSTALL_PROTOCOL.placeholder.txt", "build-installer.ps1")) {
        $src = Join-Path $ScriptDir $name
        if (Test-Path $src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $linuxDir $name) -Force
        }
    }
    # Do not ship nested dist inside the package
    $nestedDist = Join-Path $linuxDir "dist"
    if (Test-Path $nestedDist) {
        Remove-Item -LiteralPath $nestedDist -Recurse -Force
    }
    $winDist = Join-Path $DestRoot "installer\windows\dist"
    if (Test-Path $winDist) {
        Remove-Item -LiteralPath $winDist -Recurse -Force
    }

    Get-ChildItem -Path $linuxDir -Filter "*.sh" -File | ForEach-Object {
        Convert-ToUnixLf $_.FullName
    }
    $placeholder = Join-Path $DestRoot "INSTALL_PROTOCOL.txt"
    Copy-Item -LiteralPath (Join-Path $ScriptDir "INSTALL_PROTOCOL.placeholder.txt") -Destination $placeholder -Force
    Convert-ToUnixLf $placeholder
}

Write-Host "Linux installer build" -ForegroundColor Cyan
Write-Host "  Root:  $Root"
Write-Host "  Stage: $StageApp"

if (Test-Path $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
Copy-ProjectTree -SourceRoot $Root -DestRoot $StageApp

$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) {
    throw "tar.exe not found. Install Windows 10+ tar or Git for Windows."
}

if (Test-Path $OutPath) {
    Remove-Item -LiteralPath $OutPath -Force
}

Push-Location $StageRoot
try {
    # Create gzip tarball with Unix path separators
    & $tar.Source -czf $OutPath "MultiLogicTradePg"
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$item = Get-Item -LiteralPath $OutPath
Write-Host ""
Write-Host "Linux installer built:" -ForegroundColor Green
Write-Host "  $($item.FullName)"
Write-Host "  Size: $([math]::Round($item.Length / 1MB, 2)) MB"
