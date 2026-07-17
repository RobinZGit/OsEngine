#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Установка расширения pgsql-http (http) для PostgreSQL 15 на Windows.

.DESCRIPTION
  Часть развёртывания MultiLogicTrade. Выполнять ОДИН РАЗ на машине,
  ПЕРЕД HTTP-блоком в 02_multilogictrade_functions_and_procedures.sql
  (или перед повторным запуском шага 2, если CREATE EXTENSION http упал).

  Полная последовательность — в комментариях:
    00_create_database.sql
    01_multilogictrade_tables_and_data.sql
    02_multilogictrade_functions_and_procedures.sql  (заголовок + блок HTTP-ЗАГРУЗКА)

  Этот скрипт:
    1) копирует http.dll и SQL-файлы расширения в каталог PostgreSQL 15
    2) копирует зависимости libcurl в bin\
    3) копирует SSL-сертификаты для HTTPS
    4) перезапускает службу postgresql-x64-15

  После скрипта в базе multilogictrade:
    CREATE EXTENSION IF NOT EXISTS http;
  (выполняется автоматически при запуске 02, или вручную в pgAdmin)

.PREREQUISITE
  1. Скачать архив (PostgreSQL 15, Windows x64):
       https://www.postgresonline.com/downloads/pg15http_w64.zip
  2. Распаковать в каталог проекта:
       _tmp_http_ext\pg15http_w64\
     Ожидаемая структура:
       _tmp_http_ext\pg15http_w64\lib\http.dll
       _tmp_http_ext\pg15http_w64\share\extension\http.control
       _tmp_http_ext\pg15http_w64\bin\libcurl-4.dll  (и др.)
       _tmp_http_ext\pg15http_w64\ssl\certs\curl-ca-bundle.crt

.EXAMPLE
  PowerShell от администратора, из корня репозитория:
    .\scripts\install_pgsql_http.ps1

  Затем:
    $env:PGPASSWORD = '<пароль postgres>'
    .\scripts\run_multilogictrade.ps1 -Steps 2
#>
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Src = Join-Path $ProjectRoot "_tmp_http_ext\pg15http_w64"
$Pg = "C:\Program Files\PostgreSQL\15"

if (-not (Test-Path (Join-Path $Src "lib\http.dll"))) {
    Write-Error @"
Не найден: $Src\lib\http.dll

Скачайте pg15http_w64.zip и распакуйте:
  https://www.postgresonline.com/downloads/pg15http_w64.zip
  -> $Src
"@
}

Write-Host "Источник:  $Src" -ForegroundColor Gray
Write-Host "PostgreSQL: $Pg" -ForegroundColor Gray
Write-Host ""
Write-Host "Копирование http.dll и SQL-скриптов расширения..." -ForegroundColor Cyan
Copy-Item "$Src\lib\http.dll" "$Pg\lib\" -Force
Copy-Item "$Src\share\extension\http*" "$Pg\share\extension\" -Force
Copy-Item "$Src\bin\*.dll" "$Pg\bin\" -Force

$certDir = "$Pg\ssl\certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
Copy-Item "$Src\ssl\certs\*" $certDir -Force

Write-Host "Перезапуск службы postgresql-x64-15..." -ForegroundColor Cyan
Restart-Service postgresql-x64-15

Write-Host ""
Write-Host "Проверка файлов:" -ForegroundColor Cyan
@(
    "$Pg\lib\http.dll",
    "$Pg\share\extension\http.control"
) | ForEach-Object {
    $ok = Test-Path $_
    Write-Host ("  [{0}] {1}" -f $(if ($ok) { 'OK' } else { '!!' }), $_)
}

Write-Host ""
Write-Host "Готово. Следующий шаг:" -ForegroundColor Green
Write-Host "  .\scripts\run_multilogictrade.ps1 -Steps 2"
Write-Host ""
Write-Host "Или в pgAdmin (база multilogictrade):" -ForegroundColor Green
Write-Host "  CREATE EXTENSION IF NOT EXISTS http;"
Write-Host "  SELECT status FROM http_get('https://httpbin.org/get');"
