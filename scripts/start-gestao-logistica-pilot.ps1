param(
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV",
  [string]$PilotTools = "E:\GestaoLogistica_Server_Pilot\tools",
  [switch]$ReuseExistingTunnel
)

$ErrorActionPreference = "Stop"
$owner = "luizphotoshop25-prog"
$repository = "gestao-logistica"
$branch = "master"
$dataDirectory = Join-Path (Split-Path -Parent $PilotTools) "data"
$cloudflaredPath = Join-Path $PilotTools "cloudflared.exe"
$logDirectory = Join-Path $PilotTools "logs"
$cloudflaredPidPath = Join-Path $PilotTools "pilot-cloudflared.pid"
$apiOrigin = "http://127.0.0.1:8787"
$publicConfigUrl = "https://raw.githubusercontent.com/$owner/$repository/$branch/remote-config.json"

function Test-Health([string]$url) {
  try {
    $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 8
    return $health.ok -eq $true -and $health.database -eq "available"
  } catch { return $false }
}

function Stop-PreviousPilotTunnel {
  if (-not (Test-Path -LiteralPath $cloudflaredPidPath)) { return }
  $previousPid = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $cloudflaredPidPath -Raw).Trim(), [ref]$previousPid)) {
    Remove-Item -LiteralPath $cloudflaredPidPath -Force
    return
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $previousPid" -ErrorAction SilentlyContinue
  if ($processInfo) {
    $sameBinary = [string]::Equals($processInfo.ExecutablePath, $cloudflaredPath, [StringComparison]::OrdinalIgnoreCase)
    $samePilotCommand = ([string]$processInfo.CommandLine).Contains("127.0.0.1:8787")
    if ($sameBinary -and $samePilotCommand) { Stop-Process -Id $previousPid -Force }
  }
  Remove-Item -LiteralPath $cloudflaredPidPath -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "server\lan-server.cjs"))) { throw "Projeto não encontrado: $ProjectRoot" }
if (-not (Test-Path -LiteralPath $dataDirectory)) { throw "Banco piloto não encontrado: $dataDirectory" }
if (-not (Test-Path -LiteralPath $cloudflaredPath)) { throw "cloudflared.exe não encontrado: $cloudflaredPath" }
& gh auth status --hostname github.com 2>$null
if ($LASTEXITCODE -ne 0) { throw "Autentique gh no PC servidor com uma conta autorizada para atualizar o repositório." }

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$opsLogDirectory = Join-Path (Split-Path -Parent $PilotTools) "logs\remote-tunnel"
New-Item -ItemType Directory -Path $opsLogDirectory -Force | Out-Null
$opsLog = Join-Path $opsLogDirectory "remote-tunnel.log"
function Write-PilotLog([string]$Event, [string]$Detail = "") {
  Get-ChildItem -LiteralPath $opsLogDirectory -File -Filter 'remote-tunnel*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $opsLog) -and (Get-Item -LiteralPath $opsLog).Length -gt 1MB) {
    for ($index = 3; $index -ge 1; $index--) {
      $source = if ($index -eq 1) { $opsLog } else { "$opsLog.$($index - 1)" }
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination "$opsLog.$index" -Force }
    }
  }
  $safeDetail = $Detail -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
  Add-Content -LiteralPath $opsLog -Value "$(Get-Date -Format o) event=$Event $safeDetail" -Encoding utf8
}
$apiLog = Join-Path $logDirectory "pilot-api.log"
$apiErrorLog = Join-Path $logDirectory "pilot-api-error.log"
$env:GESTAO_SERVER_DATA = (Resolve-Path -LiteralPath $dataDirectory).Path
$env:GESTAO_API_HOST = "127.0.0.1"
$env:GESTAO_API_PORT = "8787"

