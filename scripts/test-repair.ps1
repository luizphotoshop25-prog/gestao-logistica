param(
  [Parameter(Mandatory = $true)][string]$RepairExecutable,
  [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedTargetSha256
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$sourceInstall = Join-Path $env:LOCALAPPDATA "Programs\gestao-logistica"
$repair = (Resolve-Path -LiteralPath $RepairExecutable).Path
$workRoot = Join-Path $root "work"
if (-not (Test-Path -LiteralPath $sourceInstall)) { throw "Instalação de referência não encontrada: $sourceInstall" }
if (-not (Test-Path -LiteralPath $repair)) { throw "Reparador de teste não encontrado: $repair" }
$sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceInstall "resources\app.asar") -Algorithm SHA256).Hash
if ($sourceHash -ne $ExpectedSourceSha256.ToUpperInvariant()) { throw "O app.asar de referência mudou; o teste foi cancelado." }

$sandbox = Join-Path $workRoot ("repair-test-" + [guid]::NewGuid().ToString("N"))
$sandboxFull = [System.IO.Path]::GetFullPath($sandbox)
$workFull = [System.IO.Path]::GetFullPath($workRoot).TrimEnd('\') + '\'
if (-not $sandboxFull.StartsWith($workFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Sandbox fora de work/: $sandboxFull" }
$testInstall = Join-Path $sandbox "Programs\gestao-logistica"
$userData = Join-Path $sandbox "user-data"
New-Item -ItemType Directory -Path (Split-Path -Parent $testInstall) -Force | Out-Null
New-Item -ItemType Directory -Path $userData -Force | Out-Null
Set-Content -LiteralPath (Join-Path $sandbox ".owned-by-repair-test") -Value "Gestão Logística repair test" -Encoding ascii

$oldRoot = $env:GESTAO_REPAIR_TEST_ROOT
$oldResult = $env:GESTAO_REPAIR_TEST_RESULT
$oldAppData = $env:APPDATA
function Invoke-TestRepair([string]$resultFile) {
  $testProcess = Start-Process -FilePath $repair -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(35)
  while (-not $testProcess.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $testProcess.Refresh()
  }
  if (-not $testProcess.HasExited) {
    Stop-Process -Id $testProcess.Id -Force -ErrorAction SilentlyContinue
    throw "O reparador de teste não encerrou dentro do tempo esperado."
  }
  if ($testProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $resultFile)) { throw "O reparo isolado falhou (código $($testProcess.ExitCode))." }
}
try {
  Copy-Item -LiteralPath $sourceInstall -Destination $testInstall -Recurse
  $env:GESTAO_REPAIR_TEST_ROOT = $testInstall
  $env:APPDATA = $userData
  $resultFile = Join-Path $sandbox "repair-result.txt"
  $env:GESTAO_REPAIR_TEST_RESULT = $resultFile
  $uninstaller = Join-Path $testInstall "Uninstall Gestão Logística.exe"
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw "O desinstalador original não foi copiado para o teste." }
  $configMarker = Join-Path $userData "remote-config-preserve.marker"
  Set-Content -LiteralPath $configMarker -Value "preserve user data" -Encoding ascii
  $configMarkerHash = (Get-FileHash -LiteralPath $configMarker -Algorithm SHA256).Hash

  Invoke-TestRepair $resultFile
  $firstResult = Get-Content -Raw -LiteralPath $resultFile
  if (-not $firstResult.StartsWith("OK`n", [System.StringComparison]::Ordinal)) { throw "O primeiro reparo isolado falhou: $firstResult" }
  $testArchive = Join-Path $testInstall "resources\app.asar"
  $afterFirst = (Get-FileHash -LiteralPath $testArchive -Algorithm SHA256).Hash
  if ($afterFirst -ne $ExpectedTargetSha256.ToUpperInvariant()) { throw "O hash final da primeira reparação não confere." }
  $backup = Join-Path $testInstall "resources\repair-backup-0.1.13\app.asar"
  if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $ExpectedSourceSha256.ToUpperInvariant()) { throw "O backup 0.1.13 não confere." }
  $firstWriteTime = (Get-Item -LiteralPath $testArchive).LastWriteTimeUtc

  Remove-Item -LiteralPath $resultFile -Force
  Invoke-TestRepair $resultFile
  $secondResult = Get-Content -Raw -LiteralPath $resultFile
  if ($secondResult -notmatch "já estava reparada") { throw "A segunda execução não foi idempotente: $secondResult" }
  if ((Get-FileHash -LiteralPath $testArchive -Algorithm SHA256).Hash -ne $ExpectedTargetSha256.ToUpperInvariant()) { throw "A segunda execução alterou o hash reparado." }
  if ((Get-Item -LiteralPath $testArchive).LastWriteTimeUtc -ne $firstWriteTime) { throw "A segunda execução regravou o app.asar." }
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw "O reparo alterou o desinstalador." }
  if ((Get-FileHash -LiteralPath $configMarker -Algorithm SHA256).Hash -ne $configMarkerHash) { throw "O reparo alterou dados do usuário." }
  [pscustomobject]@{ firstRun = "repaired and launched"; secondRun = "already repaired; unchanged"; backupHashVerified = $true; asarHashVerified = $true; userDataPreserved = $true; uninstallerPreserved = $true; sandbox = $sandboxFull }
}
finally {
  $env:GESTAO_REPAIR_TEST_ROOT = $oldRoot
  $env:GESTAO_REPAIR_TEST_RESULT = $oldResult
  $env:APPDATA = $oldAppData
  $testExecutable = Join-Path $testInstall "Gestão Logística.exe"
  foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if ($process.Name -eq "Gestão Logística.exe" -and $process.ExecutablePath -eq $testExecutable) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  if ((Test-Path -LiteralPath (Join-Path $sandbox ".owned-by-repair-test")) -and $sandboxFull.StartsWith($workFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $sandboxFull -Recurse -Force
  }
}
