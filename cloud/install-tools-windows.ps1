param()
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$tools=Join-Path $root '.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Download([string]$url,[string]$out){
  Write-Host "Downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
}

$javaDir=Join-Path $tools 'java'
if(-not (Test-Path (Join-Path $javaDir 'bin\java.exe'))){
  $tmp=Join-Path $env:TEMP 'apkstudio-jre.zip'
  Download 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse' $tmp
  $extract=Join-Path $env:TEMP ('apkstudio-jre-'+[guid]::NewGuid())
  Expand-Archive -Force $tmp $extract
  $child=Get-ChildItem $extract -Directory | Select-Object -First 1
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
  Expand-Archive -Force $tmp $jadxDir
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

$apktoolDir=Join-Path $tools 'apktool'
New-Item -ItemType Directory -Force -Path $apktoolDir | Out-Null
$apktool=Join-Path $apktoolDir 'apktool.jar'
if(-not (Test-Path $apktool)){
  Download 'https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar' $apktool
}

& (Join-Path $javaDir 'bin\java.exe') -version
Write-Host 'Local APK tools installed.'
