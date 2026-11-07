[CmdletBinding()]
param(
    [ValidatePattern('^[a-z]{2}(-[a-z]+)+-\d+$')]
    [string]$Region = 'us-east-1',
    [ValidateLength(1, 64)]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9-]*$')]
    [string]$StackName = 'pattern-studio-assets',
    [ValidatePattern('^https://[A-Za-z0-9.-]+(:[0-9]+)?$')]
    [string]$SiteOrigin = 'https://ryaneng.land',
    [ValidateSet('PriceClass_100', 'PriceClass_200', 'PriceClass_All')]
    [string]$PriceClass = 'PriceClass_100',
    [string]$Profile,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'AWS CLI is required. Install AWS CLI v2 and configure credentials before running this script.'
}
$template = Join-Path (Split-Path $PSScriptRoot -Parent) 'services\pattern-studio-assets\template.json'
if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
    throw "CloudFormation template not found: $template"
}
$template = (Resolve-Path -LiteralPath $template).Path
$common = @('--region', $Region, '--no-cli-pager')
if ($Profile) { $common += @('--profile', $Profile) }

$identity = & aws sts get-caller-identity @common --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not verify AWS credentials. No deployment was started.' }
$account = ($identity | ConvertFrom-Json).Account
if (-not $account) { throw 'AWS did not return an account ID. No deployment was started.' }
Write-Host "Target account: $account; region: $Region; stack: $StackName"

& aws cloudformation validate-template --template-body "file://$template" @common --output json
if ($LASTEXITCODE -ne 0) { throw 'CloudFormation template validation failed. No deployment was started.' }
if ($ValidateOnly) {
    Write-Output 'Template validated. No resources created or updated.'
    return
}

& aws cloudformation deploy --template-file $template --stack-name $StackName @common `
    --parameter-overrides "SiteOrigin=$SiteOrigin" "PriceClass=$PriceClass" `
    --tags 'Application=pattern-studio-assets' --no-fail-on-empty-changeset
if ($LASTEXITCODE -ne 0) { throw 'Asset infrastructure deployment failed. Inspect CloudFormation stack events for details.' }

$raw = & aws cloudformation describe-stacks --stack-name $StackName @common --query 'Stacks[0].Outputs' --output json
if ($LASTEXITCODE -ne 0) { throw 'Deployment completed, but reading stack outputs failed.' }
$outputs = @{}
foreach ($output in ($raw | ConvertFrom-Json)) { $outputs[$output.OutputKey] = $output.OutputValue }
foreach ($name in 'BucketName', 'DistributionId', 'AssetBaseUrl', 'LatestManifestUrl') {
    if (-not $outputs[$name]) { throw "Deployment completed, but stack output $name is missing." }
}
Write-Output 'Asset infrastructure deployed. Existing artwork and frontend configuration were not changed.'
[pscustomobject]@{
    BucketName = $outputs.BucketName
    DistributionId = $outputs.DistributionId
    AssetBaseUrl = $outputs.AssetBaseUrl
    LatestManifestUrl = $outputs.LatestManifestUrl
}
