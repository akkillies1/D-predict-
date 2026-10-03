param(
  [ValidateSet('start','stop','restart','status','doctor','help')]
  [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runner = Join-Path $Root 'run.ps1'
if (-not (Test-Path $Runner)) {
  Write-Error "D-Predict runner is missing: $Runner"
  exit 1
}

# Compatibility entrypoint retained for older shortcuts and user scripts. All
# startup now goes through run.ps1 -> dp.ps1 so Docker Compose, database setup,
# marker checks, and diagnostics cannot drift between launchers.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Runner -Command $Command
exit $LASTEXITCODE
