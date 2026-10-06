@echo off
setlocal
set "SCRIPT=%TEMP%\apkstudio-install-%RANDOM%%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing 'https://apk-website-sable.vercel.app/install-local-agent.ps1' -OutFile '%SCRIPT%'"
if errorlevel 1 (
  echo Failed to download APK Studio installer.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "ERR=%ERRORLEVEL%"
del "%SCRIPT%" >nul 2>&1
if not "%ERR%"=="0" (
  echo.
  echo APK Studio Local Agent installation failed.
  echo Check %%LOCALAPPDATA%%\APKStudioLocal\install.log
  pause
  exit /b %ERR%
)
exit /b 0
