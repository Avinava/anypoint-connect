$ErrorActionPreference = 'Stop'

$SampleProfile = if ($env:ANYPOINT_PROFILE) { $env:ANYPOINT_PROFILE } else { 'default' }
$SampleEnvironment = if ($env:ANYPOINT_ENV) { $env:ANYPOINT_ENV } else { 'Sandbox' }

if (-not (Get-Command anc -ErrorAction SilentlyContinue)) {
    throw 'anc is not installed. Run: npm install --global @sfdxy/anypoint-connect'
}

Write-Host "Checking profile: $SampleProfile"
anc auth status --profile $SampleProfile

Write-Host "Checking environment visibility: $SampleEnvironment"
$PreviousProfile = $env:ANYPOINT_PROFILE
try {
    $env:ANYPOINT_PROFILE = $SampleProfile
    anc apps list --env $SampleEnvironment
}
finally {
    $env:ANYPOINT_PROFILE = $PreviousProfile
}
