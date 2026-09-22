param(
    [string]$GameDirectory = 'F:\package',
    [string]$ILRepackPath = ''
)

$ErrorActionPreference = 'Stop'
$rawBuildOutput = @( & (Join-Path $PSScriptRoot 'build.ps1') `
    -GameDirectory $GameDirectory -ILRepackPath $ILRepackPath -SkipDependencyMerge )
$rawModDll = $rawBuildOutput | Where-Object { $_ -is [string] -and $_.EndsWith('OngekiCollab.Mod.raw.dll') } | Select-Object -Last 1
if (-not $rawModDll) { throw 'Raw mod build did not return a DLL path.' }
$buildOutput = @( & (Join-Path $PSScriptRoot 'build.ps1') `
    -GameDirectory $GameDirectory -ILRepackPath $ILRepackPath )
$modDll = $buildOutput | Where-Object { $_ -is [string] -and $_.EndsWith('OngekiCollab.Mod.dll') } | Select-Object -Last 1
if (-not $modDll) { throw 'Mod build did not return a DLL path.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v3.5\csc.exe'
$managed = Join-Path $GameDirectory 'mu3_Data\Managed'
$loader = Join-Path $GameDirectory 'MelonLoader\net35'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('OngekiCollab-Test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$testExe = Join-Path $scratch 'OfflineTransportTest.exe'
try {
    # Harmony resolves MonoMod helpers at runtime. Keep the repository clean while
    # making the isolated test process probe the same net35 loader set as the game.
    Get-ChildItem -LiteralPath $loader -Filter '*.dll' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $scratch $_.Name)
    }
    & $compiler /nologo /target:exe "/out:$testExe" "/reference:$(Join-Path $managed 'Assembly-CSharp.dll')" "/reference:$(Join-Path $loader '0Harmony.dll')" "/reference:$(Join-Path $loader 'Newtonsoft.Json.dll')" (Join-Path $PSScriptRoot 'tests\OfflineTransportTest.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Offline test compilation failed.' }
    & $testExe $GameDirectory $rawModDll
    if ($LASTEXITCODE -ne 0) { throw 'Offline transport checks failed.' }
    & $testExe $GameDirectory $modDll --self-contained-only
    if ($LASTEXITCODE -ne 0) { throw 'Self-contained MelonLoader checks failed.' }
} finally {
    if ([IO.Directory]::Exists($scratch)) { [IO.Directory]::Delete($scratch, $true) }
}
