param(
    [string]$Python = "C:\Users\BHAM CSR\AppData\Local\Python\pythoncore-3.14-64\python.exe"
)
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Build = Join-Path $Root ".build"
$Api = Join-Path $Build "ApiFunction"
$Broadcast = Join-Path $Build "BroadcastFunction"
if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }
New-Item -ItemType Directory -Force $Api, $Broadcast | Out-Null
# Download Linux CPython 3.12 wheels; never use the Windows host's native Pillow.
& $Python -m pip install --quiet --only-binary=:all: --platform manylinux2014_x86_64 `
    --implementation cp --python-version 3.12 --abi cp312 --target $Api `
    -r (Join-Path $Root "src\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Linux wheel dependency build failed." }
Copy-Item (Join-Path $Root "src\app.py"), (Join-Path $Root "src\rules.py") $Api
Copy-Item (Join-Path $Root "src\broadcast.py") $Broadcast
$Template = Get-Content (Join-Path $Root "template.yaml") -Raw
$Template = $Template.Replace("CodeUri: src/", "CodeUri: ApiFunction/")
# The broadcast function uses only the AWS runtime's built-in boto3.
$Template = $Template.Replace("CodeUri: ApiFunction/`n      Handler: broadcast.handler",
    "CodeUri: BroadcastFunction/`n      Handler: broadcast.handler")
$Template = $Template.Replace("CodeUri: ApiFunction/`r`n      Handler: broadcast.handler",
    "CodeUri: BroadcastFunction/`r`n      Handler: broadcast.handler")
# Packaged artifacts are already built: disable custom build metadata.
$Template = $Template.Replace("    Metadata:`n      BuildMethod: makefile`n", "")
$Template = $Template.Replace("    Metadata:`r`n      BuildMethod: makefile`r`n", "")
[System.IO.File]::WriteAllText((Join-Path $Build "template.yaml"), $Template,
    [System.Text.UTF8Encoding]::new($false))
Write-Output "Built Linux x86_64 Python 3.12 artifacts: $Build\template.yaml"
Write-Output "No deployment performed."
