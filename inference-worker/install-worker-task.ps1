param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
$taskName = 'STEGASUS GPU Worker'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$wrapper = Join-Path $PSScriptRoot 'run-worker-service.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env'))) {
    throw 'Configure the private worker .env before installing the task.'
}
$shellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $wrapper + '"'
$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Write-Host "Installed '$taskName' for the current user's next sign-in. No job was started by installation."
if ($StartNow) {
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Worker started. It can now process slides you have queued.'
}
