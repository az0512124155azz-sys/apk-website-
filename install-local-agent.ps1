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
function Expand-ZipClean([string]$zip,[string]$dest){
  if(Test-Path $dest){Remove-Item -Recurse -Force $dest}
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Force -Path $zip -DestinationPath $dest
}
function Wait-Health {
  for($i=0;$i -lt 30;$i++){
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

$runner=Join-Path $installDir 'run-agent.ps1'
$nodeExeEsc=$nodeExe
$java=Join-Path $cloud '.tools\\java\\bin\\java.exe'
$agentLog=Join-Path $installDir 'agent.log'
$agentErr=Join-Path $installDir 'agent-error.log'
$runnerBody=@"
`$ErrorActionPreference='SilentlyContinue'
`$env:PORT='32145'
`$env:WORKSPACE_ROOT='$workspace'
`$env:JAVA_BIN='$java'
`$env:NODE_ENV='production'
`$env:LOCAL_PROCESSOR='1'
`$env:APK_STUDIO_JAVA_XMS='256m'
`$env:APK_STUDIO_JAVA_XMX='4096m'
Set-Location '$cloud'
while(`$true){
  try{
    `$p=Start-Process -FilePath '$nodeExeEsc' -ArgumentList 'server.mjs' -WorkingDirectory '$cloud' -WindowStyle Hidden -RedirectStandardOutput '$agentLog' -RedirectStandardError '$agentErr' -PassThru
    `$p.WaitForExit()
  }catch{}
  Start-Sleep -Seconds 2
}
"@
Set-Content -Path $runner -Value $runnerBody -Encoding UTF8

# Remove old visible launchers/tasks if present.
try{Unregister-ScheduledTask -TaskName 'APK Studio Local Agent' -Confirm:$false -ErrorAction SilentlyContinue}catch{}
$startupOld=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\APK Studio Local Agent.lnk'
Remove-Item -Force $startupOld -ErrorAction SilentlyContinue

# Create a hidden Startup launcher. No terminal window is shown at login.
$launcher=Join-Path $installDir 'launch-hidden.vbs'
$vbs=@"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$runner""", 0, False
"@
Set-Content -Path $launcher -Value $vbs -Encoding ASCII

# Prefer Task Scheduler so the agent starts reliably in the background at logon.
# Keep the Startup shortcut as a fallback for systems where task registration
# is blocked by policy.
try{
  Unregister-ScheduledTask -TaskName 'APK Studio Local Agent' -Confirm:$false -ErrorAction SilentlyContinue
  $taskAction=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"' + $launcher + '"')
  $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $taskSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'APK Studio Local Agent' -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Description 'Runs APK Studio Local Agent in the background.' -Force | Out-Null
}catch{}

$startup=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\APK Studio Local Agent.lnk'
$w=New-Object -ComObject WScript.Shell
$link=$w.CreateShortcut($startup)
$link.TargetPath="$env:WINDIR\\System32\\wscript.exe"
$link.Arguments='"' + $launcher + '"'
$link.WorkingDirectory=$installDir
$link.WindowStyle=7
$link.Save()

# Register protocol used by the site to wake the background agent if needed.
$wake=Join-Path $installDir 'wake-agent.ps1'
$wakeBody=@"
`$ErrorActionPreference='SilentlyContinue'
try{
  `$r=Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:32145/health' -TimeoutSec 2
  if(`$r.ok){exit 0}
}catch{}
Start-Process -FilePath "$env:WINDIR\\System32\\wscript.exe" -ArgumentList '""$launcher""' -WindowStyle Hidden
"@
Set-Content -Path $wake -Value $wakeBody -Encoding UTF8
$proto='HKCU:\\Software\\Classes\\apkstudiolocal'
New-Item -Path $proto -Force | Out-Null
Set-ItemProperty -Path $proto -Name '(default)' -Value 'URL:APK Studio Local Agent'
Set-ItemProperty -Path $proto -Name 'URL Protocol' -Value ''
New-Item -Path "$proto\\shell\\open\\command" -Force | Out-Null
$protoCmd='powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$wake+'"'
Set-ItemProperty -Path "$proto\\shell\\open\\command" -Name '(default)' -Value $protoCmd

# Stop any previous watchdog/agent and start hidden now.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*APKStudioLocal*run-agent.ps1*' -or $_.CommandLine -like '*APKStudioLocal*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath "$env:WINDIR\\System32\\wscript.exe" -ArgumentList ('"'+$launcher+'"') -WindowStyle Hidden

if(-not (Wait-Health)){
  Write-Host ''
  Write-Host 'Local Agent failed to become healthy.' -ForegroundColor Red
  if(Test-Path $agentLog){
    Write-Host '--- agent.log ---'
    Get-Content $agentLog -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }
  if(Test-Path $agentErr){
    Write-Host '--- agent-error.log ---'
    Get-Content $agentErr -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }
  throw 'Local Agent did not start within 60 seconds.'
}

Set-Content -Path (Join-Path $installDir 'installed.txt') -Value (Get-Date).ToString('o') -Encoding ASCII
Write-Host 'APK Studio Local Agent is ready.' -ForegroundColor Green
Stop-Transcript | Out-Null
Start-Sleep -Seconds 1
