<#
    Start the Margin MCP server (stdio transport).

    This is what Claude Code / Claude Desktop launches. It talks MCP over
    stdin/stdout, so NOTHING may be written to stdout here -- all diagnostics go
    to stderr (Write-Host writes to the host, not the pipeline, which is safe).

    The Margin FastAPI backend must be running separately:
        backend\run.ps1          -> http://127.0.0.1:8765

    Usage:
        .\run-mcp.ps1                          # backend on 127.0.0.1:8765
        .\run-mcp.ps1 -Api http://127.0.0.1:9000
#>

[CmdletBinding()]
param(
    # Base URL of the Margin REST API; exported as MARGIN_API.
    [string]$Api = $env:MARGIN_API,
    # DEBUG / INFO / WARNING / ERROR, exported as MARGIN_MCP_LOG.
    [string]$LogLevel = 'INFO'
)

$ErrorActionPreference = 'Stop'

# backend\mcp\run-mcp.ps1 -> backend\
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Split-Path -Parent $here

$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    throw "Virtualenv interpreter not found at $python. Create backend\.venv first."
}

if ($Api) { $env:MARGIN_API = $Api }
$env:MARGIN_MCP_LOG = $LogLevel
$env:PYTHONUNBUFFERED = '1'

# Run from the backend folder so `hnrad` is importable.
Set-Location $backend

$target = if ($env:MARGIN_API) { $env:MARGIN_API } else { 'http://127.0.0.1:8765' }
[Console]::Error.WriteLine("Margin MCP server (stdio) -> backend $target")

& $python -m hnrad.mcp_server
exit $LASTEXITCODE
