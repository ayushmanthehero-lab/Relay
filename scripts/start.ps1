param(
    [ValidateSet('demo','codex','api','ollama')][string]$Provider = 'demo',
    [int]$Port = 8091,
    [switch]$SkipDatabase,
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
}
if (-not $SkipInstall) {
    & ./.venv/Scripts/python.exe -m pip install -r requirements.txt --disable-pip-version-check
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
if (-not $SkipDatabase) {
    docker compose up -d falkordb
    if ($LASTEXITCODE -ne 0) { throw 'FalkorDB did not start. Start Docker Desktop and retry.' }
}
$env:MODEL_PROVIDER = $Provider
Write-Host "Relay / Track 02 / provider: $Provider / http://127.0.0.1:$Port"
& ./.venv/Scripts/python.exe -m uvicorn relay_app.main:app --host 127.0.0.1 --port $Port
