# MultiLogic FINRESP calculator — local HTTP server (MOEX needs http://, not file://)
param(
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$Dir = $PSScriptRoot
Set-Location $Dir

$Html = "MultiLogic_FinrespCalculator.html"
if (-not (Test-Path $Html)) {
    Write-Error "Not found: $Html in $Dir"
}

$Url = "http://127.0.0.1:$Port/$Html"
Write-Host ""
Write-Host "MultiLogic FINRESP calculator"
Write-Host "  $Url"
Write-Host ""
Write-Host "MOEX works only over http:// (not file:// / Open with Browser)."
Write-Host "Press Ctrl+C to stop."
Write-Host ""

Start-Process $Url

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    & python -m http.server $Port --bind 127.0.0.1
    exit $LASTEXITCODE
}

Write-Host "Python not found. Install Python 3 or open GitHub Pages:"
Write-Host "https://robinzgit.github.io/OsEngine/multilogic/FinrespCalculator/MultiLogic_FinrespCalculator.html"
Read-Host "Press Enter to exit"
