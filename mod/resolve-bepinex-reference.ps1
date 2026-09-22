param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('1', '2', '3', '4', '5')]
    [string]$Major,
    [string]$ReferenceDirectory = ''
)

$ErrorActionPreference = 'Stop'
$profiles = @{
    '1' = @{
        Version = '1.0'; FileName = 'BepInEx.v1.0.zip'
        Uri = 'https://github.com/BepInEx/BepInEx/releases/download/v1.0/BepInEx.v1.0.zip'
        PackageHash = 'CD713FDAA37315AA746E5F909426BBA98FB5CE3902C09683E4A7227389B7482E'
        Core = 'KoikatuTrial_Data\Managed'; BepVersion = '1.0.0.0'
        BepHash = '0ABD23F08570C79AB5C1719BBC6FFD49496BE5EF822AD5878BC9583C054FFFD4'
        HarmonyVersion = '1.0.9.1'
        HarmonyHash = '844379B0D6F5E4B99B7BF0C389EF71FA7D155AC34947154A300143AD23D08500'
    }
    '2' = @{
        Version = '2.0'; FileName = 'BepInEx.v2.0.zip'
        Uri = 'https://github.com/BepInEx/BepInEx/releases/download/v2.0/BepInEx.v2.0.zip'
        PackageHash = '961E5DEDB0F6C51A279C0560B037313D51859A157B37D13A999054CAC32E7DDA'
        Core = 'KoikatuTrial_Data\Managed'; BepVersion = '1.0.0.0'
        BepHash = '080D3EBF88BA13AB6E58C14943C38CF078C90AE899692BF138CFAC389C69E194'
        HarmonyVersion = '1.0.9.1'
        HarmonyHash = '358D17E61B59BC05C2646E5EA3B48C1160065E30F0489E9E43723E046094B949'
    }
    '3' = @{
        Version = '3.2'; FileName = 'BepInEx.Patcher.zip'
        Uri = 'https://github.com/BepInEx/BepInEx/releases/download/v3.2/BepInEx.Patcher.zip'
        PackageHash = '5D591E410D1DF0A0B43331D0E8A02E41F5A0386E9B011302CD883F469BE25609'
        PatcherHash = 'FBA026C2BF7BFAAC9FB778D318336DDA914ADBB1D5FB4D7BF874B02F4FCC41A1'
        Core = 'core'; BepVersion = '3.2.0.0'
        BepHash = '6F745BF80B4901E028E61EA4E3BDDC606D7115C7776B14C56D7B430B46E44FA4'
        HarmonyVersion = '1.1.0.0'
        HarmonyHash = 'B5468E4A4708693AD9E8C4D04E7FBD42A58A12AB62B60FC0E677C691F69CCB03'
    }
    '4' = @{
        Version = '4.1.2'; FileName = 'BepInEx_x64_v4.1.2.zip'
        Uri = 'https://github.com/BepInEx/BepInEx/releases/download/v4.1.1/BepInEx_x64_v4.1.2.zip'
        PackageHash = '7A6E1D3E9BD0CBC3BA12AAAE9E5BDFE8A1B6B9D0EF83712A60374EFFFCC87443'
        Core = 'BepInEx\core'; BepVersion = '4.1.2.0'
        BepHash = '0368705EAA6CF962EEBE25EEEFE3C56F4797BC91848953E2BDB77EE9AD19EBE0'
        HarmonyVersion = '1.1.0.0'
        HarmonyHash = 'B5468E4A4708693AD9E8C4D04E7FBD42A58A12AB62B60FC0E677C691F69CCB03'
    }
    '5' = @{
        # The release package declares the BepInEx 5.4.23.2 dependency. Compile
        # against that same HarmonyX 2.9 core so STARTLINER does not redirect the
        # plugin to its retained 0Harmony20 compatibility shim at startup.
        Version = '5.4.23.2'; FileName = 'BepInEx_win_x64_5.4.23.2.zip'
        Uri = 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.2/BepInEx_win_x64_5.4.23.2.zip'
        PackageHash = 'F752CE4E838F4C305B9DA1404B6745F2CFF23B8BFD494F79F0C84D0A01F59B46'
        Core = 'BepInEx\core'; BepVersion = '5.4.23.2'
        BepHash = 'C65B42034BC8FFB9F0B336E416DC3884E3F99FC5A5A89EB1F2FF7868412322CD'
        HarmonyVersion = '2.9.0.0'
        HarmonyHash = '1A21CC03424FC82C3DD1346905D16494536B9595AE4162228D99FB7C285C1031'
    }
}
$profile = $profiles[$Major]

