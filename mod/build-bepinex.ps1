param(
    [string]$GameDirectory = 'F:\package',
    [ValidateSet('1', '2', '3', '4', '5')]
    [string]$BepInExMajor = '5',
    [Alias('BepInExDirectory')]
    [string]$BepInExReferenceDirectory = '',
    [string]$DependencyDirectory = '',
    [string]$ILRepackPath = '',
    [switch]$SkipDependencyMerge
)

$ErrorActionPreference = 'Stop'

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v3.5\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework 3.5 C# compiler is required.' }

$managed = Join-Path $GameDirectory 'mu3_Data\Managed'
$referenceOutput = @( & (Join-Path $PSScriptRoot 'resolve-bepinex-reference.ps1') `
    -Major $BepInExMajor -ReferenceDirectory $BepInExReferenceDirectory )
$core = $referenceOutput | Where-Object { $_ -is [string] -and (Test-Path -LiteralPath $_) } | Select-Object -Last 1
if (-not $core) { throw "BepInEx $BepInExMajor reference resolution did not return a core directory." }
$dependencyFolders = @()
if (-not [String]::IsNullOrEmpty($DependencyDirectory)) { $dependencyFolders += $DependencyDirectory }
$dependencyFolders += @(
    $core,
    $managed
)
$dependencyFolders = @($dependencyFolders | Select-Object -Unique)

function Resolve-OngekiCollabDependency([string]$Name) {
    foreach ($folder in $dependencyFolders) {
        if ([String]::IsNullOrEmpty($folder)) { continue }
        $candidate = Join-Path $folder $Name
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "Missing build dependency $Name. Supply -DependencyDirectory with Newtonsoft.Json.dll."
}

$json = Resolve-OngekiCollabDependency 'Newtonsoft.Json.dll'
$references = @(
    (Join-Path $managed 'Assembly-CSharp.dll'),
    (Join-Path $managed 'AMDaemon.NET.dll'),
    (Join-Path $managed 'UnityEngine.dll'),
    (Join-Path $managed 'UnityEngine.UI.dll'),
    (Join-Path $core 'BepInEx.dll'),
    (Join-Path $core '0Harmony.dll'),
    $json
)
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw "Missing read-only reference: $reference" }
}

$notice = Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt'
if (-not (Test-Path -LiteralPath $notice)) { throw "Missing third-party notice: $notice" }
$assemblyName = "OngekiCollab.BepInEx$BepInExMajor"
$rawOutput = Join-Path $PSScriptRoot "build\intermediate\$assemblyName.raw.dll"
New-Item -ItemType Directory -Force -Path (Split-Path $rawOutput) | Out-Null
$defines = "BEPINEX,BEPINEX_V$BepInExMajor"
if ($BepInExMajor -eq '1' -or $BepInExMajor -eq '2') { $defines += ',HARMONY1,HARMONY109' }
if ($BepInExMajor -eq '3' -or $BepInExMajor -eq '4') { $defines += ',HARMONY1,HARMONY110' }
$arguments = @('/nologo', '/target:library', '/optimize+', "/define:$defines", "/out:$rawOutput",
    "/resource:$notice,OngekiCollab.ThirdPartyNotices.txt")
$arguments += $references | ForEach-Object { "/reference:$_" }
$arguments += Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | ForEach-Object FullName
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "BepInEx $BepInExMajor mod compilation failed with exit code $LASTEXITCODE" }
if ($SkipDependencyMerge) { Write-Output $rawOutput; return }

$output = Join-Path $PSScriptRoot "build\bepinex\v$BepInExMajor\$assemblyName.dll"
& (Join-Path $PSScriptRoot 'merge-dependencies.ps1') `
    -PrimaryAssembly $rawOutput -OutputAssembly $output -GameDirectory $GameDirectory `
    -LoaderDirectory $core -NewtonsoftJsonPath $json `
    -ILRepackPath $ILRepackPath | Out-Null
Write-Output $output
