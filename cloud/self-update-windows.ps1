param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][int]$ServerPid
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$cloud=Join-Path $InstallDir 'cloud'
$tmpZip=Join-Path $env:TEMP ('apkstudio-update-'+[guid]::NewGuid()+'.zip')
$tmpDir=Join-Path $env:TEMP ('apkstudio-update-'+[guid]::NewGuid())

function Download([string]$url,[string]$out){
  $curl=Get-Command curl.exe -ErrorAction SilentlyContinue
  if($curl){
    & $curl.Source -L --fail --retry 4 --retry-delay 2 --connect-timeout 15 --max-time 300 --output $out $url
    if($LASTEXITCODE -eq 0){return}
  }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -TimeoutSec 300
}

Start-Sleep -Seconds 2
Download 'https://github.com/az0512124155azz-sys/apk-website-/archive/refs/heads/cloud-prod.zip' $tmpZip
Expand-Archive -Force $tmpZip $tmpDir
$root=Get-ChildItem $tmpDir -Directory | Select-Object -First 1
$fresh=Join-Path $root.FullName 'cloud'

# Copy only application files. Preserve .tools, node_modules and all Workspaces.
Get-ChildItem $fresh -Force | ForEach-Object {
  if($_.Name -in @('.tools','node_modules')){ return }
  Copy-Item -Recurse -Force $_.FullName $cloud
}

$npm=Join-Path $cloud '.tools\node\npm.cmd'
if(Test-Path $npm){
  Push-Location $cloud
  & $npm install --omit=dev --no-audit --no-fund | Out-Null
  Pop-Location
}

try{Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue}catch{}
Start-Sleep -Seconds 2

$launcher=Join-Path $InstallDir 'launch-hidden.vbs'
if(Test-Path $launcher){
  Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList ('"'+$launcher+'"') -WindowStyle Hidden
}

Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
