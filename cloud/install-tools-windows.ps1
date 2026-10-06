param()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$tools=Join-Path $root '.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Download([string]$url,[string]$out){
  Write-Host "Downloading $url"
  if(Test-Path $out){Remove-Item -Force $out -ErrorAction SilentlyContinue}

  $curl=Get-Command curl.exe -ErrorAction SilentlyContinue
  if($curl){
    & $curl.Source -L --fail --retry 5 --retry-delay 3 --connect-timeout 20 --max-time 600 --output $out $url
    if($LASTEXITCODE -eq 0 -and (Test-Path $out) -and ((Get-Item $out).Length -gt 0)){ return }
    Remove-Item -Force $out -ErrorAction SilentlyContinue
    Write-Host 'curl failed; trying BITS...' -ForegroundColor Yellow
  }

  try{
    Import-Module BitsTransfer -ErrorAction Stop
    Start-BitsTransfer -Source $url -Destination $out -TransferType Download -Priority Foreground -ErrorAction Stop
    if((Test-Path $out) -and ((Get-Item $out).Length -gt 0)){ return }
  }catch{
    Remove-Item -Force $out -ErrorAction SilentlyContinue
    Write-Host 'BITS failed; trying PowerShell fallback...' -ForegroundColor Yellow
  }

  $oldProgress=$ProgressPreference
  $ProgressPreference='SilentlyContinue'
  try{
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -TimeoutSec 600
  }finally{
    $ProgressPreference=$oldProgress
  }
  if(-not (Test-Path $out) -or (Get-Item $out).Length -eq 0){ throw "Download failed: $url" }
}

function Expand-Zip([string]$zip,[string]$dest){
  if(Test-Path $dest){Remove-Item -Recurse -Force $dest}
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Force -Path $zip -DestinationPath $dest
}

$javaDir=Join-Path $tools 'java'
if(-not (Test-Path (Join-Path $javaDir 'bin\java.exe'))){
  $tmp=Join-Path $env:TEMP 'apkstudio-jre.zip'
  Download 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse' $tmp
  $extract=Join-Path $env:TEMP ('apkstudio-jre-'+[guid]::NewGuid())
  Expand-Zip $tmp $extract
  $child=Get-ChildItem $extract -Directory | Select-Object -First 1
  if(-not $child){throw 'Downloaded Java archive did not contain a JRE folder.'}
  if(Test-Path $javaDir){Remove-Item -Recurse -Force $javaDir}
  Move-Item $child.FullName $javaDir
  Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

$jadxDir=Join-Path $tools 'jadx'
if(-not (Test-Path (Join-Path $jadxDir 'lib\jadx-1.5.6-all.jar'))){
  $tmp=Join-Path $env:TEMP 'apkstudio-jadx.zip'
  Download 'https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip' $tmp
  if(Test-Path $jadxDir){Remove-Item -Recurse -Force $jadxDir}
  New-Item -ItemType Directory -Force -Path $jadxDir | Out-Null
  Expand-Archive -Force -Path $tmp -DestinationPath $jadxDir
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

$apktoolDir=Join-Path $tools 'apktool'
New-Item -ItemType Directory -Force -Path $apktoolDir | Out-Null
$apktool=Join-Path $apktoolDir 'apktool.jar'
if(-not (Test-Path $apktool)){
  Download 'https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar' $apktool
}

& (Join-Path $javaDir 'bin\java.exe') -version
Write-Host 'Local APK tools installed.' -ForegroundColor Green
