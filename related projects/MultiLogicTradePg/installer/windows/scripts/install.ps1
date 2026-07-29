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
    [string] $PostgresMajor = "15",
    [ValidateSet("wipe", "upgrade", "create")]
    [string] $DbMode = "wipe",
    [switch] $SkipDependencyInstall,
    [switch] $SkipAppProtocol
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InstallDir = (Resolve-Path $InstallDir).Path
$LogDir = Join-Path $env:ProgramData "MultiLogicTradePg"
$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "install-$RunStamp.log"
$LatestLogPath = Join-Path $LogDir "install-latest.log"
$ProtocolPath = Join-Path $InstallDir "INSTALL_PROTOCOL.txt"
$DbModeFile = Join-Path $InstallDir "installer\windows\db-mode.txt"
if ((-not $PSBoundParameters.ContainsKey("DbMode")) -and (Test-Path $DbModeFile)) {
    $fromFile = (Get-Content -LiteralPath $DbModeFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($fromFile) {
        $fromFile = $fromFile.Trim().ToLowerInvariant()
        if ($fromFile -in @("wipe", "upgrade", "create")) {
            $DbMode = $fromFile
        }
    }
}
$DbMode = $DbMode.Trim().ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path $LogPath | Out-Null
$script:PostgresHost = "localhost"
$script:PostgresPort = 5432

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

    function Write-Utf8NoBomText {
        param(
            [string] $Path,
            [string] $Text
        )
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, $Text, $encoding)
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
        Write-Step "Checking Node.js"
        Refresh-Path
        $major = Get-NodeMajor
        if ($major -ge 18) {
            Write-Host "    Node.js found: major $major" -ForegroundColor Green
            return
        }
        if ($SkipDependencyInstall) {
            throw "Node.js 18+ was not found and dependency installation is disabled."
        }

        Write-Host "    Node.js 18+ was not found. Installing Node.js LTS..." -ForegroundColor Yellow
        try {
            if (-not (Install-NodeWithWinget)) {
                Install-NodeFromMsi
            }
        }
        catch {
            Write-Warning "winget did not install Node.js: $($_.Exception.Message)"
            Install-NodeFromMsi
        }
        Refresh-Path

        $major = Get-NodeMajor
        if ($major -lt 18) {
            throw "Node.js installation failed or version is still below 18."
        }
        Write-Host "    Node.js installed: major $major" -ForegroundColor Green
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
                Write-Host "    Starting service $serviceName..." -ForegroundColor Yellow
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
        Write-Step "Checking PostgreSQL $PostgresMajor"
        Refresh-Path
        $root = Find-PostgresRoot
        if (-not $root) {
            if ($SkipDependencyInstall) {
                throw "PostgreSQL $PostgresMajor was not found and dependency installation is disabled."
            }
            Write-Host "    PostgreSQL $PostgresMajor was not found. Installing..." -ForegroundColor Yellow
            try {
                if (-not (Install-PostgresWithWinget)) {
                    Install-PostgresFromEnterpriseDb
                }
            }
            catch {
                Write-Warning "winget did not install PostgreSQL: $($_.Exception.Message)"
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
        Invoke-Native $Psql (@("-h", $script:PostgresHost, "-p", "$script:PostgresPort", "-U", "postgres", "-d", $Database) + $Arguments)
    }

    function Invoke-PsqlScalar {
        param(
            [string] $Psql,
            [string] $Database,
            [string] $Sql
        )
        $env:PGPASSWORD = $PostgresPassword
        $env:PGCLIENTENCODING = "UTF8"
        $previous = Get-Location
        try {
            Set-Location $InstallDir
            $output = & $Psql -h $script:PostgresHost -p $script:PostgresPort -U postgres -d $Database -t -A -v ON_ERROR_STOP=1 -c $Sql
            if ($LASTEXITCODE -ne 0) {
                throw "$Psql exited with code $LASTEXITCODE"
            }
            return (($output | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1).Trim())
        }
        finally {
            Set-Location $previous
        }
    }

    function Test-TcpPortOpen {
        param(
            [string] $HostName,
            [int] $Port,
            [int] $TimeoutMs = 400
        )
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect($HostName, $Port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
            if (-not $ok) {
                try { $client.Close() } catch { }
                return $false
            }
            $client.EndConnect($iar)
            $client.Close()
            return $true
        }
        catch {
            return $false
        }
    }

    function Invoke-PsqlScalarAtPort {
        param(
            [string] $Psql,
            [int] $Port,
            [string] $Database,
            [string] $Sql
        )
        # Prefer IPv4: "localhost" often resolves to ::1 first; closed ports then
        # emit NativeCommandError and abort the whole post-install under
        # $ErrorActionPreference=Stop (npm/Angular never run).
        if (-not (Test-TcpPortOpen -HostName "127.0.0.1" -Port $Port)) {
            return $null
        }

        $env:PGPASSWORD = $PostgresPassword
        $env:PGCLIENTENCODING = "UTF8"
        $previous = Get-Location
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            Set-Location $InstallDir
            $raw = & $Psql -h 127.0.0.1 -p $Port -U postgres -d $Database -t -A -v ON_ERROR_STOP=1 -c $Sql 2>&1
            if ($LASTEXITCODE -ne 0) {
                return $null
            }
            $line = @(
                $raw |
                    ForEach-Object {
                        if ($_ -is [System.Management.Automation.ErrorRecord]) {
                            $_.ToString()
                        }
                        else {
                            "$_"
                        }
                    } |
                    Where-Object { $_ -and $_.Trim() }
            ) | Select-Object -First 1
            if (-not $line) { return $null }
            return $line.Trim()
        }
        catch {
            return $null
        }
        finally {
            $ErrorActionPreference = $prevEap
            Set-Location $previous
        }
    }

    function Get-ExistingApiEnvPort {
        $envPath = Join-Path $InstallDir "api\.env"
        if (-not (Test-Path $envPath)) { return $null }
        $line = Get-Content -Path $envPath -Encoding UTF8 -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^\s*PGPORT\s*=' } |
            Select-Object -First 1
        if (-not $line) { return $null }
        $value = (($line -split '=', 2)[1]).Trim()
        $port = 0
        if ([int]::TryParse($value, [ref] $port) -and $port -gt 0) {
            return $port
        }
        return $null
    }

    function Get-PostgresPortCandidates {
        $ports = New-Object System.Collections.Generic.List[int]
        $candidates = @(5432)
        $existingPort = Get-ExistingApiEnvPort
        if ($existingPort) { $candidates += $existingPort }
        $candidates += 5433..5440

        foreach ($port in $candidates) {
            if ($port -and -not $ports.Contains([int]$port)) {
                $ports.Add([int]$port)
            }
        }
        return $ports.ToArray()
    }

    function Select-PostgresTarget {
        param([string] $Psql)
        Write-Step "Searching PostgreSQL target for multilogictrade"
        $readyPort = $null
        foreach ($port in (Get-PostgresPortCandidates)) {
            try {
                $serverOk = Invoke-PsqlScalarAtPort $Psql $port "postgres" "SELECT 1;"
            }
            catch {
                Write-Host "    localhost:$port - probe skipped ($($_.Exception.Message))" -ForegroundColor DarkGray
                continue
            }
            if ($serverOk -ne "1") {
                Write-Host "    localhost:$port - no postgres/111 connection" -ForegroundColor DarkGray
                continue
            }

            if (-not $readyPort) { $readyPort = $port }
            try {
                $dbExists = Invoke-PsqlScalarAtPort $Psql $port "postgres" "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';"
            }
            catch {
                $dbExists = $null
            }
            Write-Host "    localhost:$port - available, multilogictrade=$dbExists" -ForegroundColor DarkGray
            if ($dbExists -eq "1") {
                $script:PostgresPort = $port
                Write-Host ("    Existing multilogictrade found on localhost:{0} (DbMode={1}; wipe resets; upgrade/create keep data)." -f $port, $DbMode) -ForegroundColor Green
                return
            }
        }

        if ($readyPort) {
            $script:PostgresPort = $readyPort
            Write-Host "    Existing multilogictrade was not found. A new database will be created on localhost:$readyPort." -ForegroundColor Yellow
            return
        }

        throw "No local PostgreSQL server accepted user postgres with the supplied password."
    }

    function Wait-PostgresReady {
        param([string] $Psql)
        Write-Step "Waiting for PostgreSQL"
        for ($i = 1; $i -le 60; $i++) {
            try {
                Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;")
                Write-Host "    PostgreSQL is ready." -ForegroundColor Green
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
            Write-Host "    pgsql-http already installed." -ForegroundColor Green
            return $true
        }

        Write-Host "    Trying to install pgsql-http for HTTP price loading..." -ForegroundColor Yellow
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
            Write-Host "    pgsql-http installed." -ForegroundColor Green
            return $true
        }
        catch {
            Write-Warning "pgsql-http was not installed: $($_.Exception.Message)"
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

    function Convert-ToCrlfFile {
        param([string] $Path)
        $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        $text = $text -replace "`r`n|`r|`n", "`r`n"
        Write-Utf8NoBomText $Path $text
    }

    function Normalize-WindowsTextFiles {
        Write-Step "Preparing Windows scripts"
        $roots = @((Join-Path $InstallDir "web")) | Where-Object { Test-Path $_ }
        $extensions = @("*.bat", "*.cmd")
        $files = foreach ($root in $roots) {
            foreach ($extension in $extensions) {
                Get-ChildItem -Path $root -Filter $extension -File -Recurse -ErrorAction SilentlyContinue
            }
        }
        $files |
            Sort-Object -Property FullName -Unique |
            ForEach-Object { Convert-ToCrlfFile $_.FullName }
        Write-Host "    Windows launchers saved as CRLF / UTF-8 without BOM." -ForegroundColor Green
    }

    function Get-Sql02Path {
        param([bool] $HttpExtensionReady)
        $sql02 = Join-Path $InstallDir "02_multilogictrade_functions_and_procedures.sql"
        if (-not $HttpExtensionReady) {
            Write-Warning "HTTP block in 02 will be skipped because pgsql-http is unavailable. HTTP price loading may be unavailable until pgsql-http is installed."
            return (New-CoreSql02File)
        }
        return $sql02
    }

    function Invoke-SchemaScripts {
        param(
            [string] $Psql,
            [bool] $HttpExtensionReady,
            [bool] $DropRoutinesFirst
        )
        if ($DropRoutinesFirst) {
            $dropSql = Join-Path $InstallDir "sql\drop_public_routines.sql"
            if (-not (Test-Path $dropSql)) {
                throw ("Missing {0} (required before upgrade recreate of 02)." -f $dropSql)
            }
            Write-Step "Dropping public functions/procedures (data tables kept)"
            Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", $dropSql)
        }

        Write-Step "Deploying database 01 -> ensure_seed -> 02"
        $sql01 = Join-Path $InstallDir "01_multilogictrade_tables_and_data.sql"
        $sqlEnsure = Join-Path $InstallDir "sql\ensure_seed_logics.sql"
        $sql02 = Get-Sql02Path -HttpExtensionReady $HttpExtensionReady
        if (-not (Test-Path $sql01)) { throw "Missing $sql01" }
        if (-not (Test-Path $sqlEnsure)) { throw ("Missing {0} (required for install-on-top seed logics)." -f $sqlEnsure) }
        $v54 = Select-String -LiteralPath $sql01 -Pattern "v54:\s*install-on-top ensure" -Quiet
        if (-not $v54) {
            throw "Installed 01 is outdated (no v54 seed ensure). Use the latest MultiLogicTradePgSetup.exe from the OsEngine repo."
        }
        $err01 = $null
        try {
            Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", $sql01)
            Write-Step "Ensuring default seed logics (LinReg Fade Optimized, ...)"
            Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", $sqlEnsure)
            $optCount = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM logics WHERE name = 'LinReg Fade Optimized';"
            if ($optCount -ne "1") {
                throw ("Seed check failed: LinReg Fade Optimized count={0} (expected 1)." -f $optCount)
            }
            Write-Host "    Seed OK: LinReg Fade Optimized present." -ForegroundColor Green
        }
        catch {
            $err01 = $_
            Write-Warning "01/ensure_seed failed after drop_routines - still applying 02 to restore API routines."
        }
        try {
            Invoke-Psql $Psql "multilogictrade" @("-v", "ON_ERROR_STOP=1", "-f", $sql02)
        }
        catch {
            if ($null -ne $err01) {
                throw ("01/ensure failed: {0}; then 02 also failed: {1}" -f $err01.Exception.Message, $_.Exception.Message)
            }
            throw
        }
        if ($null -ne $err01) {
            throw ("01/ensure failed after 02 restored routines: {0}" -f $err01.Exception.Message)
        }
    }

    function Deploy-Database {
        param(
            [string] $Psql,
            [bool] $HttpExtensionReady,
            [string] $Mode
        )
        Write-Step "Database deploy mode: $Mode"
        Write-Host "    psql:     $Psql" -ForegroundColor DarkGray
        Write-Host "    host:     $script:PostgresHost" -ForegroundColor DarkGray
        Write-Host "    port:     $script:PostgresPort" -ForegroundColor DarkGray
        Write-Host "    database: multilogictrade" -ForegroundColor DarkGray
        Write-Host "    DbMode:   $Mode" -ForegroundColor DarkGray

        $existsBefore = Invoke-PsqlScalar $Psql "postgres" "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';"
        $logicsBefore = $null
        $pricesBefore = $null
        if ($existsBefore -eq "1") {
            try {
                $logicsBefore = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM logics;"
                $pricesBefore = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM prices;"
            }
            catch {
                Write-Host "    (counts before: logics/prices unavailable yet)" -ForegroundColor DarkGray
            }
        }
        Write-Host "    Before: db_exists=$existsBefore logics=$logicsBefore prices=$pricesBefore"

        if ($Mode -eq "wipe") {
            Write-Step "Resetting database by name (wipe)"
            Invoke-Psql $Psql "postgres" @(
                "-v", "ON_ERROR_STOP=1",
                "-c", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'multilogictrade' AND pid <> pg_backend_pid();"
            )
            Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE IF EXISTS multilogictrade WITH (FORCE);")
            $existsAfterDrop = Invoke-PsqlScalar $Psql "postgres" "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';"
            if ($existsAfterDrop -ne "0") {
                throw "Database multilogictrade still exists after DROP DATABASE. Reset did not complete."
            }
            Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE multilogictrade ENCODING 'UTF8' TEMPLATE template0;")
            $existsAfterCreate = Invoke-PsqlScalar $Psql "postgres" "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';"
            if ($existsAfterCreate -ne "1") {
                throw "Database multilogictrade was not created after reset."
            }
            Invoke-SchemaScripts -Psql $Psql -HttpExtensionReady $HttpExtensionReady -DropRoutinesFirst $false
            $logicCount = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM logics;"
            $priceCount = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM prices;"
            Write-Host "    Database wiped and recreated. logics=$logicCount prices=$priceCount" -ForegroundColor Green
            return
        }

        # upgrade | create - keep data; never DROP DATABASE
        Write-Step "Ensuring database exists (no DROP; preserve data)"
        if ($existsBefore -ne "1") {
            Invoke-Psql $Psql "postgres" @("-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE multilogictrade ENCODING 'UTF8' TEMPLATE template0;")
            $existsAfterCreate = Invoke-PsqlScalar $Psql "postgres" "SELECT COUNT(*) FROM pg_database WHERE datname = 'multilogictrade';"
            if ($existsAfterCreate -ne "1") {
                throw "Database multilogictrade was not created."
            }
            Write-Host "    Created empty multilogictrade." -ForegroundColor Green
            Invoke-SchemaScripts -Psql $Psql -HttpExtensionReady $HttpExtensionReady -DropRoutinesFirst $false
        }
        else {
            Write-Host "    Existing multilogictrade kept (upgrade in place)." -ForegroundColor Green
            Invoke-SchemaScripts -Psql $Psql -HttpExtensionReady $HttpExtensionReady -DropRoutinesFirst $true
        }

        $logicCount = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM logics;"
        $priceCount = Invoke-PsqlScalar $Psql "multilogictrade" "SELECT COUNT(*) FROM prices;"
        Write-Host "    After: logics=$logicCount prices=$priceCount (before logics=$logicsBefore prices=$pricesBefore)" -ForegroundColor Green
        if ($null -ne $pricesBefore -and $pricesBefore -ne "" -and [int]$priceCount -lt [int]$pricesBefore) {
            throw "Upgrade reduced prices row count ($pricesBefore -> $priceCount). Aborting - data loss unexpected."
        }
    }

    function Write-ApiEnv {
        Write-Step "Creating api\\.env"
        $content = @(
            "PGHOST=localhost",
            "PGPORT=$($script:PostgresPort)",
            "PGDATABASE=multilogictrade",
            "PGUSER=postgres",
            "PGPASSWORD=$PostgresPassword",
            "PORT=3000",
            "CORS_ORIGIN=http://localhost:4200",
            "TRADE_RUNNER_INTERVAL_MS=15000",
            "TRADE_RUNNER_REQUIRE_UI=0"
        ) -join [Environment]::NewLine
        Write-Utf8NoBomText -Path (Join-Path $InstallDir "api\.env") -Text $content
    }

    function Stop-AppListeners {
        Write-Step "Stopping MultiLogic listeners on ports 3000 and 4200"
        foreach ($port in @(3000, 4200)) {
            try {
                $pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty OwningProcess -Unique)
                foreach ($procId in $pids) {
                    Write-Host "    Stopping PID $procId (port $port)"
                    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    & taskkill.exe /F /T /PID $procId 2>$null | Out-Null
                }
            }
            catch {
            }
        }
        Start-Sleep -Seconds 1
    }

    function Remove-DirectoryForce {
        param([string] $Path)
        if (-not (Test-Path $Path)) { return }
        Write-Host "    Removing $Path"
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        }
        catch {
            # Retry after short wait (files may still be unlocking after taskkill).
            Start-Sleep -Seconds 2
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
        }
    }

    function Install-NpmDependencies {
        Write-Step "Installing npm dependencies"
        Refresh-Path
        $npm = Get-CommandPath "npm.cmd"
        if (-not $npm) { $npm = Get-CommandPath "npm" }
        if (-not $npm) { throw "npm was not found after Node.js installation." }

        # Install-over ("No" in setup dialog) leaves old node_modules; locked Angular
        # files often produce a half-broken web\node_modules without @angular/cli.
        Stop-AppListeners
        Remove-DirectoryForce (Join-Path $InstallDir "api\node_modules")
        Remove-DirectoryForce (Join-Path $InstallDir "web\node_modules")
        Remove-DirectoryForce (Join-Path $InstallDir "web\.angular")

        foreach ($dir in @("api", "web")) {
            $path = Join-Path $InstallDir $dir
            $args = if (Test-Path (Join-Path $path "package-lock.json")) {
                @("ci", "--no-audit", "--no-fund")
            }
            else {
                @("install", "--no-audit", "--no-fund")
            }
            Invoke-Native $npm $args $path
            if (-not (Test-Path (Join-Path $path "node_modules"))) {
                throw "npm completed for $dir, but node_modules was not created."
            }
        }

        $ngJs = Join-Path $InstallDir "web\node_modules\@angular\cli\bin\ng.js"
        if (-not (Test-Path $ngJs)) {
            throw "Angular CLI was not installed at web\node_modules\@angular\cli\bin\ng.js after npm ci."
        }
        Write-Host "    Angular CLI OK: $ngJs" -ForegroundColor Green
    }

    function Grant-RuntimeWriteAccess {
        # ng serve / Vite write .angular\cache under Program Files; default ACLs deny that for Users.
        # Grant on folders only (OI)(CI) so new .angular\cache inherits - avoid /T over node_modules.
        Write-Step "Granting Users modify rights for Angular runtime cache"
        $web = Join-Path $InstallDir "web"
        $api = Join-Path $InstallDir "api"
        $angularDir = Join-Path $web ".angular"
        $cache = Join-Path $angularDir "cache"

        foreach ($path in @($InstallDir, $web, $api)) {
            if (-not (Test-Path $path)) { continue }
            Write-Host "    icacls $path -> Users:(OI)(CI)M"
            & icacls.exe $path /grant "*S-1-5-32-545:(OI)(CI)M" /C /Q
            if ($LASTEXITCODE -ne 0) {
                throw "icacls failed for $path (exit $LASTEXITCODE). Angular cannot write cache under Program Files without this."
            }
        }

        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        & icacls.exe $angularDir /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q
        if ($LASTEXITCODE -ne 0) {
            throw "icacls failed for $angularDir (exit $LASTEXITCODE)."
        }
        Write-Host "    Write access OK (Users can create .angular cache)." -ForegroundColor Green
    }

    if (-not (Test-Admin)) {
        throw "Installer post-install script must run as Administrator."
    }

    Write-Host "MultiLogicTradePg installer post-install" -ForegroundColor Green
    $versionFile = Join-Path $InstallDir "VERSION.txt"
    if (Test-Path -LiteralPath $versionFile) {
        Get-Content -LiteralPath $versionFile | ForEach-Object { Write-Host $_ }
    }
    else {
        Write-Warning "VERSION.txt missing under InstallDir - this Setup.exe is outdated or incomplete."
    }
    Write-Host "InstallDir: $InstallDir"
    Write-Host "DbMode:     $DbMode"
    Write-Host "Log:        $LogPath"
    Write-Host "Protocol:   $ProtocolPath"

    Ensure-NodeJs
    $pgRoot = Ensure-PostgreSql
    $psql = Join-Path $pgRoot "bin\psql.exe"
    Select-PostgresTarget $psql
    Wait-PostgresReady $psql
    $httpReady = Install-PgsqlHttpExtension $pgRoot
    Wait-PostgresReady $psql
    Deploy-Database -Psql $psql -HttpExtensionReady $httpReady -Mode $DbMode
    Write-ApiEnv
    Normalize-WindowsTextFiles
    Install-NpmDependencies
    Grant-RuntimeWriteAccess

    Write-Step "Done"
    Write-Host "Launch: use the 'MultiLogic Trade' shortcut on Desktop or Start Menu." -ForegroundColor Green
}
finally {
    try {
        Stop-Transcript | Out-Null
    }
    catch {
    }

    try {
        if (Test-Path $LogPath) {
            Copy-Item $LogPath $LatestLogPath -Force
        }

        if ((-not $SkipAppProtocol) -and (Test-Path $LogPath)) {
            $summary = @(
                "MultiLogicTradePg installation protocol",
                "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
                "InstallDir: $InstallDir",
                "DbMode: $DbMode",
                "Transcript: $LogPath",
                "Latest transcript copy: $LatestLogPath",
                "PostgreSQL target: $($script:PostgresHost):$($script:PostgresPort) / multilogictrade / user postgres",
                "",
                "Attach this file when reporting installer problems.",
                "",
                "================ FULL TRANSCRIPT ================"
            ) -join [Environment]::NewLine
            Write-Utf8NoBomText -Path $ProtocolPath -Text $summary
            Get-Content -Path $LogPath -Encoding UTF8 -ErrorAction SilentlyContinue |
                Add-Content -Path $ProtocolPath -Encoding UTF8
        }
    }
    catch {
        Write-Warning "Could not write install protocol: $($_.Exception.Message)"
    }
}
