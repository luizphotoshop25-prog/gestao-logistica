param(
  [string]$PilotTools = "E:\GestaoLogistica_Server_Pilot\tools",
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV"
)

$ErrorActionPreference = "Stop"
$mutex = [System.Threading.Mutex]::new($false, "Local\GestaoLogisticaPilotConnectivity")
if (-not $mutex.WaitOne(0)) { exit 0 }

$pilotRoot = Split-Path -Parent $PilotTools
$opsDirectory = Join-Path $pilotRoot "logs\remote-tunnel"
$opsLog = Join-Path $opsDirectory "remote-tunnel.log"
$stateFile = Join-Path $opsDirectory "remote-health-state.json"
$pidPath = Join-Path $PilotTools "pilot-cloudflared.pid"
$tunnelLog = Join-Path $PilotTools "logs\cloudflared.stderr.log"
$cloudflaredPath = Join-Path $PilotTools "cloudflared.exe"
$launcher = Join-Path $PilotTools "start-gestao-logistica-pilot.ps1"
$apiOrigin = "http://127.0.0.1:8787"
$publicConfigUrl = "https://raw.githubusercontent.com/luizphotoshop25-prog/gestao-logistica/master/remote-config.json"

function Write-OperationalLog([string]$Event, [string]$Detail = "") {
  New-Item -ItemType Directory -Path $opsDirectory -Force | Out-Null
  Get-ChildItem -LiteralPath $opsDirectory -File -Filter 'remote-tunnel*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force -ErrorAction SilentlyContinue
  if ((Test-Path -LiteralPath $opsLog) -and (Get-Item -LiteralPath $opsLog).Length -gt 1MB) {
    for ($index = 3; $index -ge 1; $index--) {
      $source = if ($index -eq 1) { $opsLog } else { "$opsLog.$($index - 1)" }
      $target = "$opsLog.$index"
      if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $target -Force }
    }
  }
  $safeDetail = $Detail -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
  Add-Content -LiteralPath $opsLog -Value "$(Get-Date -Format o) event=$Event $safeDetail" -Encoding utf8
}

function Test-PilotHealth([string]$Url) {
  try {
    $result = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 6
    return $result.ok -eq $true -and $result.database -eq "available"
  } catch { return $false }
}

function Get-PilotTunnelProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      [string]::Equals($_.ExecutablePath, $cloudflaredPath, [StringComparison]::OrdinalIgnoreCase) -and
      [string]$_.CommandLine -match 'tunnel\s+--url\s+http://127\.0\.0\.1:8787'
    })
}

