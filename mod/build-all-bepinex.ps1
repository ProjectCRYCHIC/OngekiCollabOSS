param(
    [string]$GameDirectory = 'F:\package',
    [string]$DependencyDirectory = '',
    [string]$ILRepackPath = ''
)

$ErrorActionPreference = 'Stop'
foreach ($major in @('1', '2', '3', '4', '5')) {
    & (Join-Path $PSScriptRoot 'build-bepinex.ps1') `
        -GameDirectory $GameDirectory -BepInExMajor $major `
        -DependencyDirectory $DependencyDirectory -ILRepackPath $ILRepackPath
}
