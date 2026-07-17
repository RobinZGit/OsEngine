#Requires -Version 5.1
<#
.SYNOPSIS
  Starts MultiLogicTradePg API and Angular UI from an installed copy.
.DESCRIPTION
  Keep the batch entry point tiny and ASCII-only. The real launcher is
  PowerShell so npm/Angular arguments are not parsed by cmd.exe.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string] $Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $paths = @($machine, $user, $env:Path) | Where-Object { $_ }
    $env:Path = ($paths -join ";")

    $nodeCandidates = @(
        (Join-Path $env:ProgramFiles "nodejs"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs"),
        (Join-Path $env:LocalAppData "Programs\node")
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "node.exe")) }

    if ($nodeCandidates.Count -gt 0) {
        $env:Path = (($nodeCandidates + @($env:Path)) -join ";")
    }
}

function Get-CommandPath {
    param([string[]] $Names)
    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Read-ApiEnv {
    param([string] $Path)
    if (-not (Test-Path $Path)) { return }

    Get-Content -Path $Path -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -le 0) { return }

        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if ($key) {
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Stop-PortListeners {
    param([int[]] $Ports)

    foreach ($port in $Ports) {
        for ($i = 0; $i -lt 5; $i++) {
            $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            if (-not $connections) { break }

            $connections |
                Select-Object -ExpandProperty OwningProcess -Unique |
                Where-Object { $_ } |
                ForEach-Object {
                    Write-Host ("       PID {0} port {1}" -f $_, $port)
                    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
                    & taskkill.exe /F /T /PID $_ 2>$null | Out-Null
                }
            Start-Sleep -Milliseconds 800
        }
    }
}

function Invoke-Native {
    param(
        [string] $FilePath,
        [string[]] $Arguments,
        [string] $WorkingDirectory
    )

    Write-Host ("    {0} {1}" -f $FilePath, ($Arguments -join " ")) -ForegroundColor DarkGray
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Ensure-NodeModules {
    param(
        [string] $Name,
        [string] $Path,
        [string] $Npm
    )

    if (Test-Path (Join-Path $Path "node_modules")) {
        Write-Host ("    {0}: OK (node_modules exists)" -f $Name) -ForegroundColor Green
        return
    }

    $args = if (Test-Path (Join-Path $Path "package-lock.json")) {
        @("ci", "--no-audit", "--no-fund")
    }
    else {
        @("install", "--no-audit", "--no-fund")
    }
    Invoke-Native $Npm $args $Path
}

function Start-DelayedBrowser {
    param([string] $Url)
    Start-Job -ScriptBlock {
        param([string] $BrowserUrl)
        Start-Sleep -Seconds 27
        Start-Process $BrowserUrl
    } -ArgumentList $Url | Out-Null
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = (Resolve-Path (Join-Path $scriptDir "..")).Path
$web = Join-Path $installDir "web"
$api = Join-Path $installDir "api"

Write-Host "MultiLogic Trade Progress Start" -ForegroundColor Green
Write-Host "InstallDir: $installDir"
Write-Host "WEB:        $web"
Write-Host "API:        $api"

Refresh-Path
$node = Get-CommandPath @("node.exe", "node")
$npm = Get-CommandPath @("npm.cmd", "npm")

if (-not $node) { throw "Node.js was not found in PATH." }
if (-not $npm) { throw "npm was not found in PATH." }

Write-Host ("Node: {0}" -f (& $node -v))

if (-not (Test-Path (Join-Path $api "server.js"))) {
    throw "API server.js was not found: $api"
}
if (-not (Test-Path (Join-Path $web "package.json"))) {
    throw "web package.json was not found: $web"
}

if (-not $env:PGPASSWORD) { $env:PGPASSWORD = "111" }
Read-ApiEnv (Join-Path $api ".env")
if (-not $env:PGHOST) { $env:PGHOST = "localhost" }
if (-not $env:PGDATABASE) { $env:PGDATABASE = "multilogictrade" }
if (-not $env:PGUSER) { $env:PGUSER = "postgres" }
if (-not $env:PORT) { $env:PORT = "3000" }
$env:CORS_ORIGIN = "http://localhost:4200"
$env:TRADE_RUNNER_INTERVAL_MS = "15000"

$apiProcess = $null
try {
    Write-Step "[1/5] Free ports 3000 and 4200"
    Stop-PortListeners @(3000, 4200)

    Write-Step "[2/5] npm dependencies: api"
    Ensure-NodeModules "api" $api $npm

    Write-Step "[3/5] npm dependencies: web"
    Ensure-NodeModules "web" $web $npm

    Write-Step "[4/5] Angular cache"
    Push-Location $web
    try {
        $cachePath = Join-Path $web ".angular\cache"
        if (Test-Path $cachePath) {
            Remove-Item -Path $cachePath -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "    removed .angular\cache"
        }

        $ngCli = Join-Path $web "node_modules\@angular\cli\bin\ng.js"
        if (Test-Path $ngCli) {
            & $node $ngCli cache clean 2>$null | Out-Null
        }
    }
    finally {
        Pop-Location
    }

    Write-Step "[5/5] Start API and Angular"
    Write-Host ("API:     http://localhost:{0}" -f $env:PORT)
    Write-Host "Angular: http://localhost:4200"
    Write-Host "Ctrl+C stops Angular and API"

    $apiProcess = Start-Process -FilePath $node -ArgumentList @("server.js") -WorkingDirectory $api -NoNewWindow -PassThru
    Start-Sleep -Seconds 2

    $cacheBust = Get-Random -Minimum 10000 -Maximum 99999
    Start-DelayedBrowser ("http://localhost:4200/?v={0}" -f $cacheBust)

    $ngCli = Join-Path $web "node_modules\@angular\cli\bin\ng.js"
    if (-not (Test-Path $ngCli)) {
        throw "Angular CLI was not found after npm install: $ngCli"
    }

    Push-Location $web
    try {
        & $node $ngCli serve --port 4200 --host localhost --open=false --configuration=development
        if ($LASTEXITCODE -ne 0) {
            throw "Angular exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    Write-Step "Stopping API and freeing ports"
    if ($apiProcess -and -not $apiProcess.HasExited) {
        Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-PortListeners @(3000, 4200)
}
