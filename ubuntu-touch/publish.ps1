# Publish TV Remote to the OpenStore (open-store.io).
# Creates the app entry if it doesn't exist yet, uploads the newest dist\*.click as a new revision,
# fills in the store page and publishes it. Run again after bumping the version to ship an update.
# -PageOnly: only update the store page (text + screenshots), no new revision.
# Screenshots: every ubuntu-touch\screenshots\*.png, in file-name order, replaces what the store has.
# Your API key is on https://open-store.io/manage/profile (it is only sent to open-store.io).
param([string]$Click, [string]$Changelog = 'Remote control for smart TVs over Wi-Fi.', [switch]$PageOnly)
$ErrorActionPreference = 'Stop'

$id = 'tvremote.juujbyg'
$api = 'https://open-store.io/api/v3/manage'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Click) {
  $Click = Get-ChildItem "$root\dist\$($id)_*.click" | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $PageOnly -and (-not $Click -or -not (Test-Path $Click))) { throw "No .click found in $root\dist. Build it first (ubuntu-touch/build.sh)." }
$screenshots = @(Get-ChildItem "$PSScriptRoot\screenshots\*.png" | Sort-Object Name | Select-Object -ExpandProperty FullName)

$key = $env:OPENSTORE_API_KEY
if (-not $key) { $key = Read-Host 'OpenStore API key (from https://open-store.io/manage/profile)' }
$key = $key.Trim()

# curl.exe ships with Windows 10+. Returns the parsed JSON reply; stops on failure.
function Invoke-Store([string]$step, [string[]]$curlArgs, [switch]$AllowMissing) {
  $reply = & curl.exe -sS @curlArgs
  if ($LASTEXITCODE -ne 0) { throw "$step failed: could not reach open-store.io" }
  try { $json = $reply | ConvertFrom-Json } catch { throw "$step failed: $reply" }
  if (-not $json.success) {
    if ($AllowMissing) { return $null }
    $detail = if ($json.data) { ($json.data | ConvertTo-Json -Compress -Depth 5) } else { '' }
    throw "$step failed: $($json.message) $detail"
  }
  Write-Host "OK  $step"
  return $json.data
}

$app = Invoke-Store 'Look up app' @("$api/$($id)?apikey=$key") -AllowMissing
if (-not $app) {
  $app = Invoke-Store 'Create app' @('-X', 'POST', "$api/?apikey=$key",
    '--data-urlencode', "id=$id",
    '--data-urlencode', 'name=TV Remote',
    '--data-urlencode', 'license=MIT/X/Expat License',
    '--data-urlencode', 'source=https://github.com/juujbyg/tv-remote')
}

if (-not $PageOnly) {
  Write-Host "Uploading $(Split-Path $Click -Leaf) (automated review runs now, this can take a minute)..."
  $null = Invoke-Store 'Upload revision' @('-X', 'POST', "$api/$id/revision?apikey=$key",
    '-F', "file=@$Click",
    '--form-string', 'channel=focal',
    '--form-string', "changelog=$Changelog")
}

$description = @'
Control your smart TV from your phone over Wi-Fi. No account, no cloud: the app talks to the TV directly on your local network.

Supported TVs:
- Android TV / Google TV (Sony, TCL, Hisense, Philips, Xiaomi, Chromecast with Google TV, Nvidia Shield...): type the code the TV shows
- Samsung (2016 and newer): press Allow on the TV
- LG webOS: accept the prompt on the TV
- Roku
- Sony Bravia (non-Google models): PIN or Pre-Shared Key

Features: scan the network to find TVs, arrow pad or swipe touchpad, volume and channels, number pad, typing text into the TV, app shortcuts, and power-on through Wake-on-LAN.

The phone and the TV must be on the same Wi-Fi network.
'@
$update = @('-X', 'PUT', "$api/$($id)?apikey=$key",
  '--form-string', 'tagline=Remote control for smart TVs over Wi-Fi',
  '--form-string', "description=$description",
  '--form-string', 'category=Utilities',
  '--form-string', 'source=https://github.com/juujbyg/tv-remote',
  '--form-string', 'support_url=https://github.com/juujbyg/tv-remote/issues',
  '--form-string', 'donate_url=https://buymeacoffee.com/juujbyg',
  '--form-string', 'license=MIT/X/Expat License',
  '--form-string', 'published=true')
# The store drops any screenshot not listed in 'screenshots' on every update, so clear the list and
# re-upload ours in order (the store keeps at most 5).
$update += @('--form-string', 'screenshots=[]')
foreach ($shot in $screenshots | Select-Object -First 5) { $update += @('-F', "screenshot_files=@$shot;type=image/png") }
$null = Invoke-Store 'Store page + publish' $update

Write-Host "Screenshots: $($screenshots.Count)"
Write-Host "`nPublished: https://open-store.io/app/$id"
