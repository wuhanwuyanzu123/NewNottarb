@echo off
REM Start only after assert-last-dryrun.mjs confirms this stays target-only/no-send.
setlocal
cd /d "%~dp0"
node.exe "%~dp0assert-last-dryrun.mjs" "%~dp0notarb-last-grpc-dryrun.toml" 1>>"%~dp0notarb-last-target-dryrun.stdout.log" 2>>"%~dp0notarb-last-target-dryrun.stderr.log"
if errorlevel 1 exit /b %errorlevel%
call "%LOCALAPPDATA%\notarb\bin\notarb.bat" onchain-bot "%~dp0notarb-last-grpc-dryrun.toml" 1>>"%~dp0notarb-last-target-dryrun.stdout.log" 2>>"%~dp0notarb-last-target-dryrun.stderr.log"
