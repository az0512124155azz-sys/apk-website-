param()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$installDir=Join-Path $env:LOCALAPPDATA 'APKStudioLocal'
$cloud=Join-Path $installDir 'cloud'
$tools=Join-Path $cloud '.tools'
$workspace=Join-Path $env:USERPROFILE 'APKStudio\Workspaces'
$log=Join-Path $installDir 'install.log'

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Start-Transcript -Path $log -Append | Out-Null

function Download([string]$url,[string]$out){
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
}
function Expand-ZipClean([string]$zip,[string]$dest){
  if(Test-Path $dest){Remove-Item -Recurse -Force $dest}
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Force -Path $zip -DestinationPath $dest
}
function Wait-Health {
  for($i=0;$i -lt 90;$i++){
    try{
      $r=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:32145/health' -TimeoutSec 2
      if($r.ok){return $true}
    }catch{}
    Start-Sleep -Seconds 2
  }
  return $false
}

Write-Host 'Installing APK Studio Local Agent...'
Write-Host "Workspace preserved at: $workspace"

# Stop any previous local agent.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*APKStudioLocal*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Refresh app files while preserving downloaded tools and dependencies.
$repoZip=Join-Path $env:TEMP 'apkstudio-cloud-prod.zip'
$tmpRepo=Join-Path $env:TEMP ('apkstudio-repo-'+[guid]::NewGuid())
$preserve=Join-Path $env:TEMP ('apkstudio-preserve-'+[guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $preserve | Out-Null

if(Test-Path (Join-Path $cloud '.tools')){
  Move-Item -Force (Join-Path $cloud '.tools') (Join-Path $preserve '.tools')
}
if(Test-Path (Join-Path $cloud 'node_modules')){
  Move-Item -Force (Join-Path $cloud 'node_modules') (Join-Path $preserve 'node_modules')
}

Download 'https://github.com/az0512124155azz-sys/apk-website-/archive/refs/heads/cloud-prod.zip' $repoZip
Expand-Archive -Force $repoZip $tmpRepo
$repoRoot=Get-ChildItem $tmpRepo -Directory | Select-Object -First 1
if(Test-Path $cloud){Remove-Item -Recurse -Force $cloud}
Copy-Item -Recurse -Force (Join-Path $repoRoot.FullName 'cloud') $installDir

if(Test-Path (Join-Path $preserve '.tools')){
  Move-Item -Force (Join-Path $preserve '.tools') (Join-Path $cloud '.tools')
}
if(Test-Path (Join-Path $preserve 'node_modules')){
  Move-Item -Force (Join-Path $preserve 'node_modules') (Join-Path $cloud 'node_modules')
}

Remove-Item -Recurse -Force $preserve -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $tmpRepo -ErrorAction SilentlyContinue
Remove-Item -Force $repoZip -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tools | Out-Null

# Portable Node.js LTS - no admin / winget required.
$nodeDir=Join-Path $tools 'node'
$nodeExe=Join-Path $nodeDir 'node.exe'
$npmCmd=Join-Path $nodeDir 'npm.cmd'
if(-not (Test-Path $nodeExe)){
  $nodeZip=Join-Path $env:TEMP 'apkstudio-node.zip'
  $nodeTmp=Join-Path $env:TEMP ('apkstudio-node-'+[guid]::NewGuid())
  Download 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip' $nodeZip
  Expand-Archive -Force $nodeZip $nodeTmp
  $nodeRoot=Get-ChildItem $nodeTmp -Directory | Select-Object -First 1
  if(Test-Path $nodeDir){Remove-Item -Recurse -Force $nodeDir}
  Move-Item $nodeRoot.FullName $nodeDir
  Remove-Item -Recurse -Force $nodeTmp -ErrorAction SilentlyContinue
  Remove-Item -Force $nodeZip -ErrorAction SilentlyContinue
}

# Portable Java/JADX/Apktool.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cloud 'install-tools-windows.ps1')

# Install backend dependencies using portable npm.
Push-Location $cloud
& $npmCmd install --omit=dev --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'npm install failed'}
Pop-Location

New-Item -ItemType Directory -Force -Path $workspace | Out-Null

$start=Join-Path $installDir 'start-local-agent.cmd'
$nodeExeEsc=$nodeExe
$java=Join-Path $cloud '.tools\java\bin\java.exe'
$cmd=@"
@echo off
set PORT=32145
set WORKSPACE_ROOT=$workspace
set JAVA_BIN=$java
set NODE_ENV=production
set LOCAL_PROCESSOR=1
set APK_STUDIO_JAVA_XMS=256m
set APK_STUDIO_JAVA_XMX=4096m
cd /d "$cloud"
"$nodeExeEsc" server.mjs >> "$installDir\agent.log" 2>&1
"@
Set-Content -Path $start -Value $cmd -Encoding ASCII

# Start automatically with Windows.
$startup=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\APK Studio Local Agent.lnk'
$w=New-Object -ComObject WScript.Shell
$link=$w.CreateShortcut($startup)
$link.TargetPath=$start
$link.WorkingDirectory=$installDir
$link.WindowStyle=7
$link.Save()

# Start now.
Start-Process -FilePath $start -WindowStyle Hidden

if(-not (Wait-Health)){
  throw 'Local Agent installed but did not become healthy. See install.log and agent.log.'
}

Set-Content -Path (Join-Path $installDir 'installed.txt') -Value (Get-Date).ToString('o') -Encoding ASCII
Write-Host 'APK Studio Local Agent is ready.' -ForegroundColor Green
Stop-Transcript | Out-Null
Start-Sleep -Seconds 1
