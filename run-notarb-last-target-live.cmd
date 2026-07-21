@echo off
REM Internal live child runner for last-notarb-supervisor.mjs.
setlocal
cd /d "%~dp0"
set "CONFIG=%~1"
if not "%~2"=="--managed-by-last-supervisor" (
  echo {"status":"last_live_start_rejected","reason":"use_run-last-notarb-live-supervisor.cmd"} 1>>"%~dp0notarb-last-target-live.stderr.log"
  exit /b 2
)
if "%CONFIG%"=="" (
  echo {"status":"last_live_start_rejected","reason":"missing_supervisor_config"} 1>>"%~dp0notarb-last-target-live.stderr.log"
  exit /b 2
)
node.exe "%~dp0assert-last-live.mjs" "%CONFIG%" 1>>"%~dp0notarb-last-target-live.stdout.log" 2>>"%~dp0notarb-last-target-live.stderr.log"
if errorlevel 1 exit /b %errorlevel%
call "%LOCALAPPDATA%\notarb\bin\notarb.bat" onchain-bot "%CONFIG%" 1>>"%~dp0notarb-last-target-live.stdout.log" 2>>"%~dp0notarb-last-target-live.stderr.log"
