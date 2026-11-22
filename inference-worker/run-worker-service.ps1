# Foreground wrapper for a user-controlled task. Never prints private .env values.
$ErrorActionPreference = 'Stop'
$logRoot = Join-Path $env:LOCALAPPDATA 'STEGASUS/worker-logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logFile = Join-Path $logRoot ("worker-{0}-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID)
Start-Transcript -LiteralPath $logFile -Append | Out-Null
try {
    & (Join-Path $PSScriptRoot 'start-worker.ps1') -Pipeline direct -BatchSize 8 -ReadWorkers 2
    exit $LASTEXITCODE
} finally {
    Stop-Transcript | Out-Null
}
