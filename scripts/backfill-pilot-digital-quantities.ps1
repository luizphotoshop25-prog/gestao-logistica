param(
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV",
  [string]$PilotRoot = "E:\GestaoLogistica_Server_Pilot"
)

$ErrorActionPreference = "Stop"
$port = 8787
$dataDirectory = Join-Path $PilotRoot "data"
$databasePath = Join-Path $dataDirectory "gestao-logistica.sqlite3"
$logsDirectory = Join-Path $PilotRoot "tools\logs"
$tunnelPidPath = Join-Path $PilotRoot "tools\pilot-cloudflared.pid"
$cloudflaredPath = Join-Path $PilotRoot "tools\cloudflared.exe"
$toolPath = Join-Path $ProjectRoot "tools\digital-history\backfill-quantities.cjs"
$apiEntry = Join-Path $ProjectRoot "server\lan-server.cjs"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$transcriptPath = Join-Path $ProjectRoot "work\digital-history\pilot-quantities-elevated.log"
Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
$apiStopped = $false
$apiStarted = $false
$apiProcess = $null
$tunnelUrl = ""

function Get-ApiListener { Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1 }
function Test-ApiHealth([string]$url) {
  try { $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 8; return $h.ok -eq $true -and $h.database -eq "available" } catch { return $false }
}
function Start-PilotApi {
  if (Test-ApiHealth "http://127.0.0.1:$port") { return }
  if (Get-ApiListener) { throw "Porta $port ocupada por processo inesperado; API não iniciada." }
  $env:GESTAO_SERVER_DATA = $dataDirectory
  $env:GESTAO_API_HOST = "127.0.0.1"
  $env:GESTAO_API_PORT = [string]$port
  $apiProcess = Start-Process -FilePath $node -ArgumentList @("server/lan-server.cjs") -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsDirectory "pilot-api.log") -RedirectStandardError (Join-Path $logsDirectory "pilot-api-error.log")
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-ApiHealth "http://127.0.0.1:$port") { $script:apiStarted = $true; return }
    if ($apiProcess.HasExited) { throw "A API terminou ao iniciar. Consulte pilot-api-error.log." }
  } while ((Get-Date) -lt $deadline)
  throw "A API não recuperou o health local."
}

if (-not (Test-Path -LiteralPath $databasePath) -or -not (Test-Path -LiteralPath $toolPath)) { throw "Banco piloto ou ferramenta não encontrados." }
$listener = Get-ApiListener
if (-not $listener -or -not (Test-ApiHealth "http://127.0.0.1:$port")) { throw "API piloto não está ativa e saudável antes da manutenção." }
$apiPid = [int]$listener.OwningProcess
$apiInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $apiPid" -ErrorAction Stop
$commandLine = [string]$apiInfo.CommandLine
if ($apiInfo.Name -ne "node.exe" -or [string]::IsNullOrWhiteSpace($commandLine) -or $commandLine -notmatch "(?i)lan-server\.cjs") { throw "Não foi possível provar que o listener é a API piloto; nenhuma ação executada." }

$tunnelPid = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $tunnelPidPath -Raw).Trim(), [ref]$tunnelPid)) { throw "PID do Quick Tunnel inválido." }
$tunnelInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $tunnelPid" -ErrorAction Stop
if (-not $tunnelInfo -or $tunnelInfo.ExecutablePath -ne $cloudflaredPath -or $tunnelInfo.CommandLine -notmatch "127\.0\.0\.1:$port") { throw "Quick Tunnel não corresponde à configuração registrada." }
$tunnelText = Get-Content (Join-Path $logsDirectory "cloudflared.stderr.log") -Tail 300 | Out-String
$tunnelMatch = [regex]::Match($tunnelText, "https://[a-z0-9-]+\.trycloudflare\.com", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
if (-not $tunnelMatch.Success) { throw "Não foi possível resolver o Quick Tunnel ativo pelo log local." }
$tunnelUrl = $tunnelMatch.Value
if (-not (Test-ApiHealth $tunnelUrl)) { throw "Health remoto pelo Quick Tunnel falhou no preflight." }
Write-Output "PRE-FLIGHT: API PID $apiPid identificada; Quick Tunnel PID $tunnelPid e acesso remoto saudáveis."

try {
  & $node -e "process.kill($apiPid,'SIGTERM')"
  if ($LASTEXITCODE -ne 0) { throw "Falha ao solicitar encerramento controlado da API." }
  $deadline = (Get-Date).AddSeconds(20)
  do { Start-Sleep -Milliseconds 250; $listener = Get-ApiListener } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "API não liberou a porta; nenhuma migração iniciada." }
  $apiStopped = $true

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDirectory = Join-Path $PilotRoot "backups"
  $backupPath = Join-Path $backupDirectory "gestao-logistica-before-digital-quantities-$stamp.sqlite3"
  $reportPath = Join-Path $ProjectRoot "work\digital-history\quantities-backfill-result.json"
  & $node $toolPath --db $databasePath --plan (Join-Path $ProjectRoot "work\digital-history\import-plan.json") --details (Join-Path $ProjectRoot "work\digital-history\details.json") --backup $backupPath | Tee-Object -FilePath $reportPath
  if ($LASTEXITCODE -ne 0) { throw "Backfill/migration interrompido (código $LASTEXITCODE); backup preservado em $backupPath." }
  Write-Output "Backfill validado. Backup: $backupPath"
} finally {
  if ($apiStopped) {
    Start-PilotApi
    if (-not (Test-ApiHealth "http://127.0.0.1:$port")) { throw "Health local falhou após reiniciar a API." }
    if (-not (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue)) { throw "Quick Tunnel deixou de estar ativo." }
    if (-not (Test-ApiHealth $tunnelUrl)) { throw "Health remoto falhou após reiniciar API; Quick Tunnel preservado." }
    Write-Output "API reiniciada; health local/remoto aprovado; Quick Tunnel mantido."
  }
  Remove-Item Env:GESTAO_SERVER_DATA -ErrorAction SilentlyContinue
  Remove-Item Env:GESTAO_API_HOST -ErrorAction SilentlyContinue
  Remove-Item Env:GESTAO_API_PORT -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
}
