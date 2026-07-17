#Requires -Version 5.1
<#
.SYNOPSIS
  Проверка SQL-скриптов перед сборкой/деплоем (обёртка над verify-sql.mjs).

.EXAMPLE
  $env:PGPASSWORD = '111'
  .\scripts\verify_sql_scripts.ps1
  .\scripts\verify_sql_scripts.ps1 -CoreOnly
#>
param(
    [switch] $CoreOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeArgs = @("$ProjectRoot\scripts\verify-sql.mjs")
if ($CoreOnly) { $nodeArgs += "--core-only" }

Write-Host "MultiLogicTrade — проверка SQL-скриптов" -ForegroundColor Green
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Готово." -ForegroundColor Green
