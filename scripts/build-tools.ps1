param([string]$PublishDirectory)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
            $name = $Matches[1]
            $value = $Matches[2]
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}

if (-not $env:IMAGE_TOOLS_API_URL -or -not $env:RECAPTCHA_SITE_KEY) {
    throw 'Set IMAGE_TOOLS_API_URL and RECAPTCHA_SITE_KEY in .env or the build environment.'
}
$apiUri = [Uri]$env:IMAGE_TOOLS_API_URL
if (-not $apiUri.IsAbsoluteUri -or $apiUri.Scheme -ne 'https') {
    throw 'IMAGE_TOOLS_API_URL must be an absolute HTTPS URL.'
}

$destination = $root
if ($PublishDirectory) {
    $destination = [IO.Path]::GetFullPath($PublishDirectory)
    if ($destination -eq $root) { throw 'PublishDirectory must differ from the repository root.' }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem $root -File | Where-Object { $_.Extension -in '.html', '.css', '.js', '.ico' -or $_.Name -eq 'CNAME' } | Copy-Item -Destination $destination
    foreach ($folder in 'assets', 'tools', 'code') {
        Copy-Item (Join-Path $root $folder) -Destination $destination -Recurse -Force
    }
}
$publicConfiguration = @{
    apiUrl           = $env:IMAGE_TOOLS_API_URL.TrimEnd('/')
    recaptchaSiteKey = $env:RECAPTCHA_SITE_KEY
} | ConvertTo-Json -Compress
$configurationPath = Join-Path $destination 'tools/image-config.js'
[IO.File]::WriteAllText($configurationPath, "window.IMAGE_TOOLS_CONFIG = $publicConfiguration;`n", (New-Object Text.UTF8Encoding($false)))
Write-Output 'Generated public image-tool configuration (no private secrets).'