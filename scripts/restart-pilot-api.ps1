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
  throw "Banco piloto nao encontrado em $pilotData. Nenhuma alteracao foi feita."
}

$tunnelPidFile = Join-Path $pilotTools "pilot-cloudflared.pid"
$tunnelPid = if (Test-Path -LiteralPath $tunnelPidFile) { [int](Get-Content -LiteralPath $tunnelPidFile -Raw).Trim() } else { 0 }
if ($tunnelPid -le 0 -or -not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) {
  throw "O PID do Quick Tunnel registrado ($tunnelPid) nao esta ativo. Inicie o tunnel antes; o script nao o altera."
}

$apiEntry = Join-Path $projectRoot "server\lan-server.cjs"
if (-not (Test-Path -LiteralPath $apiEntry)) { throw "Arquivo da API nao encontrado: $apiEntry" }

function Get-PilotApiListener {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Assert-PilotApiProcess([int]$processId) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
  if (-not $processInfo -or $processInfo.Name -ne "node.exe") {
    throw "A porta $port pertence a um processo que nao e node.exe. Nenhum processo foi encerrado; o banco nao foi migrado."
  }

  $commandLine = [string]$processInfo.CommandLine
  $rootPattern = [regex]::Escape($projectRoot)
  $entryPattern = '(?:^|[\\/\s"''])server[\\/]lan-server\.cjs(?:["'']|$|\s)'
  $absoluteEntry = [regex]::Match($commandLine, '(?i)[A-Z]:[\\/][^"'']*[\\/]server[\\/]lan-server\.cjs')
  $wrongAbsoluteRoot = $absoluteEntry.Success -and $absoluteEntry.Value -notmatch $rootPattern
  if ([string]::IsNullOrWhiteSpace($commandLine) -or $commandLine -notmatch $entryPattern -or $wrongAbsoluteRoot) {
    throw "Nao foi possivel confirmar com seguranca que o PID $processId e a API de $projectRoot\server\lan-server.cjs. Nenhum processo foi encerrado; o banco nao foi migrado."
  }
  return $processInfo
}

Write-Output "[1/6] Verificando a API e o Quick Tunnel."
$listener = Get-PilotApiListener
if ($listener) {
  $oldApiPid = [int]$listener.OwningProcess
  $null = Assert-PilotApiProcess $oldApiPid
  Write-Output "[1/6] API encontrada na porta $port - PID $oldApiPid."
  $currentListener = Get-PilotApiListener
  if (-not $currentListener -or [int]$currentListener.OwningProcess -ne $oldApiPid) {
    throw "O listener da porta $port mudou durante a verificacao. Nenhum processo foi encerrado; o banco nao foi migrado."
  }
  $null = Assert-PilotApiProcess $oldApiPid
  Stop-Process -Id $oldApiPid -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $listener = Get-PilotApiListener
  } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "A API nao liberou a porta $port. O banco nao foi migrado." }
  Write-Output "[2/6] API encerrada e porta $port liberada."
} else {
  Write-Output "[1/6] API ja estava parada; porta $port livre."
}

$oldData = $env:GESTAO_SERVER_DATA
$oldHost = $env:GESTAO_API_HOST
$oldPort = $env:GESTAO_API_PORT
try {
  $env:GESTAO_SERVER_DATA = $pilotData
  Push-Location $projectRoot
  try {
    & (Get-Command npm).Source run pilot:migrate-treatment-assignment
    if ($LASTEXITCODE -ne 0) { throw "Migracao falhou com codigo $LASTEXITCODE." }
    & (Get-Command npm).Source run pilot:reconcile-treatment-selection
    if ($LASTEXITCODE -ne 0) { throw "Reconciliação da elegibilidade falhou com codigo $LASTEXITCODE." }
  }
  finally { Pop-Location }
  Write-Output "[3/6] Backup, migração e reconciliação de elegibilidade concluídos."

  $env:GESTAO_API_HOST = "127.0.0.1"
  $env:GESTAO_API_PORT = [string]$port
  $stdout = Join-Path $pilotTools "pilot-api.stdout.log"
  $stderr = Join-Path $pilotTools "pilot-api.stderr.log"
  $node = (Get-Command node).Source
  $api = Start-Process -FilePath $node -ArgumentList ('"' + $apiEntry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-Output "[4/6] API iniciada - PID $($api.Id)."
  $healthUrl = "http://127.0.0.1:$port/health"
  $deadline = (Get-Date).AddSeconds(30)
  $healthy = $false
  do {
    Start-Sleep -Milliseconds 500
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; $healthy = [bool]$health.ok } catch {}
  } while (-not $healthy -and (Get-Date) -lt $deadline -and -not $api.HasExited)
  if (-not $healthy) { throw "Nova API nao ficou saudavel. Consulte $stderr; o banco tem backup preventivo em $pilotData\backups." }
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/orders?scope=mine" -TimeoutSec 3 -UseBasicParsing | Out-Null
    throw "A rota protegida aceitou uma requisicao sem sessao."
  } catch {
    if ([int]$_.Exception.Response.StatusCode -ne 401) { throw }
  }
  Write-Output "[5/6] Health check aprovado; endpoint protegido exige sessao (HTTP 401)."
  if (-not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { throw "O processo Quick Tunnel $tunnelPid foi alterado inesperadamente." }
  Write-Output "[6/6] Quick Tunnel preservado (PID $tunnelPid)."
  Write-Output "API reiniciada e saudavel em 127.0.0.1:$port."
} finally {
  if ($null -eq $oldData) { Remove-Item Env:GESTAO_SERVER_DATA -ErrorAction SilentlyContinue } else { $env:GESTAO_SERVER_DATA = $oldData }
  if ($null -eq $oldHost) { Remove-Item Env:GESTAO_API_HOST -ErrorAction SilentlyContinue } else { $env:GESTAO_API_HOST = $oldHost }
  if ($null -eq $oldPort) { Remove-Item Env:GESTAO_API_PORT -ErrorAction SilentlyContinue } else { $env:GESTAO_API_PORT = $oldPort }
}
