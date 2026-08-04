#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Updates CA-bundle for libcurl (pgsql-http) in PostgreSQL 15:
  Mozilla cacert.pem + Russian Trusted CA (НУЦ Минцифры / Госуслуги).

.DESCRIPTION
  Fixes HTTPS errors from PostgreSQL / pgsql-http, e.g.:
    SSL certificate problem: unable to get local issuer certificate
    SSL certificate problem: self-signed certificate in certificate chain

  T-Bank Invest API requires Russian Trusted CA (support / developer.tbank.ru):
    https://www.gosuslugi.ru/crt
    https://www.tbank.ru/bank/help/certificates/
    Host: invest-public-api.tbank.ru:443

  Steps:
    1) Base bundle: local pgsql-http curl-ca-bundle or download curl.se/ca/cacert.pem
    2) Append russiantrustedca.pem (gu-st.ru) — Root + Sub CA Минцифры
    3) Optionally import .cer into Windows LocalMachine\Root (best-effort)
    4) Restart PostgreSQL 15

  After that in psql:
    SELECT configure_http_ssl();

.EXAMPLE
  PowerShell (Admin):
    .\scripts\fix_pgsql_http_ssl.ps1
    $env:PGPASSWORD = '111'
    psql -U postgres -d multilogictrade -c "SELECT configure_http_ssl();"
#>
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Pg = "C:\Program Files\PostgreSQL\15"
$CertDir = Join-Path $Pg "ssl\certs"
$Dest = Join-Path $CertDir "curl-ca-bundle.crt"
$LocalSrc = Join-Path $ProjectRoot "_tmp_http_ext\pg15http_w64\ssl\certs\curl-ca-bundle.crt"
$CurlUrl = "https://curl.se/ca/cacert.pem"
# Official Минцифры / Госуслуги pack (PEM) — same as https://www.gosuslugi.ru/crt
$RussianPemUrl = "https://gu-st.ru/content/Other/doc/russiantrustedca.pem"
$RussianRootCerUrl = "https://gu-st.ru/content/Other/doc/russian_trusted_root_ca.cer"
$RussianSubCerUrl = "https://gu-st.ru/content/Other/doc/russian_trusted_sub_ca.cer"
$TempDir = Join-Path $env:TEMP "multilogictrade-ssl-ca"

function Write-Info([string] $Msg) { Write-Host $Msg -ForegroundColor Cyan }
function Write-Ok([string] $Msg) { Write-Host $Msg -ForegroundColor Green }
function Write-Warn2([string] $Msg) { Write-Host $Msg -ForegroundColor Yellow }

New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

# --- 1) Mozilla / curl CA base ---
if (Test-Path $LocalSrc) {
    Write-Info "Base CA from pgsql-http archive: $LocalSrc"
    Copy-Item $LocalSrc $Dest -Force
} else {
    Write-Warn2 "Local bundle missing; downloading cacert.pem from curl.se..."
    Invoke-WebRequest -Uri $CurlUrl -OutFile $Dest -UseBasicParsing
}

if (-not (Test-Path $Dest)) {
    Write-Error "Failed to get base CA-bundle: $Dest"
}

# --- 2) Append Russian Trusted CA (НУЦ Минцифры) into curl bundle ---
$russianPem = Join-Path $TempDir "russiantrustedca.pem"
$appended = $false
try {
    Write-Info "Downloading Russian Trusted CA (Госуслуги / gu-st.ru)..."
    Invoke-WebRequest -Uri $RussianPemUrl -OutFile $russianPem -UseBasicParsing
    $ruText = Get-Content -LiteralPath $russianPem -Raw -ErrorAction Stop
    if ($ruText -notmatch "BEGIN CERTIFICATE") {
        throw "russiantrustedca.pem does not look like PEM"
    }
    $baseText = Get-Content -LiteralPath $Dest -Raw
    if ($baseText -match "Russian Trusted Root CA" -or $baseText -match "MinTsifry") {
        Write-Ok "Russian Trusted CA already present in bundle (skip append)."
    } else {
        $combined = $baseText.TrimEnd() + "`r`n`r`n# Russian Trusted CA (gosuslugi.ru/crt / gu-st.ru)`r`n" + $ruText.Trim() + "`r`n"
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($Dest, $combined, $utf8NoBom)
        Write-Ok "Appended russiantrustedca.pem into curl-ca-bundle.crt"
    }
    $appended = $true
} catch {
    Write-Warn2 "Could not download/append Russian PEM: $($_.Exception.Message)"
    Write-Warn2 "Install manually: https://www.gosuslugi.ru/crt or https://www.tbank.ru/bank/help/certificates/"
}

# --- 3) Best-effort: import .cer into Windows machine Root store (helps system tools) ---
function Import-CerBestEffort([string] $Url, [string] $FileName) {
    $path = Join-Path $TempDir $FileName
    try {
        Invoke-WebRequest -Uri $Url -OutFile $path -UseBasicParsing
        Import-Certificate -FilePath $path -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
        Write-Ok "Imported into LocalMachine\Root: $FileName"
    } catch {
        Write-Warn2 "Windows Root import skipped ($FileName): $($_.Exception.Message)"
    }
}

Import-CerBestEffort $RussianRootCerUrl "russian_trusted_root_ca.cer"
Import-CerBestEffort $RussianSubCerUrl "russian_trusted_sub_ca.cer"

$sizeKb = [math]::Round((Get-Item $Dest).Length / 1KB, 1)
Write-Ok "OK: $Dest ($sizeKb KB); russian_ca_appended=$appended"

if (Get-Service postgresql-x64-15 -ErrorAction SilentlyContinue) {
    Write-Info "Restarting postgresql-x64-15..."
    Restart-Service postgresql-x64-15
}

Write-Host ""
Write-Info "Next in psql:"
Write-Host "  SELECT configure_http_ssl();" -ForegroundColor Gray
Write-Host "  -- optional smoke (no token needed for TLS):" -ForegroundColor Gray
Write-Host "  SELECT status FROM http_get('https://invest-public-api.tbank.ru/');" -ForegroundColor Gray
Write-Host ""
Write-Host "T-Bank docs: https://developer.tbank.ru/invest/intro/developer/network" -ForegroundColor DarkGray
Write-Host "Certificates: https://www.gosuslugi.ru/crt" -ForegroundColor DarkGray
