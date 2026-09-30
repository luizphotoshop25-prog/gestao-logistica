param(
  [Parameter(Mandatory = $true)][string]$PackagedDirectory,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [switch]$TestBuild
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$packaged = (Resolve-Path -LiteralPath $PackagedDirectory).Path
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)
$asar = Join-Path $packaged "resources\app.asar"
$repairSource = Join-Path $root "tools\repair\GestaoLogisticaRepair.cs"
$manifestTemplate = Join-Path $root "tools\repair\repair.manifest"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $asar)) { throw "app.asar do pacote não encontrado: $asar" }
if (-not (Test-Path -LiteralPath $csc)) { throw "Compilador .NET Framework não encontrado: $csc" }

$inspection = @'
const fs=require("node:fs");const asar=require("@electron/asar");const p=process.argv[1];const pkg=JSON.parse(asar.extractFile(p,"package.json").toString("utf8"));if(pkg.version!=="0.1.14")throw new Error("Pacote do reparador precisa ser 0.1.14.");if(!asar.listPackage(p).some(x=>x.replace(/\\/g,"/").replace(/^\/+/,"")==="electron/digital-shipment-write.cjs"))throw new Error("Módulo operacional ausente no pacote de destino.");process.stdout.write(String(fs.statSync(p).size));
'@
$asarLength = [int64]((& node -e $inspection $asar) -join "")
if ($LASTEXITCODE -ne 0 -or $asarLength -lt 1MB) { throw "O pacote de destino não passou na inspeção." }

$installed = Join-Path $env:LOCALAPPDATA "Programs\gestao-logistica\resources\app.asar"
if (-not (Test-Path -LiteralPath $installed)) { throw "Instalação 0.1.13 de referência não encontrada: $installed" }
$sourceHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToUpperInvariant()
$inspectionOld = @'
const asar=require("@electron/asar");const p=process.argv[1];const pkg=JSON.parse(asar.extractFile(p,"package.json").toString("utf8"));if(pkg.version!=="0.1.13")throw new Error("A instalação de referência não é 0.1.13.");if(asar.listPackage(p).some(x=>x.replace(/\\/g,"/").replace(/^\/+/,"")==="electron/digital-shipment-write.cjs"))throw new Error("A instalação de referência já contém o módulo.");process.stdout.write("verified");
'@
if ((& node -e $inspectionOld $installed) -ne "verified" -or $LASTEXITCODE -ne 0) { throw "Instalação de referência não corresponde à 0.1.13 quebrada esperada." }

$work = Join-Path $root "work\repair-build-0.1.14"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zipPath = Join-Path $work "repair-patch.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -LiteralPath $asar -DestinationPath $zipPath -CompressionLevel Optimal
$targetHash = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToUpperInvariant()
$manifest = Join-Path $work "repair-manifest.txt"
@(
  "sourceVersion=0.1.13"
  "targetVersion=0.1.14"
  "sourceSha256=$sourceHash"
  "targetSha256=$targetHash"
) | Set-Content -LiteralPath $manifest -Encoding ascii

$outputDirectory = Split-Path -Parent $outputFull
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }
$arguments = @(
  "/nologo", "/optimize+", "/target:winexe", "/platform:anycpu",
  "/out:$outputFull", "/win32manifest:$manifestTemplate",
  "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
  "/reference:System.IO.Compression.dll", "/reference:System.dll", "/reference:System.Core.dll"
)
if ($TestBuild) { $arguments += "/define:REPAIR_TEST_MODE" }
$arguments += "/resource:$manifest,RepairManifest.txt"
$arguments += "/resource:$zipPath,RepairPatch.zip"
$arguments += $repairSource
& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw "Compilação do reparador falhou com código $LASTEXITCODE." }

[pscustomobject]@{
  Output = $outputFull
  SourceSha256 = $sourceHash
  TargetSha256 = $targetHash
  AsarBytes = $asarLength
  PatchZipBytes = (Get-Item -LiteralPath $zipPath).Length
  RepairBytes = (Get-Item -LiteralPath $outputFull).Length
  TestBuild = [bool]$TestBuild
}
