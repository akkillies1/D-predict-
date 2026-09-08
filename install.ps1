param(
  [string]$Version = "latest",
  [string]$InstallDir = "$HOME\.d-predict"
)
$ErrorActionPreference = "Stop"
$Repo = if ($env:DP_RELEASE_REPO) { $env:DP_RELEASE_REPO } else { "akkillies1/D-predict-" }
if ($Version -eq "latest") {
  $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $release.tag_name
}
$archive = "d-predict-$($Version.TrimStart('v'))-windows.zip"
$url = "https://github.com/$Repo/releases/download/$Version/$archive"
$tmp = Join-Path $env:TEMP $archive
Invoke-WebRequest $url -OutFile $tmp
New-Item -ItemType Directory -Force -Path "$InstallDir\releases\$Version" | Out-Null
Expand-Archive $tmp -DestinationPath "$InstallDir\releases\$Version" -Force
Set-Content -Path "$InstallDir\current.txt" -Value "$InstallDir\releases\$Version"
Write-Host "Installed d-predict $Version in $InstallDir"
Write-Host "Run the dp.ps1 launcher from the extracted release, then .\dp.ps1 init"
