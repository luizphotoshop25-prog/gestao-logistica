param(
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV",
  [string]$PilotTools = "E:\GestaoLogistica_Server_Pilot\tools",
  [ValidateRange(30, 300)]
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = "Stop"
$watchMutex = [System.Threading.Mutex]::new($false, "Local\GestaoLogisticaPilotWatchdog")
if (-not $watchMutex.WaitOne(0)) { exit 0 }
$ensureScript = Join-Path $ProjectRoot "scripts\ensure-pilot-connectivity.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$opsDirectory = Join-Path (Split-Path -Parent $PilotTools) "logs\remote-tunnel"
$opsLog = Join-Path $opsDirectory "remote-tunnel.log"

function Write-WatchLog([string]$Event, [string]$Detail = "") {
  New-Item -ItemType Directory -Path $opsDirectory -Force | Out-Null
  Get-ChildItem -LiteralPath $opsDirectory -File -Filter 'remote-tunnel*.log' -ErrorAction SilentlyContinue |
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

if (-not (Test-Path -LiteralPath $ensureScript)) { throw "Supervisor de verificação ausente: $ensureScript" }
if (-not (Test-Path -LiteralPath $powershell)) { throw "Windows PowerShell não encontrado." }
Write-WatchLog 'watchdog-started' "intervalSeconds=$IntervalSeconds"

try {
  while ($true) {
    try {
      $child = Start-Process -FilePath $powershell -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', $ensureScript, '-ProjectRoot', $ProjectRoot, '-PilotTools', $PilotTools
      ) -WorkingDirectory (Join-Path $ProjectRoot 'scripts') -WindowStyle Hidden -Wait -PassThru
      if ($child.ExitCode -ne 0) { Write-WatchLog 'watchdog-check-failed' "exitCode=$($child.ExitCode)" }
    } catch {
      $message = $_.Exception.Message -replace '(?i)(token|authorization|password|secret)\s*[=:]\s*\S+', '$1=[REDACTED]'
      Write-WatchLog 'watchdog-check-failed' "message=$message"
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  try { $watchMutex.ReleaseMutex() } catch { }
  $watchMutex.Dispose()
}
