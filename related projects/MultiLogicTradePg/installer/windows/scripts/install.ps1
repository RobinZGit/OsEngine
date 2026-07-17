#Requires -Version 5.1
<#
.SYNOPSIS
  Post-install script for the MultiLogicTradePg Windows installer.
.DESCRIPTION
  Runs elevated from the Inno Setup installer. It installs missing Node.js and
  PostgreSQL, deploys the database scripts, installs npm dependencies for the
  API and Angular UI, and writes api\.env for local launches.
#>
[CmdletBinding()]
param(
    [string] $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
    [string] $PostgresPassword = "111",
    [bool] $ResetDatabase = $true,
    [string] $PostgresMajor = "15",
    [switch] $SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InstallDir = (Resolve-Path $InstallDir).Path
$LogDir = Join-Path $env:ProgramData "MultiLogicTradePg"
$LogPath = Join-Path $LogDir "install.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path $LogPath -Append | Out-Null

try {
    function Write-Step {
        param([string] $Message)
        Write-Host ""
        Write-Host "==> $Message" -ForegroundColor Cyan
    }

    function Test-Admin {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    }

    function Refresh-Path {
        $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $user = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path = "$machine;$user"
    }

    function Invoke-Native {
        param(
            [string] $FilePath,
            [string[]] $Arguments,
            [string] $WorkingDirectory = $InstallDir
        )
        Write-Host "    $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
        $previous = Get-Location
        try {
            Set-Location $WorkingDirectory
            & $FilePath @Arguments
            if ($LASTEXITCODE -ne 0) {
                throw "$FilePath exited with code $LASTEXITCODE"
            }
        }
        finally {
            Set-Location $previous
        }
    }

    function Get-CommandPath {
        param([string] $Command)
        $cmd = Get-Command $Command -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
        return $null
    }

    function Get-NodeMajor {
        try {
            $version = (& node -p "process.versions.node" 2>$null).Trim()
            if (-not $version) { return 0 }
            return [int]($version.Split(".")[0])
        }
        catch {
            return 0
        }
    }

    function Install-NodeWithWinget {
        $winget = Get-CommandPath "winget.exe"
        if (-not $winget) { return $false }
        Invoke-Native $winget @(
            "install",
            "--id", "OpenJS.NodeJS.LTS",
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements"
        )
        return $true
    }

    function Install-NodeFromMsi {
        $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
        $release = $index |
            Where-Object { $_.lts -and $_.version -match "^v20\." } |
            Select-Object -First 1
        if (-not $release) {
            throw "Could not find latest Node.js 20 LTS release in nodejs.org index."
        }
        $fileName = "node-$($release.version)-x64.msi"
        $url = "https://nodejs.org/dist/$($release.version)/$fileName"
        $download = Join-Path $env:TEMP $fileName
        Invoke-WebRequest -Uri $url -OutFile $download
        $process = Start-Process "msiexec.exe" -ArgumentList @("/i", "`"$download`"", "/qn", "/norestart") -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "Node.js MSI installer exited with code $($process.ExitCode)"
        }
    }

    function Ensure-NodeJs {
        Write-Step "Проверка Node.js"
        Refresh-Path
        $major = Get-NodeMajor
        if ($major -ge 18) {
            Write-Host "    Node.js найден: major $major" -ForegroundColor Green
            return
        }
        if ($SkipDependencyInstall) {
            throw "Node.js 18+ не найден, а установка зависимостей отключена."
        }

        Write-Host "    Node.js 18+ не найден. Установка Node.js LTS..." -ForegroundColor Yellow
        try {
            if (-not (Install-NodeWithWinget)) {
                Install-NodeFromMsi
            }
        }
        catch {
            Write-Warning "winget не установил Node.js: $($_.Exception.Message)"
            Install-NodeFromMsi
        }
        Refresh-Path

        $major = Get-NodeMajor
        if ($major -lt 18) {
            throw "Node.js installation failed or version is still below 18."
        }
        Write-Host "    Node.js установлен: major $major" -ForegroundColor Green
    }

    function Find-PostgresRoot {
        $candidates = @(
            (Join-Path $env:ProgramFiles "PostgreSQL\$PostgresMajor"),
            (Join-Path ${env:ProgramFiles(x86)} "PostgreSQL\$PostgresMajor")
        ) | Where-Object { $_ }

        foreach ($root in $candidates) {
            if (Test-Path (Join-Path $root "bin\psql.exe")) {
                return $root
            }
        }

        $psql = Get-CommandPath "psql.exe"
        if ($psql) {
            return (Resolve-Path (Join-Path (Split-Path $psql -Parent) "..")).Path
        }
        return $null
    }

    function Get-PostgresServiceName {
        $name = "postgresql-x64-$PostgresMajor"
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
            return $name
        }
        $service = Get-Service -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "postgresql*x64*$PostgresMajor*" -or $_.Name -like "postgresql-$PostgresMajor*" } |
            Select-Object -First 1
        return $service.Name
    }

    function Start-PostgresService {
        $serviceName = Get-PostgresServiceName
        if ($serviceName) {
            $svc = Get-Service -Name $serviceName
            if ($svc.Status -ne "Running") {
                Write-Host "    Запуск службы $serviceName..." -ForegroundColor Yellow
                Start-Service -Name $serviceName
                $svc.WaitForStatus("Running", [TimeSpan]::FromSeconds(60))
            }
        }
    }

    function Install-PostgresWithWinget {
        $winget = Get-CommandPath "winget.exe"
        if (-not $winget) { return $false }

        $override = "--mode unattended --unattendedmodeui none --superpassword `"$PostgresPassword`" --servicename postgresql-x64-$PostgresMajor --serverport 5432 --locale `"Russian, Russia`""
        Invoke-Native $winget @(
            "install",
            "--id", "PostgreSQL.PostgreSQL.$PostgresMajor",
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--override", $override
        )
        return $true
    }

    function Install-PostgresFromEnterpriseDb {
        $version = "15.13-1"
        $fileName = "postgresql-$version-windows-x64.exe"
        $url = "https://get.enterprisedb.com/postgresql/$fileName"
        $download = Join-Path $env:TEMP $fileName
        Invoke-WebRequest -Uri $url -OutFile $download

        $args = @(
            "--mode", "unattended",
            "--unattendedmodeui", "none",
            "--superpassword", $PostgresPassword,
            "--servicename", "postgresql-x64-$PostgresMajor",
            "--serverport", "5432"
        )
        $process = Start-Process $download -ArgumentList $args -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            throw "PostgreSQL installer exited with code $($process.ExitCode)"
        }
    }

    function Ensure-PostgreSql {
        Write-Step "Проверка PostgreSQL $PostgresMajor"
        Refresh-Path
        $root = Find-PostgresRoot
        if (-not $root) {
            if ($SkipDependencyInstall) {
                throw "PostgreSQL $PostgresMajor не найден, а установка зависимостей отключена."
            }
            Write-Host "    PostgreSQL $PostgresMajor не найден. Установка..." -ForegroundColor Yellow
            try {
                if (-not (Install-PostgresWithWinget)) {
                    Install-PostgresFromEnterpriseDb
                }
            }
            catch {
                Write-Warning "winget не установил PostgreSQL: $($_.Exception.Message)"
                Install-PostgresFromEnterpriseDb
            }
            Refresh-Path
            $root = Find-PostgresRoot
        }

        if (-not $root) {
            throw "PostgreSQL $PostgresMajor installation finished, but psql.exe was not found."
        }

        Start-PostgresService
        Write-Host "    PostgreSQL: $root" -ForegroundColor Green
        return $root
    }

    function Invoke-Psql {
        param(
            [string] $Psql,
            [string] $Database,
            [string[]] $Arguments
        )
        $env:PGPASSWORD = $PostgresPassword
        $env:PGCLIENTENCODING = "UTF8"
        Invoke-Native $Psql (@("-h", "localhost", "-p", "5432", "-U", "postgres", "-d", $Database) + $Arguments)
    }

    function Wait-PostgresReady {
        param([string] $Psql)
        Write-Step "Ожидание готовности PostgreSQL"
        for ($i = 1; $i -le 60; $i++) {
            try {
                Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;")
                Write-Host "    PostgreSQL готов." -ForegroundColor Green
                return
            }
            catch {
                Start-Sleep -Seconds 2
            }
        }
        throw "PostgreSQL did not become ready within 120 seconds."
    }

    function Install-PgsqlHttpExtension {
        param([string] $PostgresRoot)

        $control = Join-Path $PostgresRoot "share\extension\http.control"
        if (Test-Path $control) {
            Write-Host "    pgsql-http уже установлен." -ForegroundColor Green
            return $true
        }

        Write-Host "    Попытка установить pgsql-http для полной HTTP-загрузки цен..." -ForegroundColor Yellow
        try {
            $zip = Join-Path $env:TEMP "pg15http_w64.zip"
            $extract = Join-Path $env:TEMP "pg15http_w64"
            Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
            Invoke-WebRequest -Uri "https://www.postgresonline.com/downloads/pg15http_w64.zip" -OutFile $zip
            Expand-Archive -Path $zip -DestinationPath $extract -Force

            $src = Get-ChildItem -Path $extract -Directory -Recurse |
                Where-Object { Test-Path (Join-Path $_.FullName "lib\http.dll") } |
                Select-Object -First 1
            if (-not $src) {
                throw "http.dll was not found in pg15http_w64.zip"
            }

            Copy-Item (Join-Path $src.FullName "lib\http.dll") (Join-Path $PostgresRoot "lib") -Force
            Copy-Item (Join-Path $src.FullName "share\extension\http*") (Join-Path $PostgresRoot "share\extension") -Force
            Copy-Item (Join-Path $src.FullName "bin\*.dll") (Join-Path $PostgresRoot "bin") -Force

            $srcCerts = Join-Path $src.FullName "ssl\certs"
            if (Test-Path $srcCerts) {
                $certDir = Join-Path $PostgresRoot "ssl\certs"
                New-Item -ItemType Directory -Force -Path $certDir | Out-Null
                Copy-Item (Join-Path $srcCerts "*") $certDir -Force
            }

            $serviceName = Get-PostgresServiceName
            if ($serviceName) {
                Restart-Service -Name $serviceName -Force
                Start-Sleep -Seconds 3
            }
            Write-Host "    pgsql-http установлен." -ForegroundColor Green
            return $true
        }
        catch {
            Write-Warning "pgsql-http не установлен: $($_.Exception.Message)"
            return $false
        }
    }

    function New-CoreSql02File {
        $source = Join-Path $InstallDir "02_multilogictrade_functions_and_procedures.sql"
        $target = Join-Path $env:TEMP "02_multilogictrade_functions_and_procedures.core.sql"
        $text = Get-Content -Raw -Encoding UTF8 $source
        $marker = "-- @optional-pgcron-block"
        $idx = $text.IndexOf($marker, [StringComparison]::Ordinal)
        if ($idx -ge 0) {
            $text = $text.Substring(0, $idx)
        }
        Set-Content -Path $target -Value $text -Encoding UTF8
        return $target
    }

    function Deploy-Database {
        param(
            [string] $Psql,
            [bool] $HttpExtensionReady
        )
        if (-not $ResetDatabase) {
            Write-Host "    Развёртывание БД пропущено по выбору пользователя." -ForegroundColor Yellow
            return
        }

        Write-Step "Развёртывание базы данных 00 -> 01 -> 02"
        Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-f", (Join-Path $InstallDir "00_create_database.sql"))
        Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", (Join-Path $InstallDir "01_multilogictrade_tables_and_data.sql"))

        $sql02 = Join-Path $InstallDir "02_multilogictrade_functions_and_procedures.sql"
        if (-not $HttpExtensionReady) {
            Write-Warning "HTTP-блок 02 будет пропущен, потому что pgsql-http недоступен. Загрузка цен через HTTP может быть недоступна до установки pgsql-http."
            $sql02 = New-CoreSql02File
        }
        Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", $sql02)
    }

    function Write-ApiEnv {
        Write-Step "Создание api\\.env"
        $content = @"
PGHOST=localhost
PGPORT=5432
PGDATABASE=multilogictrade
PGUSER=postgres
PGPASSWORD=$PostgresPassword
PORT=3000
CORS_ORIGIN=http://localhost:4200
TRADE_RUNNER_INTERVAL_MS=15000
"@
        Set-Content -Path (Join-Path $InstallDir "api\.env") -Value $content -Encoding UTF8
    }

    function Install-NpmDependencies {
        Write-Step "Установка npm-зависимостей"
        Refresh-Path
        $npm = Get-CommandPath "npm.cmd"
        if (-not $npm) { $npm = Get-CommandPath "npm" }
        if (-not $npm) { throw "npm не найден после установки Node.js." }

        foreach ($dir in @("api", "web")) {
            $path = Join-Path $InstallDir $dir
            $args = if (Test-Path (Join-Path $path "package-lock.json")) {
                @("ci", "--no-audit", "--no-fund")
            }
            else {
                @("install", "--no-audit", "--no-fund")
            }
            Invoke-Native $npm $args $path
        }
    }

    if (-not (Test-Admin)) {
        throw "Installer post-install script must run as Administrator."
    }

    Write-Host "MultiLogicTradePg installer post-install" -ForegroundColor Green
    Write-Host "InstallDir: $InstallDir"
    Write-Host "Log:        $LogPath"

    Ensure-NodeJs
    $pgRoot = Ensure-PostgreSql
    $psql = Join-Path $pgRoot "bin\psql.exe"
    Wait-PostgresReady $psql
    $httpReady = Install-PgsqlHttpExtension $pgRoot
    Wait-PostgresReady $psql
    Deploy-Database $psql $httpReady
    Write-ApiEnv
    Install-NpmDependencies

    Write-Step "Готово"
    Write-Host "Запуск: ярлык 'MultiLogic Trade' на рабочем столе или в меню Пуск." -ForegroundColor Green
}
finally {
    Stop-Transcript | Out-Null
}
