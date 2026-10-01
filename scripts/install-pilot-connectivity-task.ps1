$ErrorActionPreference = "Stop"

$taskName = "GestaoLogisticaPilotConnectivity"
$scriptPath = Join-Path $PSScriptRoot "watch-pilot-connectivity.ps1"
$startupScript = Join-Path $PSScriptRoot "install-pilot-connectivity-startup.ps1"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$opsDirectory = "E:\GestaoLogistica_Server_Pilot\logs\remote-tunnel"
$installLog = Join-Path $opsDirectory "task-install.log"
New-Item -ItemType Directory -Path $opsDirectory -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$identityPrincipal = [Security.Principal.WindowsPrincipal]::new($identity)
Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format o) event=install-start user=$($identity.Name) elevated=$($identityPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" -Encoding utf8

if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Supervisor não encontrado: $scriptPath" }
if (-not (Test-Path -LiteralPath $startupScript)) { throw "Inicializador de logon não encontrado: $startupScript" }
& $startupScript | Out-Null

$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn -User $userId)
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
  -Description "Mantém em segundo plano a API piloto e o Quick Tunnel, verificando a saúde a cada minuto."

try {
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null
  Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  & schtasks.exe /Change /TN $taskName /ENABLE | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "O Agendador não confirmou a ativação da tarefa $taskName." }
  $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $triggerTypes = @($registered.Triggers | ForEach-Object { $_.CimClass.CimClassName })
  if (($registered.Actions.Execute -ne $powershell) -or
    ($registered.Actions.Arguments -notlike "*watch-pilot-connectivity.ps1*") -or
    ($triggerTypes -notcontains 'MSFT_TaskBootTrigger') -or ($triggerTypes -notcontains 'MSFT_TaskLogonTrigger') -or
    ($registered.Settings.Enabled -ne $true) -or
    ($registered.Settings.MultipleInstances -ne 'IgnoreNew') -or ($registered.Settings.ExecutionTimeLimit -ne 'PT0S')) {
    throw "A tarefa foi registrada, mas não correspondeu à configuração de boot, logon, watchdog persistente e instância única esperada."
  }
} catch {
  $message = $_.Exception.Message -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
  Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format o) event=install-failed message=$message" -Encoding utf8
  throw
}
Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format o) event=install-succeeded task=$taskName user=$userId" -Encoding utf8
Write-Output "Tarefa $taskName atualizada para iniciar no boot/logon e manter o watchdog oculto ativo, verificando a cada minuto."
