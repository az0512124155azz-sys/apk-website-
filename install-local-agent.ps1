param()
$ErrorActionPreference='Stop'
$installDir=Join-Path $env:LOCALAPPDATA 'APKStudioLocal'
$zip=Join-Path $env:TEMP 'apkstudio-local.zip'
$tmp=Join-Path $env:TEMP ('apkstudio-local-'+[guid]::NewGuid())

Write-Host 'Installing APK Studio Local Agent...'
if(Test-Path $installDir){Remove-Item -Recurse -Force $installDir}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/az0512124155azz-sys/apk-website-/archive/refs/heads/cloud-prod.zip' -OutFile $zip
Expand-Archive -Force $zip $tmp
$src=Get-ChildItem $tmp -Directory | Select-Object -First 1
Copy-Item -Recurse -Force (Join-Path $src.FullName 'cloud') $installDir
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue

$cloud=Join-Path $installDir 'cloud'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $cloud 'install-tools-windows.ps1')

$node=(Get-Command node -ErrorAction SilentlyContinue)
if(-not $node){
  $winget=(Get-Command winget -ErrorAction SilentlyContinue)
  if(-not $winget){throw 'Node.js is required. Install Node.js LTS and run this installer again.'}
  Write-Host 'Installing Node.js LTS...'
  & winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
}
$npm=(Get-Command npm -ErrorAction SilentlyContinue)
if(-not $npm){
  $npmPath=Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
  if(Test-Path $npmPath){$npm=$npmPath}else{throw 'npm was not found after Node.js installation.'}
}else{$npm=$npm.Source}

Push-Location $cloud
& $npm install --omit=dev
Pop-Location

$start=Join-Path $installDir 'start-local-agent.cmd'
$java=Join-Path $cloud '.tools\java\bin\java.exe'
$workspace=Join-Path $env:USERPROFILE 'APKStudio\Workspaces'
$cmd=@"
@echo off
set PORT=32145
set WORKSPACE_ROOT=$workspace
set JAVA_BIN=$java
cd /d "$cloud"
node server.mjs
"@
Set-Content -Path $start -Value $cmd -Encoding ASCII

$startup=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\APK Studio Local Agent.lnk'
$w=New-Object -ComObject WScript.Shell
$link=$w.CreateShortcut($startup)
$link.TargetPath=$start
$link.WorkingDirectory=$installDir
$link.WindowStyle=7
$link.Save()

Start-Process -FilePath $start -WindowStyle Hidden
Write-Host ''
Write-Host 'APK Studio Local Agent installed and started on http://127.0.0.1:32145' -ForegroundColor Green
Write-Host 'You can now choose This computer in APK Studio.'
Read-Host 'Press Enter to close'
