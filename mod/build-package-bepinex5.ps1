param(
    [string]$GameDirectory = 'F:\package',
    [string]$DependencyDirectory = '',
    [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
    [string]$Version = '0.1.2',
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
if ([String]::IsNullOrEmpty($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot 'build\packages'
}
if ([String]::IsNullOrEmpty($DependencyDirectory)) {
    $DependencyDirectory = Join-Path $GameDirectory 'MelonLoader\net35'
}

$entrySource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'src\ModEntry.cs')
$pluginVersion = [regex]::Match($entrySource,
    'BepInPlugin\("[^"]+",\s*"[^"]+",\s*"(?<version>[0-9]+\.[0-9]+\.[0-9]+)"\)').Groups['version'].Value
if ([String]::IsNullOrEmpty($pluginVersion) -or $pluginVersion -ne $Version) {
    throw "Package version $Version does not match the BepInEx plugin version $pluginVersion."
}

$buildOutput = @( & (Join-Path $PSScriptRoot 'build-bepinex.ps1') `
    -GameDirectory $GameDirectory -BepInExMajor 5 -DependencyDirectory $DependencyDirectory )
$dll = $buildOutput | Where-Object {
    $_ -is [string] -and $_.EndsWith('OngekiCollab.BepInEx5.dll')
} | Select-Object -Last 1
if (-not $dll -or -not (Test-Path -LiteralPath $dll -PathType Leaf)) {
    throw 'The BepInEx 5 build did not return its final DLL.'
}

$icon = Join-Path $PSScriptRoot 'package\icon.png'
$readme = Join-Path $PSScriptRoot 'package\README.md'
foreach ($required in @($icon, $readme)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Missing package input: $required"
    }
}
Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile($icon)
try {
    if ($image.Width -ne 256 -or $image.Height -ne 256) {
        throw 'package/icon.png must be exactly 256x256 pixels.'
    }
} finally { $image.Dispose() }

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$archive = Join-Path $outputRoot "ProjectCRYCHIC-OngekiCollab-$Version.zip"
$staging = Join-Path $outputRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
$pluginDirectory = Join-Path $staging 'app\BepInEx\plugins\OngekiCollab'
[IO.Directory]::CreateDirectory($pluginDirectory) | Out-Null
try {
    Copy-Item -LiteralPath $dll -Destination (Join-Path $pluginDirectory 'OngekiCollab.BepInEx5.dll')
    Copy-Item -LiteralPath $icon -Destination (Join-Path $staging 'icon.png')
    Copy-Item -LiteralPath $readme -Destination (Join-Path $staging 'README.md')
    $manifest = [ordered]@{
        name = 'OngekiCollab'
        version_number = $Version
        website_url = 'https://github.com/ProjectCRYCHIC/OngekiCollabOSS'
        description = 'Online relay matching client for ONGEKI.'
        dependencies = @('7EVENDAYSHOLIDAYS-BepInExPack-5.4.23002')
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $staging 'manifest.json'),
        ($manifest | ConvertTo-Json -Depth 4), $utf8)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ([IO.File]::Exists($archive)) { [IO.File]::Delete($archive) }
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $archive,
        [IO.Compression.CompressionLevel]::Optimal, $false)
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $actual = @($zip.Entries | ForEach-Object FullName | Sort-Object)
        $expected = @(
            'app/BepInEx/plugins/OngekiCollab/OngekiCollab.BepInEx5.dll',
            'icon.png',
            'manifest.json',
            'README.md'
        ) | Sort-Object
        if (($actual -join "`n") -ne ($expected -join "`n")) {
            throw "Unexpected package entries: $($actual -join ', ')"
        }
    } finally { $zip.Dispose() }
} finally {
    $stagingParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($staging))
    $stagingName = [IO.Path]::GetFileName($staging)
    if (-not [String]::Equals($stagingParent, $outputRoot,
            [StringComparison]::OrdinalIgnoreCase) -or
        -not $stagingName.StartsWith('.staging-', [StringComparison]::Ordinal)) {
        throw "Refusing to clean unexpected staging path: $staging"
    }
    if ([IO.Directory]::Exists($staging)) { [IO.Directory]::Delete($staging, $true) }
}

Write-Output $archive
