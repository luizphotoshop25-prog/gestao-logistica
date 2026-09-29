param(
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV",
  [string]$PilotRoot = "E:\GestaoLogistica_Server_Pilot"
)

$ErrorActionPreference = "Stop"
$transcriptPath = Join-Path $ProjectRoot "work\digital-history\pilot-import-elevated.log"
Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
$port = 8787
$dataDirectory = Join-Path $PilotRoot "data"
$databasePath = Join-Path $dataDirectory "gestao-logistica.sqlite3"
$toolsDirectory = Join-Path $PilotRoot "tools"
$logsDirectory = Join-Path $toolsDirectory "logs"
$tunnelPidPath = Join-Path $toolsDirectory "pilot-cloudflared.pid"
$cloudflaredPath = Join-Path $toolsDirectory "cloudflared.exe"
$planPath = Join-Path $ProjectRoot "work\digital-history\import-plan.json"
$listingPath = Join-Path $ProjectRoot "work\digital-history\listing.json"
$detailsPath = Join-Path $ProjectRoot "work\digital-history\details.json"
$importerPath = Join-Path $ProjectRoot "tools\digital-history\import-real.cjs"
$apiEntry = Join-Path $ProjectRoot "server\lan-server.cjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$apiStopped = $false
$committed = $false
$importSucceeded = $false
$apiStarted = $false
$apiProcess = $null

function Get-ApiListener {
  Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-ApiHealth([string]$url) {
  try {
    $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 8
    return $health.ok -eq $true -and $health.database -eq "available"
  } catch { return $false }
}

function Start-PilotApi {
  if (Test-ApiHealth "http://127.0.0.1:$port") { return }
  if (Get-ApiListener) { throw "A porta $port está ocupada por processo não confirmado como a API piloto." }
  $env:GESTAO_SERVER_DATA = $dataDirectory
  $env:GESTAO_API_HOST = "127.0.0.1"
  $env:GESTAO_API_PORT = [string]$port
  $apiLog = Join-Path $logsDirectory "pilot-api.log"
  $apiErrorLog = Join-Path $logsDirectory "pilot-api-error.log"
  $script:apiProcess = Start-Process -FilePath $node -ArgumentList @("server/lan-server.cjs") -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-ApiHealth "http://127.0.0.1:$port") { $script:apiStarted = $true; return }
    if ($script:apiProcess.HasExited) { throw "A API encerrou ao iniciar. Consulte $apiErrorLog" }
  } while ((Get-Date) -lt $deadline)
  throw "A API não ficou saudável em http://127.0.0.1:$port/health"
}

if (-not (Test-Path -LiteralPath $databasePath) -or -not (Test-Path -LiteralPath $importerPath)) { throw "Banco ou ferramenta não encontrados." }
if (-not (Test-Path -LiteralPath $logsDirectory)) { New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null }

$listener = Get-ApiListener
if (-not $listener) { throw "A API piloto não está ativa; estado inesperado antes da janela de manutenção." }
$apiPid = [int]$listener.OwningProcess
$apiInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $apiPid" -ErrorAction Stop
$apiCommandLine = [string]$apiInfo.CommandLine
$expectedApiPath = [regex]::Escape($apiEntry)
if (($apiInfo.Name -ne "node.exe") -or ([string]::IsNullOrWhiteSpace($apiCommandLine)) -or ($apiCommandLine -notmatch "(?i)$expectedApiPath")) {
  throw "Não foi possível provar que PID $apiPid é a API deste piloto. Nenhum processo será encerrado."
}
if (-not (Test-ApiHealth "http://127.0.0.1:$port")) { throw "A API não passou pelo health check antes da manutenção." }

$tunnelPid = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $tunnelPidPath -Raw).Trim(), [ref]$tunnelPid)) { throw "PID do Quick Tunnel inválido." }
$tunnelInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelPid" -ErrorAction Stop
if ((-not $tunnelInfo) -or ($tunnelInfo.ExecutablePath -ne $cloudflaredPath) -or ($tunnelInfo.CommandLine -notmatch "127\.0\.0\.1:$port")) {
  throw "Quick Tunnel não corresponde ao processo registrado; nenhum processo será encerrado."
}
$tunnelText = Get-Content (Join-Path $logsDirectory "cloudflared.stderr.log") -Tail 300 | Out-String
$tunnelMatch = [regex]::Match($tunnelText, "https://[a-z0-9-]+\.trycloudflare\.com", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $tunnelMatch.Success -or -not (Test-ApiHealth $tunnelMatch.Value)) { throw "Acesso remoto do Quick Tunnel não passou no preflight." }
$tunnelUrl = $tunnelMatch.Value

Write-Output "PRE-FLIGHT API: PID $apiPid confirmado em $apiEntry."
Write-Output "PRE-FLIGHT TUNNEL: PID $tunnelPid preservado; acesso remoto saudável."

try {
  # Node handles SIGTERM through lan-server.cjs and awaits api.close().
  & $node -e "process.kill($apiPid,'SIGTERM')"
  if ($LASTEXITCODE -ne 0) { throw "Não foi possível enviar encerramento controlado para a API." }
  $deadline = (Get-Date).AddSeconds(20)
  do { Start-Sleep -Milliseconds 250; $listener = Get-ApiListener } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "A API não liberou a porta; nenhum backup ou write foi iniciado." }
  $apiStopped = $true
  Write-Output "API parada; iniciando preflight final, backup consistente e transação."

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDirectory = Join-Path $PilotRoot "backups"
  $backupPath = Join-Path $backupDirectory "gestao-logistica-before-digital-history-$timestamp.sqlite3"
  & $node $importerPath --db $databasePath --plan $planPath --listing $listingPath --details $detailsPath --backup $backupPath --result-dir (Join-Path $ProjectRoot "work\digital-history")
  if ($LASTEXITCODE -ne 0) {
    $counts = & $node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT (SELECT count(*) FROM digital_envios) envios,(SELECT count(*) FROM digital_envio_itens) itens').get()));d.close()" $databasePath
    $state = $counts | ConvertFrom-Json
    $committed = ($state.envios -eq 172 -and $state.itens -eq 780)
    throw "Ferramenta de importação terminou com código $LASTEXITCODE (envios=$($state.envios), relações=$($state.itens))."
  }
  $committed = $true
  $importSucceeded = $true
  Write-Output "Importação, contagens, integridade, chaves estrangeiras e idempotência aprovadas."
} finally {
  if ($apiStopped -and (-not $committed -or $importSucceeded)) {
    Start-PilotApi
    if (-not (Test-ApiHealth "http://127.0.0.1:$port")) { throw "API não recuperou health local." }
    if (-not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { throw "Quick Tunnel não permaneceu ativo." }
    if (-not (Test-ApiHealth $tunnelUrl)) { throw "Acesso remoto via Quick Tunnel falhou após reiniciar a API." }
    Write-Output "API reiniciada e saudável; Quick Tunnel preservado e health remoto aprovado."
  }
  Remove-Item Env:GESTAO_SERVER_DATA -ErrorAction SilentlyContinue
  Remove-Item Env:GESTAO_API_HOST -ErrorAction SilentlyContinue
  Remove-Item Env:GESTAO_API_PORT -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
