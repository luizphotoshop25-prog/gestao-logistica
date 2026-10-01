$ErrorActionPreference = "Stop"

$watchScript = Join-Path $PSScriptRoot "watch-pilot-connectivity.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "GestaoLogisticaPilotConnectivity"
$opsDirectory = "E:\GestaoLogistica_Server_Pilot\logs\remote-tunnel"
$installLog = Join-Path $opsDirectory "startup-install.log"

if (-not (Test-Path -LiteralPath $watchScript)) { throw "Watchdog ausente: $watchScript" }
New-Item -Path $runKey -Force | Out-Null
New-Item -ItemType Directory -Path $opsDirectory -Force | Out-Null
$command = '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $powershell, $watchScript
New-ItemProperty -LiteralPath $runKey -Name $runName -Value $command -PropertyType String -Force | Out-Null
Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format o) event=logon-startup-registered user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)" -Encoding utf8

$started = Start-Process -FilePath $powershell -ArgumentList @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $watchScript
) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Add-Content -LiteralPath $installLog -Value "$(Get-Date -Format o) event=watchdog-launch-requested pid=$($started.Id)" -Encoding utf8

Write-Output "Inicialização do watchdog registrada para o próximo logon e iniciada em segundo plano."
