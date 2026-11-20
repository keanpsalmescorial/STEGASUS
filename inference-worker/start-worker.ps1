param(
    [ValidateSet('frozen','direct')][string]$Pipeline = 'frozen',
    [ValidateRange(1,256)][int]$BatchSize = 8,
    [string]$CacheDirectory = ''
)
$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'Create the private worker .env configuration first.'
}

$allowedNames = @('SUPABASE_URL', 'WORKER_TOKEN', 'WORKER_ID', 'STEGASUS_MODEL_RUN', 'WORKER_MAX_BYTES', 'WORKER_TMP')
foreach ($line in [IO.File]::ReadAllLines($configPath)) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }
    $parts = $line.Split('=', 2)
    if ($parts.Count -ne 2 -or $parts[0] -notin $allowedNames) {
        throw 'The worker configuration contains an unsupported setting.'
    }
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
}

$pythonPath = Join-Path $PSScriptRoot '../../../stegasus/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'The laboratory Python environment is missing.'
}
Write-Host 'Starting the frozen STEGASUS worker. Keep this terminal open. Use Ctrl+C to stop.'
$workerArguments = @((Join-Path $PSScriptRoot 'worker.py'),'--pipeline',$Pipeline,'--batch-size',$BatchSize)
if ($CacheDirectory) { $workerArguments += @('--cache-dir',$CacheDirectory) }
& $pythonPath @workerArguments
exit $LASTEXITCODE
