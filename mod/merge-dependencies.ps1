param(
    [Parameter(Mandatory = $true)][string]$PrimaryAssembly,
    [Parameter(Mandatory = $true)][string]$OutputAssembly,
    [Parameter(Mandatory = $true)][string]$GameDirectory,
    [Parameter(Mandatory = $true)][string]$LoaderDirectory,
    [Parameter(Mandatory = $true)][string]$NewtonsoftJsonPath,
    [string]$ILRepackPath = ''
)

$ErrorActionPreference = 'Stop'
$ilRepackVersion = '2.0.48'
$ilRepackPackageHash = '799017B829A6ED69FAC0D4FC0A874A4A6A9951F46D73A3CCE20BA016796B949F'

function Assert-Dependency(
    [string]$Path,
    [string]$ExpectedName,
    [string]$ExpectedVersion,
    [string]$ExpectedHash
) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Missing dependency: $Path" }
    $assembly = [Reflection.AssemblyName]::GetAssemblyName($Path)
    if ($assembly.Name -ne $ExpectedName -or $assembly.Version.ToString() -ne $ExpectedVersion) {
        throw "Unexpected dependency identity for $Path. Expected $ExpectedName $ExpectedVersion."
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($hash -ne $ExpectedHash) {
        throw "Unexpected dependency bytes for $ExpectedName $ExpectedVersion. SHA-256 was $hash."
    }
}

function Resolve-ILRepack([string]$RequestedPath) {
    if (-not [String]::IsNullOrEmpty($RequestedPath)) {
        if (-not (Test-Path -LiteralPath $RequestedPath)) { throw "ILRepack was not found: $RequestedPath" }
        return (Resolve-Path -LiteralPath $RequestedPath).Path
    }

    $cache = Join-Path $PSScriptRoot "build\tools\ILRepack.$ilRepackVersion"
    $tool = Join-Path $cache 'tools\ILRepack.exe'
    if (Test-Path -LiteralPath $tool) { return $tool }

    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $package = Join-Path $cache "ILRepack.$ilRepackVersion.nupkg"
    $archive = Join-Path $cache "ILRepack.$ilRepackVersion.zip"
    $uri = "https://www.nuget.org/api/v2/package/ILRepack/$ilRepackVersion"
    $client = New-Object Net.WebClient
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $client.DownloadFile($uri, $package)
    } finally {
        $client.Dispose()
    }
    $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash
    if ($packageHash -ne $ilRepackPackageHash) {
        throw "ILRepack package hash mismatch. Expected $ilRepackPackageHash, got $packageHash."
    }
    Copy-Item -LiteralPath $package -Destination $archive -Force
    Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force
    if (-not (Test-Path -LiteralPath $tool)) { throw 'ILRepack package did not contain tools\ILRepack.exe.' }
    return $tool
}

Assert-Dependency $NewtonsoftJsonPath 'Newtonsoft.Json' '13.0.0.0' `
    'C69B18993D8236E5DFE3F0580A4392E7BC0B5F525911737318117C91D43B3EA5'

$managed = Join-Path $GameDirectory 'mu3_Data\Managed'
foreach ($path in @($PrimaryAssembly, $managed, $LoaderDirectory)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing merge input: $path" }
}

$toolPath = Resolve-ILRepack $ILRepackPath
New-Item -ItemType Directory -Force -Path (Split-Path $OutputAssembly) | Out-Null
$arguments = @(
    '/target:library',
    "/targetplatform:v2,$managed",
    "/lib:$managed",
    "/lib:$LoaderDirectory",
    "/out:$OutputAssembly",
    $PrimaryAssembly,
    $NewtonsoftJsonPath
)
& $toolPath @arguments
if ($LASTEXITCODE -ne 0) { throw "Dependency merge failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $OutputAssembly)) { throw 'Dependency merge did not create the output assembly.' }
Write-Output $OutputAssembly
