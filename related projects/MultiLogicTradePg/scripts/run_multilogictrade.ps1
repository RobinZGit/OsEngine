#Requires -Version 5.1
<#
.SYNOPSIS
  Выполнение SQL-скриптов MultiLogicTrade на локальном PostgreSQL 15.

.DESCRIPTION
  Последовательность развёртывания (см. также комментарии в SQL-файлах):

    Шаг 0  00_create_database.sql              БД postgres
    Шаг 1  01_multilogictrade_tables_and_data.sql   multilogictrade (расширения не нужны)
    Шаг 2a install_pgsql_http.ps1              один раз, от администратора (перед HTTP-блоком)
    Шаг 2b 02_multilogictrade_functions_and_procedures.sql
    Шаг 3  03_multilogictrade_examples.sql     необязательно (-IncludeExamples)

  Если шаг 2 упал на CREATE EXTENSION http — установите pgsql-http (шаг 2a)
  и повторите:  .\scripts\run_multilogictrade.ps1 -Steps 2

  Правило проекта: после изменений схемы править CREATE TABLE в 01/02 и прогонять
  этот скрипт (обычно шаги 0,1,2). См. .cursor/rules/database-scripts.mdc

.EXAMPLE
  $env:PGPASSWORD = '<пароль postgres>'
  .\scripts\run_multilogictrade.ps1
  .\scripts\run_multilogictrade.ps1 -Steps 0,1,2
  .\scripts\run_multilogictrade.ps1 -IncludeExamples
#>
param(
    [int[]] $Steps = @(0, 1, 2),
    [switch] $IncludeExamples,
    [string] $PgBin = "C:\Program Files\PostgreSQL\15\bin",
    [string] $User = "postgres",
    [string] $HostName = "localhost",
    [int] $Port = 5432
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) {
    Write-Error "psql не найден: $psql`nУкажите -PgBin или установите PostgreSQL 15."
}

$env:PGCLIENTENCODING = "UTF8"

function Invoke-PsqlFile {
    param(
        [string] $Database,
        [string] $FilePath
    )
    if (-not (Test-Path $FilePath)) {
        Write-Error "Файл не найден: $FilePath"
    }
    Write-Host ""
    Write-Host "==> $Database : $(Split-Path $FilePath -Leaf)" -ForegroundColor Cyan
    & $psql -h $HostName -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -f $FilePath
    if ($LASTEXITCODE -ne 0) {
        throw "psql завершился с кодом $LASTEXITCODE для $FilePath"
    }
}

Write-Host "MultiLogicTrade — запуск SQL" -ForegroundColor Green
Write-Host "Проект: $ProjectRoot"
Write-Host "PostgreSQL: $psql"
Write-Host "Шаги: $($Steps -join ', ')"
Write-Host ""
if (-not $env:PGPASSWORD) {
    Write-Host "Пароль пользователя '$User' (Enter, если есть pgpass.conf):" -ForegroundColor Yellow
}

$files = @{
    0 = @{ Db = "postgres";         File = "00_create_database.sql" }
    1 = @{ Db = "multilogictrade";  File = "01_multilogictrade_tables_and_data.sql" }
    2 = @{ Db = "multilogictrade";  File = "02_multilogictrade_functions_and_procedures.sql" }
    3 = @{ Db = "multilogictrade";  File = "03_multilogictrade_examples.sql" }
}

if ($IncludeExamples -and ($Steps -notcontains 3)) {
    $Steps += 3
}

foreach ($step in $Steps | Sort-Object) {
    if (-not $files.ContainsKey($step)) {
        Write-Warning "Неизвестный шаг: $step (доступны 0,1,2,3)"
        continue
    }
    $info = $files[$step]
    $path = Join-Path $ProjectRoot $info.File
    Invoke-PsqlFile -Database $info.Db -FilePath $path
}

Write-Host ""
Write-Host "Готово." -ForegroundColor Green
