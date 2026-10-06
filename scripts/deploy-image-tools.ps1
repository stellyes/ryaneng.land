$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build-tools.ps1')
foreach ($name in 'SITE_ORIGIN', 'API_DOMAIN_NAME', 'ACM_CERTIFICATE_ARN', 'HOSTED_ZONE_ID', 'SES_FROM_ADDRESS', 'SES_TO_ADDRESS', 'AWS_REGION', 'AWS_STACK_NAME') {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) { throw "Missing $name in .env or environment." }
}
$parameters = @(
    "SiteOrigin=$env:SITE_ORIGIN",
    "ApiDomainName=$env:API_DOMAIN_NAME",
    "AcmCertificateArn=$env:ACM_CERTIFICATE_ARN",
    "HostedZoneId=$env:HOSTED_ZONE_ID",
    "SesFromAddress=$env:SES_FROM_ADDRESS",
    "SesToAddress=$env:SES_TO_ADDRESS",
    "RecaptchaSiteKey=$env:RECAPTCHA_SITE_KEY"
)
Push-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'services/image-converter')
try {
    sam build
    if ($LASTEXITCODE -ne 0) { throw 'SAM build failed; deployment was not started.' }
    sam deploy --stack-name $env:AWS_STACK_NAME --region $env:AWS_REGION --capabilities CAPABILITY_IAM --resolve-s3 --resolve-image-repos --parameter-overrides $parameters --no-confirm-changeset --no-fail-on-empty-changeset
    if ($LASTEXITCODE -ne 0) { throw 'SAM deployment failed.' }
} finally {
    Pop-Location
}