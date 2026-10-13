param(
    [string]$Region = 'us-west-2',
    [string]$StackName = 'sticky-board-west',
    [string]$SiteOrigin = 'https://ryaneng.land',
    [string]$NotificationEmail
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$service = Join-Path $root 'services\sticky-board'
Push-Location $service
try {
    & (Join-Path $service 'build.ps1')
    if (-not $?) { throw 'Sticky board build failed; deployment was not started.' }
    $parameters = @("SiteOrigin=$SiteOrigin")
    if ($NotificationEmail) { $parameters += "NotificationEmail=$NotificationEmail" }
    sam deploy --template-file '.build\template.yaml' --stack-name $StackName --region $Region --capabilities CAPABILITY_IAM --resolve-s3 --parameter-overrides $parameters --no-confirm-changeset --no-fail-on-empty-changeset
    if ($LASTEXITCODE -ne 0) { throw 'Sticky board deployment failed.' }
    $raw = aws cloudformation describe-stacks --stack-name $StackName --region $Region --query 'Stacks[0].Outputs' --output json
    if ($LASTEXITCODE -ne 0) { throw 'Could not read deployed stack outputs.' }
    $outputs = @{}
    foreach ($output in ($raw | ConvertFrom-Json)) { $outputs[$output.OutputKey] = $output.OutputValue }
    foreach ($name in 'ApiUrl', 'WebSocketUrl', 'MediaUrl') {
        if (-not $outputs[$name]) { throw "Missing stack output: $name." }
    }
    $config = @{
        apiUrl = $outputs.ApiUrl.TrimEnd('/')
        websocketUrl = $outputs.WebSocketUrl.TrimEnd('/')
        mediaUrl = $outputs.MediaUrl.TrimEnd('/')
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $root 'assets\js\sticky-board-config.js'), "window.STICKY_BOARD_CONFIG = $config;`n", (New-Object Text.UTF8Encoding($false)))
    Write-Output 'Deployed sticky board and saved public endpoint configuration. Publish the frontend to connect visitors.'
} finally {
    Pop-Location
}
