$ErrorActionPreference = "Stop"

$projectRoot = "E:\GestaoLogistica_DEV"
$pilotData = "E:\GestaoLogistica_Server_Pilot\data"
$pilotTools = "E:\GestaoLogistica_Server_Pilot\tools"
$port = 8787

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Abra o PowerShell como Administrador e execute novamente: $PSCommandPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $pilotData "gestao-logistica.sqlite3"))) {
  throw "Banco piloto não encontrado em $pilotData. Nenhuma alteração foi feita."
}

$tunnelPidFile = Join-Path $pilotTools "pilot-cloudflared.pid"
$tunnelPid = if (Test-Path -LiteralPath $tunnelPidFile) { [int](Get-Content -LiteralPath $tunnelPidFile -Raw).Trim() } else { 0 }
if ($tunnelPid -gt 0 -and -not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) {
  throw "O PID do Quick Tunnel registrado ($tunnelPid) não está ativo. Inicie o tunnel antes; o script não o altera."
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $apiProcess = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if ($apiProcess.ProcessName -ne "node") { throw "A porta $port pertence a $($apiProcess.ProcessName), não ao servidor Node. Nenhuma alteração foi feita." }
  $env:GESTAO_API_PID = [string]$listener.OwningProcess
  try { & (Get-Command node).Source -e 'process.kill(Number(process.env.GESTAO_API_PID), "SIGTERM")' }
  finally { Remove-Item Env:GESTAO_API_PID -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "A API não liberou a porta $port após SIGTERM. O banco não foi migrado." }
}

$oldData = $env:GESTAO_SERVER_DATA
$oldHost = $env:GESTAO_API_HOST
$oldPort = $env:GESTAO_API_PORT
try {
  $env:GESTAO_SERVER_DATA = $pilotData
  Push-Location $projectRoot
  try { & (Get-Command npm).Source run pilot:migrate-treatment-assignment; if ($LASTEXITCODE -ne 0) { throw "Migração falhou com código $LASTEXITCODE." } }
  finally { Pop-Location }

  $env:GESTAO_API_HOST = "127.0.0.1"
  $env:GESTAO_API_PORT = [string]$port
  $stdout = Join-Path $pilotTools "pilot-api.stdout.log"
  $stderr = Join-Path $pilotTools "pilot-api.stderr.log"
  $node = (Get-Command node).Source
  $api = Start-Process -FilePath $node -ArgumentList 'server/lan-server.cjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $healthUrl = "http://127.0.0.1:$port/health"
  $deadline = (Get-Date).AddSeconds(30)
  $healthy = $false
  do {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; $healthy = [bool]$health.ok } catch {}
  } while (-not $healthy -and (Get-Date) -lt $deadline -and -not $api.HasExited)
  if (-not $healthy) { throw "Nova API não ficou saudável. Consulte $stderr; o banco tem backup preventivo em $pilotData\backups." }
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/orders?scope=mine" -TimeoutSec 3 -UseBasicParsing | Out-Null
    throw "A rota protegida aceitou uma requisição sem sessão."
  } catch {
    if ([int]$_.Exception.Response.StatusCode -ne 401) { throw }
  }
  if ($tunnelPid -gt 0 -and -not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { throw "O processo Quick Tunnel $tunnelPid foi alterado inesperadamente." }
  Write-Output "API reiniciada e saudável em 127.0.0.1:$port; endpoint protegido exige sessão. Quick Tunnel preservado (PID $tunnelPid)."
} finally {
  if ($null -eq $oldData) { Remove-Item Env:GESTAO_SERVER_DATA -ErrorAction SilentlyContinue } else { $env:GESTAO_SERVER_DATA = $oldData }
  if ($null -eq $oldHost) { Remove-Item Env:GESTAO_API_HOST -ErrorAction SilentlyContinue } else { $env:GESTAO_API_HOST = $oldHost }
  if ($null -eq $oldPort) { Remove-Item Env:GESTAO_API_PORT -ErrorAction SilentlyContinue } else { $env:GESTAO_API_PORT = $oldPort }
}
