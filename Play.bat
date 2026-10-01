@echo off
REM Neon Coast launcher: opens the game in its own browser window (no install needed).
setlocal
set "GAME=%~dp0dist\NeonCoast.html"
if not exist "%GAME%" (
  echo Could not find "%GAME%"
  pause
  exit /b 1
)
set "URL=file:///%GAME:\=/%"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app="%URL%" --start-maximized
) else if exist "%EDGE%" (
  start "" "%EDGE%" --app="%URL%" --start-maximized
) else (
  start "" "%GAME%"
)
endlocal