if (-not (Test-Health $apiOrigin)) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue
  if ($listener) { throw "A porta 8787 já está ocupada, mas não responde como a API deste piloto." }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $apiProcess = Start-Process -FilePath $node -ArgumentList @("server/lan-server.cjs") -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog
  $apiReady = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-Health $apiOrigin) { $apiReady = $true; break }
    if ($apiProcess.HasExited) { throw "API piloto encerrou ao iniciar. Consulte $apiErrorLog" }
    Start-Sleep -Milliseconds 500
  }
  if (-not $apiReady) { throw "API piloto não ficou pronta em http://127.0.0.1:8787/health" }
}

$cloudflaredOutput = Join-Path $logDirectory "cloudflared.stdout.log"
$cloudflaredErrors = Join-Path $logDirectory "cloudflared.stderr.log"
$ownsTunnel = $false
$remoteTunnelHealthy = $false
if ($ReuseExistingTunnel) {
  $existingPid = 0
  if (-not (Test-Path -LiteralPath $cloudflaredPidPath) -or -not [int]::TryParse((Get-Content -LiteralPath $cloudflaredPidPath -Raw).Trim(), [ref]$existingPid)) {
    throw "PID do Quick Tunnel existente não pôde ser confirmado para reutilização."
  }
  $existingInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
  if ((-not $existingInfo) -or
    (-not [string]::Equals($existingInfo.ExecutablePath, $cloudflaredPath, [StringComparison]::OrdinalIgnoreCase)) -or
    ([string]$existingInfo.CommandLine -notmatch 'tunnel\s+--url\s+http://127\.0\.0\.1:8787')) {
    throw "O PID registrado não corresponde ao Quick Tunnel do piloto."
  }
  $tunnel = Get-Process -Id $existingPid -ErrorAction Stop
} else {
  Stop-PreviousPilotTunnel
  foreach ($logPath in @($cloudflaredOutput, $cloudflaredErrors)) {
    if (Test-Path -LiteralPath $logPath) {
      if ((Get-Item -LiteralPath $logPath).Length -gt 2MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
      }
    }
  }
  Get-ChildItem -LiteralPath $logDirectory -File -Filter 'cloudflared.*.log.*' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $tunnel = Start-Process -FilePath $cloudflaredPath -ArgumentList @("tunnel", "--url", $apiOrigin, "--no-autoupdate") `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $cloudflaredOutput -RedirectStandardError $cloudflaredErrors
  Set-Content -LiteralPath $cloudflaredPidPath -Value $tunnel.Id -Encoding ascii
  $ownsTunnel = $true
  Write-PilotLog 'tunnel-started' "pid=$($tunnel.Id) target=$apiOrigin"
}

try {
  $tunnelUrl = $null
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($tunnel.HasExited) { throw "Quick Tunnel encerrou. Consulte os logs em $logDirectory" }
  $logText = ""
    foreach ($logPath in @($cloudflaredOutput, $cloudflaredErrors)) {
      if (Test-Path -LiteralPath $logPath) { $logText += Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue }
    }
    $match = [regex]::Match($logText, "https://[a-z0-9-]+\.trycloudflare\.com", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) { $tunnelUrl = $match.Value.TrimEnd([char]'.'); break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $tunnelUrl) { throw "Não foi possível obter a URL do Quick Tunnel. Consulte os logs em $logDirectory" }

  $remoteHealth = $false
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    if (Test-Health $tunnelUrl) { $remoteHealth = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $remoteHealth) { throw "O Quick Tunnel iniciou, mas $tunnelUrl/health não confirmou a API." }
  $remoteTunnelHealthy = $true

  $remoteConfig = @{ apiBaseUrl = $tunnelUrl; environment = "pilot"; enabled = $true } | ConvertTo-Json -Compress
  $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteConfig))
  $configPath = "repos/$owner/$repository/contents/remote-config.json"
  $metadataJson = & gh api --hostname github.com $configPath --jq '{sha:.sha,content:.content}'
  if ($LASTEXITCODE -ne 0 -or -not $metadataJson) { throw "Não foi possível ler remote-config.json via GitHub CLI." }
  $metadata = $metadataJson | ConvertFrom-Json
  if (-not $metadata.sha -or -not $metadata.content) { throw "Metadados do remote-config.json são inválidos." }
  $currentConfigText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($metadata.content -replace '\s', '')))
  $currentConfig = $currentConfigText | ConvertFrom-Json
  if ($currentConfig.apiBaseUrl -ne $tunnelUrl -or $currentConfig.enabled -ne $true -or $currentConfig.environment -ne "pilot") {
    & gh api --hostname github.com --method PUT $configPath -f "message=Refresh pilot Quick Tunnel URL" -f "content=$encodedConfig" -f "sha=$($metadata.sha.Trim())" -f "branch=$branch" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Não foi possível publicar a nova URL no remote-config.json." }
    Write-PilotLog 'remote-config-updated' "pid=$($tunnel.Id) url=$tunnelUrl"
  } else {
    Write-PilotLog 'remote-config-current' "pid=$($tunnel.Id) url=$tunnelUrl reused=$ReuseExistingTunnel"
  }

  $published = $false
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    try {
      $publicConfig = Invoke-RestMethod -Uri $publicConfigUrl -TimeoutSec 10 -Headers @{ "Cache-Control" = "no-cache" }
      if ($publicConfig.apiBaseUrl -eq $tunnelUrl -and $publicConfig.enabled -eq $true -and $publicConfig.environment -eq "pilot") { $published = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if (-not $published) { throw "A URL foi enviada, mas ainda não aparece no remote-config.json público: $publicConfigUrl" }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $env:GESTAO_PILOT_PROJECT_ROOT = $ProjectRoot
  $clientProbe = Join-Path ([IO.Path]::GetTempPath()) ("gestao-pilot-client-probe-{0}.cjs" -f [guid]::NewGuid().ToString('N'))
  $clientProbeSource = 'const path = require("node:path"); const { fetchRemoteConfig, checkRemoteApiHealth } = require(path.join(process.env.GESTAO_PILOT_PROJECT_ROOT, "electron", "remote-config.cjs")); (async () => { const config = await fetchRemoteConfig(); const health = await checkRemoteApiHealth(config.apiBaseUrl); process.exitCode = health.ok ? 0 : 1; })().catch(() => { process.exitCode = 1; });'
  [IO.File]::WriteAllText($clientProbe, $clientProbeSource, [Text.UTF8Encoding]::new($false))
  $clientReady = $false
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    & $node $clientProbe 2>&1 | Out-Null
    $probeExitCode = $LASTEXITCODE
    if ($probeExitCode -eq 0) { $clientReady = $true; break }
    if ($attempt -lt 11) { Start-Sleep -Seconds 5 }
  }
  Remove-Item -LiteralPath $clientProbe -Force -ErrorAction SilentlyContinue
  Write-Host "API piloto saudável em $apiOrigin"
  Write-Host "Quick Tunnel público: $tunnelUrl"
  if ($clientReady) {
    Write-Host "Configuração e saúde remotas confirmadas pelo mesmo caminho usado pelo aplicativo."
    Write-PilotLog 'client-probe-healthy' "pid=$($tunnel.Id) url=$tunnelUrl localHealth=200 remoteHealth=200"
  } else {
    Write-Warning "O GitHub ainda entrega a URL anterior a alguns clientes. O túnel permanece ativo; aguarde a expiração do cache e tente novamente."
    Write-PilotLog 'client-probe-pending' "pid=$($tunnel.Id) url=$tunnelUrl tunnelHealth=200"
  }
} catch {
  if ($ownsTunnel -and -not $remoteTunnelHealthy -and $tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  if ($ownsTunnel -and -not $remoteTunnelHealthy) { Remove-Item -LiteralPath $cloudflaredPidPath -Force -ErrorAction SilentlyContinue }
  $message = $_.Exception.Message -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
  Write-PilotLog 'launcher-failure' "message=$message"
  throw
}
