$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$deploy = Join-Path $root 'scripts\deploy-pattern-studio-assets.ps1'
$templatePath = Join-Path $root 'services\pattern-studio-assets\template.json'
$global:PatternStudioAssetDeployTestState = @{
    Calls = @()
    FailCommand = ''
    MissingOutput = $false
}

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Expect-Failure([scriptblock]$Run, [string]$Message) {
    $failure = $null
    try { & $Run | Out-Null } catch { $failure = $_ }
    Assert ($null -ne $failure -and $failure.Exception.Message.Contains($Message)) "Expected failure containing: $Message"
}

function aws {
    $global:PatternStudioAssetDeployTestState.Calls += ,@($args)
    $command = "$($args[0]) $($args[1])"
    $global:LASTEXITCODE = 0
    if ($command -eq $global:PatternStudioAssetDeployTestState.FailCommand) {
        $global:LASTEXITCODE = 1
        return
    }
    switch ($command) {
        'sts get-caller-identity' { '{"Account":"123456789012"}' }
        'cloudformation validate-template' { '{"Parameters":[]}' }
        'cloudformation deploy' { 'Successfully created/updated stack' }
        'cloudformation describe-stacks' {
            if ($global:PatternStudioAssetDeployTestState.MissingOutput) {
                '[{"OutputKey":"BucketName","OutputValue":"test-assets"}]'
            } else {
                '[{"OutputKey":"BucketName","OutputValue":"test-assets"},{"OutputKey":"DistributionId","OutputValue":"TEST123"},{"OutputKey":"AssetBaseUrl","OutputValue":"https://test.cloudfront.net"},{"OutputKey":"LatestManifestUrl","OutputValue":"https://test.cloudfront.net/latest.json"}]'
            }
        }
        default { throw "Unexpected AWS command: $command" }
    }
}

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($deploy, [ref]$tokens, [ref]$errors)
Assert ($errors.Count -eq 0) 'Deployment script must parse in Windows PowerShell.'
$t = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
$r = $t.Resources
Assert ($r.AssetBucket.DeletionPolicy -eq 'Retain' -and $r.AssetBucket.UpdateReplacePolicy -eq 'Retain') 'Bucket contents must be retained.'
Assert ($r.AssetBucket.Properties.VersioningConfiguration.Status -eq 'Enabled') 'Versioning must be enabled.'
foreach ($property in 'BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets') {
    Assert ($r.AssetBucket.Properties.PublicAccessBlockConfiguration.$property -eq $true) "Missing public-access protection: $property"
}
Assert ($r.AssetBucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm -eq 'AES256') 'Bucket must be encrypted.'
$policy = $r.AssetBucketPolicy.Properties.PolicyDocument.Statement
Assert ($policy[0].Principal.Service -eq 'cloudfront.amazonaws.com') 'Only CloudFront should have public-delivery access.'
Assert ($policy[0].Condition.StringEquals.'AWS:SourceArn'.'Fn::Sub' -match '\$\{Distribution\}') 'Access must be scoped to this distribution.'
Assert ($policy[1].Effect -eq 'Deny' -and $policy[1].Condition.Bool.'aws:SecureTransport' -eq 'false') 'Insecure S3 transport must be denied.'
$distribution = $r.Distribution.Properties.DistributionConfig
Assert ($distribution.DefaultCacheBehavior.ViewerProtocolPolicy -eq 'redirect-to-https') 'HTTPS must be enforced.'
Assert ($distribution.CacheBehaviors.Count -eq 1 -and $distribution.CacheBehaviors[0].PathPattern -eq 'latest.json') 'Revision endpoint needs a dedicated behavior.'
$revision = $r.RevisionCachePolicy.Properties.CachePolicyConfig
Assert ($revision.MinTTL -eq 0 -and $revision.DefaultTTL -eq 0 -and $revision.MaxTTL -eq 0) 'Revision must not be cached at the edge.'
$cache = $r.AssetCachePolicy.Properties.CachePolicyConfig
Assert ($cache.MinTTL -eq 0 -and $cache.DefaultTTL -eq 0 -and $cache.MaxTTL -eq 31536000) 'Artwork must honor explicit immutable-object cache metadata.'
Assert ($r.RevisionResponseHeaders.Properties.ResponseHeadersPolicyConfig.CustomHeadersConfig.Items[0].Value -eq 'no-cache') 'Browser revision revalidation must be enforced.'
Assert ($r.AssetResponseHeaders.Properties.ResponseHeadersPolicyConfig.CorsConfig.AccessControlAllowOrigins.Items[0].Ref -eq 'SiteOrigin') 'CORS must use the configured origin.'

