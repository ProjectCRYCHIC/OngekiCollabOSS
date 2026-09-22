param(
    [string]$GameDirectory = 'F:\package',
    [string]$DependencyDirectory = '',
    [string]$ILRepackPath = '',
    [Alias('BepInExDirectory')]
    [string]$BepInEx5RuntimeDirectory = ''
)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v3.5\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework 3.5 C# compiler is required.' }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('OngekiCollab-BepInEx-Test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$testExe = Join-Path $scratch 'BepInExCompatibilityTest.exe'

function Find-BepInExDll([string]$Root) {
    foreach ($candidate in @(
        (Join-Path $Root 'BepInEx.dll'),
        (Join-Path $Root 'core\BepInEx.dll'),
        (Join-Path $Root 'BepInEx\core\BepInEx.dll')
    )) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw "BepInEx.dll was not found below $Root."
}

try {
    & $compiler /nologo /target:exe "/out:$testExe" (Join-Path $PSScriptRoot 'tests\BepInExCompatibilityTest.cs')
    if ($LASTEXITCODE -ne 0) { throw 'BepInEx compatibility test compilation failed.' }

    foreach ($major in @('1', '2', '3', '4', '5')) {
        $buildOutput = @( & (Join-Path $PSScriptRoot 'build-bepinex.ps1') `
            -GameDirectory $GameDirectory -BepInExMajor $major `
            -DependencyDirectory $DependencyDirectory -ILRepackPath $ILRepackPath )
        $expectedName = "OngekiCollab.BepInEx$major.dll"
        $modDll = $buildOutput | Where-Object {
            $_ -is [string] -and $_.EndsWith($expectedName)
        } | Select-Object -Last 1
        if (-not $modDll) { throw "BepInEx $major build did not return $expectedName." }

        $referenceOutput = @( & (Join-Path $PSScriptRoot 'resolve-bepinex-reference.ps1') -Major $major )
        $core = $referenceOutput | Where-Object { $_ -is [string] -and (Test-Path -LiteralPath $_) } | Select-Object -Last 1
        if (-not $core) { throw "BepInEx $major reference resolution failed." }
        $runtime = Join-Path $scratch "v$major"
        [IO.Directory]::CreateDirectory($runtime) | Out-Null
        Copy-Item -LiteralPath $testExe -Destination (Join-Path $runtime 'BepInExCompatibilityTest.exe')
        Copy-Item -LiteralPath (Join-Path $core 'BepInEx.dll') -Destination (Join-Path $runtime 'BepInEx.dll')
        Copy-Item -LiteralPath (Join-Path $core '0Harmony.dll') -Destination (Join-Path $runtime '0Harmony.dll')
        & (Join-Path $runtime 'BepInExCompatibilityTest.exe') $GameDirectory $modDll $major
        if ($LASTEXITCODE -ne 0) { throw "BepInEx $major compatibility checks failed." }
    }

    if (-not [String]::IsNullOrEmpty($BepInEx5RuntimeDirectory)) {
        $latestRuntime = Join-Path $scratch 'v5-runtime'
        [IO.Directory]::CreateDirectory($latestRuntime) | Out-Null
        Copy-Item -LiteralPath $testExe -Destination (Join-Path $latestRuntime 'BepInExCompatibilityTest.exe')
        Copy-Item -LiteralPath (Find-BepInExDll $BepInEx5RuntimeDirectory) `
            -Destination (Join-Path $latestRuntime 'BepInEx.dll')
        $latestBep = Find-BepInExDll $BepInEx5RuntimeDirectory
        Copy-Item -LiteralPath (Join-Path (Split-Path $latestBep) '0Harmony.dll') `
            -Destination (Join-Path $latestRuntime '0Harmony.dll')
        $v5Dll = Join-Path $PSScriptRoot 'build\bepinex\v5\OngekiCollab.BepInEx5.dll'
        & (Join-Path $latestRuntime 'BepInExCompatibilityTest.exe') $GameDirectory $v5Dll '5'
        if ($LASTEXITCODE -ne 0) { throw 'BepInEx 5 current-runtime compatibility checks failed.' }
    }
} finally {
    if ([IO.Directory]::Exists($scratch)) { [IO.Directory]::Delete($scratch, $true) }
}