function Get-CurrentTunnelUrl {
  if (-not (Test-Path -LiteralPath $tunnelLog)) { return $null }
  $tail = Get-Content -LiteralPath $tunnelLog -Tail 500 -ErrorAction SilentlyContinue | Out-String
  $matches = [regex]::Matches($tail, 'https://[a-z0-9-]+\.trycloudflare\.com', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($matches.Count) { return $matches[$matches.Count - 1].Value }
  return $null
}

function Save-RemoteHealthState([int]$ProcessId, [int]$Failures) {
  $temporary = "$stateFile.$PID.tmp"
  Set-Content -LiteralPath $temporary -Value (@{ pid = $ProcessId; consecutiveFailures = $Failures } | ConvertTo-Json -Compress) -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}

try {
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Iniciador do piloto ausente." }
  if (-not (Test-Path -LiteralPath $cloudflaredPath)) { throw "Executável cloudflared ausente." }

  $apiHealthy = Test-PilotHealth $apiOrigin
  $tunnelProcesses = Get-PilotTunnelProcesses
  if ($tunnelProcesses.Count -gt 1) {
    $recorded = 0
    if (Test-Path -LiteralPath $pidPath) { [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recorded) }
    $keeper = $tunnelProcesses | Where-Object { $_.ProcessId -eq $recorded } | Select-Object -First 1
    if (-not $keeper) { $keeper = $tunnelProcesses | Sort-Object CreationDate | Select-Object -First 1 }
    foreach ($duplicate in $tunnelProcesses | Where-Object { $_.ProcessId -ne $keeper.ProcessId }) {
      Stop-Process -Id $duplicate.ProcessId -Force -ErrorAction Stop
      Write-OperationalLog 'duplicate-stopped' "pid=$($duplicate.ProcessId) keeper=$($keeper.ProcessId)"
    }
    $tunnelProcesses = @($keeper)
  }

  $tunnelProcess = $tunnelProcesses | Select-Object -First 1
  if ($tunnelProcess) {
    Set-Content -LiteralPath $pidPath -Value $tunnelProcess.ProcessId -Encoding ascii
  } elseif (Test-Path -LiteralPath $pidPath) {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }

  $tunnelUrl = if ($tunnelProcess) { Get-CurrentTunnelUrl } else { $null }
  if ($apiHealthy -and $tunnelProcess -and $tunnelUrl) {
    if (Test-PilotHealth $tunnelUrl) {
      Save-RemoteHealthState -ProcessId $tunnelProcess.ProcessId -Failures 0
      try {
        $published = Invoke-RestMethod -Uri $publicConfigUrl -TimeoutSec 8 -Headers @{ 'Cache-Control' = 'no-cache' }
        if ($published.apiBaseUrl -ne $tunnelUrl -or $published.enabled -ne $true -or $published.environment -ne 'pilot') {
          Write-OperationalLog 'config-stale' "pid=$($tunnelProcess.ProcessId) url=$tunnelUrl action=republish-existing"
          & $launcher -ProjectRoot $ProjectRoot -PilotTools $PilotTools -ReuseExistingTunnel
        } else {
          Write-OperationalLog 'healthy' "apiPid=$((Get-NetTCPConnection -State Listen -LocalPort 8787 | Select-Object -First 1).OwningProcess) tunnelPid=$($tunnelProcess.ProcessId) url=$tunnelUrl remoteHealth=200"
        }
      } catch {
        Write-OperationalLog 'config-check-deferred' "tunnelPid=$($tunnelProcess.ProcessId) remoteHealth=200"
      }
      exit 0
    }

    $state = $null
    try { $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { }
    $failures = if ($state -and [int]$state.pid -eq $tunnelProcess.ProcessId) { [int]$state.consecutiveFailures + 1 } else { 1 }
    Save-RemoteHealthState -ProcessId $tunnelProcess.ProcessId -Failures $failures
    if ($failures -lt 3) {
      Write-OperationalLog 'remote-health-retry' "tunnelPid=$($tunnelProcess.ProcessId) url=$tunnelUrl consecutiveFailures=$failures action=allow-cloudflared-reconnect"
      exit 0
    }
    Write-OperationalLog 'restart' "reason=remote-health-failed-three-checks tunnelPid=$($tunnelProcess.ProcessId) url=$tunnelUrl"
  } else {
    $reason = if (-not $apiHealthy) { 'api-unhealthy' } elseif (-not $tunnelProcess) { 'cloudflared-process-absent' } else { 'tunnel-url-not-found-in-log' }
    Write-OperationalLog 'restart' "reason=$reason apiHealthy=$apiHealthy tunnelPid=$($tunnelProcess.ProcessId)"
  }

  & $launcher -ProjectRoot $ProjectRoot -PilotTools $PilotTools
  if (-not (Test-PilotHealth $apiOrigin)) { throw "A API piloto não ficou saudável após a recuperação." }
  $newPid = 0
  if (-not (Test-Path -LiteralPath $pidPath) -or -not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$newPid)) { throw "PID do Quick Tunnel ausente após recuperação." }
  $newUrl = Get-CurrentTunnelUrl
  if (-not $newUrl -or -not (Test-PilotHealth $newUrl)) { throw "Health do Quick Tunnel não passou após recuperação." }
  Save-RemoteHealthState -ProcessId $newPid -Failures 0
  Write-OperationalLog 'recovery-succeeded' "apiPid=$((Get-NetTCPConnection -State Listen -LocalPort 8787 | Select-Object -First 1).OwningProcess) tunnelPid=$newPid url=$newUrl localHealth=200 remoteHealth=200"
} catch {
  $reason = $_.Exception.Message -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
  Write-OperationalLog 'failure' "message=$reason"
  throw
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
