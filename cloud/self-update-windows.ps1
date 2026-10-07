param(
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][int]$ServerPid
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$cloud=Join-Path $InstallDir 'cloud'
$log=Join-Path $InstallDir 'update.log'
$tmpZip=Join-Path $env:TEMP ('apkstudio-update-'+[guid]::NewGuid()+'.zip')
$tmpDir=Join-Path $env:TEMP ('apkstudio-update-'+[guid]::NewGuid())
$preserve=Join-Path $env:TEMP ('apkstudio-update-preserve-'+[guid]::NewGuid())

function Write-UpdateLog([string]$message){
  $line=(Get-Date).ToString('o')+' '+$message
  Add-Content -Path $log -Value $line -Encoding UTF8
}
function Download([string]$url,[string]$out){
  if(Test-Path $out){Remove-Item -Force $out -ErrorAction SilentlyContinue}
  $curl=Get-Command curl.exe -ErrorAction SilentlyContinue
  if($curl){
    & $curl.Source -L --fail --retry 5 --retry-delay 2 --connect-timeout 15 --max-time 600 --output $out $url
    if($LASTEXITCODE -eq 0 -and (Test-Path $out) -and ((Get-Item $out).Length -gt 0)){return}
    Remove-Item -Force $out -ErrorAction SilentlyContinue
  }
  try{
    Import-Module BitsTransfer -ErrorAction Stop
    Start-BitsTransfer -Source $url -Destination $out -TransferType Download -Priority Foreground -ErrorAction Stop
    if((Test-Path $out) -and ((Get-Item $out).Length -gt 0)){return}
  }catch{
    Remove-Item -Force $out -ErrorAction SilentlyContinue
  }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -TimeoutSec 600
  if(-not (Test-Path $out) -or (Get-Item $out).Length -eq 0){throw "Download failed: $url"}
}
function Stop-AgentProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $PID -and (
        $_.ProcessId -eq $ServerPid -or
        $_.CommandLine -like '*APKStudioLocal*run-agent.ps1*' -or
        $_.CommandLine -like '*APKStudioLocal*server.mjs*'
      )
    } |
    ForEach-Object {
      try{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}catch{}
    }
}

try{
  Write-UpdateLog 'Starting atomic Local Agent update.'
  New-Item -ItemType Directory -Force -Path $preserve | Out-Null

  # Stop watchdog first so it cannot restart the old server while files change.
  Stop-AgentProcesses
  Start-Sleep -Milliseconds 800

  Download 'https://github.com/az0512124155azz-sys/apk-website-/archive/refs/heads/cloud-prod.zip' $tmpZip
  Expand-Archive -Force $tmpZip $tmpDir
  $root=Get-ChildItem $tmpDir -Directory | Select-Object -First 1
  if(-not $root){throw 'Downloaded update did not contain a repository root.'}
  $fresh=Join-Path $root.FullName 'cloud'
  if(-not (Test-Path $fresh)){throw 'Downloaded update did not contain cloud files.'}

  # Preserve large downloaded tools/dependencies. Workspaces are outside
  # InstallDir and are never touched by this updater.
  if(Test-Path (Join-Path $cloud '.tools')){
    Move-Item -Force (Join-Path $cloud '.tools') (Join-Path $preserve '.tools')
  }
  if(Test-Path (Join-Path $cloud 'node_modules')){
    Move-Item -Force (Join-Path $cloud 'node_modules') (Join-Path $preserve 'node_modules')
  }

  if(Test-Path $cloud){Remove-Item -Recurse -Force $cloud}
  Copy-Item -Recurse -Force $fresh $cloud

  if(Test-Path (Join-Path $preserve '.tools')){
    Move-Item -Force (Join-Path $preserve '.tools') (Join-Path $cloud '.tools')
  }
  if(Test-Path (Join-Path $preserve 'node_modules')){
    Move-Item -Force (Join-Path $preserve 'node_modules') (Join-Path $cloud 'node_modules')
  }

  $npm=Join-Path $cloud '.tools\node\npm.cmd'
  if(Test-Path $npm){
    Push-Location $cloud
    try{
      & $npm install --omit=dev --no-audit --no-fund
      if($LASTEXITCODE -ne 0){throw 'npm install failed during Local Agent update.'}
    }finally{Pop-Location}
  }

  $launcher=Join-Path $InstallDir 'launch-hidden.vbs'
  if(-not (Test-Path $launcher)){throw 'Local Agent launcher is missing.'}

  Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList ('"'+$launcher+'"') -WindowStyle Hidden
  Write-UpdateLog 'Local Agent files replaced and watchdog restarted successfully.'
}catch{
  Write-UpdateLog ('UPDATE FAILED: '+$_.Exception.Message)
  throw
}finally{
  Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $preserve -ErrorAction SilentlyContinue
}
