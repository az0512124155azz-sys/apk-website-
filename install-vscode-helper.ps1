param()

$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'APKStudio'
$handlerPath = Join-Path $installDir 'apkstudio-handler.ps1'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$handler = @'
param([Parameter(Mandatory=$true)][string]$Uri)

$ErrorActionPreference = 'Stop'
function Decode([string]$s) { [System.Uri]::UnescapeDataString(($s -replace '\+',' ')) }
function Get-Query([string]$uri) {
  $q = @{}
  $u = [System.Uri]$uri
  $u.Query.TrimStart('?').Split('&') | ForEach-Object {
    if ($_ -eq '') { return }
    $p = $_.Split('=',2)
    $q[(Decode $p[0])] = if($p.Length -gt 1){ Decode $p[1] } else { '' }
  }
  return $q
}
function Find-Code {
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
  )
  foreach($c in $candidates){ if($c -and (Test-Path $c)){ return $c } }
  throw 'Visual Studio Code was not found. Install VS Code first.'
}

$q = Get-Query $Uri
$name = if($q.name){ $q.name } else { 'APKStudioProject' }
$safeName = ($name -replace '[^A-Za-z0-9._-]','_')
$projectsDir = Join-Path $env:USERPROFILE 'APKStudio\Projects'
$projectDir = Join-Path $projectsDir $safeName
New-Item -ItemType Directory -Force -Path $projectsDir | Out-Null

if($q.download){
  $zip = Join-Path $env:TEMP ($safeName + '.zip')
  Write-Host "Downloading APK Studio workspace..."
  Invoke-WebRequest -UseBasicParsing -Uri $q.download -OutFile $zip
  if(Test-Path $projectDir){ Remove-Item -Recurse -Force $projectDir }
  New-Item -ItemType Directory -Force -Path $projectDir | Out-Null
  Expand-Archive -Force -Path $zip -DestinationPath $projectDir
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
} elseif($q.repo) {
  $repo = $q.repo
  if(Test-Path (Join-Path $projectDir '.git')){
    & git -C $projectDir pull --ff-only
  } else {
    if(Test-Path $projectDir){ Remove-Item -Recurse -Force $projectDir }
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if($gh){
      & gh auth status 2>$null
      if($LASTEXITCODE -ne 0){ & gh auth login --web }
      & gh repo clone $repo $projectDir
    } else {
      & git clone $repo $projectDir
    }
  }
} else {
  throw 'The APK Studio link does not contain a project download or GitHub repository.'
}

$code = Find-Code
$workspace = Get-ChildItem -Path $projectDir -Filter '*.code-workspace' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if($workspace){ Start-Process -FilePath $code -ArgumentList @($workspace.FullName) }
else { Start-Process -FilePath $code -ArgumentList @($projectDir) }
'@

Set-Content -Path $handlerPath -Value $handler -Encoding UTF8

$base = 'HKCU:\Software\Classes\apkstudio'
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name '(default)' -Value 'URL:APK Studio Protocol'
Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''
New-Item -Path "$base\shell\open\command" -Force | Out-Null
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $handlerPath + '" "%1"'
Set-ItemProperty -Path "$base\shell\open\command" -Name '(default)' -Value $command

Write-Host ''
Write-Host 'APK Studio VS Code helper installed successfully.' -ForegroundColor Green
Write-Host 'You can now use Open in VS Code from APK Studio.'
Read-Host 'Press Enter to close'
