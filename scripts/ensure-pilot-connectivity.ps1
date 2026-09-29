param(
  [string]$PilotTools = "E:\GestaoLogistica_Server_Pilot\tools",
  [string]$ProjectRoot = "E:\GestaoLogistica_DEV"
)

$ErrorActionPreference = "Stop"
$mutex = [System.Threading.Mutex]::new($false, "Local\GestaoLogisticaPilotConnectivity")
if (-not $mutex.WaitOne(0)) { exit 0 }

try {
  $launcher = Join-Path $PilotTools "start-gestao-logistica-pilot.ps1"
  $pidPath = Join-Path $PilotTools "pilot-cloudflared.pid"
  $tunnelLog = Join-Path $PilotTools "logs\cloudflared.stderr.log"
  if (-not (Test-Path -LiteralPath $launcher)) { throw "Iniciador do piloto não encontrado: $launcher" }

  function Test-PilotHealth([string]$url) {
    try {
      $result = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 8
      return $result.ok -eq $true -and $result.database -eq "available"
    } catch { return $false }
  }

  $apiHealthy = Test-PilotHealth "http://127.0.0.1:8787"
  $tunnelProcess = $null
  if (Test-Path -LiteralPath $pidPath) {
    $pidValue = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$pidValue)) {
      $tunnelProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
      if ($tunnelProcess -and -not [string]::Equals($tunnelProcess.ExecutablePath, (Join-Path $PilotTools "cloudflared.exe"), [StringComparison]::OrdinalIgnoreCase)) {
        $tunnelProcess = $null
      }
    }
  }
  $tunnelUrl = $null
  if ($tunnelProcess -and (Test-Path -LiteralPath $tunnelLog)) {
    $urlMatches = [regex]::Matches((Get-Content -LiteralPath $tunnelLog -Raw), "https://[a-z0-9-]+\.trycloudflare\.com", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($urlMatches.Count) { $tunnelUrl = $urlMatches[$urlMatches.Count - 1].Value }
  }
  if ($apiHealthy -and $tunnelProcess -and $tunnelUrl -and (Test-PilotHealth $tunnelUrl)) { exit 0 }

  & $launcher -ProjectRoot $ProjectRoot
  if (-not (Test-PilotHealth "http://127.0.0.1:8787")) { throw "A API piloto não ficou saudável após a reinicialização." }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
