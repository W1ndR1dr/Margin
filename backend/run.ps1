<#
    Start the HNRad backend on 127.0.0.1:8765 with auto-reload.

    Usage:   .\run.ps1            # from anywhere; the script cd's to its own folder
    Stop:    Ctrl+C
#>

[CmdletBinding()]
param(
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 8765,
    [switch]$NoReload
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$python = Join-Path $here '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Virtualenv interpreter not found at $python"
}

$uvicornArgs = @(
    '-m', 'uvicorn', 'hnrad.app:app',
    '--host', $BindHost,
    '--port', $Port
)
if (-not $NoReload) { $uvicornArgs += '--reload' }

Write-Host "HNRad backend -> http://$BindHost`:$Port/api/health" -ForegroundColor Cyan
& $python @uvicornArgs
