param(
    [switch]$Upload,
    [switch]$Smoke
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$backupDirectory = Join-Path $env:LOCALAPPDATA 'OngekiCollab'
$backupPath = Join-Path $backupDirectory 'secrets.dpapi'
$names = @(
    'IDENTITY_HASH_SECRET',
    'KEY_ENCRYPTION_SECRET',
    'TICKET_SIGNING_SECRET',
    'ADMIN_RESET_SECRET'
)

if (Test-Path -LiteralPath $backupPath) {
    $ciphertext = [System.IO.File]::ReadAllBytes($backupPath)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $ciphertext, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        $values = [System.Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json -AsHashtable
    } finally {
        [System.Array]::Clear($plain, 0, $plain.Length)
    }
} else {
    $values = @{}
    foreach ($name in $names) {
        $bytes = [byte[]]::new(32)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $values[$name] = [Convert]::ToBase64String($bytes)
        [System.Array]::Clear($bytes, 0, $bytes.Length)
    }
    [System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
    $plain = [System.Text.Encoding]::UTF8.GetBytes(($values | ConvertTo-Json -Compress))
    try {
        $ciphertext = [System.Security.Cryptography.ProtectedData]::Protect(
            $plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.IO.File]::WriteAllBytes($backupPath, $ciphertext)
    } finally {
        [System.Array]::Clear($plain, 0, $plain.Length)
    }
}

foreach ($name in $names) {
    if (-not $values.ContainsKey($name) -or
        [Convert]::FromBase64String([string]$values[$name]).Length -ne 32) {
        throw "Invalid local secret backup: $name"
    }
}

Write-Output "Four independent secrets are backed up for the current Windows user at $backupPath."
if ($Upload) {
    Push-Location $repository
    try {
        $values | ConvertTo-Json -Compress | & node 'node_modules/wrangler/bin/wrangler.js' secret bulk
        if ($LASTEXITCODE -ne 0) { throw "Secret upload failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
if ($Smoke) {
    Push-Location $repository
    try {
        $env:ADMIN_RESET_SECRET = [string]$values['ADMIN_RESET_SECRET']
        & node 'scripts/smoke-production.mjs'
        if ($LASTEXITCODE -ne 0) { throw "Production smoke failed with exit code $LASTEXITCODE" }
    } finally {
        Remove-Item Env:ADMIN_RESET_SECRET -ErrorAction SilentlyContinue
        Pop-Location
    }
}
