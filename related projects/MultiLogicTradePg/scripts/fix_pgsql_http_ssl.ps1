#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Копирует CA-bundle для libcurl (pgsql-http) в PostgreSQL 15.

.DESCRIPTION
  Устраняет ошибку HTTPS в PostgreSQL:
    SSL certificate problem: unable to get local issuer certificate

  Источники (по приоритету):
    1) _tmp_http_ext\pg15http_w64\ssl\certs\curl-ca-bundle.crt (из install_pgsql_http.ps1)
    2) curl.se/ca/cacert.pem (скачивается, если нет локального файла)

  После копирования в БД вызывается configure_http_ssl() (см. 02_*.sql).

.EXAMPLE
  PowerShell от администратора:
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

New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

if (Test-Path $LocalSrc) {
    Write-Host "Копирование из архива pgsql-http: $LocalSrc" -ForegroundColor Cyan
    Copy-Item $LocalSrc $Dest -Force
} else {
    Write-Host "Локальный bundle не найден, скачиваем cacert.pem с curl.se..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $CurlUrl -OutFile $Dest -UseBasicParsing
}

if (-not (Test-Path $Dest)) {
    Write-Error "Не удалось получить CA-bundle: $Dest"
}

$sizeKb = [math]::Round((Get-Item $Dest).Length / 1KB, 1)
Write-Host "OK: $Dest ($sizeKb KB)" -ForegroundColor Green

if (Get-Service postgresql-x64-15 -ErrorAction SilentlyContinue) {
    Write-Host "Перезапуск postgresql-x64-15..." -ForegroundColor Cyan
    Restart-Service postgresql-x64-15
}

Write-Host ""
Write-Host "Проверка в psql:" -ForegroundColor Cyan
Write-Host "  SELECT configure_http_ssl();" -ForegroundColor Gray