& $deploy -ValidateOnly -Profile 'test-profile' | Out-Null
Assert ($global:PatternStudioAssetDeployTestState.Calls.Count -eq 2) 'ValidateOnly must not deploy or read a stack.'
Assert ($global:PatternStudioAssetDeployTestState.Calls[0][0] -eq 'sts' -and $global:PatternStudioAssetDeployTestState.Calls[1][1] -eq 'validate-template') 'Identity and validation must precede deployment.'
foreach ($call in $global:PatternStudioAssetDeployTestState.Calls) {
    Assert ($call -contains '--no-cli-pager' -and $call -contains '--profile' -and $call -contains 'test-profile') 'Profile and pager flags must reach every AWS call.'
}
$fileArgument = $global:PatternStudioAssetDeployTestState.Calls[1] | Where-Object { $_ -like 'file://*' }
Assert ($fileArgument -eq "file://$templatePath") 'Template path, including spaces, must remain a single argument.'

$global:PatternStudioAssetDeployTestState.Calls = @()
$result = @(& $deploy -Region us-west-2 -StackName test-assets -SiteOrigin https://example.com -PriceClass PriceClass_All)
Assert ($global:PatternStudioAssetDeployTestState.Calls.Count -eq 4) 'Deployment must verify identity, validate, deploy, and read outputs.'
$deployCall = $global:PatternStudioAssetDeployTestState.Calls[2]
Assert ($deployCall[1] -eq 'deploy' -and $deployCall -contains '--no-fail-on-empty-changeset') 'Deployment must be rerunnable.'
foreach ($argument in 'us-west-2', 'test-assets', 'SiteOrigin=https://example.com', 'PriceClass=PriceClass_All') {
    Assert ($deployCall -contains $argument) "Missing deployment argument: $argument"
}
Assert ($result[-1].BucketName -eq 'test-assets' -and $result[-1].DistributionId -eq 'TEST123') 'Script must return usable stack outputs.'

foreach ($case in @(
    @('sts get-caller-identity', 'Could not verify AWS credentials', 1),
    @('cloudformation validate-template', 'template validation failed', 2),
    @('cloudformation deploy', 'deployment failed', 3),
    @('cloudformation describe-stacks', 'reading stack outputs failed', 4)
)) {
    $global:PatternStudioAssetDeployTestState.Calls = @()
    $global:PatternStudioAssetDeployTestState.FailCommand = $case[0]
    Expect-Failure { & $deploy } $case[1]
    Assert ($global:PatternStudioAssetDeployTestState.Calls.Count -eq $case[2]) "Must stop after failure: $($case[0])"
}
$global:PatternStudioAssetDeployTestState.FailCommand = ''
$global:PatternStudioAssetDeployTestState.MissingOutput = $true
Expect-Failure { & $deploy } 'stack output DistributionId is missing'
$global:PatternStudioAssetDeployTestState.MissingOutput = $false
$global:PatternStudioAssetDeployTestState.Calls = @()
Expect-Failure { & $deploy -SiteOrigin 'https://example.com/' } 'SiteOrigin'
Expect-Failure { & $deploy -StackName 'invalid stack' } 'StackName'
Expect-Failure { & $deploy -PriceClass 'invalid' } 'PriceClass'
Assert ($global:PatternStudioAssetDeployTestState.Calls.Count -eq 0) 'Invalid inputs must fail before contacting AWS.'

Remove-Variable PatternStudioAssetDeployTestState -Scope Global
Write-Output 'PASS: asset template invariants, deployment arguments, validate-only mode, outputs, and failure handling (mock AWS only).'