function Assert-File([string]$Path, [string]$Name, [string]$Version, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "Missing $Name reference: $Path" }
    $identity = [Reflection.AssemblyName]::GetAssemblyName($Path)
    if ($identity.Name -ne $Name -or $identity.Version.ToString() -ne $Version) {
        throw "Unexpected $Name reference identity. Expected $Name $Version, got $($identity.FullName)."
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($actualHash -ne $Hash) {
        throw "Unexpected $Name $Version bytes. SHA-256 was $actualHash."
    }
}

function Find-Core([string]$Root) {
    $candidates = @(
        $Root,
        (Join-Path $Root 'core'),
        (Join-Path $Root 'BepInEx\core'),
        (Join-Path $Root 'KoikatuTrial_Data\Managed')
    )
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'BepInEx.dll')) -and
            (Test-Path -LiteralPath (Join-Path $candidate '0Harmony.dll'))) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Expand-BepInEx3Core([string]$Patcher, [string]$Destination) {
    $patcherHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Patcher).Hash
    if ($patcherHash -ne $profile.PatcherHash) {
        throw "Unexpected BepInEx 3.2 patcher bytes. SHA-256 was $patcherHash."
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $patcherAssembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Patcher))
    foreach ($item in @(
        @{ Resource = 'BepInEx.Patcher.BepInEx.dll'; Name = 'BepInEx.dll' },
        @{ Resource = 'BepInEx.Patcher.0Harmony.dll'; Name = '0Harmony.dll' }
    )) {
        $stream = $patcherAssembly.GetManifestResourceStream($item.Resource)
        if ($null -eq $stream) { throw "BepInEx 3 patcher is missing $($item.Resource)." }
        try {
            $output = [IO.File]::Create((Join-Path $Destination $item.Name))
            try { $stream.CopyTo($output) } finally { $output.Dispose() }
        } finally {
            $stream.Dispose()
        }
    }
}

if (-not [String]::IsNullOrEmpty($ReferenceDirectory)) {
    if (-not (Test-Path -LiteralPath $ReferenceDirectory)) {
        throw "BepInEx reference directory was not found: $ReferenceDirectory"
    }
    $core = Find-Core $ReferenceDirectory
    if (-not $core -and $Major -eq '3') {
        $patcher = Join-Path $ReferenceDirectory 'BepInEx.Patcher.exe'
        if (Test-Path -LiteralPath $patcher) {
            $core = Join-Path $PSScriptRoot 'build\tools\BepInEx.3.2-explicit\core'
            Expand-BepInEx3Core $patcher $core
            $core = (Resolve-Path -LiteralPath $core).Path
        }
    }
    if (-not $core) { throw "No BepInEx.dll/0Harmony.dll pair was found below $ReferenceDirectory." }
} else {
    $cache = Join-Path $PSScriptRoot "build\tools\BepInEx.$($profile.Version)"
    $core = Join-Path $cache $profile.Core
    $bep = Join-Path $core 'BepInEx.dll'
    $harmony = Join-Path $core '0Harmony.dll'
    if (-not ((Test-Path -LiteralPath $bep) -and (Test-Path -LiteralPath $harmony))) {
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $package = Join-Path $cache $profile.FileName
        $client = New-Object Net.WebClient
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $client.DownloadFile($profile.Uri, $package)
        } finally {
            $client.Dispose()
        }
        $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash
        if ($packageHash -ne $profile.PackageHash) {
            throw "BepInEx $($profile.Version) package hash mismatch. Expected $($profile.PackageHash), got $packageHash."
        }
        $archive = Join-Path $cache ($profile.FileName + '.zip')
        Copy-Item -LiteralPath $package -Destination $archive -Force
        Expand-Archive -LiteralPath $archive -DestinationPath $cache -Force

        if ($Major -eq '3') {
            $patcher = Join-Path $cache 'BepInEx.Patcher.exe'
            Expand-BepInEx3Core $patcher $core
        }
    }
    $core = (Resolve-Path -LiteralPath $core).Path
}

Assert-File (Join-Path $core 'BepInEx.dll') 'BepInEx' $profile.BepVersion $profile.BepHash
Assert-File (Join-Path $core '0Harmony.dll') '0Harmony' $profile.HarmonyVersion $profile.HarmonyHash
Write-Output $core
