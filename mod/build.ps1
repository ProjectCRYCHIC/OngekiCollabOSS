param(
    [string]$GameDirectory = 'F:\package',
    [string]$ILRepackPath = '',
    [switch]$SkipDependencyMerge
)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v3.5\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework 3.5 C# compiler is required.' }
$managed = Join-Path $GameDirectory 'mu3_Data\Managed'
$loader = Join-Path $GameDirectory 'MelonLoader\net35'
$json = Join-Path $loader 'Newtonsoft.Json.dll'
$references = @(
    (Join-Path $managed 'Assembly-CSharp.dll'),
    (Join-Path $managed 'AMDaemon.NET.dll'),
    (Join-Path $managed 'UnityEngine.dll'),
    (Join-Path $managed 'UnityEngine.UI.dll'),
    (Join-Path $loader 'MelonLoader.dll'),
    (Join-Path $loader '0Harmony.dll'),
    $json
)
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw "Missing read-only reference: $reference" }
}
$notice = Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt'
if (-not (Test-Path -LiteralPath $notice)) { throw "Missing third-party notice: $notice" }
$rawOutput = Join-Path $PSScriptRoot 'build\intermediate\OngekiCollab.Mod.raw.dll'
New-Item -ItemType Directory -Force -Path (Split-Path $rawOutput) | Out-Null
$arguments = @('/nologo', '/target:library', '/optimize+', "/out:$rawOutput",
    "/resource:$notice,OngekiCollab.ThirdPartyNotices.txt")
$arguments += $references | ForEach-Object { "/reference:$_" }
$arguments += Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | ForEach-Object FullName
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Mod compilation failed with exit code $LASTEXITCODE" }
if ($SkipDependencyMerge) { Write-Output $rawOutput; return }

$output = Join-Path $PSScriptRoot 'build\OngekiCollab.Mod.dll'
& (Join-Path $PSScriptRoot 'merge-dependencies.ps1') `
    -PrimaryAssembly $rawOutput -OutputAssembly $output -GameDirectory $GameDirectory `
    -LoaderDirectory $loader -NewtonsoftJsonPath $json `
    -ILRepackPath $ILRepackPath | Out-Null
Write-Output $output
